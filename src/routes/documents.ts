/**
 * Document Management — Sprint 15 (Module-Spec-Document-Management §2–§4).
 *
 * Centralizes every file the platform stores. R2 is canonical (src/lib/r2.ts
 * key layout), D1 holds metadata, Google Drive is a one-way best-effort mirror
 * (extended in src/lib/ops/drive-mirror.ts — NO new cron). Files are NEVER
 * physically foldered: a document is tagged with context_type + job/client/
 * estimate id + document_category and filtered for the virtual-folder views
 * (§3.1). Deletion is soft (is_active=0) — the R2 object is never removed
 * (business rule 1). Every upload is audit-logged (business rule 7).
 *
 *   POST   /api/documents                 (O/PM/OA)  multipart upload → R2 + row
 *   GET    /api/documents                 (O/PM/OA)  list + ?job_id=&context_type=&category=&search=
 *   GET    /api/documents/company         (O/OA)     context_type='company'
 *   GET    /api/documents/:id             (O/PM/OA)  detail
 *   GET    /api/documents/:id/file        (O/PM/OA)  stream from R2
 *   PUT    /api/documents/:id             (O/PM/OA)  update metadata
 *   DELETE /api/documents/:id             (O/PM/OA)  soft-delete
 *   POST   /api/documents/:id/share       (O/PM/OA)  generate/regenerate share link
 *   GET    /api/jobs/:id/documents        (O/PM/OA)  grouped by category (+ receipts from photos)
 *   GET    /api/share/:token              (PUBLIC)   token-gated R2 stream / expired page
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

export const DOC_WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

/** document_category vocabulary (spec §2). Free-text column, but we validate. */
export const DOCUMENT_CATEGORIES = new Set([
  "contract",
  "change_order",
  "permit",
  "plan_drawing",
  "receipt",
  "invoice",
  "lien_waiver",
  "insurance",
  "license",
  "sop",
  "photo_report",
  "completion_package",
  "other",
]);

/** Categories that are never shown to the client in the portal. */
export const PORTAL_HIDDEN_CATEGORIES = new Set(["receipt", "sop", "insurance", "license"]);

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per-file cap (business rule 8)
const SHARE_DEFAULT_DAYS = 7; // business rule 3

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}
function getEntry(form: FormData, name: string): Blob | string | null {
  return form.get(name) as unknown as Blob | string | null;
}
function str(form: FormData, name: string): string | null {
  const v = getEntry(form, name);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}
function extFromName(name: string): string {
  const m = name.match(/\.([a-z0-9]{1,8})$/i);
  return m ? `.${m[1].toLowerCase()}` : "";
}

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  documentId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, 'document', ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), userEmail, action, documentId, JSON.stringify(details))
    .run();
}

export interface NewDocumentInput {
  title: string;
  fileType: string;
  fileSize: number | null;
  bytes: ArrayBuffer;
  contextType: "job" | "client" | "estimate" | "company" | "template";
  jobId?: string | null;
  clientId?: string | null;
  estimateId?: string | null;
  category: string;
  uploadedBy: string | null;
  mirror?: boolean; // default true → mirror_status='pending'
  isSigned?: boolean;
}

/**
 * Shared insert path used by upload, template generation, lien-waiver
 * generation, and the completion package. Writes the R2 object then the row;
 * rolls the object back if the insert throws. Returns the new document id.
 */
