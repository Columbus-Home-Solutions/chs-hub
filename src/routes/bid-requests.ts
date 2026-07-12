/**
 * Multi-Vendor Bid Solicitation API (Sprint 38 Run 3).
 *
 * Owner-facing (authenticated):
 *   POST  /api/bid-requests               create + invite subs
 *   POST  /api/bid-requests/:id/photos    owner attaches reference photos
 *   GET   /api/bid-requests/:id           comparison view (owner always sees everything)
 *   POST  /api/bid-requests/:id/award     pick winner, update vendor_materials + estimate line
 *
 * Sub-facing (unauthenticated, token-gated):
 *   GET   /api/bid/:token                 scope details (sealed mode hides other subs' prices)
 *   GET   /api/bid/:token/photos/:photoId reference photo stream
 *   POST  /api/bid/:token/submit          sub submits price + notes + optional photo
 *
 * Sealed mode: subs can never see each other's submissions. Only the owner sees
 * all prices. Open mode: each sub sees the current price list (their own
 * highlighted) after they view the request.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { createOwnerInApp, sendSubEmail } from "../lib/notification-engine.js";
import { getTwilioConfig, sendSms } from "../lib/twilio.js";
import { applyVendorMaterialPriceUpdate } from "../lib/receipt-matching.js";
import { putImage, streamObject } from "../lib/r2.js";
import { assignAwardedBidToJobIfExists } from "../lib/bid-job-assignment.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  const n = parseFloat(String(v ?? ""));
  return isNaN(n) ? null : n;
}

/** Generate a compact unguessable token (32-char hex). */
function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Send a simple invite SMS to a sub via Twilio.
 * Non-fatal: logs a warning but does not throw if Twilio is unconfigured.
 */
async function sendBidInviteSms(
  env: Env,
  phone: string | null,
  subName: string,
  scopeTitle: string,
  bidLink: string,
): Promise<void> {
  if (!phone) return;
  const cfg = await getTwilioConfig(env);
  const body =
    `CHS: Hi ${subName}, we're collecting price quotes for "${scopeTitle}". Submit your bid here: ${bidLink}`;
  const result = await sendSms(cfg, phone, body);
  if (!result.ok) {
    console.warn(`[bid-invite] SMS to ${phone} failed: ${result.error}`);
  }
}

/**
 * Send a simple "thanks, went another direction" SMS to a losing sub.
 * Non-fatal.
 */
async function sendLoserSms(
  env: Env,
  phone: string | null,
  subName: string,
  scopeTitle: string,
): Promise<void> {
  if (!phone) return;
  const cfg = await getTwilioConfig(env);
  const body =
    `CHS: Hi ${subName}, thanks for submitting your quote for "${scopeTitle}". We went another direction this time, but we appreciate you bidding.`;
  const result = await sendSms(cfg, phone, body);
  if (!result.ok) {
    console.warn(`[bid-loser] SMS to ${phone} failed: ${result.error}`);
  }
}

// ── internal data types ──────────────────────────────────────────────────────

interface BidRequestRow {
  id: string;
  estimate_id: string | null;
  job_id: string | null;
  estimate_sub_item_id: string | null;
  title: string;
  scope_description: string;
  quantities_notes: string | null;
  needed_by_date: string | null;
  status: string;
  bid_mode: string;
  notify_losers: number;
  awarded_sub_id: string | null;
  awarded_bid_id: string | null;
  created_at: string;
}

interface RecipientRow {
  id: string;
  bid_request_id: string;
  sub_id: string;
  portal_token: string;
  sent_at: string | null;
  viewed_at: string | null;
  created_at: string;
  // joined from subcontractors
  company_name: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  phone: string | null;
  email: string | null;
}

interface SubmissionRow {
  id: string;
  bid_request_id: string;
  sub_id: string;
  price: number;
  notes: string | null;
  attachment_photo_id: string | null;
  status: string;
  submitted_at: string;
}

interface ReferencePhotoRow {
  id: string;
  caption: string | null;
  created_at: string;
}

