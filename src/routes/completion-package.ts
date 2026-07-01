/**
 * Job Completion Package — Sprint 15 + Sprint 32.
 *
 *   GET  /api/jobs/:id/completion-package        (O/PM)  review screen payload
 *   POST /api/jobs/:id/completion-package/send   (O/PM)  send to client
 *   POST /api/jobs/:id/completion-package        (O/PM)  legacy: compile HTML draft
 *
 * Sprint 32 adds the warranty + lien waiver + final invoice review flow and
 * stamps jobs.completion_package_sent_at on send. The legacy compile POST
 * remains for backward compatibility with the S15 HTML artifact path.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { buildCompletionPackageData, renderCompletionPackageHtml } from "../lib/completion-package.js";
import { triggerNotification } from "../lib/notification-engine.js";
import { formatDate, formatDatePlusOneYear } from "../lib/document-generator.js";

const WRITE_ROLES = ["owner", "project_manager"] as const;
const READ_ROLES = ["owner", "project_manager", "office_admin"] as const;

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

async function settingValue(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string | null }>();
  return (row?.value ?? "").trim();
}

export type PackageReviewStatus = "not_ready" | "ready_to_send" | "sent";

export async function buildCompletionPackageReview(env: Env, jobId: string) {
  const job = await env.DB.prepare(
    `SELECT j.id, j.job_number, j.title, j.completion_package_sent_at, j.actual_end_date, j.target_end_date,
            j.warranty_expiration, j.portal_token,
            COALESCE(c.first_name || ' ' || c.last_name, c.name, '') AS client_name
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.id = ?`,
  )
    .bind(jobId)
    .first<{
      id: string;
      job_number: string;
      title: string;
      completion_package_sent_at: string | null;
      actual_end_date: string | null;
      target_end_date: string | null;
      warranty_expiration: string | null;
      portal_token: string | null;
      client_name: string;
    }>();

  if (!job) return null;

  const warrantyRow = await env.DB.prepare(
    `SELECT id, r2_key, generated_at, review_status
       FROM job_documents
      WHERE job_id = ? AND template_type = 'warranty_certificate'
        AND review_status IN ('pending_review', 'approved', 'manual')
      ORDER BY datetime(generated_at) DESC
      LIMIT 1`,
  )
    .bind(jobId)
    .first<{ id: string; r2_key: string; generated_at: string; review_status: string }>();

  const warranty = warrantyRow
    ? {
        document_id: warrantyRow.id,
        r2_key: warrantyRow.r2_key,
        generated_at: warrantyRow.generated_at,
        status: "ready" as const,
      }
    : {
        document_id: null,
        r2_key: null,
        generated_at: null,
        status: "missing" as const,
      };

  const finalInvoice = await env.DB.prepare(
    `SELECT id, amount, paid_date, status
       FROM invoices
      WHERE job_id = ? AND status = 'paid'
      ORDER BY datetime(COALESCE(paid_date, created_at)) DESC
      LIMIT 1`,
  )
    .bind(jobId)
    .first<{ id: string; amount: number; paid_date: string | null; status: string }>();

  const invoiceCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM invoices WHERE job_id = ? AND status != 'void'`,
  )
    .bind(jobId)
    .first<{ n: number }>();

  const lienWaiver = await env.DB.prepare(
    `SELECT id, status, sent_at, signed_at, document_id
       FROM client_lien_waivers
      WHERE job_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT 1`,
  )
    .bind(jobId)
    .first<{
      id: string;
      status: string;
      sent_at: string | null;
      signed_at: string | null;
      document_id: string | null;
    }>();

  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
  const photoSelect = `SELECT id, r2_thumbnail_key, r2_key, r2_url, caption FROM photos`;
  const beforePhotos = (
    await env.DB.prepare(
      `${photoSelect}
        WHERE job_id = ? AND COALESCE(is_active,1)=1 AND COALESCE(photo_type,'')!='receipt'
          AND (lower(COALESCE(category,''))='before' OR COALESCE(is_before_photo,0)=1)
        ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 24`,
    )
      .bind(jobId)
      .all<{ id: string; r2_thumbnail_key: string | null; r2_key: string | null; r2_url: string | null; caption: string | null }>()
  ).results ?? [];

  const afterPhotos = (
    await env.DB.prepare(
      `${photoSelect}
        WHERE job_id = ? AND COALESCE(is_active,1)=1 AND COALESCE(photo_type,'')!='receipt'
          AND (lower(COALESCE(category,''))='final' OR COALESCE(is_after_photo,0)=1)
        ORDER BY COALESCE(taken_at, created_at) ASC LIMIT 24`,
    )
      .bind(jobId)
      .all<{ id: string; r2_thumbnail_key: string | null; r2_key: string | null; r2_url: string | null; caption: string | null }>()
  ).results ?? [];

  const mapPhoto = (p: {
    id: string;
    r2_thumbnail_key: string | null;
    r2_key: string | null;
    r2_url: string | null;
    caption: string | null;
  }) => ({
    id: p.id,
    r2_thumbnail_key: p.r2_thumbnail_key,
    r2_url:
      p.r2_url ??
      (job.portal_token ? `${origin}/api/portal/${encodeURIComponent(job.portal_token)}/photos/${p.id}/image` : null),
    caption: p.caption,
  });

  let packageStatus: PackageReviewStatus = "not_ready";
  if (job.completion_package_sent_at) {
    packageStatus = "sent";
  } else if (
    warranty.status === "ready" &&
    lienWaiver?.status === "signed" &&
    (invoiceCount?.n ?? 0) > 0
  ) {
    packageStatus = "ready_to_send";
  }

  return {
    job: {
      id: job.id,
      title: job.title,
      client_name: job.client_name,
      job_number: job.job_number,
    },
    warranty,
    final_invoice: finalInvoice
      ? {
          invoice_id: finalInvoice.id,
          amount: finalInvoice.amount,
          paid_at: finalInvoice.paid_date,
          status: "ready" as const,
        }
      : {
          invoice_id: null,
          amount: null,
          paid_at: null,
          status: "missing" as const,
        },
    lien_waiver: lienWaiver
      ? {
          waiver_id: lienWaiver.id,
          status: lienWaiver.status as "pending" | "sent" | "signed" | "declined" | "failed",
          sent_at: lienWaiver.sent_at,
          signed_at: lienWaiver.signed_at,
          document_id: lienWaiver.document_id,
        }
      : {
          waiver_id: null,
          status: "missing" as const,
          sent_at: null,
          signed_at: null,
          document_id: null,
        },
    photos: {
      before: beforePhotos.map(mapPhoto),
      after: afterPhotos.map(mapPhoto),
    },
    package_status: packageStatus,
    sent_at: job.completion_package_sent_at,
  };
}

// ─── POST /api/jobs/:id/completion-package (legacy compile DRAFT) ───────────

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

// ─── GET /api/jobs/:id/completion-package (Sprint 32 review payload) ────────

export async function handleCompletionPackageGet(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const review = await buildCompletionPackageReview(env, jobId);
  if (!review) return err(404, "job_not_found");
  return json(review);
}

// ─── POST /api/jobs/:id/completion-package/send ─────────────────────────────

export async function handleCompletionPackageSend(request: Request, env: Env, jobId: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const review = await buildCompletionPackageReview(env, jobId);
  if (!review) return err(404, "job_not_found");

  if (review.sent_at) {
    return err(400, "already_sent", "Completion package was already sent to the client.");
  }
  if (review.package_status !== "ready_to_send") {
    return err(409, "not_ready", "Completion package is not ready to send.");
  }

  const job = await env.DB.prepare(
    `SELECT client_id, portal_token, warranty_expiration, actual_end_date, target_end_date
       FROM jobs WHERE id = ?`,
  )
    .bind(jobId)
    .first<{
      client_id: string | null;
      portal_token: string | null;
      warranty_expiration: string | null;
      actual_end_date: string | null;
      target_end_date: string | null;
    }>();

  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
  const portalUrl = job?.portal_token ? `${origin}/portal/${job.portal_token}/completion-package` : `${origin}/portal`;
  const completionRaw = job?.actual_end_date ?? job?.target_end_date ?? null;
  const warrantyExpiry =
    job?.warranty_expiration != null
      ? formatDate(job.warranty_expiration)
      : formatDatePlusOneYear(completionRaw);
  const googleReviewLink =
    (await settingValue(env, "google_review_link")) ||
    (await settingValue(env, "google_review_url")) ||
    "https://g.page/r/review";

  // Compile branded HTML artifact for the client portal tab.
  const data = await buildCompletionPackageData(env, jobId);
  if (data) {
    const html = renderCompletionPackageHtml(data);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const r2Key = `documents/job/${jobId}/completion_package/${id}.html`;
    const title = `Completion Package — ${data.job_display || data.job_title || jobId}`;
    await env.FILES.put(r2Key, new TextEncoder().encode(html), {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    await env.DB.prepare(
      `UPDATE documents SET is_active=0, updated_at=?
        WHERE job_id=? AND document_category='completion_package' AND COALESCE(is_active,1)=1`,
    )
      .bind(now, jobId)
      .run();
    await env.DB.prepare(
      `INSERT INTO documents
         (id, title, file_type, file_size, r2_key, r2_url, mirror_status,
          context_type, job_id, document_category, is_signed, is_active, uploaded_by, created_at, updated_at)
       VALUES (?, ?, 'text/html', ?, ?, ?, 'pending', 'job', ?, 'completion_package', 1, 1, ?, ?, ?)`,
    )
      .bind(id, title, html.length, r2Key, `/api/documents/${id}/file`, jobId, user.email, now, now)
      .run();
  }

  const sentAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE jobs SET completion_package_sent_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(sentAt.slice(0, 19).replace("T", " "), sentAt, jobId)
    .run();

  const trigger = await triggerNotification(env, "completion_package_sent", {
    jobId,
    clientId: job?.client_id ?? null,
    linkPath: job?.portal_token ? `/portal/${job.portal_token}/completion-package` : null,
    instanceKey: jobId,
    merge: {
      portal_url: portalUrl,
      warranty_expiry_date: warrantyExpiry,
      google_review_link: googleReviewLink,
    },
  });

  await logAudit(env, user.email, "completion_package.send", jobId, {
    sent_at: sentAt,
    notifications_enqueued: trigger.enqueued,
  });

  return json({
    ok: true,
    package_status: "sent",
    sent_at: sentAt,
    notifications_enqueued: trigger.enqueued,
    notification_reasons: trigger.reasons,
  });
}
