/**
 * Per-job file cabinet (drawings, notes, contracts, project receipts, pay records, etc.)
 *
 *   GET    /api/job-files?job_id=&doc_type=&q=&limit=
 *   POST   /api/job-files  — multipart: job_id, file, title, doc_type, notes?
 *   GET    /api/job-files/:id/file
 *   DELETE /api/job-files/:id
 *   PATCH  /api/job-files/:id  — { job_id?: string, doc_type?: string }
 */

import type { Env } from "../env.js";

/** Allowed for new uploads and PATCH. (Legacy rows may still have `other`.) */
export const JOB_FILE_TYPES = new Set([
  "drawings",
  "notes",
  "contracts",
  "receipts",
  "pay_stub",
  "design",
]);

/** Includes `other` for list filters and Explorer (legacy Miscellaneous). */
export const JOB_FILE_DOC_TYPES_KNOWN = new Set([...JOB_FILE_TYPES, "other"]);

function jsonErr(status: number, code: string, message?: string): Response {
  return new Response(JSON.stringify({ error: code, message: message ?? code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function getEntry(form: FormData, name: string): Blob | string | null {
  return form.get(name) as unknown as Blob | string | null;
}

function extFromName(name: string): string {
  const m = name.match(/\.([a-z0-9]{1,8})$/i);
  return m ? `.${m[1].toLowerCase()}` : "";
}

// GET /api/job-files
export async function handleJobFileList(env: Env, url: URL): Promise<Response> {
  const jobId = (url.searchParams.get("job_id") ?? "").trim() || null;
  const type = url.searchParams.get("doc_type");
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(300, Math.max(10, Number(url.searchParams.get("limit")) || 150));
  const where: string[] = ["1=1"];
  const binds: (string | number)[] = [];
  if (jobId) {
    where.push("jf.job_id = ?");
    binds.push(jobId);
  }
  if (type && JOB_FILE_DOC_TYPES_KNOWN.has(type)) {
    where.push("jf.doc_type = ?");
    binds.push(type);
  }
  if (q) {
    where.push("(lower(jf.title) LIKE ? OR lower(jf.filename) LIKE ? OR lower(jf.notes) LIKE ? OR lower(j.title) LIKE ?)");
    const p = `%${q.toLowerCase()}%`;
    binds.push(p, p, p, p);
  }
  const sql = `SELECT jf.id, jf.job_id, jf.created_at, jf.updated_at, jf.title, jf.doc_type,
        jf.filename, jf.mime_type, jf.size_bytes, jf.notes, jf.r2_key,
        jf.source, jf.jobber_attachment_id,
        j.title AS job_title, j.job_number
     FROM job_files jf
     LEFT JOIN jobs j ON j.id = jf.job_id
     WHERE ${where.join(" AND ")}
     ORDER BY datetime(jf.created_at) DESC
     LIMIT ?`;
  binds.push(limit);
  const res = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{
      id: string;
      job_id: string;
      created_at: string;
      updated_at: string;
      title: string;
      doc_type: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
      notes: string | null;
      r2_key: string;
      source: string;
      jobber_attachment_id: string | null;
      job_title: string | null;
      job_number: number | null;
    }>();
  return jsonResponse({ files: res.results ?? [] });
}

// POST /api/job-files
export async function handleJobFileCreate(env: Env, request: Request): Promise<Response> {
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
  const jobRaw = typeof getEntry(form, "job_id") === "string" ? (getEntry(form, "job_id") as string).trim() : "";
  if (!jobRaw) return jsonErr(400, "job_id_required");
  const jobOk = await env.DB.prepare("SELECT 1 AS o FROM jobs WHERE id = ?")
    .bind(jobRaw)
    .first<{ o: number }>();
  if (!jobOk) return jsonErr(400, "unknown_job");

  const title =
    typeof getEntry(form, "title") === "string" ? (getEntry(form, "title") as string).trim() : "";
  if (!title) return jsonErr(400, "title_required");
  const rawType =
    typeof getEntry(form, "doc_type") === "string" ? (getEntry(form, "doc_type") as string).trim() : "";
  if (!JOB_FILE_TYPES.has(rawType)) return jsonErr(400, "invalid_doc_type");
  const docType = rawType;
  const notes =
    typeof getEntry(form, "notes") === "string" ? (getEntry(form, "notes") as string).trim() || null : null;

  const origName = file instanceof File && typeof file.name === "string" ? file.name : "document";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ext = extFromName(origName) || ".bin";
  const safeBase = origName
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120) || "upload";
  const r2Key = `job-files/${jobRaw}/${docType}/${id}${ext}`;

  const bytes = await file.arrayBuffer();
  const mime = file.type || "application/octet-stream";
  const uploadedBy = request.headers.get("cf-access-authenticated-user-email") ?? null;

  await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
  try {
    await env.DB.prepare(
      `INSERT INTO job_files
        (id, job_id, created_at, updated_at, title, doc_type, r2_key, filename, mime_type, size_bytes, notes, uploaded_by, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dashboard')`,
    )
      .bind(
        id,
        jobRaw,
        now,
        now,
        title,
        docType,
        r2Key,
        safeBase,
        mime,
        bytes.byteLength,
        notes,
        uploadedBy,
      )
      .run();
  } catch (e) {
    await env.FILES.delete(r2Key).catch(() => undefined);
    throw e;
  }

  return new Response(
    JSON.stringify({ id, r2_key: r2Key, title, doc_type: docType, job_id: jobRaw }),
    { status: 201, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

// GET/HEAD /api/job-files/:id/file
export async function handleJobFileStream(env: Env, id: string, method: string): Promise<Response> {
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const row = await env.DB.prepare(
    "SELECT r2_key, mime_type, filename FROM job_files WHERE id = ?",
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

// DELETE /api/job-files/:id
export async function handleJobFileDelete(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT r2_key FROM job_files WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string }>();
  if (!row) return jsonErr(404, "not_found");
  await env.FILES.delete(row.r2_key).catch(() => undefined);
  await env.DB.prepare("DELETE FROM job_files WHERE id = ?").bind(id).run();
  return jsonResponse({ ok: true });
}

// PATCH /api/job-files/:id
export async function handleJobFilePatch(
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
  const row = await env.DB.prepare(
    "SELECT id, job_id, doc_type, r2_key, filename, mime_type FROM job_files WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      job_id: string;
      doc_type: string;
      r2_key: string;
      filename: string;
      mime_type: string;
    }>();
  if (!row) return jsonErr(404, "not_found");

  let nextJob = row.job_id;
  if (Object.prototype.hasOwnProperty.call(body, "job_id")) {
    if (typeof body.job_id === "string" && body.job_id.trim()) {
      const j = body.job_id.trim();
      const ok = await env.DB.prepare("SELECT 1 AS o FROM jobs WHERE id = ?")
        .bind(j)
        .first<{ o: number }>();
      if (!ok) return jsonErr(400, "unknown_job");
      nextJob = j;
    } else {
      return jsonErr(400, "job_id_required", "job_id must be a valid Jobber job id");
    }
  }

  let nextType = row.doc_type;
  if (Object.prototype.hasOwnProperty.call(body, "doc_type")) {
    if (typeof body.doc_type === "string" && JOB_FILE_TYPES.has(body.doc_type)) {
      nextType = body.doc_type;
    } else {
      return jsonErr(400, "invalid_doc_type");
    }
  }

  if (nextJob === row.job_id && nextType === row.doc_type) {
    return jsonResponse({ ok: true, unchanged: true });
  }

  const ext = extFromName(row.r2_key) || extFromName(row.filename) || ".bin";
  const newKey = `job-files/${nextJob}/${nextType}/${id}${ext}`;
  if (newKey === row.r2_key) {
    if (nextJob !== row.job_id) {
      await env.DB.prepare("UPDATE job_files SET job_id = ?, updated_at = ? WHERE id = ?")
        .bind(nextJob, new Date().toISOString(), id)
        .run();
    } else {
      await env.DB.prepare("UPDATE job_files SET doc_type = ?, updated_at = ? WHERE id = ?")
        .bind(nextType, new Date().toISOString(), id)
        .run();
    }
    return jsonResponse({ ok: true, job_id: nextJob, doc_type: nextType, r2_key: row.r2_key });
  }

  const o = await env.FILES.get(row.r2_key);
  if (!o) return jsonErr(500, "r2_missing");
  const ab = await o.arrayBuffer();
  const ct = row.mime_type || o.httpMetadata?.contentType || "application/octet-stream";
  await env.FILES.put(newKey, ab, { httpMetadata: { contentType: ct } });
  if (row.r2_key !== newKey) {
    await env.FILES.delete(row.r2_key).catch(() => undefined);
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE job_files
     SET job_id = ?, doc_type = ?, r2_key = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(nextJob, nextType, newKey, now, id)
    .run();
  return jsonResponse({ ok: true, job_id: nextJob, doc_type: nextType, r2_key: newKey });
}
