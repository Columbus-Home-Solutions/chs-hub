/**
 * Photo report endpoint — Sprint 18 (deliverable C; Photo Capture §3.8).
 *
 *   POST /api/jobs/:id/photo-report   (O/PM)  generate a photo-report artifact
 *
 * Body: { photo_ids: string[], include_gps?: bool, include_captions?: bool }.
 * Builds branded printable HTML (S15 pattern), stores it in R2, and registers a
 * `documents` row with document_category='photo_report'. Owner-generated; share
 * is a separate explicit action via POST /api/documents/:id/share (business rule
 * 3). HTML-first — no Puppeteer / no binary-PDF dep.
 *
 * NOTE: document_category='photo_report' must NEVER be swept into an unscoped
 * `WHERE is_signed=1` query — is_signed is overloaded (means "sent" for the
 * completion_package category). This row leaves is_signed at its default 0.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { writeAudit } from "../lib/audit.js";
import { buildPhotoReportData, renderPhotoReportHtml } from "../lib/photo-report.js";

const WRITE_ROLES = ["owner", "project_manager"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, message?: string): Response {
  return json({ error, message: message ?? error }, { status });
}

export async function handlePhotoReportGenerate(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }
  const photoIds = Array.isArray(body.photo_ids) ? body.photo_ids.map(String) : [];
  if (photoIds.length === 0) return err(400, "photo_ids_required", "Select at least one photo.");

  const data = await buildPhotoReportData(env, jobId, {
    photoIds,
    includeGps: body.include_gps !== false,
    includeCaptions: body.include_captions !== false,
  });
  if (!data) return err(404, "job_not_found");
  if (data.photos.length === 0) return err(400, "no_matching_photos", "None of the photo ids belong to this job.");

  const html = renderPhotoReportHtml(data);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `documents/job/${jobId}/photo_report/${id}.html`;
  const title = `Photo Report — ${data.job_display || data.job_title || jobId} (${data.photos.length})`;

  await env.FILES.put(r2Key, new TextEncoder().encode(html), {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO documents
         (id, title, file_type, file_size, r2_key, r2_url, mirror_status,
          context_type, job_id, document_category, is_signed, is_active, uploaded_by, created_at, updated_at)
       VALUES (?, ?, 'text/html', ?, ?, ?, 'pending', 'job', ?, 'photo_report', 0, 1, ?, ?, ?)`,
    )
      .bind(id, title, html.length, r2Key, `/api/documents/${id}/file`, jobId, user.email, now, now)
      .run();
  } catch (e) {
    await env.FILES.delete(r2Key).catch(() => undefined);
    throw e;
  }

  await writeAudit(env, {
    userEmail: user.email,
    action: "photo_report.generate",
    entityType: "document",
    entityId: id,
    details: { job_id: jobId, photo_count: data.photos.length, include_gps: data.include_gps },
  });

  return json(
    {
      ok: true,
      document_id: id,
      title,
      preview_url: `/api/documents/${id}/file`,
      share_endpoint: `/api/documents/${id}/share`,
      photo_count: data.photos.length,
    },
    { status: 201 },
  );
}
