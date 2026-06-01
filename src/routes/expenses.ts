/**
 * Expense capture endpoints — third leg of the CHS Capture PWA, alongside
 * /api/photos and /api/notes.
 *
 *   POST /api/expenses              — multipart upload (optional receipt + JSON metadata)
 *   GET  /api/expenses              — list with filters (?job_id=, ?since=, ?limit=)
 *   GET  /api/expenses/:id/receipt  — stream receipt image from R2 (404 if no receipt)
 *
 * Auth model identical to /api/photos: Cloudflare Access gates the
 * dashboard host, and we attribute uploads via the
 * Cf-Access-Authenticated-User-Email header. Bare *.workers.dev requests
 * bypass Access so curl smoke tests still work; uploaded_by stays NULL
 * in that case.
 *
 * R2 layout for receipts:
 *   expenses/{job_id|"general"}/{YYYY-MM-DD}/{uuid}.jpg
 *
 * Jobber write-back is intentionally NOT implemented yet. Rows created
 * here have entered_via='pwa' and pushed_to_jobber_at=NULL. The dashboard
 * surfaces both flags so it's obvious which expenses still need to be
 * reconciled in Jobber. A follow-up session will add the GraphQL mutation
 * and a /api/expenses/:id/push-to-jobber endpoint.
 */

import type { Env } from "../env.js";
import { pushExpenseToJobber } from "../lib/jobber/expenses.js";
import { guard } from "../middleware/guard.js";
import { upsertVendorMaterial } from "./vendor-materials.js";

// Sprint 10 role map (route map): create allows FC; edit/void is O/PM/OA.
const EXPENSE_CREATE_ROLES = ["owner", "project_manager", "office_admin", "field_crew"] as const;
const EXPENSE_EDIT_ROLES = ["owner", "project_manager", "office_admin"] as const;

interface ExpenseRow {
  id: string;
  job_id: string | null;
  amount: number | null;
  description: string | null;
  incurred_at: string | null;
  vendor: string | null;
  receipt_r2_key: string | null;
  entered_via: string;
  pushed_to_jobber_at: string | null;
  jobber_id: string | null;
}

interface ExpenseOut extends ExpenseRow {
  receipt_url: string | null;
}

// ── Full expense shape (Sprint 10) ─────────────────────────────────────────
interface FullExpenseRow {
  id: string;
  job_id: string | null;
  amount: number | null;
  description: string | null;
  incurred_date: string | null;
  incurred_at: string | null;
  vendor: string | null;
  expense_type: string | null;
  estimate_line_item_id: string | null;
  tax_category: string | null;
  is_1099_reportable: number | null;
  sub_id: string | null;
  receipt_photo_id: string | null;
  receipt_r2_key: string | null;
  entered_via: string;
  is_active: number | null;
  pushed_to_qbo: number | null;
  created_at: string | null;
  created_by: string | null;
}

export interface FullExpenseInput {
  job_id: string | null;
  expense_type: string | null;
  vendor: string | null;
  description: string | null;
  amount: number;
  incurred_date: string;
  estimate_line_item_id: string | null;
  tax_category: string | null;
  sub_id: string | null;
  is_1099_reportable: boolean;
  receipt_photo_id: string | null;
  receipt_r2_key: string | null;
  entered_via: string;
  created_by: string | null;
  save_to_price_book?: boolean;
  material_name?: string | null;
  material_unit?: string | null;
}

/**
 * Shared full-expense insert used by the expense form, the receipt-confirm seam
 * and the smart-note accept-expense seam, so all three land the SAME complete
 * row (alignment + tax category + sub/1099) rather than a minimal stub.
 * `synced_at` + `incurred_at` are legacy NOT NULL — mirror created_at /
 * incurred_date so the constraints hold. Native-only: pushed_to_qbo=0, no
 * Jobber write-back.
 */
