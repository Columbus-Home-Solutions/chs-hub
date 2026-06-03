/**
 * User management API — Sprint 17 (System Admin & Multi-User Foundation).
 *
 *   GET  /api/users                                  (O) list
 *   GET  /api/users/:id                              (O) detail
 *   POST /api/users                                  (O) create + invite
 *   PUT  /api/users/:id                              (O) update / (de)activate
 *   PUT  /api/users/:id/notification-preferences     (self or O)
 *
 * Owner-only is enforced centrally by the RBAC gate (src/lib/rbac.ts); these
 * handlers focus on the data work + audit logging. `/api/users/me` and
 * `/api/users/clockable` live in routes/me.ts (all roles) and are matched first.
 *
 * Business rules:
 *   • Never hard-delete a user — deactivate via is_active so historical audit
 *     rows survive (rule 2). The legacy `disabled` column is mirrored for the
 *     dashboard's older queries.
 *   • Every create/update is audit-logged with the actor; role changes record
 *     old→new (rule 3).
 *   • Cloudflare Access provisions the login identity out-of-band — CHS creates
 *     the row + sends an invite but does NOT call an Access API (§7 step 7).
 */

import type { Env } from "../env.js";
import { writeAudit, actorEmail } from "../lib/audit.js";
import type { UserRole } from "../middleware/auth.js";

const VALID_ROLES: UserRole[] = [
  "owner",
  "project_manager",
  "field_crew",
  "office_admin",
];

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

interface UserRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  phone: string | null;
  role: string;
  is_active: number;
  last_login: string | null;
  notification_preferences: string | null;
  created_at: string;
  updated_at: string | null;
}

const SELECT_FIELDS =
  "id, email, first_name, last_name, name, phone, role, is_active, last_login, notification_preferences, created_at, updated_at";

function displayName(row: { first_name: string | null; last_name: string | null; name: string | null }): string {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || (row.name ?? "").trim();
}

function shape(row: UserRow) {
  let prefs: unknown = null;
  if (row.notification_preferences) {
    try {
      prefs = JSON.parse(row.notification_preferences);
    } catch {
      prefs = null;
    }
  }
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    name: displayName(row),
    phone: row.phone,
    role: row.role,
    is_active: row.is_active === 1,
    last_login: row.last_login,
    notification_preferences: prefs,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── GET /api/users ────────────────────────────────────────────────────────

export async function handleUserList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_FIELDS} FROM users ORDER BY is_active DESC, role, first_name, last_name, email`,
  ).all<UserRow>();
  return json({ users: (results ?? []).map(shape) });
}

// ─── GET /api/users/:id ──────────────────────────────────────────────────────

export async function handleUserGet(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT ${SELECT_FIELDS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  if (!row) return json({ error: "not_found", id }, { status: 404 });
  return json({ user: shape(row) });
}

// ─── POST /api/users (create + invite) ───────────────────────────────────────

export async function handleUserCreate(request: Request, env: Env): Promise<Response> {
  let body: {
    email?: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    role?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_request", message: "Body must be JSON" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const role = (body.role ?? "").trim();
  if (!email || !email.includes("@")) {
    return json({ error: "bad_request", message: "Valid email required" }, { status: 400 });
  }
  if (!VALID_ROLES.includes(role as UserRole)) {
    return json(
      { error: "bad_request", message: `role must be one of ${VALID_ROLES.join(", ")}` },
      { status: 400 },
    );
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    return json({ error: "conflict", message: "A user with that email already exists" }, { status: 409 });
  }

  const id = crypto.randomUUID();
  const firstName = (body.first_name ?? "").trim() || null;
  const lastName = (body.last_name ?? "").trim() || null;
  const name = [firstName, lastName].filter(Boolean).join(" ").trim() || email;
  const phone = (body.phone ?? "").trim() || null;
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (id, email, name, first_name, last_name, phone, role, is_active, disabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
    .bind(id, email, name, firstName, lastName, phone, role, now, now)
    .run();

  const actor = actorEmail(request);
  await writeAudit(env, {
    userEmail: actor,
    action: "user.create",
    entityType: "user",
    entityId: id,
    details: { email, role, name },
    ipAddress: request.headers.get("cf-connecting-ip"),
  });

  const invite = await sendInvite(env, email, name, role);

  const row = await env.DB.prepare(`SELECT ${SELECT_FIELDS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();

  return json(
    {
      user: shape(row as UserRow),
      invite,
      access_provisioning_note:
        "Cloudflare Access provisions the login identity out-of-band — add this email to the Access application policy before first login (§7).",
    },
    { status: 201 },
  );
}

// ─── PUT /api/users/:id (update / deactivate / reactivate) ───────────────────

