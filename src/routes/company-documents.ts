/**
 * Company documents (SOPs, insurance, licenses, W-9, etc.)
 *
 *   GET    /api/company-documents              — all authenticated users
 *   POST   /api/company-documents              — owner + office_admin
 *   GET    /api/company-documents/:id/file     — all authenticated users
 *   PATCH  /api/company-documents/:id          — owner + office_admin
 *   DELETE /api/company-documents/:id          — owner + office_admin
 *
 * Files land in R2; drive_mirrored_at is set by the hourly Drive mirror cron
 * (owner-only ops surface — admins cannot trigger or configure mirror).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

export const COMPANY_DOC_TYPES = [
  "sop",
  "insurance",
  "license",
  "contract",
  "w9",
  "safety",
  "hr",
  "tax",
  "marketing",
  "legal",
  "other",
] as const;

const DOC_TYPES = new Set<string>(COMPANY_DOC_TYPES);

export const COMPANY_DOC_WRITE_ROLES = ["owner", "office_admin"] as const;

function jsonErr(status: number, code: string, details?: string): Response {
  return new Response(JSON.stringify({ error: code, details }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getEntry(form: FormData, name: string): Blob | string | null {
  return form.get(name) as unknown as Blob | string | null;
}

function extFromName(name: string): string {
  const m = name.match(/\.([a-z0-9]{1,8})$/i);
  return m ? `.${m[1].toLowerCase()}` : "";
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export async function handleCompanyDocumentList(
  env: Env,
  url: URL,
): Promise<Response> {
  const type = url.searchParams.get("doc_type");
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get("limit")) || 100));
  const where: string[] = ["1=1"];
  const binds: (string | number)[] = [];
  if (type && DOC_TYPES.has(type)) {
    where.push("doc_type = ?");
    binds.push(type);
  }
  if (q) {
    where.push("(lower(title) LIKE ? OR lower(filename) LIKE ? OR lower(notes) LIKE ?)");
    const p = `%${q.toLowerCase()}%`;
    binds.push(p, p, p);
  }
  const sql = `SELECT id, created_at, updated_at, title, doc_type, filename, mime_type, size_bytes,
      effective_date, expires_at, notes, uploaded_by, drive_mirrored_at
     FROM company_documents
     WHERE ${where.join(" AND ")}
     ORDER BY datetime(created_at) DESC
     LIMIT ?`;
  binds.push(limit);
  const res = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{
      id: string;
      created_at: string;
      updated_at: string;
      title: string;
      doc_type: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
      effective_date: string | null;
      expires_at: string | null;
      notes: string | null;
      uploaded_by: string | null;
      drive_mirrored_at: string | null;
    }>();
  return new Response(JSON.stringify({ documents: res.results ?? [] }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleCompanyDocumentCreate(
  env: Env,
  request: Request,
): Promise<Response> {
  const guarded = await guard(request, env, [...COMPANY_DOC_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonErr(400, "invalid_form_data");
  }
  const file = getEntry(form, "file");
  if (!(file instanceof Blob) || file.size < 1) {
    return jsonErr(400, "file_required");
  }
  const title =
    typeof getEntry(form, "title") === "string" ? (getEntry(form, "title") as string).trim() : "";
  if (!title) return jsonErr(400, "title_required");
  const rawType =
    typeof getEntry(form, "doc_type") === "string" ? (getEntry(form, "doc_type") as string).trim() : "other";
  const docType = DOC_TYPES.has(rawType) ? rawType : "other";
  const effectiveDate =
    typeof getEntry(form, "effective_date") === "string"
      ? (getEntry(form, "effective_date") as string).trim() || null
      : null;
  const expiresAt =
    typeof getEntry(form, "expires_at") === "string"
      ? (getEntry(form, "expires_at") as string).trim() || null
      : null;
  const notes =
    typeof getEntry(form, "notes") === "string" ? (getEntry(form, "notes") as string).trim() || null : null;

  const origName = file instanceof File && typeof file.name === "string" ? file.name : "document";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ext = extFromName(origName) || ".bin";
  const safeBase = origName
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120) || "upload";
  const r2Key = `company-docs/${docType}/${id}${ext}`;

  const bytes = await file.arrayBuffer();
  const mime = file.type || "application/octet-stream";
  const uploadedBy = guarded.user.email;

  await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
  try {
    await env.DB.prepare(
      `INSERT INTO company_documents
        (id, created_at, updated_at, title, doc_type, r2_key, filename, mime_type, size_bytes,
         effective_date, expires_at, notes, uploaded_by, drive_mirrored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(
        id,
        now,
        now,
        title,
        docType,
        r2Key,
        safeBase,
        mime,
        bytes.byteLength,
        effectiveDate,
        expiresAt,
        notes,
        uploadedBy,
      )
      .run();
  } catch (e) {
    await env.FILES.delete(r2Key);
    throw e;
  }

  return new Response(
    JSON.stringify({
      id,
      r2_key: r2Key,
      title,
      doc_type: docType,
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

export async function handleCompanyDocumentFile(
  env: Env,
  id: string,
  method: string,
): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const row = await env.DB.prepare(
    "SELECT r2_key, mime_type, filename FROM company_documents WHERE id = ?",
  )
    .bind(id)
    .first<{
      r2_key: string;
      mime_type: string;
      filename: string;
    }>();
  if (!row) return jsonErr(404, "not_found");
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return jsonErr(404, "r2_missing");
  const body = method === "HEAD" ? null : obj.body;
  const ct = row.mime_type || obj.httpMetadata?.contentType || "application/octet-stream";
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": ct,
      "content-disposition": `inline; filename="${encodeURIComponent(row.filename)}"`,
      "cache-control": "private, max-age=300",
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleCompanyDocumentDelete(
  env: Env,
  id: string,
  request: Request,
): Promise<Response> {
  const guarded = await guard(request, env, [...COMPANY_DOC_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare("SELECT r2_key FROM company_documents WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string }>();
  if (!row) return jsonErr(404, "not_found");
  await env.FILES.delete(row.r2_key).catch(() => undefined);
  await env.DB.prepare("DELETE FROM company_documents WHERE id = ?").bind(id).run();
  return jsonResponse({ ok: true });
}

export async function handleCompanyDocumentPatch(
  env: Env,
  id: string,
  request: Request,
): Promise<Response> {
  const guarded = await guard(request, env, [...COMPANY_DOC_WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonErr(400, "invalid_json");
  }

  const row = await env.DB.prepare(
    "SELECT r2_key, doc_type, filename, mime_type, title, notes, effective_date, expires_at FROM company_documents WHERE id = ?",
  )
    .bind(id)
    .first<{
      r2_key: string;
      doc_type: string;
      filename: string;
      mime_type: string;
      title: string;
      notes: string | null;
      effective_date: string | null;
      expires_at: string | null;
    }>();
  if (!row) return jsonErr(404, "not_found");

  const nextType =
    typeof body.doc_type === "string" && DOC_TYPES.has(body.doc_type) ? body.doc_type : row.doc_type;
  const nextTitle = "title" in body ? str(body.title) ?? row.title : row.title;
  const nextNotes = "notes" in body ? str(body.notes) : row.notes;
  const nextEffective = "effective_date" in body ? str(body.effective_date) : row.effective_date;
  const nextExpires = "expires_at" in body ? str(body.expires_at) : row.expires_at;

  if (!nextTitle) return jsonErr(400, "title_required");

  let r2Key = row.r2_key;
  if (nextType !== row.doc_type) {
    const ext = extFromName(row.r2_key) || extFromName(row.filename) || ".bin";
    const newKey = `company-docs/${nextType}/${id}${ext}`;
    const o = await env.FILES.get(row.r2_key);
    if (!o) return jsonErr(500, "r2_missing");
    const ab = await o.arrayBuffer();
    const ct = row.mime_type || o.httpMetadata?.contentType || "application/octet-stream";
    await env.FILES.put(newKey, ab, { httpMetadata: { contentType: ct } });
    if (row.r2_key !== newKey) {
      await env.FILES.delete(row.r2_key).catch(() => undefined);
    }
    r2Key = newKey;
  }

  const typeChanged = nextType !== row.doc_type;
  const metaChanged =
    nextTitle !== row.title ||
    nextNotes !== row.notes ||
    nextEffective !== row.effective_date ||
    nextExpires !== row.expires_at;

  if (!typeChanged && !metaChanged) {
    return jsonResponse({ ok: true, unchanged: true });
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE company_documents
     SET doc_type = ?, r2_key = ?, title = ?, notes = ?, effective_date = ?, expires_at = ?,
         updated_at = ?, drive_mirrored_at = CASE WHEN ? = 1 THEN NULL ELSE drive_mirrored_at END
     WHERE id = ?`,
  )
    .bind(
      nextType,
      r2Key,
      nextTitle,
      nextNotes,
      nextEffective,
      nextExpires,
      now,
      typeChanged ? 1 : 0,
      id,
    )
    .run();

  return jsonResponse({
    ok: true,
    doc_type: nextType,
    title: nextTitle,
    r2_key: r2Key,
  });
}