export async function insertDocument(env: Env, input: NewDocumentInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ext = extFromName(input.title) || mimeExt(input.fileType);
  const seg = input.contextType === "company" ? "company" : input.jobId ? `job/${input.jobId}` : input.contextType;
  const r2Key = `documents/${seg}/${input.category}/${id}${ext}`;
  const r2Url = `/api/documents/${id}/file`;
  const mirrorStatus = input.mirror === false ? null : "pending";

  await env.FILES.put(r2Key, input.bytes, {
    httpMetadata: { contentType: input.fileType || "application/octet-stream" },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO documents
         (id, title, file_type, file_size, r2_key, r2_url, mirror_status,
          context_type, job_id, client_id, estimate_id, document_category,
          is_signed, is_active, uploaded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(
        id,
        input.title,
        input.fileType || "application/octet-stream",
        input.fileSize,
        r2Key,
        r2Url,
        mirrorStatus,
        input.contextType,
        input.jobId ?? null,
        input.clientId ?? null,
        input.estimateId ?? null,
        input.category,
        input.isSigned ? 1 : 0,
        input.uploadedBy,
        now,
        now,
      )
      .run();
  } catch (e) {
    await env.FILES.delete(r2Key).catch(() => undefined);
    throw e;
  }
  return id;
}

function mimeExt(mime: string): string {
  const m: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "text/html": ".html",
    "text/plain": ".txt",
  };
  return m[mime] ?? ".bin";
}

// ─── POST /api/documents ────────────────────────────────────────────────────

export async function handleDocumentCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...DOC_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return err(400, "invalid_form_data");
  }
  const file = getEntry(form, "file");
  if (!(file instanceof Blob) || file.size < 1) return err(400, "file_required");
  if (file.size > MAX_FILE_BYTES) return err(413, "file_too_large", "Files are capped at 50 MB.");

  const rawCategory = str(form, "document_category") ?? "other";
  const category = DOCUMENT_CATEGORIES.has(rawCategory) ? rawCategory : "other";
  const jobId = str(form, "job_id");
  const clientId = str(form, "client_id");
  const estimateId = str(form, "estimate_id");
  let contextType = str(form, "context_type") as NewDocumentInput["contextType"] | null;
  if (!contextType) {
    contextType = jobId ? "job" : clientId ? "client" : estimateId ? "estimate" : "company";
  }
  const origName = file instanceof File && typeof file.name === "string" ? file.name : "document";
  const title = str(form, "title") ?? origName;
  const bytes = await file.arrayBuffer();

  const id = await insertDocument(env, {
    title,
    fileType: (file as Blob).type || "application/octet-stream",
    fileSize: bytes.byteLength,
    bytes,
    contextType,
    jobId,
    clientId,
    estimateId,
    category,
    uploadedBy: user.email,
  });

  await logAudit(env, user.email, "document.upload", id, { title, category, context_type: contextType, job_id: jobId });
  return json({ id, title, document_category: category, context_type: contextType, mirror_status: "pending" }, { status: 201 });
}

// ─── GET /api/documents (list + filters) ────────────────────────────────────

export async function handleDocumentList(env: Env, url: URL): Promise<Response> {
  const jobId = url.searchParams.get("job_id");
  const contextType = url.searchParams.get("context_type");
  const category = url.searchParams.get("category");
  const search = (url.searchParams.get("search") ?? "").trim();
  const limit = Math.min(500, Math.max(10, Number(url.searchParams.get("limit")) || 200));

  const where: string[] = ["COALESCE(is_active, 1) = 1"];
  const binds: (string | number)[] = [];
  if (jobId) {
    where.push("job_id = ?");
    binds.push(jobId);
  }
  if (contextType) {
    where.push("context_type = ?");
    binds.push(contextType);
  }
  if (category) {
    where.push("document_category = ?");
    binds.push(category);
  }
  if (search) {
    // LIKE over title + document_category (NOT file-content search — keep simple).
    where.push("(lower(title) LIKE ? OR lower(document_category) LIKE ?)");
    const p = `%${search.toLowerCase()}%`;
    binds.push(p, p);
  }
  binds.push(limit);
  const { results } = await env.DB.prepare(
    `SELECT id, title, file_type, file_size, context_type, job_id, client_id, estimate_id,
            document_category, is_signed, signed_date, mirror_status, mirror_date,
            share_token, share_expiration, uploaded_by, created_at, updated_at
       FROM documents
      WHERE ${where.join(" AND ")}
      ORDER BY datetime(created_at) DESC
      LIMIT ?`,
  )
    .bind(...binds)
    .all<Record<string, unknown>>();
  return json({ documents: results ?? [] });
}

// ─── GET /api/documents/company ─────────────────────────────────────────────

export async function handleCompanyDocuments(env: Env, url: URL): Promise<Response> {
  const search = (url.searchParams.get("search") ?? "").trim();
  const category = url.searchParams.get("category");
  const where: string[] = ["context_type = 'company'", "COALESCE(is_active,1) = 1"];
  const binds: (string | number)[] = [];
  if (category) {
    where.push("document_category = ?");
    binds.push(category);
  }
  if (search) {
    where.push("(lower(title) LIKE ? OR lower(document_category) LIKE ?)");
    const p = `%${search.toLowerCase()}%`;
    binds.push(p, p);
  }
  const { results } = await env.DB.prepare(
    `SELECT id, title, file_type, file_size, document_category, mirror_status,
            uploaded_by, created_at, updated_at
       FROM documents WHERE ${where.join(" AND ")}
      ORDER BY document_category ASC, datetime(created_at) DESC`,
  )
    .bind(...binds)
    .all<Record<string, unknown>>();
  return json({ documents: results ?? [] });
}

