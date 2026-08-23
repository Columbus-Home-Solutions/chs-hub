/**
 * Client module API — clients, their properties, and the communication
 * timeline. Follows the settings.ts pattern: thin handlers, parameterized D1
 * queries, audit logging on every write, role enforcement via guard().
 *
 *   GET    /api/clients                       list + filters
 *   GET    /api/clients/:id                   detail (client + totals + properties + jobs)
 *   GET    /api/clients/:id/summary           computed totals (v_client_summary)
 *   POST   /api/clients                       create (runs repeat detection)
 *   PUT    /api/clients/:id                   update
 *   DELETE /api/clients/:id                   cascade delete (guards on active jobs)
 *   GET    /api/clients/:id/properties        list properties
 *   POST   /api/clients/:id/properties        add property
 *   PUT    /api/properties/:id                update property
 *   GET    /api/clients/:id/communications    timeline + filters
 *   POST   /api/communications                log a manual communication
 *
 * Schema note: the live `clients` table carries legacy Jobber columns (name,
 * synced_at NOT NULL, address_*) alongside the Sprint-1 native columns. New
 * rows populate both the native fields and the legacy `name`/`synced_at` so the
 * existing dashboard and sync stay coherent. Display name prefers
 * first_name+last_name and falls back to the legacy `name`.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { cascadeDeleteClient } from "../lib/cascade-delete.js";
import { NON_TEST_CLIENT } from "../lib/non-test-client.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

// ─── shared helpers ────────────────────────────────────────────────────────

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function digits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityType: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, entityType, entityId, JSON.stringify(details))
    .run();
}

interface ClientRow {
  id: string;
  name: string | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  phone_secondary: string | null;
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  lead_source: string | null;
  referral_source_id: string | null;
  high_level_contact_id: string | null;
  is_repeat_client: number | null;
  review_requested: number | null;
  google_review_left: number | null;
  notes: string | null;
  last_interaction_date: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
  total_jobs?: number;
  total_revenue?: number;
  active_jobs?: number;
  has_reviewed?: number;
}

/** Best-effort display name: native first/last, else legacy `name`. */
function displayName(row: ClientRow): string {
  const parts = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return parts || row.name || "(unnamed)";
}

function shapeClient(row: ClientRow) {
  return {
    id: row.id,
    name: displayName(row),
    company_name: row.company_name,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    phone_secondary: row.phone_secondary,
    mailing_address: row.mailing_address,
    mailing_city: row.mailing_city,
    mailing_state: row.mailing_state,
    mailing_zip: row.mailing_zip,
    lead_source: row.lead_source,
    referral_source_id: row.referral_source_id ?? null,
    high_level_contact_id: row.high_level_contact_id,
    is_repeat_client: (row.is_repeat_client ?? 0) === 1,
    review_requested: (row.review_requested ?? 0) === 1,
    google_review_left: (row.google_review_left ?? 0) === 1,
    notes: row.notes,
    last_interaction_date: row.last_interaction_date,
    total_jobs: row.total_jobs ?? 0,
    total_revenue: row.total_revenue ?? 0,
    active_jobs: row.active_jobs ?? 0,
    has_reviewed: (row.has_reviewed ?? 0) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
  };
}

// In-progress job statuses (unified schema). Used for the Active/Past filter.
const ACTIVE_JOB_STATUSES = ["deposit_paid", "scheduled", "in_progress", "punch_list"];

const CLIENT_SELECT = `
  SELECT c.*,
    COALESCE(s.total_jobs, 0) AS total_jobs,
    COALESCE(s.total_revenue, 0) AS total_revenue,
    (SELECT COUNT(*) FROM jobs j WHERE j.client_id = c.id
       AND j.status IN (${ACTIVE_JOB_STATUSES.map(() => "?").join(",")})) AS active_jobs,
    (SELECT COUNT(*) > 0 FROM google_reviews gr
       WHERE gr.matched_client_id = c.id AND gr.match_confidence = 'confirmed') AS has_reviewed
  FROM clients c
  LEFT JOIN v_client_summary s ON s.client_id = c.id
`;

