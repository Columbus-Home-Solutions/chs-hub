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

  return jsonResponse({
    expense: {
      id,
      receipt_url: receiptKey ? `/api/expenses/${id}/receipt` : null,
    },
  });
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