// ─── GET /api/jobs/:id/documents (grouped by category) ──────────────────────

export async function handleJobDocuments(env: Env, jobId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, file_type, file_size, document_category, is_signed, signed_date,
            mirror_status, share_token, share_expiration, created_at
       FROM documents
      WHERE job_id = ? AND COALESCE(is_active,1) = 1
      ORDER BY datetime(created_at) DESC`,
  )
    .bind(jobId)
    .all<Record<string, unknown> & { document_category: string }>();

  const groups: Record<string, unknown[]> = {};
  for (const d of results ?? []) {
    const cat = d.document_category || "other";
    (groups[cat] ??= []).push(d);
  }

  // Receipts virtual folder reads from the PHOTO records (flat storage, no
  // duplication — business rule 5). Receipt photos are photo_type='receipt'.
  const receipts = (
    await env.DB.prepare(
      `SELECT p.id, COALESCE(p.caption, 'Receipt') AS title, COALESCE(p.taken_at, p.created_at) AS created_at,
              rp.ai_vendor, rp.ai_amount
         FROM photos p
         LEFT JOIN receipt_photos rp ON rp.photo_id = p.id
        WHERE p.job_id = ? AND COALESCE(p.is_active,1) = 1 AND COALESCE(p.photo_type,'') = 'receipt'
        ORDER BY COALESCE(p.taken_at, p.created_at) DESC`,
    )
      .bind(jobId)
      .all<{ id: string; title: string; created_at: string; ai_vendor: string | null; ai_amount: number | null }>()
  ).results ?? [];
  if (receipts.length > 0) {
    groups.receipt = receipts.map((r) => ({
      id: r.id,
      title: r.ai_vendor ? `${r.ai_vendor}${r.ai_amount != null ? ` — $${r.ai_amount}` : ""}` : r.title,
      document_category: "receipt",
      source: "photo",
      created_at: r.created_at,
    }));
  }

  return json({ job_id: jobId, groups });
}

// ─── GET /api/documents/:id ─────────────────────────────────────────────────

export async function handleDocumentGet(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, title, file_type, file_size, r2_url, context_type, job_id, client_id, estimate_id,
            document_category, is_signed, signed_date, mirror_status, mirror_date,
            google_drive_url, share_token, share_expiration, is_active, uploaded_by, created_at, updated_at
       FROM documents WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return err(404, "not_found");
  return json({ document: row });
}

// ─── GET /api/documents/:id/file (stream from R2) ───────────────────────────

export async function handleDocumentFile(env: Env, id: string, method: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT r2_key, file_type, title FROM documents WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string; file_type: string; title: string }>();
  if (!row) return err(404, "not_found");
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return err(404, "r2_missing");
  const body = method === "HEAD" ? null : obj.body;
  const ct = row.file_type || obj.httpMetadata?.contentType || "application/octet-stream";
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": ct,
      "content-disposition": `inline; filename="${encodeURIComponent(row.title)}"`,
      "cache-control": "private, max-age=300",
    },
  });
}

// ─── PUT /api/documents/:id (metadata) ──────────────────────────────────────

export async function handleDocumentUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...DOC_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }
  const existing = await env.DB.prepare("SELECT id FROM documents WHERE id = ?").bind(id).first();
  if (!existing) return err(404, "not_found");

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];
  if (typeof body.title === "string" && body.title.trim()) {
    sets.push("title = ?");
    binds.push(body.title.trim());
  }
  if (typeof body.document_category === "string" && DOCUMENT_CATEGORIES.has(body.document_category)) {
    sets.push("document_category = ?");
    binds.push(body.document_category);
  }
  if (typeof body.is_signed === "boolean") {
    sets.push("is_signed = ?");
    binds.push(body.is_signed ? 1 : 0);
    sets.push("signed_date = ?");
    binds.push(body.is_signed ? new Date().toISOString() : null);
  }
  if (sets.length === 0) return err(400, "no_fields");
  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);
  await env.DB.prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  await logAudit(env, user.email, "document.update", id, body);
  return json({ ok: true });
}

// ─── DELETE /api/documents/:id (soft-delete) ────────────────────────────────

export async function handleDocumentDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...DOC_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare("SELECT id FROM documents WHERE id = ?").bind(id).first();
  if (!row) return err(404, "not_found");
  // Soft-delete only — the R2 object is NEVER removed (business rule 1).
  await env.DB.prepare("UPDATE documents SET is_active = 0, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
  await logAudit(env, user.email, "document.soft_delete", id, {});
  return json({ ok: true, soft_deleted: true });
}

// ─── POST /api/documents/:id/share ──────────────────────────────────────────

function shareOrigin(env: Env, request: Request): string {
  // Shared links join the unresolved APP_PUBLIC_ORIGIN Pre-Launch blocker
  // (pay/quote/portal). Fall back to the request origin for local/dev testing.
  const cfg = (env.APP_PUBLIC_ORIGIN ?? "").trim();
  if (cfg) return cfg.replace(/\/$/, "");
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

export async function handleDocumentShare(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...DOC_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare(
    "SELECT id, share_token, share_expiration FROM documents WHERE id = ? AND COALESCE(is_active,1)=1",
  )
    .bind(id)
    .first<{ id: string; share_token: string | null; share_expiration: string | null }>();
  if (!row) return err(404, "not_found");

  let days = SHARE_DEFAULT_DAYS;
  try {
    const body = (await request.json()) as { expires_in_days?: number };
    if (body && Number.isFinite(Number(body.expires_in_days)) && Number(body.expires_in_days) > 0) {
      days = Math.min(365, Math.floor(Number(body.expires_in_days)));
    }
  } catch {
    /* default 7 days */
  }

  // Reuse an existing, still-valid token; regenerate if absent or expired
  // (business rule 3).
  const now = Date.now();
  const stillValid =
    row.share_token && row.share_expiration && new Date(row.share_expiration).getTime() > now;
  const token = stillValid ? (row.share_token as string) : crypto.randomUUID().replace(/-/g, "");
  const expiration = new Date(now + days * 864e5).toISOString();

  await env.DB.prepare(
    "UPDATE documents SET share_token = ?, share_expiration = ?, updated_at = ? WHERE id = ?",
  )
    .bind(token, expiration, new Date().toISOString(), id)
    .run();
  await logAudit(env, user.email, "document.share", id, { regenerated: !stillValid, expiration });

  const origin = shareOrigin(env, request);
  return json({
    ok: true,
    token,
    share_url: `${origin}/share/${token}`,
    share_expiration: expiration,
    regenerated: !stillValid,
  });
}

// ─── GET /api/share/:token (PUBLIC) ─────────────────────────────────────────

const EXPIRED_HTML = (company: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link expired</title>
<style>
  :root{--ink:#1d2733;--muted:#5b6b7b;--accent:#c8102e;--bg:#f4f6f8}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:440px;width:100%;padding:40px 32px;text-align:center}
  .badge{width:56px;height:56px;border-radius:50%;background:#fdecee;color:var(--accent);display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:28px}
  h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);font-size:15px;line-height:1.5;margin:0 0 6px}
  .co{margin-top:22px;font-size:13px;color:var(--muted)}
</style></head>
<body><div class="card">
  <div class="badge">⏱</div>
  <h1>This link has expired</h1>
  <p>The shared document is no longer available through this link.</p>
  <p>Please contact us and we'll be happy to send you a fresh copy.</p>
  <div class="co">${company}</div>
</div></body></html>`;

export async function handleShareToken(env: Env, token: string, method: string): Promise<Response> {
  const company = await env.DB.prepare("SELECT value FROM system_settings WHERE key='company_name'")
    .first<{ value: string | null }>()
    .then((r) => (r?.value ?? "").trim() || "Columbus Home Solutions, LLC")
    .catch(() => "Columbus Home Solutions, LLC");

  const row = await env.DB.prepare(
    `SELECT id, r2_key, file_type, title, share_expiration
       FROM documents WHERE share_token = ? AND COALESCE(is_active,1) = 1`,
  )
    .bind(token)
    .first<{ id: string; r2_key: string; file_type: string; title: string; share_expiration: string | null }>();

  const expiredResponse = () =>
    new Response(EXPIRED_HTML(company), {
      status: 410,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });

  if (!row) return expiredResponse();
  if (!row.share_expiration || new Date(row.share_expiration).getTime() < Date.now()) {
    return expiredResponse();
  }

  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return expiredResponse();
  const body = method === "HEAD" ? null : obj.body;
  const ct = row.file_type || obj.httpMetadata?.contentType || "application/octet-stream";
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": ct,
      "content-disposition": `inline; filename="${encodeURIComponent(row.title)}"`,
      "cache-control": "private, max-age=60",
    },
  });
}