// ─── GET /api/clients ────────────────────────────────────────────────────────

export async function handleClientList(env: Env, url: URL): Promise<Response> {
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
  const leadSource = str(url.searchParams.get("lead_source"));
  const isRepeat = url.searchParams.get("is_repeat");
  // filter: all | active | past | repeat
  const filter = (url.searchParams.get("filter") ?? "all").toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "500", 10) || 500, 2000);

  const where: string[] = [NON_TEST_CLIENT];
  const binds: unknown[] = [...ACTIVE_JOB_STATUSES];

  if (leadSource) {
    where.push("c.lead_source = ?");
    binds.push(leadSource);
  }
  if (isRepeat === "1" || filter === "repeat") {
    where.push("COALESCE(c.is_repeat_client, 0) = 1");
  }

  // When a free-text search is present, fetch all rows first so the JS-side
  // substring filter can match any client — not just the top N by recency.
  // The caller's `limit` is applied after filtering.
  const sqlLimit = search ? 2000 : limit;

  const sql = `${CLIENT_SELECT}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY c.last_interaction_date DESC, c.updated_at DESC, c.created_at DESC
    LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds, sqlLimit).all<ClientRow>();
  let rows = (results ?? []).map(shapeClient);

  // Active/past quick filters depend on the computed active_jobs count.
  if (filter === "active") rows = rows.filter((r) => r.active_jobs > 0);
  else if (filter === "past") rows = rows.filter((r) => r.total_jobs > 0 && r.active_jobs === 0);

  // Free-text search across name/phone/email/mailing address — done in JS so we
  // can match the computed display name (native or legacy).
  if (search) {
    rows = rows.filter((r) => {
      const hay = [
        r.name,
        r.company_name,
        r.first_name,
        r.last_name,
        r.email,
        r.phone,
        r.phone_secondary,
        r.mailing_address,
        r.mailing_city,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const searchDigits = digits(search);
      return hay.includes(search) || (searchDigits.length > 0 && digits(r.phone ?? "").includes(searchDigits));
    });
    rows = rows.slice(0, limit);
  }

  return json({ as_of: new Date().toISOString(), total: rows.length, clients: rows });
}

// ─── GET /api/clients/:id ─────────────────────────────────────────────────────

export async function handleClientGet(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`${CLIENT_SELECT} WHERE c.id = ?`)
    .bind(...ACTIVE_JOB_STATUSES, id)
    .first<ClientRow>();
  if (!row) return err(404, "not_found", "Client not found");

  const [
    properties,
    jobs,
    blockingJobs,
    contacts,
    tags,
    referralSource,
    unconvertedRequests,
    quotes,
    invoices,
    payments,
    googleReviews,
  ] = await Promise.all([
    env.DB.prepare("SELECT * FROM properties WHERE client_id = ? ORDER BY created_at ASC")
      .bind(id)
      .all(),
    env.DB.prepare(
      "SELECT id, job_number, title, status, contract_total, start_date, created_at FROM jobs WHERE client_id = ? ORDER BY created_at DESC LIMIT 200",
    )
      .bind(id)
      .all(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE client_id = ? AND status NOT IN ('closed', 'cancelled')",
    )
      .bind(id)
      .first<{ n: number }>(),
    env.DB.prepare(
      "SELECT * FROM client_contacts WHERE client_id = ? ORDER BY created_at ASC",
    )
      .bind(id)
      .all(),
    env.DB.prepare(
      `SELECT td.id, td.tag_text, td.archived, ct.created_at AS assigned_at
       FROM client_tags ct JOIN tag_definitions td ON td.id = ct.tag_definition_id
       WHERE ct.client_id = ? ORDER BY ct.created_at ASC`,
    )
      .bind(id)
      .all(),
    row.referral_source_id
      ? env.DB.prepare("SELECT id, label FROM referral_sources WHERE id = ?")
          .bind(row.referral_source_id)
          .first<{ id: string; label: string }>()
      : Promise.resolve(null),
    // Unconverted requests only — once estimate_id is set, the request is a quote.
    env.DB.prepare(
      `SELECT id, request_number, status, property_address, property_city, job_type, created_at
       FROM estimate_requests WHERE client_id = ? AND estimate_id IS NULL ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(id)
      .all(),
    // Quotes = estimates table (the client-facing quote built from a request).
    env.DB.prepare(
      `SELECT id, estimate_number, title, status, total, subtotal, client_signature, viewed_date, sent_at, created_at
       FROM estimates WHERE client_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(id)
      .all(),
    // Invoices for this client (has direct client_id column).
    env.DB.prepare(
      `SELECT id, invoice_number, title, job_id, amount, total_due, status, due_date, created_at
       FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 200`,
    )
      .bind(id)
      .all(),
    // Payments for all invoices belonging to this client.
    env.DB.prepare(
      `SELECT p.id, p.invoice_id, p.amount, p.received_date, p.created_at, i.invoice_number
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id
       WHERE i.client_id = ? ORDER BY COALESCE(p.received_date, p.created_at) DESC LIMIT 200`,
    )
      .bind(id)
      .all(),
    env.DB.prepare(
      `SELECT id, reviewer_name, star_rating, comment_text, review_created_at,
              reply_text, reply_sent_at, match_confidence, entry_source
       FROM google_reviews WHERE matched_client_id = ? AND match_confidence = 'confirmed'
       ORDER BY review_created_at DESC`,
    )
      .bind(id)
      .all(),
  ]);

  return json({
    client: {
      ...shapeClient(row),
      can_delete: (blockingJobs?.n ?? 0) === 0,
      referral_source: referralSource ?? null,
    },
    properties: properties.results ?? [],
    jobs: jobs.results ?? [],
    contacts: contacts.results ?? [],
    tags: tags.results ?? [],
    estimate_requests: unconvertedRequests.results ?? [],
    quotes: quotes.results ?? [],
    invoices: invoices.results ?? [],
    payments: payments.results ?? [],
    google_reviews: googleReviews.results ?? [],
  });
}

// ─── GET /api/clients/:id/summary ─────────────────────────────────────────────

export async function handleClientSummary(env: Env, id: string): Promise<Response> {
  const client = await env.DB.prepare(
    "SELECT id, last_interaction_date FROM clients WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; last_interaction_date: string | null }>();
  if (!client) return err(404, "not_found", "Client not found");

  const summary = await env.DB.prepare(
    "SELECT total_jobs, total_revenue FROM v_client_summary WHERE client_id = ?",
  )
    .bind(id)
    .first<{ total_jobs: number; total_revenue: number }>();

  return json({
    client_id: id,
    total_jobs: summary?.total_jobs ?? 0,
    total_revenue: summary?.total_revenue ?? 0,
    last_interaction: client.last_interaction_date,
  });
}

// ─── Repeat client detection ──────────────────────────────────────────────────

interface DuplicateMatch {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  total_jobs: number;
  total_revenue: number;
  last_interaction_date: string | null;
  match_reason: string;
}

/**
 * Find clients that likely already exist, by (1) exact phone, (2) exact email,
 * (3) last name + property address. Returns de-duplicated matches with their
 * computed totals so the UI can show a "Possible existing client" prompt.
 */
async function findDuplicates(
  env: Env,
  opts: { phone?: string | null; email?: string | null; lastName?: string | null; address?: string | null },
): Promise<DuplicateMatch[]> {
  const matches = new Map<string, DuplicateMatch>();

  const add = (row: ClientRow, reason: string) => {
    if (!matches.has(row.id)) {
      matches.set(row.id, {
        id: row.id,
        name: displayName(row),
        phone: row.phone,
        email: row.email,
        total_jobs: row.total_jobs ?? 0,
        total_revenue: row.total_revenue ?? 0,
        last_interaction_date: row.last_interaction_date,
        match_reason: reason,
      });
    }
  };

  // (1) phone — compare on digits only so formatting differences still match.
  const phoneDigits = digits(opts.phone);
  if (phoneDigits.length >= 7) {
    const { results } = await env.DB.prepare(
      `${CLIENT_SELECT} WHERE REPLACE(REPLACE(REPLACE(REPLACE(c.phone,'(',''),')',''),'-',''),' ','') LIKE ?`,
    )
      .bind(...ACTIVE_JOB_STATUSES, `%${phoneDigits}%`)
      .all<ClientRow>();
    for (const r of results ?? []) {
      if (digits(r.phone) === phoneDigits) add(r, "phone");
    }
  }

  // (2) email — exact, case-insensitive.
  const email = str(opts.email);
  if (email) {
    const { results } = await env.DB.prepare(
      `${CLIENT_SELECT} WHERE LOWER(c.email) = LOWER(?)`,
    )
      .bind(...ACTIVE_JOB_STATUSES, email)
      .all<ClientRow>();
    for (const r of results ?? []) add(r, "email");
  }

  // (3) last name + property address (matched against all properties).
  const lastName = str(opts.lastName);
  const address = str(opts.address);
  if (lastName && address) {
    const { results } = await env.DB.prepare(
      `${CLIENT_SELECT}
       WHERE LOWER(c.last_name) = LOWER(?)
         AND EXISTS (SELECT 1 FROM properties p WHERE p.client_id = c.id AND LOWER(p.address) LIKE LOWER(?))`,
    )
      .bind(...ACTIVE_JOB_STATUSES, lastName, `%${address}%`)
      .all<ClientRow>();
    for (const r of results ?? []) add(r, "name_and_address");
  }

  return [...matches.values()];
}

// ─── POST /api/clients ────────────────────────────────────────────────────────

export async function handleClientCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const firstName = str(body.first_name);
  const lastName = str(body.last_name);
  const email = str(body.email);
  const phone = str(body.phone);

  if (!firstName || !lastName || !email || !phone) {
    return err(422, "validation_error", "first_name, last_name, email and phone are required");
  }

  // Repeat detection — unless the caller explicitly forces creation.
  const force = body.force === true || new URL(request.url).searchParams.get("force") === "true";
  if (!force) {
    const matches = await findDuplicates(env, {
      phone,
      email,
      lastName,
      address: str(body.address) ?? str(body.mailing_address),
    });
    if (matches.length > 0) {
      return json({ possible_duplicate: true, matches });
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const fullName = `${firstName} ${lastName}`.trim();

  await env.DB.prepare(
    `INSERT INTO clients (
      id, name, company_name, first_name, last_name, email, phone, phone_secondary,
      mailing_address, mailing_city, mailing_state, mailing_zip,
      lead_source, high_level_contact_id, is_repeat_client, review_requested,
      google_review_left, notes, last_interaction_date,
      synced_at, created_at, updated_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      fullName,
      str(body.company_name),
      firstName,
      lastName,
      email,
      phone,
      str(body.phone_secondary),
      str(body.mailing_address),
      str(body.mailing_city),
      str(body.mailing_state),
      str(body.mailing_zip),
      str(body.lead_source),
      str(body.high_level_contact_id),
      str(body.notes),
      now,
      now,
      now,
      now,
      user.email,
    )
    .run();

  await logAudit(env, user.email, "client_created", "client", id, { first_name: firstName, last_name: lastName });

  const created = await env.DB.prepare(`${CLIENT_SELECT} WHERE c.id = ?`)
    .bind(...ACTIVE_JOB_STATUSES, id)
    .first<ClientRow>();
  return json({ client: created ? shapeClient(created) : null }, { status: 201 });
}

