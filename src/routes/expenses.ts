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