export async function handleUserUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const existing = await env.DB.prepare(`SELECT ${SELECT_FIELDS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  if (!existing) return json({ error: "not_found", id }, { status: 404 });

  let body: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    role?: string;
    is_active?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_request", message: "Body must be JSON" }, { status: 400 });
  }

  if (body.role !== undefined && !VALID_ROLES.includes(body.role as UserRole)) {
    return json(
      { error: "bad_request", message: `role must be one of ${VALID_ROLES.join(", ")}` },
      { status: 400 },
    );
  }

  // Guard: never strip the platform's last active owner (single-user safety,
  // rule 11). Deactivating or demoting the only owner would lock everyone out.
  const demotingOwner =
    existing.role === "owner" &&
    ((body.role !== undefined && body.role !== "owner") || body.is_active === false);
  if (demotingOwner) {
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_active = 1",
    ).first<{ n: number }>();
    if ((owners?.n ?? 0) <= 1) {
      return json(
        { error: "conflict", message: "Cannot deactivate or demote the only active owner" },
        { status: 409 },
      );
    }
  }

  const firstName = body.first_name !== undefined ? body.first_name.trim() || null : existing.first_name;
  const lastName = body.last_name !== undefined ? body.last_name.trim() || null : existing.last_name;
  const phone = body.phone !== undefined ? body.phone.trim() || null : existing.phone;
  const role = body.role !== undefined ? body.role : existing.role;
  const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;
  const name = [firstName, lastName].filter(Boolean).join(" ").trim() || existing.name || existing.email;
  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE users
        SET first_name = ?, last_name = ?, name = ?, phone = ?, role = ?,
            is_active = ?, disabled = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(firstName, lastName, name, phone, role, isActive, isActive === 1 ? 0 : 1, now, id)
    .run();

  const actor = actorEmail(request);
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  if (role !== existing.role) changes.role = { old: existing.role, new: role };
  if (isActive !== existing.is_active) {
    changes.is_active = { old: existing.is_active === 1, new: isActive === 1 };
  }
  await writeAudit(env, {
    userEmail: actor,
    action: role !== existing.role ? "user.role_change" : "user.update",
    entityType: "user",
    entityId: id,
    details: { email: existing.email, changes },
    ipAddress: request.headers.get("cf-connecting-ip"),
  });

  const row = await env.DB.prepare(`SELECT ${SELECT_FIELDS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  return json({ user: shape(row as UserRow), changes });
}

// ─── PUT /api/users/:id/notification-preferences ─────────────────────────────
//
// Per-user channel preferences (email / sms / push / in_app). Allowed for the
// owner (managing anyone) or the user editing their own row. The RBAC gate lets
// any authenticated user reach this; the self/owner check lives here.

export async function handleUserNotificationPreferences(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const actor = (request as Request & { user?: { id: string; role: string; email: string } }).user;
  if (actor && actor.role !== "owner" && actor.id !== id) {
    return json(
      { error: "forbidden", message: "You can only edit your own notification preferences" },
      { status: 403 },
    );
  }

  const existing = await env.DB.prepare(`SELECT ${SELECT_FIELDS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  if (!existing) return json({ error: "not_found", id }, { status: 404 });

  let body: { notification_preferences?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_request", message: "Body must be JSON" }, { status: 400 });
  }
  if (body.notification_preferences === undefined) {
    return json({ error: "bad_request", message: "Missing 'notification_preferences'" }, { status: 400 });
  }

  const serialized = JSON.stringify(body.notification_preferences);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE users SET notification_preferences = ?, updated_at = ? WHERE id = ?",
  )
    .bind(serialized, now, id)
    .run();

  await writeAudit(env, {
    userEmail: actorEmail(request),
    action: "user.notification_preferences",
    entityType: "user",
    entityId: id,
    details: { old: existing.notification_preferences, new: serialized },
    ipAddress: request.headers.get("cf-connecting-ip"),
  });

  const row = await env.DB.prepare(`SELECT ${SELECT_FIELDS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  return json({ user: shape(row as UserRow) });
}

// ─── Invite email (SIMULATE-aware, reuses the Resend config) ─────────────────
//
// Mirrors the notification engine's SIMULATE discipline: unless
// NOTIFICATIONS_DISPATCH_MODE === 'live' (and a Resend key + sender exist), we
// log the invite instead of sending — so local/test never emails a real person.

async function sendInvite(
  env: Env,
  email: string,
  name: string,
  role: string,
): Promise<{ sent: boolean; mode: "live" | "simulate"; reason?: string }> {
  const live = env.NOTIFICATIONS_DISPATCH_MODE === "live";
  const apiKey = env.RESEND_API_KEY;
  const from = env.NOTIFICATIONS_EMAIL_FROM ?? env.ALERT_EMAIL_FROM;
  const origin = env.APP_PUBLIC_ORIGIN ?? "https://dashboard.homesolutionsar.com";
  const subject = "You've been invited to Columbus Home Solutions";
  const text =
    `Hi ${name},\n\n` +
    `You've been added to the Columbus Home Solutions platform as ${role.replace(/_/g, " ")}.\n` +
    `Sign in at ${origin}/app/ once your account has been activated.\n\n` +
    `(Your login is managed through Cloudflare Access — you'll be prompted to verify ${email}.)`;

  if (!live || !apiKey || !from) {
    console.log(`[user-invite simulate] to=${email} role=${role}\n${text}`);
    return { sent: false, mode: "simulate", reason: !live ? "dispatch_mode_not_live" : "missing_config" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject, text }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[user-invite resend_error] ${res.status} :: ${detail}`);
      return { sent: false, mode: "live", reason: `resend_${res.status}` };
    }
    return { sent: true, mode: "live" };
  } catch (err) {
    return { sent: false, mode: "live", reason: (err as Error).message };
  }
}
