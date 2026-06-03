/**
 * Project packet endpoint — Sprint 18 (deliverable D; Photo Capture §3.5.5).
 *
 *   POST /api/jobs/:id/project-packet   (O/PM)  generate a sales packet
 *
 * Branded printable HTML (S15 pattern), stored in R2 + a `documents` row with
 * document_category='project_packet'. Owner-generated; shareable via
 * POST /api/documents/:id/share. Distinct from the completion package (no
 * financials/warranty/doc inventory). HTML-first — no binary-PDF dep.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { writeAudit } from "../lib/audit.js";
import { buildProjectPacketData, renderProjectPacketHtml } from "../lib/project-packet.js";

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

export async function handleProjectPacketGenerate(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const data = await buildProjectPacketData(env, jobId);
  if (!data) return err(404, "job_not_found");

  const html = renderProjectPacketHtml(data);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `documents/job/${jobId}/project_packet/${id}.html`;
  const title = `Project Packet — ${data.job_display || data.job_title || jobId}`;

  await env.FILES.put(r2Key, new TextEncoder().encode(html), {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO documents
         (id, title, file_type, file_size, r2_key, r2_url, mirror_status,
          context_type, job_id, document_category, is_signed, is_active, uploaded_by, created_at, updated_at)
       VALUES (?, ?, 'text/html', ?, ?, ?, 'pending', 'job', ?, 'project_packet', 0, 1, ?, ?, ?)`,
    )
      .bind(id, title, html.length, r2Key, `/api/documents/${id}/file`, jobId, user.email, now, now)
      .run();
  } catch (e) {
    await env.FILES.delete(r2Key).catch(() => undefined);
    throw e;
  }

  await writeAudit(env, {
    userEmail: user.email,
    action: "project_packet.generate",
    entityType: "document",
    entityId: id,
    details: {
      job_id: jobId,
      before: data.before_photos.length,
      after: data.after_photos.length,
      highlights: data.highlight_photos.length,
    },
  });

  return json(
    {
      ok: true,
      document_id: id,
      title,
      preview_url: `/api/documents/${id}/file`,
      share_endpoint: `/api/documents/${id}/share`,
      counts: {
        before: data.before_photos.length,
        after: data.after_photos.length,
        highlights: data.highlight_photos.length,
      },
    },
    { status: 201 },
  );
}