export async function insertFullExpense(env: Env, input: FullExpenseInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO expenses
       (id, job_id, amount, description, incurred_at, incurred_date, synced_at, vendor,
        expense_type, estimate_line_item_id, tax_category, is_1099_reportable, sub_id,
        receipt_photo_id, receipt_r2_key, entered_via, is_active, pushed_to_qbo, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
    .bind(
      id,
      input.job_id,
      input.amount,
      input.description,
      input.incurred_date,
      input.incurred_date,
      now,
      input.vendor,
      input.expense_type,
      input.estimate_line_item_id,
      input.tax_category,
      input.is_1099_reportable ? 1 : 0,
      input.sub_id,
      input.receipt_photo_id,
      input.receipt_r2_key,
      input.entered_via,
      now,
      input.created_by,
    )
    .run();

  // Vendor-material price-book upsert — gated behind the explicit affordance
  // (Open Question 3): material type + vendor + explicit material_name + unit.
  if (
    input.save_to_price_book &&
    input.expense_type === "material" &&
    input.vendor &&
    input.material_name &&
    input.material_unit
  ) {
    await upsertVendorMaterial(env, {
      vendor: input.vendor,
      materialName: input.material_name,
      unit: input.material_unit,
      category: "material",
      price: input.amount,
      date: input.incurred_date,
      expenseId: id,
    });
  }

  return id;
}

function hydrateFull(r: FullExpenseRow) {
  return {
    id: r.id,
    job_id: r.job_id,
    amount: r.amount,
    description: r.description,
    incurred_date: r.incurred_date ?? r.incurred_at,
    vendor: r.vendor,
    expense_type: r.expense_type,
    estimate_line_item_id: r.estimate_line_item_id,
    tax_category: r.tax_category,
    is_1099_reportable: Boolean(r.is_1099_reportable),
    sub_id: r.sub_id,
    receipt_photo_id: r.receipt_photo_id,
    receipt_url: r.receipt_r2_key ? `/api/expenses/${r.id}/receipt` : null,
    has_receipt: Boolean(r.receipt_r2_key || r.receipt_photo_id),
    entered_via: r.entered_via,
    is_active: r.is_active == null ? true : Boolean(r.is_active),
    created_at: r.created_at,
    created_by: r.created_by,
  };
}

const FULL_EXPENSE_SELECT = `id, job_id, amount, description, incurred_date, incurred_at, vendor,
  expense_type, estimate_line_item_id, tax_category, is_1099_reportable, sub_id,
  receipt_photo_id, receipt_r2_key, entered_via, is_active, pushed_to_qbo, created_at, created_by`;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

function jsonErr(status: number, code: string, message?: string): Response {
  return jsonResponse({ error: code, message: message ?? code }, { status });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function dateBucket(incurredAt: string | null): string {
  const d = incurredAt ? new Date(incurredAt) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// FormData.get() is under-narrowed to `string | null` in workers-types;
// the runtime can return Blob/File for file inputs. Cast through unknown.
function getEntry(form: FormData, name: string): Blob | string | null {
  return form.get(name) as unknown as Blob | string | null;
}

function hydrateExpense(row: ExpenseRow): ExpenseOut {
  return {
    ...row,
    receipt_url: row.receipt_r2_key ? `/api/expenses/${row.id}/receipt` : null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// POST /api/expenses
// ────────────────────────────────────────────────────────────────────────
//
// Body: multipart/form-data with fields:
//   metadata  (string, JSON)  — required. Shape:
//     {
//       job_id?: string|null,    // null/missing → "general" bucket
//       amount: number,          // required, positive
//       vendor?: string,
//       description?: string,
//       incurred_at?: string     // ISO; defaults to now
//     }
//   receipt  (Blob, optional)   — JPEG/HEIC/etc. Skipped → no R2 write,
//                                 receipt_r2_key stays NULL.
//
// Returns: { expense: { id, receipt_url } }

export async function handleExpenseCreate(
  env: Env,
  request: Request,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonErr(400, "invalid_form_data");
  }

  const metadataRaw = getEntry(form, "metadata");
  if (typeof metadataRaw !== "string") return jsonErr(400, "metadata_required");

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "metadata_not_json");
  }

  const amount = Number(metadata.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonErr(400, "amount_required", "amount must be a positive number");
  }

  const jobId =
    typeof metadata.job_id === "string" && metadata.job_id.trim()
      ? metadata.job_id.trim()
      : null;
  const vendor =
    typeof metadata.vendor === "string" ? metadata.vendor.trim() || null : null;
  const description =
    typeof metadata.description === "string"
      ? metadata.description.trim() || null
      : null;
  const incurredAt =
    typeof metadata.incurred_at === "string" && metadata.incurred_at
      ? metadata.incurred_at
      : new Date().toISOString();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Optional receipt
  const receipt = getEntry(form, "receipt");
  let receiptKey: string | null = null;
  if (receipt instanceof Blob) {
    const bucket = dateBucket(incurredAt);
    const slug = jobId ?? "general";
    receiptKey = `expenses/${slug}/${bucket}/${id}.jpg`;
    const bytes = await receipt.arrayBuffer();
    await env.FILES.put(receiptKey, bytes, {
      httpMetadata: { contentType: receipt.type || "image/jpeg" },
    });
  }

  // synced_at on the existing row is NOT NULL (legacy, set by Jobber sync).
  // For PWA-created rows we record the same value as created_at so the
  // column constraint is satisfied; the new entered_via/pushed_to_jobber_at
  // fields are what we actually inspect for sync state.
  await env.DB.prepare(
    `INSERT INTO expenses
       (id, job_id, amount, description, incurred_at, synced_at,
        vendor, receipt_r2_key, entered_via, pushed_to_jobber_at, jobber_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pwa', NULL, NULL)`,
  )
    .bind(id, jobId, amount, description, incurredAt, now, vendor, receiptKey)
    .run();

  // Best-effort Jobber write-back. We deliberately await so the success
  // result can flow back in the response — the PWA waits anyway because
  // it needs to dismiss the form. If Jobber is down, the row stays in
  // D1 with the PENDING JOBBER badge and the dashboard's retry button
  // can flush it later. The push helper itself never throws — it
  // converts errors into a result object.
  const push = await pushExpenseToJobber(env, id);

  return jsonResponse({
    expense: {
      id,
      receipt_url: receiptKey ? `/api/expenses/${id}/receipt` : null,
      jobber_pushed: push.ok,
      jobber_id: push.jobber_id ?? null,
      jobber_error: push.ok ? null : push.error ?? null,
    },
  });
}

// ────────────────────────────────────────────────────────────────────────
// POST /api/expenses  (JSON — full Sprint 10 expense form). O/PM/OA/FC.
// ────────────────────────────────────────────────────────────────────────

export async function handleExpenseCreateJson(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...EXPENSE_CREATE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonErr(400, "amount_required", "amount must be a positive number");
  }
  const jobId = strv(body.job_id);
  if (jobId) {
    const ok = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
    if (!ok) return jsonErr(400, "unknown_job");
  }
  const expenseType = strv(body.expense_type) ?? "material";
  const subId = expenseType === "subcontractor" ? strv(body.sub_id) : null;
  const is1099 = expenseType === "subcontractor" && Boolean(body.is_1099_reportable);
  const enteredVia = strv(body.entered_via) ?? "web";

  const id = await insertFullExpense(env, {
    job_id: jobId,
    expense_type: expenseType,
    vendor: strv(body.vendor),
    description: strv(body.description),
    amount,
    incurred_date: strv(body.incurred_date) ?? new Date().toISOString().slice(0, 10),
    estimate_line_item_id: strv(body.estimate_line_item_id),
    tax_category: strv(body.tax_category),
    sub_id: subId,
    is_1099_reportable: is1099,
    receipt_photo_id: strv(body.receipt_photo_id),
    receipt_r2_key: strv(body.receipt_r2_key),
    entered_via: enteredVia,
    created_by: user.email,
    save_to_price_book: Boolean(body.save_to_price_book),
    material_name: strv(body.material_name),
    material_unit: strv(body.material_unit),
  });

  const row = await env.DB.prepare(`SELECT ${FULL_EXPENSE_SELECT} FROM expenses WHERE id = ?`)
    .bind(id)
    .first<FullExpenseRow>();
  return jsonResponse({ expense: row ? hydrateFull(row) : { id } }, { status: 201 });
}

// ────────────────────────────────────────────────────────────────────────
// PUT /api/expenses/:id  (edit / correct / void). O/PM/OA.
// ────────────────────────────────────────────────────────────────────────
//
// Voiding sets is_active=0: the row + receipt linkage are PRESERVED (rule #8)
// and excluded from costing/profit (rule #13). Never hard-delete.

export async function handleExpenseUpdate(env: Env, request: Request, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...EXPENSE_EDIT_ROLES]);
  if (guarded instanceof Response) return guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }
  const row = await env.DB.prepare(`SELECT ${FULL_EXPENSE_SELECT} FROM expenses WHERE id = ?`)
    .bind(id)
    .first<FullExpenseRow>();
  if (!row) return jsonErr(404, "expense_not_found");

  // Void / restore.
  if (body.action === "void" || body.is_active === 0 || body.is_active === false) {
    await env.DB.prepare("UPDATE expenses SET is_active = 0 WHERE id = ?").bind(id).run();
    const voided = await env.DB.prepare(`SELECT ${FULL_EXPENSE_SELECT} FROM expenses WHERE id = ?`)
      .bind(id)
      .first<FullExpenseRow>();
    return jsonResponse({ expense: voided ? hydrateFull(voided) : null, voided: true });
  }
  if (body.action === "restore" || body.is_active === 1 || body.is_active === true) {
    await env.DB.prepare("UPDATE expenses SET is_active = 1 WHERE id = ?").bind(id).run();
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("amount" in body) {
    const a = Number(body.amount);
    if (!Number.isFinite(a) || a <= 0) return jsonErr(400, "amount_required");
    sets.push("amount = ?");
    binds.push(a);
  }
  for (const [k, col] of [
    ["vendor", "vendor"],
    ["description", "description"],
    ["expense_type", "expense_type"],
    ["incurred_date", "incurred_date"],
    ["estimate_line_item_id", "estimate_line_item_id"],
    ["tax_category", "tax_category"],
    ["sub_id", "sub_id"],
  ] as const) {
    if (k in body) {
      sets.push(`${col} = ?`);
      binds.push(strv(body[k]));
    }
  }
  if ("is_1099_reportable" in body) {
    sets.push("is_1099_reportable = ?");
    binds.push(body.is_1099_reportable ? 1 : 0);
  }
  if (sets.length === 0) {
    const cur = await env.DB.prepare(`SELECT ${FULL_EXPENSE_SELECT} FROM expenses WHERE id = ?`)
      .bind(id)
      .first<FullExpenseRow>();
    return jsonResponse({ expense: cur ? hydrateFull(cur) : null });
  }
  binds.push(id);
  await env.DB.prepare(`UPDATE expenses SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();

  // Re-run the price-book upsert (idempotent) when asked.
  if (body.save_to_price_book) {
    const updated = await env.DB.prepare(`SELECT ${FULL_EXPENSE_SELECT} FROM expenses WHERE id = ?`)
      .bind(id)
      .first<FullExpenseRow>();
    const mName = strv(body.material_name);
    const mUnit = strv(body.material_unit);
    if (updated && updated.expense_type === "material" && updated.vendor && mName && mUnit) {
      await upsertVendorMaterial(env, {
        vendor: updated.vendor,
        materialName: mName,
        unit: mUnit,
        category: "material",
        price: Number(updated.amount) || 0,
        date: updated.incurred_date ?? new Date().toISOString().slice(0, 10),
        expenseId: id,
      });
    }
  }

  const out = await env.DB.prepare(`SELECT ${FULL_EXPENSE_SELECT} FROM expenses WHERE id = ?`)
    .bind(id)
    .first<FullExpenseRow>();
  return jsonResponse({ expense: out ? hydrateFull(out) : null });
}

// ────────────────────────────────────────────────────────────────────────
// GET /api/expenses  (Sprint 10 full shape + filters). Excludes voided.
// ?job_id=&type=&vendor=&from=&to=&include_voided=1
// ────────────────────────────────────────────────────────────────────────

export async function handleFullExpenseList(env: Env, url: URL): Promise<Response> {
  return jsonResponse(await listExpenses(env, url, null));
}

export async function handleJobExpenses(env: Env, jobId: string, url: URL): Promise<Response> {
  return jsonResponse(await listExpenses(env, url, jobId));
}

async function listExpenses(env: Env, url: URL, forceJobId: string | null) {
  const jobIdParam = forceJobId ?? (url.searchParams.get("job_id") ?? "").trim();
  const type = (url.searchParams.get("type") ?? "").trim();
  const vendor = (url.searchParams.get("vendor") ?? "").trim();
  const from = (url.searchParams.get("from") ?? "").trim();
  const to = (url.searchParams.get("to") ?? "").trim();
  const includeVoided = url.searchParams.get("include_voided") === "1";

  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (!includeVoided) where.push("COALESCE(is_active, 1) = 1");
  if (jobIdParam === "general") {
    where.push("job_id IS NULL");
  } else if (jobIdParam) {
    where.push("job_id = ?");
    binds.push(jobIdParam);
  }
  if (type) {
    where.push("expense_type = ?");
    binds.push(type);
  }
  if (vendor) {
    where.push("vendor LIKE ?");
    binds.push(`%${vendor}%`);
  }
  if (from) {
    where.push("COALESCE(incurred_date, incurred_at) >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("COALESCE(incurred_date, incurred_at) <= ?");
    binds.push(to);
  }
  const sql =
    `SELECT ${FULL_EXPENSE_SELECT} FROM expenses` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY COALESCE(incurred_date, incurred_at) DESC LIMIT 500";
  const rows = (await env.DB.prepare(sql).bind(...binds).all<FullExpenseRow>()).results ?? [];
  const expenses = rows.map(hydrateFull);
  const total_amount = expenses
    .filter((e) => e.is_active)
    .reduce((a, e) => a + (e.amount ?? 0), 0);
  return {
    job_id: jobIdParam || null,
    total: expenses.length,
    total_amount: Math.round((total_amount + Number.EPSILON) * 100) / 100,
    expenses,
  };
}

function strv(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// ────────────────────────────────────────────────────────────────────────
// POST /api/expenses/:id/push-to-jobber
// ────────────────────────────────────────────────────────────────────────
//
// Manual retry of the Jobber write-back. Used by the dashboard's
// "Retry Jobber sync" button next to the PENDING JOBBER badge. Idempotent:
// if the row is already pushed we just return the existing jobber_id.

export async function handleExpensePush(
  env: Env,
  expenseId: string,
): Promise<Response> {
  const result = await pushExpenseToJobber(env, expenseId);
  return jsonResponse(result, { status: result.ok ? 200 : 502 });
}

// ────────────────────────────────────────────────────────────────────────
// GET /api/expenses?job_id=&since=&limit=
// ────────────────────────────────────────────────────────────────────────

export async function handleExpenseList(env: Env, url: URL): Promise<Response> {
  const jobIdParam = (url.searchParams.get("job_id") ?? "").trim();
  const since = (url.searchParams.get("since") ?? "").trim();
  const limit = Math.min(
    Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100),
    500,
  );

  const where: string[] = [];
  const binds: (string | number)[] = [];

  if (jobIdParam === "general") {
    where.push("job_id IS NULL");
  } else if (jobIdParam) {
    where.push("job_id = ?");
    binds.push(jobIdParam);
  }
  if (since) {
    where.push("incurred_at >= ?");
    binds.push(since);
  }

  const sql =
    `SELECT id, job_id, amount, description, incurred_at,
            vendor, receipt_r2_key, entered_via,
            pushed_to_jobber_at, jobber_id
     FROM expenses` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY incurred_at DESC LIMIT ?`;
  binds.push(limit);

  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<ExpenseRow>();

  return jsonResponse({
    expenses: (rows.results ?? []).map(hydrateExpense),
  });
}

// ────────────────────────────────────────────────────────────────────────
// GET /api/expenses/:id/receipt
// ────────────────────────────────────────────────────────────────────────

export async function handleExpenseReceipt(
  env: Env,
  id: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT receipt_r2_key FROM expenses WHERE id = ?`,
  )
    .bind(id)
    .first<{ receipt_r2_key: string | null }>();

  if (!row) return jsonErr(404, "expense_not_found");
  if (!row.receipt_r2_key) return jsonErr(404, "no_receipt_attached");

  const obj = await env.FILES.get(row.receipt_r2_key);
  if (!obj) return jsonErr(404, "receipt_missing_in_r2");

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=300");
  return new Response(obj.body, { headers });
}

// DELETE /api/expenses/:id  — PWA rows only (protects Jobber-sourced expenses)
export async function handleExpenseDelete(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT receipt_r2_key, entered_via FROM expenses WHERE id = ?`,
  )
    .bind(id)
    .first<{ receipt_r2_key: string | null; entered_via: string }>();
  if (!row) return jsonErr(404, "expense_not_found");
  if (row.entered_via !== "pwa") {
    return jsonResponse(
      {
        error: "jobber_protected",
        message:
          "Only expenses created in CHS Capture (PWA) can be deleted here. Jobber-sourced rows stay in sync with Jobber.",
      },
      { status: 409 },
    );
  }
  if (row.receipt_r2_key) {
    await env.FILES.delete(row.receipt_r2_key).catch(() => undefined);
  }
  await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
  return jsonResponse({ ok: true });
}

