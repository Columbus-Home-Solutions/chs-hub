/**
 * Job Completion Package — Sprint 15 (Module-Spec-Document-Management §3.6).
 * The draft → owner review → send state machine (business rule 6: generation
 * NEVER auto-sends; sending is an explicit, separate action).
 *
 *   POST /api/jobs/:id/completion-package        (O/PM)  compile a DRAFT
 *   GET  /api/jobs/:id/completion-package        (O/PM)  fetch current package
 *   POST /api/jobs/:id/completion-package/send   (O/PM)  explicit send (SIMULATE + portal)
 *
 * ── State machine (schema-free — no new columns) ─────────────────────────────
 * The package is a single `documents` row, document_category='completion_package',
 * linked to the job. Send-state is encoded on that row WITHOUT a new column:
 *   • DRAFT  = is_active=1 AND is_signed=0   (compiled, awaiting owner review)
 *   • SENT   = is_active=1 AND is_signed=1   (signed_date = sent timestamp)
 * Recompiling soft-deletes any prior DRAFT (is_active=0) and writes a fresh
 * draft; a SENT package is preserved. The portal completion tab only renders a
 * SENT package. (Deviation logged: is_signed/signed_date are repurposed as the
 * owner's send sign-off for this category — chosen over a migration because the
 * sprint mandates no new documents columns.)
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { buildCompletionPackageData, renderCompletionPackageHtml } from "../lib/completion-package.js";
import { triggerNotification } from "../lib/notification-engine.js";

const WRITE_ROLES = ["owner", "project_manager"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

interface PackageRow {
  id: string;
  title: string;
  r2_key: string;
  is_signed: number;
  signed_date: string | null;
  created_at: string;
}

/** Latest active completion-package doc for a job (prefer SENT, else newest). */
async function currentPackage(env: Env, jobId: string): Promise<PackageRow | null> {
  return env.DB.prepare(
    `SELECT id, title, r2_key, is_signed, signed_date, created_at
       FROM documents
      WHERE job_id = ? AND document_category='completion_package' AND COALESCE(is_active,1)=1
      ORDER BY is_signed DESC, datetime(created_at) DESC
      LIMIT 1`,
  )
    .bind(jobId)
    .first<PackageRow>();
}

async function logAudit(env: Env, email: string, action: string, jobId: string, details: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, 'completion_package', ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), email, action, jobId, JSON.stringify(details))
    .run();
}

// ─── POST /api/jobs/:id/completion-package (compile DRAFT) ──────────────────

export async function handleCompletionPackageCompile(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const data = await buildCompletionPackageData(env, jobId);
  if (!data) return err(404, "job_not_found");
  const html = renderCompletionPackageHtml(data);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const r2Key = `documents/job/${jobId}/completion_package/${id}.html`;
  const title = `Completion Package — ${data.job_display || data.job_title || jobId}`;

  await env.FILES.put(r2Key, new TextEncoder().encode(html), {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  try {
    // Soft-delete any prior DRAFT (unsent) package; preserve SENT history.
    await env.DB.prepare(
      `UPDATE documents SET is_active=0, updated_at=?
        WHERE job_id=? AND document_category='completion_package' AND COALESCE(is_active,1)=1 AND COALESCE(is_signed,0)=0`,
    )
      .bind(now, jobId)
      .run();
    await env.DB.prepare(
      `INSERT INTO documents
         (id, title, file_type, file_size, r2_key, r2_url, mirror_status,
          context_type, job_id, document_category, is_signed, is_active, uploaded_by, created_at, updated_at)
       VALUES (?, ?, 'text/html', ?, ?, ?, 'pending', 'job', ?, 'completion_package', 0, 1, ?, ?, ?)`,
    )
      .bind(id, title, html.length, r2Key, `/api/documents/${id}/file`, jobId, user.email, now, now)
      .run();
  } catch (e) {
    await env.FILES.delete(r2Key).catch(() => undefined);
    throw e;
  }

  await logAudit(env, user.email, "completion_package.compile", jobId, { document_id: id });
  return json(
    {
      ok: true,
      state: "draft",
      document_id: id,
      title,
      preview_url: `/api/documents/${id}/file`,
      summary: data.financial,
      document_count: data.documents.reduce((n, g) => n + g.items.length, 0),
      before_photos: data.before_photos.length,
      after_photos: data.after_photos.length,
    },
    { status: 201 },
  );
}

// ─── GET /api/jobs/:id/completion-package ───────────────────────────────────

export async function handleCompletionPackageGet(env: Env, jobId: string): Promise<Response> {
  const pkg = await currentPackage(env, jobId);
  if (!pkg) return json({ ok: true, state: "none", package: null });
  return json({
    ok: true,
    state: pkg.is_signed === 1 ? "sent" : "draft",
    package: {
      document_id: pkg.id,
      title: pkg.title,
      preview_url: `/api/documents/${pkg.id}/file`,
      sent_at: pkg.is_signed === 1 ? pkg.signed_date : null,
      created_at: pkg.created_at,
    },
  });
}

// ─── POST /api/jobs/:id/completion-package/send (explicit) ──────────────────

export async function handleCompletionPackageSend(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const pkg = await currentPackage(env, jobId);
  if (!pkg) return err(409, "no_package", "Compile a completion package draft before sending.");

  const alreadySent = pkg.is_signed === 1;
  const now = new Date().toISOString();
  if (!alreadySent) {
    // Transition DRAFT → SENT (review gate cleared by this explicit action).
    await env.DB.prepare("UPDATE documents SET is_signed=1, signed_date=?, updated_at=? WHERE id=?")
      .bind(now, now, pkg.id)
      .run();
  }

  // Deliver via the SIMULATE notification engine. Dedupe key (jobId) makes
  // resend idempotent — the engine's INSERT OR IGNORE won't re-enqueue.
  const job = await env.DB.prepare("SELECT client_id, portal_token FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ client_id: string | null; portal_token: string | null }>();
  const trigger = await triggerNotification(env, "completion_package_sent", {
    jobId,
    clientId: job?.client_id ?? null,
    linkPath: job?.portal_token ? `/portal/${job.portal_token}` : null,
    instanceKey: pkg.id,
  });

  await logAudit(env, user.email, "completion_package.send", jobId, {
    document_id: pkg.id,
    already_sent: alreadySent,
    notifications_enqueued: trigger.enqueued,
  });

  return json({
    ok: true,
    state: "sent",
    document_id: pkg.id,
    resent: alreadySent,
    notifications_enqueued: trigger.enqueued,
    notification_reasons: trigger.reasons,
  });
}