// ─── PUT /api/clients/:id ─────────────────────────────────────────────────────

const CLIENT_UPDATABLE = [
  "first_name",
  "last_name",
  "company_name",
  "email",
  "phone",
  "phone_secondary",
  "mailing_address",
  "mailing_city",
  "mailing_state",
  "mailing_zip",
  "lead_source",
  "referral_source_id",
  "high_level_contact_id",
  "notes",
] as const;

const CLIENT_BOOL_FIELDS = ["is_repeat_client", "review_requested", "google_review_left"] as const;

export async function handleClientUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare(
    "SELECT id, first_name, last_name FROM clients WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; first_name: string | null; last_name: string | null }>();
  if (!existing) return err(404, "not_found", "Client not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const col of CLIENT_UPDATABLE) {
    if (col in body) {
      updates.push(`${col} = ?`);
      binds.push(str(body[col]));
    }
  }
  for (const col of CLIENT_BOOL_FIELDS) {
    if (col in body) {
      updates.push(`${col} = ?`);
      binds.push(body[col] === true || body[col] === 1 || body[col] === "1" ? 1 : 0);
    }
  }

  // Keep legacy `name` in sync when first/last change.
  if ("first_name" in body || "last_name" in body) {
    const fn = "first_name" in body ? str(body.first_name) : existing.first_name;
    const ln = "last_name" in body ? str(body.last_name) : existing.last_name;
    updates.push("name = ?");
    binds.push([fn, ln].filter(Boolean).join(" ").trim() || null);
  }

  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  updates.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await env.DB.prepare(`UPDATE clients SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logAudit(env, user.email, "client_updated", "client", id, { fields: Object.keys(body) });

  const updated = await env.DB.prepare(`${CLIENT_SELECT} WHERE c.id = ?`)
    .bind(...ACTIVE_JOB_STATUSES, id)
    .first<ClientRow>();
  return json({ client: updated ? shapeClient(updated) : null });
}

// ─── Properties ───────────────────────────────────────────────────────────────

export async function handlePropertyList(env: Env, clientId: string): Promise<Response> {
  const client = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
  if (!client) return err(404, "not_found", "Client not found");
  const { results } = await env.DB.prepare(
    "SELECT * FROM properties WHERE client_id = ? ORDER BY created_at ASC",
  )
    .bind(clientId)
    .all();
  return json({ properties: results ?? [] });
}

export async function handlePropertyCreate(
  request: Request,
  env: Env,
  clientId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const client = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
  if (!client) return err(404, "not_found", "Client not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const address = str(body.address);
  const city = str(body.city);
  const zip = str(body.zip);
  if (!address || !city || !zip) {
    return err(422, "validation_error", "address, city and zip are required");
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO properties (id, client_id, address, city, state, zip, property_type, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      clientId,
      address,
      city,
      str(body.state) ?? "Arkansas",
      zip,
      str(body.property_type),
      str(body.notes),
    )
    .run();

  await logAudit(env, user.email, "property_created", "property", id, { client_id: clientId, address });

  const row = await env.DB.prepare("SELECT * FROM properties WHERE id = ?").bind(id).first();
  return json({ property: row }, { status: 201 });
}

const PROPERTY_UPDATABLE = ["address", "city", "state", "zip", "property_type", "notes"] as const;

export async function handlePropertyUpdate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare("SELECT id FROM properties WHERE id = ?").bind(id).first();
  if (!existing) return err(404, "not_found", "Property not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];
  for (const col of PROPERTY_UPDATABLE) {
    if (col in body) {
      updates.push(`${col} = ?`);
      // state cannot be nulled (NOT NULL DEFAULT 'Arkansas')
      binds.push(col === "state" ? str(body[col]) ?? "Arkansas" : str(body[col]));
    }
  }
  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");
  binds.push(id);

  await env.DB.prepare(`UPDATE properties SET ${updates.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logAudit(env, user.email, "property_updated", "property", id, { fields: Object.keys(body) });

  const row = await env.DB.prepare("SELECT * FROM properties WHERE id = ?").bind(id).first();
  return json({ property: row });
}

// ─── Communications ─────────────────────────────────────────────────────────

const COMM_CHANNELS = ["phone_call", "text_sms", "email", "portal_message", "in_person", "other"];
const COMM_DIRECTIONS = ["inbound", "outbound"];

export async function handleCommunicationList(env: Env, clientId: string, url: URL): Promise<Response> {
  const client = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
  if (!client) return err(404, "not_found", "Client not found");

  const where = ["client_id = ?"];
  const binds: unknown[] = [clientId];
  const channel = str(url.searchParams.get("channel"));
  const jobId = str(url.searchParams.get("job_id"));
  const from = str(url.searchParams.get("from"));
  const to = str(url.searchParams.get("to"));
  if (channel) {
    where.push("channel = ?");
    binds.push(channel);
  }
  if (jobId) {
    where.push("job_id = ?");
    binds.push(jobId);
  }
  if (from) {
    where.push("created_at >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("created_at <= ?");
    binds.push(to);
  }

  const { results } = await env.DB.prepare(
    `SELECT * FROM communications WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(...binds)
    .all();
  return json({ communications: results ?? [] });
}

// ─── GET /api/jobs/:id/communications ─────────────────────────────────────────
// Job-filtered communication timeline (Sprint 7). Same unified feed as the
// client timeline — auto-logged notifications (sent_via='system_auto'), inbound
// Twilio ('twilio'), and manual entries ('manual') — narrowed to one job.

export async function handleJobCommunicationList(env: Env, jobId: string, url: URL): Promise<Response> {
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first();
  if (!job) return err(404, "not_found", "Job not found");

  const where = ["job_id = ?"];
  const binds: unknown[] = [jobId];
  const channel = str(url.searchParams.get("channel"));
  const from = str(url.searchParams.get("from"));
  const to = str(url.searchParams.get("to"));
  if (channel) {
    where.push("channel = ?");
    binds.push(channel);
  }
  if (from) {
    where.push("created_at >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("created_at <= ?");
    binds.push(to);
  }

  const { results } = await env.DB.prepare(
    `SELECT * FROM communications WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(...binds)
    .all();
  return json({ communications: results ?? [] });
}

export async function handleCommunicationCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const clientId = str(body.client_id);
  const channel = str(body.channel);
  const direction = str(body.direction) ?? "outbound";
  const summary = str(body.summary);

  if (!clientId || !channel || !summary) {
    return err(422, "validation_error", "client_id, channel and summary are required");
  }
  if (!COMM_CHANNELS.includes(channel)) {
    return err(422, "validation_error", `channel must be one of: ${COMM_CHANNELS.join(", ")}`);
  }
  if (!COMM_DIRECTIONS.includes(direction)) {
    return err(422, "validation_error", `direction must be one of: ${COMM_DIRECTIONS.join(", ")}`);
  }

  const client = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
  if (!client) return err(404, "not_found", "Client not found");

  const id = crypto.randomUUID();
  const duration =
    body.duration_seconds == null ? null : Number(body.duration_seconds) || null;

  await env.DB.prepare(
    `INSERT INTO communications (
      id, client_id, job_id, channel, direction, summary, body,
      duration_seconds, sent_via, logged_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      clientId,
      str(body.job_id),
      channel,
      direction,
      summary,
      str(body.body),
      duration,
      str(body.sent_via) ?? "manual",
      user.email,
    )
    .run();

  // Logging a communication counts as an interaction.
  await env.DB.prepare(
    "UPDATE clients SET last_interaction_date = datetime('now') WHERE id = ?",
  )
    .bind(clientId)
    .run();

  await logAudit(env, user.email, "communication_logged", "communication", id, {
    client_id: clientId,
    channel,
  });

  const row = await env.DB.prepare("SELECT * FROM communications WHERE id = ?").bind(id).first();
  return json({ communication: row }, { status: 201 });
}

// ─── DELETE /api/clients/:id ──────────────────────────────────────────────────

export async function handleClientDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const client = await env.DB.prepare(
    `SELECT c.id, c.name, c.first_name, c.last_name, c.email, c.phone,
            (SELECT COUNT(*) FROM jobs j WHERE j.client_id = c.id
               AND j.status NOT IN ('closed', 'cancelled')) AS blocking_jobs
     FROM clients c WHERE c.id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      name: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      phone: string | null;
      blocking_jobs: number;
    }>();
  if (!client) return err(404, "not_found", "Client not found");

  if ((client.blocking_jobs ?? 0) > 0) {
    return json(
      {
        error: "cannot_delete_client_with_active_jobs",
        message: "This client has active jobs. Close or cancel all jobs before deleting the client.",
      },
      { status: 409 },
    );
  }

  const displayName =
    [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || client.name || "(unnamed)";

  const { jobs_removed, estimates_removed } = await cascadeDeleteClient(env, id);

  await logAudit(env, user.email, "client_deleted", "client", id, {
    name: displayName,
    email: client.email,
    phone: client.phone,
    jobs_removed,
    estimates_removed,
  });

  return json({ ok: true, deleted: true, id });
}

// ─── Client Contacts ─────────────────────────────────────────────────────────

export async function handleContactCreate(
  request: Request,
  env: Env,
  clientId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const client = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
  if (!client) return err(404, "not_found", "Client not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const label = str(body.label);
  const contactType = str(body.contact_type);
  const value = str(body.value);

  if (!label || !contactType || !value) {
    return err(422, "validation_error", "label, contact_type and value are required");
  }
  if (!["phone", "email"].includes(contactType)) {
    return err(422, "validation_error", "contact_type must be phone or email");
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO client_contacts (id, client_id, label, contact_type, value) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, clientId, label, contactType, value)
    .run();

  await logAudit(env, user.email, "contact_created", "client_contact", id, { client_id: clientId, label });

  const row = await env.DB.prepare("SELECT * FROM client_contacts WHERE id = ?").bind(id).first();
  return json({ contact: row }, { status: 201 });
}

export async function handleContactDelete(
  request: Request,
  env: Env,
  contactId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare("SELECT id, client_id FROM client_contacts WHERE id = ?")
    .bind(contactId)
    .first<{ id: string; client_id: string }>();
  if (!existing) return err(404, "not_found", "Contact not found");

  await env.DB.prepare("DELETE FROM client_contacts WHERE id = ?").bind(contactId).run();
  await logAudit(env, user.email, "contact_deleted", "client_contact", contactId, {
    client_id: existing.client_id,
  });

  return json({ ok: true });
}

// ─── Client Tags ─────────────────────────────────────────────────────────────

export async function handleTagAssign(
  request: Request,
  env: Env,
  clientId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const client = await env.DB.prepare("SELECT id FROM clients WHERE id = ?").bind(clientId).first();
  if (!client) return err(404, "not_found", "Client not found");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  let tagId = str(body.tag_definition_id);

  // Inline creation: if tag_text is supplied instead of tag_definition_id, create the tag.
  if (!tagId) {
    const tagText = str(body.tag_text);
    if (!tagText) return err(422, "validation_error", "tag_definition_id or tag_text is required");

    const existing = await env.DB.prepare(
      "SELECT id FROM tag_definitions WHERE LOWER(tag_text) = LOWER(?)",
    )
      .bind(tagText)
      .first<{ id: string }>();

    if (existing) {
      tagId = existing.id;
    } else {
      tagId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO tag_definitions (id, tag_text) VALUES (?, ?)")
        .bind(tagId, tagText)
        .run();
    }
  }

  // Upsert — silently ignore if already assigned.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO client_tags (client_id, tag_definition_id) VALUES (?, ?)",
  )
    .bind(clientId, tagId)
    .run();

  const tag = await env.DB.prepare("SELECT * FROM tag_definitions WHERE id = ?")
    .bind(tagId)
    .first();
  return json({ tag }, { status: 201 });
}

export async function handleTagRemove(
  request: Request,
  env: Env,
  clientId: string,
  tagId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  await env.DB.prepare(
    "DELETE FROM client_tags WHERE client_id = ? AND tag_definition_id = ?",
  )
    .bind(clientId, tagId)
    .run();

  return json({ ok: true });
}