// PATCH /api/expenses/:id  body: { job_id: string | null } — move to another job bucket in R2; PWA only
export async function handleExpensePatch(
  env: Env,
  id: string,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }
  if (!Object.prototype.hasOwnProperty.call(body, "job_id")) {
    return jsonErr(400, "job_id_required");
  }
  const row = await env.DB.prepare(
    `SELECT id, job_id, incurred_at, receipt_r2_key, entered_via FROM expenses WHERE id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      job_id: string | null;
      incurred_at: string | null;
      receipt_r2_key: string | null;
      entered_via: string;
    }>();
  if (!row) return jsonErr(404, "expense_not_found");
  if (row.entered_via !== "pwa") {
    return jsonResponse(
      {
        error: "jobber_protected",
        message: "Only PWA expenses can be re-assigned to another job from Hub Files.",
      },
      { status: 409 },
    );
  }
  let nextJob: string | null = null;
  if (body.job_id === null || body.job_id === "") {
    nextJob = null;
  } else if (typeof body.job_id === "string" && body.job_id.trim()) {
    const j = body.job_id.trim();
    const ok = await env.DB.prepare("SELECT 1 AS o FROM jobs WHERE id = ?")
      .bind(j)
      .first<{ o: number }>();
    if (!ok) return jsonErr(400, "unknown_job");
    nextJob = j;
  } else {
    return jsonErr(400, "invalid_job_id");
  }
  if (nextJob === row.job_id) {
    return jsonResponse({ ok: true, unchanged: true });
  }

  if (!row.receipt_r2_key) {
    await env.DB.prepare("UPDATE expenses SET job_id = ? WHERE id = ?")
      .bind(nextJob, id)
      .run();
    return jsonResponse({ ok: true, job_id: nextJob });
  }

  const bucket = dateBucket(row.incurred_at);
  const slug = nextJob ?? "general";
  const newKey = `expenses/${slug}/${bucket}/${id}.jpg`;
  if (newKey === row.receipt_r2_key) {
    await env.DB.prepare("UPDATE expenses SET job_id = ? WHERE id = ?")
      .bind(nextJob, id)
      .run();
    return jsonResponse({ ok: true, job_id: nextJob });
  }
  const o = await env.FILES.get(row.receipt_r2_key);
  if (!o) return jsonErr(500, "receipt_missing_in_r2");
  const ab = await o.arrayBuffer();
  const ct = o.httpMetadata?.contentType || "image/jpeg";
  await env.FILES.put(newKey, ab, { httpMetadata: { contentType: ct } });
  if (row.receipt_r2_key !== newKey) {
    await env.FILES.delete(row.receipt_r2_key).catch(() => undefined);
  }
  await env.DB.prepare(
    `UPDATE expenses SET job_id = ?, receipt_r2_key = ? WHERE id = ?`,
  )
    .bind(nextJob, newKey, id)
    .run();
  return jsonResponse({ ok: true, job_id: nextJob, receipt_r2_key: newKey });
}