async function listReferencePhotos(
  env: Env,
  bidRequestId: string,
): Promise<ReferencePhotoRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, caption, created_at
       FROM photos
      WHERE bid_request_id = ?
        AND photo_type = 'bid_request'
        AND COALESCE(is_active, 1) = 1
      ORDER BY created_at ASC`,
  )
    .bind(bidRequestId)
    .all<ReferencePhotoRow>();
  return rows.results ?? [];
}

// ── GET /api/bid-requests?job_id=&estimate_id= ───────────────────────────────

export async function handleListBidRequests(request: Request, env: Env): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const url = new URL(request.url);
  const jobId = url.searchParams.get("job_id") || null;
  const estimateId = url.searchParams.get("estimate_id") || null;

  // Cross-job mode: no job_id or estimate_id → return all open bid requests across
  // active jobs, sorted by staleness (days open desc). Used by the dashboard widget.
  if (!jobId && !estimateId) {
    const crossJobRows = await env.DB.prepare(
      `SELECT br.id, br.title, br.job_id, j.title AS job_title, br.created_at,
              CAST((julianday('now') - julianday(br.created_at)) AS INTEGER) AS days_open,
              (SELECT COUNT(*) FROM bid_request_recipients WHERE bid_request_id = br.id) AS recipient_count,
              (SELECT COUNT(*) FROM bid_submissions WHERE bid_request_id = br.id) AS submission_count
         FROM bid_requests br
         LEFT JOIN jobs j ON j.id = br.job_id
        WHERE br.status = 'open'
        ORDER BY days_open DESC
        LIMIT 20`,
    ).all<{
      id: string;
      title: string;
      job_id: string | null;
      job_title: string | null;
      created_at: string;
      days_open: number;
      recipient_count: number;
      submission_count: number;
    }>();
    return json({ open_bids: crossJobRows.results ?? [] });
  }

  const rows = jobId
    ? await env.DB.prepare(
        `SELECT br.id, br.title, br.status, br.bid_mode, br.notify_losers,
                br.awarded_sub_id, br.awarded_bid_id, br.created_at, br.estimate_sub_item_id,
                (SELECT COUNT(*) FROM bid_request_recipients WHERE bid_request_id = br.id) AS recipient_count,
                (SELECT COUNT(*) FROM bid_submissions WHERE bid_request_id = br.id) AS submission_count
           FROM bid_requests br WHERE br.job_id = ? ORDER BY br.created_at DESC`,
      )
        .bind(jobId)
        .all<BidRequestRow & { recipient_count: number; submission_count: number }>()
    : await env.DB.prepare(
        `SELECT br.id, br.title, br.status, br.bid_mode, br.notify_losers,
                br.awarded_sub_id, br.awarded_bid_id, br.created_at, br.estimate_sub_item_id,
                (SELECT COUNT(*) FROM bid_request_recipients WHERE bid_request_id = br.id) AS recipient_count,
                (SELECT COUNT(*) FROM bid_submissions WHERE bid_request_id = br.id) AS submission_count
           FROM bid_requests br WHERE br.estimate_id = ? ORDER BY br.created_at DESC`,
      )
        .bind(estimateId)
        .all<BidRequestRow & { recipient_count: number; submission_count: number }>();

  return json({ bid_requests: rows.results ?? [] });
}

// ── POST /api/bid-requests ────────────────────────────────────────────────────

export async function handleCreateBidRequest(request: Request, env: Env): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const title = str(body.title);
  const scopeDescription = str(body.scope_description);
  if (!title) return err(400, "title_required");
  if (!scopeDescription) return err(400, "scope_description_required");

  const estimateId = str(body.estimate_id);
  const jobId = str(body.job_id);
  const estimateSubItemId = str(body.estimate_sub_item_id);
  if (!estimateId && !jobId) return err(400, "estimate_id_or_job_id_required");

  const quantitiesNotes = str(body.quantities_notes);
  const neededByDate = str(body.needed_by_date);
  const bidMode = str(body.bid_mode) === "open" ? "open" : "sealed";
  const notifyLosers = body.notify_losers === false || body.notify_losers === 0 ? 0 : 1;

  const inviteSubIds: string[] = Array.isArray(body.sub_ids)
    ? (body.sub_ids as unknown[]).map(String).filter(Boolean)
    : [];
  if (inviteSubIds.length === 0) return err(400, "at_least_one_sub_required");

  // Validate that all invited subs are active
  const placeholders = inviteSubIds.map(() => "?").join(",");
  const activeSubs = await env.DB.prepare(
    `SELECT id, company_name, contact_name, primary_contact, phone, email
       FROM subcontractors WHERE id IN (${placeholders}) AND is_active = 1`,
  )
    .bind(...inviteSubIds)
    .all<{
      id: string;
      company_name: string | null;
      contact_name: string | null;
      primary_contact: string | null;
      phone: string | null;
      email: string | null;
    }>();

  if ((activeSubs.results ?? []).length !== inviteSubIds.length) {
    return err(400, "one_or_more_subs_inactive_or_not_found");
  }

  const bidRequestId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bid_requests
       (id, estimate_id, job_id, estimate_sub_item_id, title, scope_description,
        quantities_notes, needed_by_date, status, bid_mode, notify_losers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, datetime('now'))`,
  )
    .bind(
      bidRequestId,
      estimateId,
      jobId,
      estimateSubItemId,
      title,
      scopeDescription,
      quantitiesNotes,
      neededByDate,
      bidMode,
      notifyLosers,
    )
    .run();

  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");

  for (const sub of activeSubs.results ?? []) {
    const recipientId = crypto.randomUUID();
    const portalToken = generateToken();
    const bidLink = `${origin}/bid/${portalToken}`;

    await env.DB.prepare(
      `INSERT INTO bid_request_recipients (id, bid_request_id, sub_id, portal_token, sent_at, created_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
      .bind(recipientId, bidRequestId, sub.id, portalToken)
      .run();

    // Send SMS invite (primary, non-fatal)
    const subName = sub.contact_name || sub.primary_contact || sub.company_name || "there";
    await sendBidInviteSms(env, sub.phone, subName, title, bidLink);

    // Additive email invite alongside SMS when sub has email on file
    if (sub.email) {
      const emailBody =
        `Hi ${subName},\n\nColumbus Home Solutions is collecting price quotes for "${title}". ` +
        `Please review the scope and submit your bid here:\n${bidLink}\n\n` +
        `Thank you for bidding with us!`;
      await sendSubEmail(
        env,
        sub.email,
        `Bid Request: ${title}`,
        emailBody,
      );
    }
  }

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'bid_request_created', 'bid_request', ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      authed.user.email,
      bidRequestId,
      JSON.stringify({ title, sub_count: inviteSubIds.length }),
    )
    .run();

  return json({ id: bidRequestId, status: "open", invited_count: inviteSubIds.length }, 201);
}

// ── POST /api/bid-requests/:id/photos ─────────────────────────────────────────

export async function handleUploadBidRequestPhotos(
  request: Request,
  env: Env,
  bidRequestId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const br = await env.DB.prepare(`SELECT id FROM bid_requests WHERE id = ?`)
    .bind(bidRequestId)
    .first<{ id: string }>();
  if (!br) return err(404, "not_found");

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) return err(400, "multipart_required");

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return err(400, "invalid_form_data");
  }

  const files: File[] = [];
  for (const [key, value] of formData.entries()) {
    if ((key === "photo" || key === "photos") && value instanceof File && value.size > 0) {
      files.push(value);
    }
  }
  if (files.length === 0) return err(400, "no_photos");

  const uploaded: Array<{ id: string; thumb_url: string; original_url: string }> = [];
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) return err(413, "photo_too_large");
    if (!env.FILES) return err(503, "storage_unavailable");

    const photoId = crypto.randomUUID();
    const now = new Date().toISOString();
    const bytes = await file.arrayBuffer();
    const r2Key = `bid-request-photos/${bidRequestId}/${photoId}.jpg`;
    await putImage(env, r2Key, bytes, file.type || "image/jpeg");

    await env.DB.prepare(
      `INSERT INTO photos (id, created_at, taken_at, job_id, category, r2_key, thumb_key,
          caption, photo_type, r2_url, uploaded_at, is_active, entered_via, bid_request_id,
          uploaded_by, created_by)
       VALUES (?, ?, ?, NULL, 'progress', ?, ?, ?, 'bid_request', ?, ?, 1, 'dashboard', ?, ?, ?)`,
    )
      .bind(
        photoId,
        now,
        now,
        r2Key,
        r2Key,
        file.name || "Bid reference photo",
        `/api/photos/${photoId}`,
        now,
        bidRequestId,
        authed.user.email,
        authed.user.email,
      )
      .run();

    uploaded.push({
      id: photoId,
      thumb_url: `/api/photos/${photoId}/thumb`,
      original_url: `/api/photos/${photoId}`,
    });
  }

  return json({ photos: uploaded }, 201);
}

// ── GET /api/bid-requests/:id ─────────────────────────────────────────────────

export async function handleGetBidRequest(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const br = await env.DB.prepare(
    `SELECT * FROM bid_requests WHERE id = ?`,
  )
    .bind(id)
    .first<BidRequestRow>();
  if (!br) return err(404, "not_found");

  const recipients = await env.DB.prepare(
    `SELECT r.id, r.bid_request_id, r.sub_id, r.portal_token, r.sent_at, r.viewed_at, r.created_at,
            s.company_name, s.contact_name, s.primary_contact, s.phone, s.email
       FROM bid_request_recipients r
       JOIN subcontractors s ON s.id = r.sub_id
      WHERE r.bid_request_id = ?
      ORDER BY r.created_at ASC`,
  )
    .bind(id)
    .all<RecipientRow>();

  const submissions = await env.DB.prepare(
    `SELECT * FROM bid_submissions WHERE bid_request_id = ? ORDER BY submitted_at ASC`,
  )
    .bind(id)
    .all<SubmissionRow>();

  const submissionBySub = new Map<string, SubmissionRow>();
  for (const s of submissions.results ?? []) {
    submissionBySub.set(s.sub_id, s);
  }

  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");

  const subs = (recipients.results ?? []).map((r) => {
    const sub = submissionBySub.get(r.sub_id) ?? null;
    return {
      recipient_id: r.id,
      sub_id: r.sub_id,
      name: r.contact_name || r.primary_contact || r.company_name || r.sub_id,
      company: r.company_name,
      phone: r.phone,
      email: r.email,
      portal_token: r.portal_token,
      bid_link: `${origin}/bid/${r.portal_token}`,
      sent_at: r.sent_at,
      viewed_at: r.viewed_at,
      submission: sub
        ? {
            id: sub.id,
            price: sub.price,
            notes: sub.notes,
            attachment_photo_id: sub.attachment_photo_id,
            status: sub.status,
            submitted_at: sub.submitted_at,
          }
        : null,
    };
  });

  const referencePhotos = await listReferencePhotos(env, id);

  return json({
    ...br,
    subs,
    reference_photos: referencePhotos.map((p) => ({
      id: p.id,
      caption: p.caption,
      thumb_url: `/api/photos/${p.id}/thumb`,
      original_url: `/api/photos/${p.id}`,
    })),
  });
}

// ── POST /api/bid-requests/:id/award ─────────────────────────────────────────

export async function handleAwardBid(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager"]);
  if (authed instanceof Response) return authed;

  const br = await env.DB.prepare(`SELECT * FROM bid_requests WHERE id = ?`)
    .bind(id)
    .first<BidRequestRow>();
  if (!br) return err(404, "not_found");
  if (br.status === "awarded") return err(409, "already_awarded");

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const winningSubmissionId = str(body.submission_id);
  if (!winningSubmissionId) return err(400, "submission_id_required");

  const winningSubmission = await env.DB.prepare(
    `SELECT * FROM bid_submissions WHERE id = ? AND bid_request_id = ?`,
  )
    .bind(winningSubmissionId, id)
    .first<SubmissionRow>();
  if (!winningSubmission) return err(404, "submission_not_found");

  // Resolve the winning sub
  const winningSub = await env.DB.prepare(
    `SELECT id, company_name, contact_name, primary_contact, phone
       FROM subcontractors WHERE id = ?`,
  )
    .bind(winningSubmission.sub_id)
    .first<{
      id: string;
      company_name: string | null;
      contact_name: string | null;
      primary_contact: string | null;
      phone: string | null;
    }>();

  // ── Update bid_requests ────────────────────────────────────────────────────
  await env.DB.prepare(
    `UPDATE bid_requests
        SET status = 'awarded', awarded_sub_id = ?, awarded_bid_id = ?
      WHERE id = ?`,
  )
    .bind(winningSubmission.sub_id, winningSubmissionId, id)
    .run();

  // ── Mark submissions as won/lost ──────────────────────────────────────────
  await env.DB.prepare(
    `UPDATE bid_submissions SET status = 'won' WHERE id = ?`,
  )
    .bind(winningSubmissionId)
    .run();

  await env.DB.prepare(
    `UPDATE bid_submissions
        SET status = 'lost'
      WHERE bid_request_id = ? AND id != ? AND status = 'submitted'`,
  )
    .bind(id, winningSubmissionId)
    .run();

  // ── Update vendor_materials if tied to a sub item with a material_id ──────
  if (br.estimate_sub_item_id) {
    const subItem = await env.DB.prepare(
      `SELECT id, material_id, quantity FROM estimate_sub_items WHERE id = ?`,
    )
      .bind(br.estimate_sub_item_id)
      .first<{ id: string; material_id: string | null; quantity: number | null }>();

    if (subItem) {
      const qty = subItem.quantity ?? 1;
      const unitCost = Math.round((winningSubmission.price / qty) * 100) / 100;
      const totalCost = Math.round(winningSubmission.price * 100) / 100;

      // Update the estimate sub-item cost
      await env.DB.prepare(
        `UPDATE estimate_sub_items SET unit_cost = ?, total_cost = ? WHERE id = ?`,
      )
        .bind(unitCost, totalCost, br.estimate_sub_item_id)
        .run();

      // Update vendor_materials catalog if the item references a material
      if (subItem.material_id) {
        const today = new Date().toISOString().slice(0, 10);
        await applyVendorMaterialPriceUpdate(
          env.DB,
          subItem.material_id,
          winningSubmission.price,
          today,
        );
      }
    }
  }

  // ── Job schedule assignment when job already exists (post-conversion award) ─
  await assignAwardedBidToJobIfExists(env, br, winningSubmission.sub_id);

  // ── Notify losing subs (if notify_losers = 1) ─────────────────────────────
  if (br.notify_losers === 1) {
    const losers = await env.DB.prepare(
      `SELECT bs.sub_id, s.phone, s.email, s.company_name, s.contact_name, s.primary_contact
         FROM bid_submissions bs
         JOIN subcontractors s ON s.id = bs.sub_id
        WHERE bs.bid_request_id = ? AND bs.id != ? AND bs.status = 'lost'`,
    )
      .bind(id, winningSubmissionId)
      .all<{
        sub_id: string;
        phone: string | null;
        email: string | null;
        company_name: string | null;
        contact_name: string | null;
        primary_contact: string | null;
      }>();

    for (const loser of losers.results ?? []) {
      const loserName =
        loser.contact_name || loser.primary_contact || loser.company_name || "there";
      await sendLoserSms(env, loser.phone, loserName, br.title);

      // Additive email notification alongside SMS when sub has email on file
      if (loser.email) {
        const emailBody =
          `Hi ${loserName},\n\nThank you for submitting your quote for "${br.title}". ` +
          `We went another direction this time, but we appreciate you bidding and hope to work with you in the future.\n\n` +
          `— Columbus Home Solutions`;
        await sendSubEmail(
          env,
          loser.email,
          `Bid Update: ${br.title}`,
          emailBody,
        );
      }
    }
  }

  // ── Owner in-app audit notification ───────────────────────────────────────
  const winnerName =
    winningSub?.contact_name ||
    winningSub?.primary_contact ||
    winningSub?.company_name ||
    "Sub";
  await createOwnerInApp(env, {
    message: `Bid awarded for "${br.title}" to ${winnerName} at $${winningSubmission.price.toFixed(2)}.`,
    linkPath: `/estimates${br.estimate_id ? `/${br.estimate_id}` : ""}`,
    dedupe: null,
  });

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'bid_awarded', 'bid_request', ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      authed.user.email,
      id,
      JSON.stringify({
        winning_submission_id: winningSubmissionId,
        price: winningSubmission.price,
        sub_id: winningSubmission.sub_id,
      }),
    )
    .run();

  return json({ ok: true, awarded_to: winningSubmission.sub_id });
}

// ── GET /api/bid/:token  (sub-facing, no auth) ────────────────────────────────

export async function handleBidLanding(
  _request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const recipient = await env.DB.prepare(
    `SELECT r.id AS recipient_id, r.bid_request_id, r.sub_id, r.viewed_at,
            s.company_name, s.contact_name, s.primary_contact, s.phone
       FROM bid_request_recipients r
       JOIN subcontractors s ON s.id = r.sub_id
      WHERE r.portal_token = ?`,
  )
    .bind(token)
    .first<{
      recipient_id: string;
      bid_request_id: string;
      sub_id: string;
      viewed_at: string | null;
      company_name: string | null;
      contact_name: string | null;
      primary_contact: string | null;
      phone: string | null;
    }>();

  if (!recipient) return err(404, "invalid_token");

  const br = await env.DB.prepare(`SELECT * FROM bid_requests WHERE id = ?`)
    .bind(recipient.bid_request_id)
    .first<BidRequestRow>();
  if (!br) return err(404, "not_found");

  // Mark viewed if first time
  if (!recipient.viewed_at) {
    await env.DB.prepare(
      `UPDATE bid_request_recipients SET viewed_at = datetime('now') WHERE id = ?`,
    )
      .bind(recipient.recipient_id)
      .run();
  }

  // Check if this sub has already submitted
  const mySubmission = await env.DB.prepare(
    `SELECT id, price, notes, status, submitted_at
       FROM bid_submissions WHERE bid_request_id = ? AND sub_id = ?`,
  )
    .bind(recipient.bid_request_id, recipient.sub_id)
    .first<{
      id: string;
      price: number;
      notes: string | null;
      status: string;
      submitted_at: string;
    }>();

  // Other submissions visible only in open mode (sealed = hidden from subs)
  let otherSubmissions: Array<{ price: number; submitted_at: string }> = [];
  if (br.bid_mode === "open" && mySubmission) {
    const others = await env.DB.prepare(
      `SELECT price, submitted_at FROM bid_submissions
        WHERE bid_request_id = ? AND sub_id != ?
        ORDER BY price ASC`,
    )
      .bind(recipient.bid_request_id, recipient.sub_id)
      .all<{ price: number; submitted_at: string }>();
    otherSubmissions = others.results ?? [];
  }

  const subName =
    recipient.contact_name || recipient.primary_contact || recipient.company_name || "there";

  const referencePhotoRows = await listReferencePhotos(env, br.id);

  return json({
    bid_request_id: br.id,
    title: br.title,
    scope_description: br.scope_description,
    quantities_notes: br.quantities_notes,
    needed_by_date: br.needed_by_date,
    status: br.status,
    bid_mode: br.bid_mode,
    sub_name: subName,
    my_submission: mySubmission ?? null,
    // Only populated in open mode after the viewing sub has submitted
    other_submissions: otherSubmissions,
    reference_photos: referencePhotoRows.map((p) => ({
      id: p.id,
      caption: p.caption,
      image_url: `/api/bid/${token}/photos/${p.id}`,
    })),
  });
}

// ── POST /api/bid/:token/submit (sub-facing, no auth) ─────────────────────────

export async function handleBidSubmit(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const recipient = await env.DB.prepare(
    `SELECT r.id AS recipient_id, r.bid_request_id, r.sub_id,
            s.company_name, s.contact_name, s.primary_contact
       FROM bid_request_recipients r
       JOIN subcontractors s ON s.id = r.sub_id
      WHERE r.portal_token = ?`,
  )
    .bind(token)
    .first<{
      recipient_id: string;
      bid_request_id: string;
      sub_id: string;
      company_name: string | null;
      contact_name: string | null;
      primary_contact: string | null;
    }>();

  if (!recipient) return err(404, "invalid_token");

  const br = await env.DB.prepare(
    `SELECT id, title, status FROM bid_requests WHERE id = ?`,
  )
    .bind(recipient.bid_request_id)
    .first<{ id: string; title: string; status: string }>();

  if (!br) return err(404, "not_found");
  if (br.status !== "open") return err(409, "bid_closed", "This bid request is no longer accepting submissions.");

  // Prevent duplicate submission from the same sub
  const existing = await env.DB.prepare(
    `SELECT id FROM bid_submissions WHERE bid_request_id = ? AND sub_id = ?`,
  )
    .bind(recipient.bid_request_id, recipient.sub_id)
    .first<{ id: string }>();
  if (existing) return err(409, "already_submitted", "You have already submitted a bid for this request.");

  // Parse submission — supports both JSON and multipart (for photo upload)
  const contentType = request.headers.get("content-type") ?? "";
  let price: number | null = null;
  let notes: string | null = null;
  let photoBytes: ArrayBuffer | null = null;
  let photoContentType: string | null = null;

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return err(400, "invalid_form_data");
    }
    price = num(formData.get("price"));
    notes = str(formData.get("notes"));
    const photoFile = formData.get("photo") as File | null;
    if (photoFile && photoFile.size > 0) {
      if (photoFile.size > 15 * 1024 * 1024) return err(413, "photo_too_large");
      photoBytes = await photoFile.arrayBuffer();
      photoContentType = photoFile.type || "image/jpeg";
    }
  } else {
    const body = await readJson(request);
    if (!body) return err(400, "invalid_json");
    price = num(body.price);
    notes = str(body.notes);
  }

  if (price === null || price <= 0) return err(400, "price_required", "A positive price is required.");

  // Store optional photo attachment
  let photoId: string | null = null;
  if (photoBytes && env.FILES) {
    photoId = crypto.randomUUID();
    const now = new Date().toISOString();
    const r2Key = `bid-attachments/${recipient.bid_request_id}/${photoId}.jpg`;
    await putImage(env, r2Key, photoBytes, photoContentType ?? "image/jpeg");
    // photos.thumb_key is NOT NULL — point at the full image when no separate thumb exists.
    await env.DB.prepare(
      `INSERT INTO photos (id, created_at, taken_at, job_id, category, r2_key, thumb_key,
          caption, photo_type, r2_url, uploaded_at, is_active, entered_via)
       VALUES (?, ?, ?, NULL, 'progress', ?, ?, ?, 'bid_attachment', ?, ?, 1, 'bid_link')`,
    )
      .bind(
        photoId,
        now,
        now,
        r2Key,
        r2Key,
        "Bid submission attachment",
        `/api/photos/${photoId}`,
        now,
      )
      .run();
  }

  const submissionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO bid_submissions (id, bid_request_id, sub_id, price, notes, attachment_photo_id, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', datetime('now'))`,
  )
    .bind(submissionId, recipient.bid_request_id, recipient.sub_id, price, notes, photoId)
    .run();

  // Notify owner in-app
  const subName =
    recipient.contact_name || recipient.primary_contact || recipient.company_name || "Sub";
  await createOwnerInApp(env, {
    message: `${subName} submitted a bid of $${price.toFixed(2)} for "${br.title}".`,
    linkPath: `/bid-requests/${br.id}`,
    dedupe: `bid-received:${submissionId}`,
  });

  return json({ ok: true, submission_id: submissionId }, 201);
}

// ── GET /api/bid/:token/photos/:photoId (sub-facing reference photo) ───────────

export async function handleBidPublicPhoto(
  env: Env,
  token: string,
  photoId: string,
): Promise<Response> {
  const recipient = await env.DB.prepare(
    `SELECT bid_request_id FROM bid_request_recipients WHERE portal_token = ?`,
  )
    .bind(token)
    .first<{ bid_request_id: string }>();
  if (!recipient) return err(404, "invalid_token");

  const photo = await env.DB.prepare(
    `SELECT r2_key FROM photos
      WHERE id = ?
        AND bid_request_id = ?
        AND photo_type = 'bid_request'
        AND COALESCE(is_active, 1) = 1`,
  )
    .bind(photoId, recipient.bid_request_id)
    .first<{ r2_key: string | null }>();
  if (!photo?.r2_key) return err(404, "photo_not_found");

  const streamed = await streamObject(env, photo.r2_key);
  return streamed ?? err(404, "photo_missing");
}
