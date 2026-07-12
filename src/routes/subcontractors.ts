/**
 * Subcontractor module API (CHS-API-Route-Map §12).
 *
 *   GET    /api/subcontractors        list + filters (?trade=&search=&active=1)
 *   GET    /api/subcontractors/:id    detail
 *   POST   /api/subcontractors        create
 *   PUT    /api/subcontractors/:id    update
 *
 * Schema note: the live `subcontractors` table carries BOTH the legacy chs-hub
 * columns (company, primary_contact, insurance_verified, active_status — driven
 * by the existing /api/subs dashboard) and the Sprint-1 canonical columns
 * (company_name, contact_name, insurance_on_file, w9_on_file, is_active). To
 * keep both surfaces coherent we COALESCE on read and dual-write both sets on
 * create/update. Existing records are preserved and never wiped.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const WRITE_ROLES = ["owner", "project_manager"] as const;

const TRADES = [
  "electrical", "plumbing", "hvac", "concrete", "roofing", "drywall", "painting",
  "flooring", "cabinetry", "tile", "stone", "insulation", "framing", "general",
];

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function bool(v: unknown): number {
  return v === true || v === 1 || v === "1" || v === "yes" || v === "Yes" ? 1 : 0;
}

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, "subcontractor", entityId, JSON.stringify(details))
    .run();
}

interface RawSub {
  id: string;
  created_at: string | null;
  updated_at: string | null;
  company: string | null;
  company_name: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  trade: string | null;
  phone: string | null;
  email: string | null;
  license_number: string | null;
  insurance_verified: number | null;
  insurance_on_file: number | null;
  w9_on_file: number | null;
  hourly_rate: number | null;
  flat_rate_notes: string | null;
  rating: number | null;
  notes: string | null;
  is_active: number | null;
  active_status: string | null;
  tax_id: string | null;
  coi_expiration_date: string | null;
  license_expiration_date: string | null;
}

/** Normalize a raw row (legacy + canonical columns) into the canonical shape. */
function shape(row: RawSub) {
  const isActive =
    row.is_active != null ? row.is_active === 1 : row.active_status !== "Inactive";
  const insurance = (row.insurance_on_file ?? 0) === 1 || (row.insurance_verified ?? 0) === 1;
  return {
    id: row.id,
    company_name: row.company_name ?? row.company,
    contact_name: row.contact_name ?? row.primary_contact,
    trade: row.trade,
    phone: row.phone,
    email: row.email,
    license_number: row.license_number,
    insurance_on_file: insurance,
    w9_on_file: (row.w9_on_file ?? 0) === 1,
    hourly_rate: row.hourly_rate,
    flat_rate_notes: row.flat_rate_notes,
    rating: row.rating,
    notes: row.notes,
    is_active: isActive,
    tax_id: row.tax_id,
    coi_expiration_date: row.coi_expiration_date ?? null,
    license_expiration_date: row.license_expiration_date ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── GET /api/subcontractors ──────────────────────────────────────────────────

export async function handleSubcontractorList(env: Env, url: URL): Promise<Response> {
  const trade = str(url.searchParams.get("trade"));
  const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
  const activeParam = url.searchParams.get("active");

  const { results } = await env.DB.prepare(
    "SELECT * FROM subcontractors ORDER BY COALESCE(company_name, company) COLLATE NOCASE ASC",
  ).all<RawSub>();
  let subs = (results ?? []).map(shape);

  if (trade) subs = subs.filter((s) => (s.trade ?? "").toLowerCase() === trade.toLowerCase());
  if (activeParam === "1") subs = subs.filter((s) => s.is_active);
  else if (activeParam === "0") subs = subs.filter((s) => !s.is_active);
  if (search) {
    subs = subs.filter((s) => {
      const hay = [s.company_name, s.contact_name, s.trade, s.phone, s.email, s.notes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(search);
    });
  }

  // Distinct trades present, for the filter dropdown.
  const trades = [...new Set(subs.map((s) => s.trade).filter(Boolean) as string[])].sort();

  return json({ as_of: new Date().toISOString(), total: subs.length, trades, subcontractors: subs });
}

// ─── GET /api/subcontractors/:id ──────────────────────────────────────────────

export async function handleSubcontractorGet(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM subcontractors WHERE id = ?")
    .bind(id)
    .first<RawSub>();
  if (!row) return err(404, "not_found", "Subcontractor not found");

  const payments = await loadSubPayments(env, id);
  return json({ subcontractor: shape(row), payments });
}

/**
 * Payment history for a sub, sourced from the `expenses` ledger (rows tagged with
 * sub_id). Amounts are stored positive; we ignore voided (is_active=0) rows. The
 * effective date is incurred_date, falling back to the legacy incurred_at. We
 * surface YTD + 1099 YTD + lifetime, a per-year breakdown ("paid for the year"),
 * and a recent line-item history joined to the job for context.
 */
async function loadSubPayments(env: Env, subId: string) {
  const dateExpr = "substr(COALESCE(incurred_date, incurred_at), 1, 4)";
  const year = String(new Date().getUTCFullYear());

  const totals = await env.DB.prepare(
    `SELECT
        COALESCE(SUM(amount), 0) AS lifetime,
        COALESCE(SUM(CASE WHEN ${dateExpr} = ? THEN amount ELSE 0 END), 0) AS ytd,
        COALESCE(SUM(CASE WHEN is_1099_reportable = 1 AND ${dateExpr} = ? THEN amount ELSE 0 END), 0) AS ytd_1099,
        COUNT(*) AS count
       FROM expenses
      WHERE sub_id = ? AND COALESCE(is_active, 1) = 1`,
  )
    .bind(year, year, subId)
    .first<{ lifetime: number; ytd: number; ytd_1099: number; count: number }>();

  const byYear = (
    await env.DB.prepare(
      `SELECT ${dateExpr} AS year,
              COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(CASE WHEN is_1099_reportable = 1 THEN amount ELSE 0 END), 0) AS total_1099,
              COUNT(*) AS count
         FROM expenses
        WHERE sub_id = ? AND COALESCE(is_active, 1) = 1 AND ${dateExpr} IS NOT NULL
        GROUP BY year
        ORDER BY year DESC`,
    )
      .bind(subId)
      .all<{ year: string; total: number; total_1099: number; count: number }>()
  ).results ?? [];

  const history = (
    await env.DB.prepare(
      `SELECT e.id, e.amount, COALESCE(e.incurred_date, e.incurred_at) AS date,
              e.description, e.expense_type, e.is_1099_reportable,
              e.job_id, j.job_number AS job_number, j.title AS job_title
         FROM expenses e
         LEFT JOIN jobs j ON j.id = e.job_id
        WHERE e.sub_id = ? AND COALESCE(e.is_active, 1) = 1
        ORDER BY COALESCE(e.incurred_date, e.incurred_at) DESC
        LIMIT 50`,
    )
      .bind(subId)
      .all<{
        id: string;
        amount: number | null;
        date: string | null;
        description: string | null;
        expense_type: string | null;
        is_1099_reportable: number | null;
        job_id: string | null;
        job_number: number | null;
        job_title: string | null;
      }>()
  ).results ?? [];

  return {
    year: Number(year),
    ytd: round2(totals?.ytd ?? 0),
    ytd_1099: round2(totals?.ytd_1099 ?? 0),
    lifetime: round2(totals?.lifetime ?? 0),
    count: totals?.count ?? 0,
    by_year: byYear.map((r) => ({
      year: r.year,
      total: round2(r.total),
      total_1099: round2(r.total_1099),
      count: r.count,
    })),
    history: history.map((h) => ({
      id: h.id,
      amount: round2(h.amount ?? 0),
      date: h.date,
      description: h.description,
      expense_type: h.expense_type,
      is_1099_reportable: Boolean(h.is_1099_reportable),
      job_id: h.job_id,
      job_number: h.job_number,
      job_title: h.job_title,
    })),
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ─── POST /api/subcontractors ─────────────────────────────────────────────────

export async function handleSubcontractorCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const companyName = str(body.company_name) ?? str(body.company);
  const trade = str(body.trade);
  if (!companyName || !trade) {
    return err(422, "validation_error", "company_name and trade are required");
  }
  if (!TRADES.includes(trade.toLowerCase())) {
    return err(422, "validation_error", `trade must be one of: ${TRADES.join(", ")}`);
  }

  const contactName = str(body.contact_name) ?? str(body.primary_contact);
  const insurance = bool(body.insurance_on_file);
  const isActive = body.is_active == null ? 1 : bool(body.is_active);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Dual-write: canonical columns + legacy mirror so /api/subs stays coherent.
  await env.DB.prepare(
    `INSERT INTO subcontractors (
      id, created_at, updated_at,
      company_name, contact_name, trade, phone, email, license_number,
      insurance_on_file, w9_on_file, hourly_rate, flat_rate_notes, rating, notes, is_active, tax_id,
      company, primary_contact, insurance_verified, active_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      now,
      now,
      companyName,
      contactName,
      trade,
      str(body.phone),
      str(body.email),
      str(body.license_number),
      insurance,
      bool(body.w9_on_file),
      body.hourly_rate == null ? null : Number(body.hourly_rate) || null,
      str(body.flat_rate_notes),
      body.rating == null ? null : Math.max(1, Math.min(5, Math.round(Number(body.rating)))) || null,
      str(body.notes),
      isActive,
      str(body.tax_id),
      companyName,
      contactName,
      insurance,
      isActive === 1 ? "Active" : "Inactive",
    )
    .run();

  await logAudit(env, user.email, "subcontractor_created", id, { company_name: companyName, trade });

  const row = await env.DB.prepare("SELECT * FROM subcontractors WHERE id = ?").bind(id).first<RawSub>();
  return json({ subcontractor: row ? shape(row) : null }, { status: 201 });
}

// ─── PUT /api/subcontractors/:id ──────────────────────────────────────────────

export async function handleSubcontractorUpdate(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await env.DB.prepare("SELECT id FROM subcontractors WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return err(404, "not_found", "Subcontractor not found");

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const updates: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, val: unknown) => {
    updates.push(`${col} = ?`);
    binds.push(val);
  };

  if ("company_name" in body || "company" in body) {
    const v = str(body.company_name) ?? str(body.company);
    set("company_name", v);
    set("company", v); // legacy mirror
  }
  if ("contact_name" in body || "primary_contact" in body) {
    const v = str(body.contact_name) ?? str(body.primary_contact);
    set("contact_name", v);
    set("primary_contact", v); // legacy mirror
  }
  if ("trade" in body) {
    const t = str(body.trade);
    if (t && !TRADES.includes(t.toLowerCase())) {
      return err(422, "validation_error", `trade must be one of: ${TRADES.join(", ")}`);
    }
    set("trade", t);
  }
  if ("phone" in body) set("phone", str(body.phone));
  if ("email" in body) set("email", str(body.email));
  if ("license_number" in body) set("license_number", str(body.license_number));
  if ("insurance_on_file" in body) {
    const v = bool(body.insurance_on_file);
    set("insurance_on_file", v);
    set("insurance_verified", v); // legacy mirror
  }
  if ("w9_on_file" in body) set("w9_on_file", bool(body.w9_on_file));
  if ("hourly_rate" in body) {
    set("hourly_rate", body.hourly_rate == null ? null : Number(body.hourly_rate) || null);
  }
  if ("flat_rate_notes" in body) set("flat_rate_notes", str(body.flat_rate_notes));
  if ("rating" in body) {
    set(
      "rating",
      body.rating == null ? null : Math.max(1, Math.min(5, Math.round(Number(body.rating)))) || null,
    );
  }
  if ("notes" in body) set("notes", str(body.notes));
  if ("tax_id" in body) set("tax_id", str(body.tax_id));
  if ("coi_expiration_date" in body) set("coi_expiration_date", str(body.coi_expiration_date));
  if ("license_expiration_date" in body) set("license_expiration_date", str(body.license_expiration_date));
  if ("is_active" in body) {
    const v = bool(body.is_active);
    set("is_active", v);
    set("active_status", v === 1 ? "Active" : "Inactive"); // legacy mirror
  }

  if (updates.length === 0) return err(400, "bad_request", "No updatable fields supplied");

  set("updated_at", new Date().toISOString());
  binds.push(id);

  await env.DB.prepare(`UPDATE subcontractors SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  await logAudit(env, user.email, "subcontractor_updated", id, { fields: Object.keys(body) });

  const row = await env.DB.prepare("SELECT * FROM subcontractors WHERE id = ?").bind(id).first<RawSub>();
  return json({ subcontractor: row ? shape(row) : null });
}

// ── POST /api/subcontractors/:id/test-compliance-check (owner-only) ───────────
/**
 * Manual compliance check for a single sub. Owner-only spot-check.
 * Fires for any expiration within 31 days, bypassing the real cron's narrow
 * threshold window — use this to confirm the send path works, not to verify
 * threshold timing (that's handled by the real nightly cron).
 *
 * Uses test-specific dedupe keys (prefix "test:") so real cron alerts are
 * never blocked by manual test runs.
 *
 * Sends both in-app bell AND a direct email to ALERT_EMAIL_TO.
 * Note: the real nightly cron is in-app only — the email here is bonus
 * visibility for manual testing. See CHS-Task-Manual-SubCompliance-Trigger.
 */

import { createOwnerInApp, sendSubEmail } from "../lib/notification-engine.js";

function _daysUntil(isoDate: string): number {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const exp = new Date(`${isoDate}T00:00:00Z`);
  return Math.round((exp.getTime() - today.getTime()) / 86_400_000);
}

function _fmtDate(iso: string): string {
  try {
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  } catch { return iso; }
}

export async function handleTestComplianceCheck(
  request: Request,
  env: Env,
  subId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner"]);
  if (authed instanceof Response) return authed;

  const sub = await env.DB.prepare(
    `SELECT id, company_name, company, coi_expiration_date, license_expiration_date, is_active
       FROM subcontractors WHERE id = ?`,
  ).bind(subId).first<{
    id: string;
    company_name: string | null;
    company: string | null;
    coi_expiration_date: string | null;
    license_expiration_date: string | null;
    is_active: number;
  }>();
  if (!sub) return new Response(JSON.stringify({ error: "subcontractor_not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });

  const subName = (sub.company_name ?? sub.company ?? `Sub ${sub.id.slice(0, 8)}`).trim();
  const fields: Array<{ field: "coi" | "license"; date: string }> = [];
  if (sub.coi_expiration_date) fields.push({ field: "coi", date: sub.coi_expiration_date });
  if (sub.license_expiration_date) fields.push({ field: "license", date: sub.license_expiration_date });

  const nearTerm = fields.filter(({ date }) => _daysUntil(date) <= 31);

  if (nearTerm.length === 0) {
    return new Response(JSON.stringify({
      ok: true,
      alerted: false,
      reason: "no_expirations_within_31_days",
      sub: subName,
      fields: fields.map(({ field, date }) => ({
        field,
        expiration_date: date,
        days_until: _daysUntil(date),
      })),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://app.homesolutionsar.com").replace(/\/$/, "");
  const alerts: string[] = [];

  for (const { field, date } of nearTerm) {
    const days = _daysUntil(date);
    const fieldLabel = field === "coi" ? "COI" : "License";
    const daysLabel = days <= 0 ? "TODAY" : `in ${days} day${days === 1 ? "" : "s"}`;
    const msg = `Sub compliance: ${fieldLabel} for ${subName} expires ${daysLabel} (${_fmtDate(date)}).`;
    alerts.push(msg);

    // In-app alert (test-prefixed dedupe so real cron alerts are unaffected)
    await createOwnerInApp(env, {
      message: msg,
      linkPath: `/subcontractors/${sub.id}`,
      dedupe: `test:sub_${field}_expiring:${sub.id}:${date}`,
    });
  }

  // Direct email to owner (bonus for test visibility — real cron is in-app only)
  const emailTo = (env.ALERT_EMAIL_TO ?? "").trim();
  if (emailTo) {
    const emailBody =
      `Compliance check for ${subName}:\n\n` +
      alerts.join("\n") +
      `\n\nView sub: ${origin}/subcontractors/${sub.id}`;
    await sendSubEmail(env, emailTo, `Compliance Alert: ${subName}`, emailBody);
  }

  return new Response(JSON.stringify({
    ok: true,
    alerted: true,
    sub: subName,
    alerts,
    sent_to: emailTo || null,
    fields: nearTerm.map(({ field, date }) => ({
      field,
      expiration_date: date,
      days_until: _daysUntil(date),
    })),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
