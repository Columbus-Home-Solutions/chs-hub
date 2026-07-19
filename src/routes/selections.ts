/**
 * Selections & Allowances API (Sprint 38 Run 4).
 *
 * Owner-facing (authenticated):
 *   POST  /api/estimates/:id/selections         create selection (LOCKED after estimate sent)
 *   POST  /api/jobs/:id/selections              create selection mid-job
 *   POST  /api/selections/:id/choices           add choices to existing selection
 *   PUT   /api/selections/:id                     update allowance (pending only)
 *   PUT   /api/selections/:id/choices/:choiceId   update choice (pending only)
 *   GET   /api/estimates/:id/selections         list selections for estimate
 *   GET   /api/jobs/:id/selections              list selections for job (owner view)
 *
 * Portal / client-facing (token-gated):
 *   GET   /api/portal/:token/selections         client views pending+approved selections
 *   POST  /api/portal/:token/selections/:id/approve  client picks a choice → BoldSign
 *   GET   /api/portal/:token/selections/:id/sign-link  embedded sign link fallback
 *
 * Quote / client-facing (estimate portal_token, pre-job):
 *   GET   /api/public/quote/:token/selections
 *   POST  /api/public/quote/:token/selections/:id/choose
 *   POST  /api/public/quote/:token/selections/confirm-all
 *   GET   /api/public/quote/:token/selections/sign-link
 *   POST  /api/public/quote/:token/selections/:id/approve  (legacy alias → choose only)
 *
 * Estimate lock rule: selections/allowances may only be created while the
 * estimate is in a pre-send status. This mirrors real-world practice.
 * Lock states: sent, viewed, approved, won, lost, revised.
 *
 * Budget delta: on approval, if choice.price > selection.allowance_amount,
 * the overage is added to jobs.contract_total using the same UPDATE that
 * applyChangeOrder uses — no second budget engine.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { createOwnerInApp } from "../lib/notification-engine.js";
import {
  downloadSignedDocument,
  getBoldSignConfig,
  getEmbeddedSignLink,
  revokeDocument,
  sendDocumentForSignature,
} from "../lib/boldsign.js";
import { generateDocument, formatCurrency } from "../lib/document-generator.js";
import { resolveMergeFields } from "../lib/merge-fields.js";

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

/** States where the estimate is locked for new selections. */
const LOCKED_STATUSES = new Set(["sent", "viewed", "approved", "won", "lost", "revised"]);

interface SelectionRow {
  id: string;
  estimate_id: string | null;
  job_id: string | null;
  estimate_sub_item_id: string | null;
  title: string;
  category: string | null;
  location: string | null;
  allowance_amount: number;
  is_shared_allowance: number;
  shared_allowance_group_id: string | null;
  required: number;
  deadline_date: string | null;
  public_instructions: string | null;
  internal_notes: string | null;
  status: string;
  chosen_choice_id: string | null;
  created_at: string;
}

interface ChoiceRow {
  id: string;
  selection_id: string;
  title: string;
  description: string | null;
  price: number;
  photo_ids: string | null;
  vendor_name: string | null;
  is_client_added: number;
  approved: number;
  approved_at: string | null;
  client_signature_document_id: string | null;
  created_at: string;
}

async function loadChoices(env: Env, selectionId: string): Promise<ChoiceRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM selection_choices WHERE selection_id = ? ORDER BY created_at ASC`,
  )
    .bind(selectionId)
    .all<ChoiceRow>();
  return result.results ?? [];
}

function shapeSelection(s: SelectionRow, choices: ChoiceRow[]) {
  return {
    id: s.id,
    estimate_id: s.estimate_id,
    job_id: s.job_id,
    estimate_sub_item_id: s.estimate_sub_item_id,
    title: s.title,
    category: s.category,
    location: s.location,
    allowance_amount: s.allowance_amount,
    is_shared_allowance: s.is_shared_allowance === 1,
    required: s.required === 1,
    deadline_date: s.deadline_date,
    public_instructions: s.public_instructions,
    status: s.status,
    chosen_choice_id: s.chosen_choice_id,
    created_at: s.created_at,
    choices: choices.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      price: c.price,
      photo_ids: c.photo_ids ? (JSON.parse(c.photo_ids) as string[]) : [],
      vendor_name: c.vendor_name,
      is_client_added: c.is_client_added === 1,
      approved: c.approved === 1,
      approved_at: c.approved_at,
      client_signature_document_id: c.client_signature_document_id,
    })),
  };
}

/** R2 path for the Selection Choice Approval DOCX (server-side merge + text-tag send). */
const SELECTION_APPROVAL_TEMPLATE_R2 = "documents/templates/selection-choice-approval.docx";
/** Quote-stage combined approval — one signature for all estimate selections. */
const SELECTION_COMBINED_APPROVAL_TEMPLATE_R2 = "documents/templates/selection-combined-approval.docx";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** BoldSign document/send is async — embed link often 403s if fetched immediately. */
async function fetchEmbeddedSignLinkWithRetry(
  config: Awaited<ReturnType<typeof getBoldSignConfig>>,
  documentId: string,
  signerEmail: string,
  redirectUrl: string,
  attempts = 4,
): Promise<string | null> {
  if (!config) return null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const linkResult = await getEmbeddedSignLink(config, documentId, signerEmail, redirectUrl);
      return linkResult.signLink ?? null;
    } catch (linkErr) {
      const msg = (linkErr as Error).message;
      console.warn(
        `[selections] getEmbeddedSignLink attempt ${attempt + 1}/${attempts} failed: ${msg}`,
      );
      if (attempt === attempts - 1) return null;
    }
  }
  return null;
}

async function loadCombinedSelectionSignDocument(
  env: Env,
  estimateId: string,
): Promise<{ id: string; signature_data: string } | null> {
  return env.DB.prepare(
    `SELECT id, signature_data
       FROM documents
      WHERE context_type = 'selection'
        AND document_category = 'selection_approval'
        AND COALESCE(is_active, 1) = 1
        AND json_extract(signature_data, '$.combined') = 1
        AND json_extract(signature_data, '$.estimate_id') = ?
      ORDER BY datetime(created_at) DESC
      LIMIT 1`,
  )
    .bind(estimateId)
    .first<{ id: string; signature_data: string }>();
}

/** BoldSign doc for an individual (per-selection) portal approval awaiting signature. */
async function loadIndividualSelectionSignDocument(
  env: Env,
  selectionId: string,
): Promise<{ boldsign_document_id: string; choice_id: string } | null> {
  const choice = await env.DB.prepare(
    `SELECT id, client_signature_document_id
       FROM selection_choices
      WHERE selection_id = ?
        AND client_signature_document_id IS NOT NULL
      ORDER BY datetime(created_at) DESC
      LIMIT 1`,
  )
    .bind(selectionId)
    .first<{ id: string; client_signature_document_id: string }>();
  if (!choice) return null;

  const docRow = await env.DB.prepare(
    `SELECT signature_data FROM documents WHERE id = ?`,
  )
    .bind(choice.client_signature_document_id)
    .first<{ signature_data: string }>();
  if (!docRow) return null;

  try {
    const sigData = JSON.parse(docRow.signature_data) as { boldsign_document_id?: string };
    if (!sigData.boldsign_document_id) return null;
    return { boldsign_document_id: sigData.boldsign_document_id, choice_id: choice.id };
  } catch {
    return null;
  }
}

/** Build merge-field map for the Selection Choice Approval DOCX template. */
interface SelectionClientContext {
  estimateId: string;
  jobId: string | null;
  clientId: string | null;
  clientEmail: string | null;
  clientName: string;
  estimateNumber: number | null;
  estimateTitle: string | null;
}

async function buildSelectionApprovalMergeFields(
  env: Env,
  ctx: SelectionClientContext,
  sel: SelectionRow,
  choice: ChoiceRow,
): Promise<Record<string, string>> {
  const base = ctx.jobId
    ? await resolveMergeFields(env, { job_id: ctx.jobId })
    : await resolveMergeFields(env, { estimate_id: ctx.estimateId, client_id: ctx.clientId });
  const overage = Math.max(0, choice.price - sel.allowance_amount);
  const merged: Record<string, string> = {
    ...base,
    client_name: base.client_name || ctx.clientName,
    job_title: base.job_title || ctx.estimateTitle || "",
    job_number:
      base.job_number ||
      (ctx.estimateNumber != null ? `EST-${String(ctx.estimateNumber).padStart(3, "0")}` : ""),
    selection_title: sel.title,
    selection_category: sel.category ?? "",
    selection_location: sel.location ?? "",
    allowance_amount: formatCurrency(sel.allowance_amount),
    choice_title: choice.title,
    choice_vendor: choice.vendor_name ?? "",
    choice_description: choice.description ?? "",
    choice_price: formatCurrency(choice.price),
    overage_amount: overage > 0 ? formatCurrency(overage) : "$0.00",
  };
  const FIELD_IDS = [
    "client_name",
    "property_address",
    "job_title",
    "job_number",
    "today_date",
    "selection_title",
    "selection_category",
    "selection_location",
    "allowance_amount",
    "choice_title",
    "choice_vendor",
    "choice_description",
    "choice_price",
    "overage_amount",
  ] as const;
  const valuesByTag: Record<string, string> = {};
  for (const id of FIELD_IDS) valuesByTag[id] = merged[id] ?? "";
  return valuesByTag;
}

/** Build merge fields for the combined quote-stage selection approval document. */
async function buildCombinedSelectionApprovalMergeFields(
  env: Env,
  ctx: SelectionClientContext,
  pairs: Array<{ sel: SelectionRow; choice: ChoiceRow }>,
): Promise<Record<string, string>> {
  const base = await resolveMergeFields(env, { estimate_id: ctx.estimateId, client_id: ctx.clientId });
  let totalOverage = 0;
  const summaryLines = pairs.map(({ sel, choice }) => {
    const overage = Math.max(0, choice.price - sel.allowance_amount);
    totalOverage += overage;
    const overStr = overage > 0 ? ` (+${formatCurrency(overage)} over allowance)` : "";
    const vendor = choice.vendor_name ? ` — ${choice.vendor_name}` : "";
    return `• ${sel.title}: ${choice.title}${vendor} — ${formatCurrency(choice.price)}${overStr}`;
  });
  totalOverage = Math.round(totalOverage * 100) / 100;

  const merged: Record<string, string> = {
    ...base,
    client_name: base.client_name || ctx.clientName,
    job_title: base.job_title || ctx.estimateTitle || "",
    job_number:
      base.job_number ||
      (ctx.estimateNumber != null ? `EST-${String(ctx.estimateNumber).padStart(3, "0")}` : ""),
    selections_heading: `Material Selections (${pairs.length})`,
    selections_summary: summaryLines.join("\n"),
    total_overage_amount: totalOverage > 0 ? formatCurrency(totalOverage) : "$0.00",
  };
  const FIELD_IDS = [
    "client_name",
    "property_address",
    "job_title",
    "job_number",
    "today_date",
    "selections_heading",
    "selections_summary",
    "total_overage_amount",
  ] as const;
  const valuesByTag: Record<string, string> = {};
  for (const id of FIELD_IDS) valuesByTag[id] = merged[id] ?? "";
  return valuesByTag;
}

async function executeSelectionChoose(
  env: Env,
  ctx: SelectionClientContext,
  selectionId: string,
  choiceId: string,
): Promise<Response> {
  const sel = await env.DB.prepare(
    `SELECT * FROM selections
      WHERE id = ?
        AND ((? != '' AND estimate_id = ?) OR (? IS NOT NULL AND job_id = ?))
      LIMIT 1`,
  )
    .bind(selectionId, ctx.estimateId, ctx.estimateId, ctx.jobId, ctx.jobId ?? "__none__")
    .first<SelectionRow>();
  if (!sel) return err(404, "selection_not_found");
  if (sel.status === "approved") {
    return err(409, "already_approved", "This selection has already been approved.");
  }
  if (sel.status === "sent") {
    return err(
      409,
      "signature_pending",
      "A signature request is already pending. Complete or wait for it before changing your pick.",
    );
  }

  const choice = await env.DB.prepare(
    `SELECT * FROM selection_choices WHERE id = ? AND selection_id = ?`,
  )
    .bind(choiceId, selectionId)
    .first<ChoiceRow>();
  if (!choice) return err(404, "choice_not_found");

  await env.DB.prepare(
    `UPDATE selections SET chosen_choice_id = ?, status = 'pending' WHERE id = ?`,
  )
    .bind(choiceId, selectionId)
    .run();

  return json({
    ok: true,
    chosen: true,
    selection_id: selectionId,
    choice_id: choiceId,
    message: "Your choice has been saved. You can change it until you confirm and sign all selections.",
  });
}

/**
 * Revoke + supersede a stuck combined selection BoldSign send (e.g. docs sent
 * during the brief 1pt tag-shrink regression that collapsed signature fields).
 */
async function supersedePendingCombinedSelectionSend(
  env: Env,
  estimateId: string,
): Promise<{ revoked: string[] }> {
  const config = await getBoldSignConfig(env);
  const pendingDocs = await env.DB.prepare(
    `SELECT id, signature_data
       FROM documents
      WHERE context_type = 'selection'
        AND document_category = 'selection_approval'
        AND COALESCE(is_active, 1) = 1
        AND json_extract(signature_data, '$.combined') = 1
        AND json_extract(signature_data, '$.estimate_id') = ?`,
  )
    .bind(estimateId)
    .all<{ id: string; signature_data: string }>();

  const revoked: string[] = [];
  for (const doc of pendingDocs.results ?? []) {
    let boldId: string | undefined;
    try {
      boldId = (JSON.parse(doc.signature_data) as { boldsign_document_id?: string })
        .boldsign_document_id;
    } catch {
      /* ignore */
    }
    if (boldId && config) {
      try {
        await revokeDocument(config, boldId, "Resend — prior signature field was unusable");
        revoked.push(boldId);
      } catch (e) {
        console.warn(
          `[selections] revoke prior combined doc ${boldId}: ${(e as Error).message}`,
        );
      }
    }
    await env.DB.prepare(
      `UPDATE documents
          SET is_active = 0, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(doc.id)
      .run();
  }

  await env.DB.prepare(
    `UPDATE selections
        SET status = 'pending'
      WHERE estimate_id = ?
        AND status = 'sent'`,
  )
    .bind(estimateId)
    .run();

  return { revoked };
}

async function executeCombinedSelectionApproval(
  env: Env,
  ctx: SelectionClientContext,
  redirectPath: string,
  origin: string,
  opts?: { forceResend?: boolean },
): Promise<Response> {
  if (!ctx.estimateId) {
    return err(400, "estimate_required", "Combined selection signing is only available at quote stage.");
  }

  const sels = await env.DB.prepare(
    `SELECT * FROM selections WHERE estimate_id = ? ORDER BY created_at ASC`,
  )
    .bind(ctx.estimateId)
    .all<SelectionRow>();
  let rows = sels.results ?? [];
  if (rows.length === 0) return err(404, "no_selections");

  const unchosen = rows.filter((s) => !s.chosen_choice_id);
  if (unchosen.length > 0) {
    return err(
      409,
      "selections_incomplete",
      `Please choose an option for every allowance (${rows.length - unchosen.length} of ${rows.length} chosen).`,
    );
  }

  const alreadyApproved = rows.filter((s) => s.status === "approved");
  if (alreadyApproved.length === rows.length) {
    return err(409, "already_approved", "All selections have already been approved.");
  }

  let pendingSig = rows.filter((s) => s.status === "sent");
  if (pendingSig.length > 0 && opts?.forceResend) {
    await supersedePendingCombinedSelectionSend(env, ctx.estimateId);
    const refreshed = await env.DB.prepare(
      `SELECT * FROM selections WHERE estimate_id = ? ORDER BY created_at ASC`,
    )
      .bind(ctx.estimateId)
      .all<SelectionRow>();
    rows = refreshed.results ?? [];
    pendingSig = rows.filter((s) => s.status === "sent");
  }

  if (pendingSig.length > 0) {
    return err(
      409,
      "signature_pending",
      "A combined signature request is already pending. Please check your email.",
    );
  }

  const pairs: Array<{ sel: SelectionRow; choice: ChoiceRow }> = [];
  for (const sel of rows) {
    const choice = await env.DB.prepare(
      `SELECT * FROM selection_choices WHERE id = ? AND selection_id = ?`,
    )
      .bind(sel.chosen_choice_id, sel.id)
      .first<ChoiceRow>();
    if (!choice) {
      return err(409, "invalid_choice", `Chosen option for "${sel.title}" is no longer available.`);
    }
    pairs.push({ sel, choice });
  }

  const clientEmail = ctx.clientEmail;
  const clientName = ctx.clientName;
  if (!clientEmail) {
    return err(
      422,
      "client_email_missing",
      "The client does not have an email address on file. Add an email to send the e-signature request.",
    );
  }

  try {
    const config = await getBoldSignConfig(env);
    if (!config) {
      return err(503, "boldsign_not_configured", "BOLDSIGN_API_KEY is not set. Cannot send e-signature request.");
    }

    const templateObj = await env.FILES.get(SELECTION_COMBINED_APPROVAL_TEMPLATE_R2);
    if (!templateObj) {
      console.error(`[selections] Combined approval template missing from R2: ${SELECTION_COMBINED_APPROVAL_TEMPLATE_R2}`);
      return err(
        503,
        "selection_template_missing",
        "The combined Selection Approval template is not configured. Please upload it to R2 and try again.",
      );
    }

    const mergeFields = await buildCombinedSelectionApprovalMergeFields(env, ctx, pairs);
    const docBytes = await generateDocument(await templateObj.arrayBuffer(), mergeFields);
    const docBlob = new Blob([docBytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const estLabel =
      ctx.estimateNumber != null
        ? `EST-${String(ctx.estimateNumber).padStart(3, "0")}`
        : ctx.estimateId.slice(0, 8);
    const docFilename = `Selection-Approvals-${estLabel}.docx`;

    const sendResult = await sendDocumentForSignature(config, {
      fileBlob: docBlob,
      filename: docFilename,
      title: `Material Selections Approval — ${ctx.estimateTitle ?? estLabel}`,
      message: `Please review and sign to confirm your ${pairs.length} material selection${pairs.length === 1 ? "" : "s"}.`,
      signerEmail: clientEmail,
      signerName: clientName,
      useTextTags: true,
    });
    const boldSignDocumentId = sendResult.documentId;

    const docId = crypto.randomUUID();
    const r2Key = `selection-approvals/combined/${ctx.estimateId}/${docId}.pdf`;
    const sigData = JSON.stringify({
      combined: true,
      boldsign_document_id: boldSignDocumentId,
      estimate_id: ctx.estimateId,
      job_id: ctx.jobId,
      selections: pairs.map(({ sel, choice }) => ({
        selection_id: sel.id,
        choice_id: choice.id,
      })),
    });

    await env.DB.prepare(
      `INSERT INTO documents
         (id, title, file_type, file_size, r2_key, r2_url, context_type, document_category,
          client_id, job_id, estimate_id, signature_data, is_active, created_at, updated_at)
       VALUES (?, ?, 'application/pdf', NULL, ?, ?, 'selection', 'selection_approval',
               ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
      .bind(
        docId,
        `Material Selections Approval — ${ctx.estimateTitle ?? estLabel}`,
        r2Key,
        r2Key,
        ctx.clientId,
        ctx.jobId,
        ctx.estimateId,
        sigData,
      )
      .run();

    for (const { sel, choice } of pairs) {
      await env.DB.prepare(
        `UPDATE selection_choices SET client_signature_document_id = ? WHERE id = ?`,
      )
        .bind(docId, choice.id)
        .run();
      await env.DB.prepare(`UPDATE selections SET status = 'sent' WHERE id = ?`)
        .bind(sel.id)
        .run();
    }

    const redirectUrl = `${origin}${redirectPath}`;
    const signLink = await fetchEmbeddedSignLinkWithRetry(
      config,
      boldSignDocumentId,
      clientEmail,
      redirectUrl,
    );

    return json({
      ok: true,
      signature_pending: true,
      combined: true,
      boldsign_document_id: boldSignDocumentId,
      sign_link: signLink,
      selection_count: pairs.length,
      message: "One signature request sent for all selections. Your choices will be confirmed once you sign.",
    });
  } catch (e) {
    console.error(`[selections] Combined BoldSign send failed for estimate ${ctx.estimateId}:`, (e as Error).message);
    return err(502, "signature_send_failed", (e as Error).message.slice(0, 200));
  }
}

async function loadJobClientContext(
  env: Env,
  portalToken: string,
): Promise<SelectionClientContext | null> {
  const job = await env.DB.prepare(
    `SELECT j.id AS job_id, j.estimate_id, j.client_id, j.title AS job_title,
            e.estimate_number, e.title AS estimate_title,
            c.first_name, c.last_name, c.email
       FROM jobs j
       LEFT JOIN estimates e ON e.id = j.estimate_id
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.portal_token = ?`,
  )
    .bind(portalToken)
    .first<{
      job_id: string;
      estimate_id: string | null;
      client_id: string | null;
      job_title: string | null;
      estimate_number: number | null;
      estimate_title: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>();
  if (!job) return null;
  return {
    estimateId: job.estimate_id ?? "",
    jobId: job.job_id,
    clientId: job.client_id,
    clientEmail: job.email,
    clientName: [job.first_name, job.last_name].filter(Boolean).join(" ") || "Client",
    estimateNumber: job.estimate_number,
    estimateTitle: job.job_title || job.estimate_title,
  };
}

async function loadQuoteClientContext(
  env: Env,
  quoteToken: string,
): Promise<SelectionClientContext | null> {
  const row = await env.DB.prepare(
    `SELECT e.id AS estimate_id, e.estimate_number, e.title AS estimate_title, e.client_id,
            c.first_name, c.last_name, c.email
       FROM estimates e
       LEFT JOIN clients c ON c.id = e.client_id
      WHERE e.portal_token = ?`,
  )
    .bind(quoteToken)
    .first<{
      estimate_id: string;
      estimate_number: number | null;
      estimate_title: string | null;
      client_id: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>();
  if (!row) return null;
  return {
    estimateId: row.estimate_id,
    jobId: null,
    clientId: row.client_id,
    clientEmail: row.email,
    clientName: [row.first_name, row.last_name].filter(Boolean).join(" ") || "Client",
    estimateNumber: row.estimate_number,
    estimateTitle: row.estimate_title,
  };
}

async function listClientSelections(env: Env, ctx: SelectionClientContext) {
  const sels = await env.DB.prepare(
    `SELECT DISTINCT s.*
       FROM selections s
      WHERE (? != '' AND s.estimate_id = ?)
         OR (? IS NOT NULL AND s.job_id = ?)
      ORDER BY s.created_at ASC`,
  )
    .bind(ctx.estimateId, ctx.estimateId, ctx.jobId, ctx.jobId ?? "__none__")
    .all<SelectionRow>();

  const today = new Date().toISOString().slice(0, 10);
  return Promise.all(
    (sels.results ?? []).map(async (s) => {
      const choices = await loadChoices(env, s.id);
      const shaped = shapeSelection(s, choices);
      const deadlineApproaching = s.deadline_date
        ? s.deadline_date <= new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
        : false;
      const deadlinePassed = s.deadline_date ? s.deadline_date < today : false;
      return { ...shaped, deadline_approaching: deadlineApproaching, deadline_passed: deadlinePassed };
    }),
  );
}

/** Progress for quote-stage gating — only estimate-linked selections count. */
export async function getQuoteSelectionProgress(
  env: Env,
  estimateId: string,
): Promise<{
  required: boolean;
  total: number;
  chosen: number;
  approved: number;
  all_chosen: boolean;
  signature_pending: boolean;
  complete: boolean;
}> {
  const sels = await env.DB.prepare(
    `SELECT id, status, chosen_choice_id FROM selections WHERE estimate_id = ? ORDER BY created_at ASC`,
  )
    .bind(estimateId)
    .all<{ id: string; status: string; chosen_choice_id: string | null }>();
  const rows = sels.results ?? [];
  if (rows.length === 0) {
    return {
      required: false,
      total: 0,
      chosen: 0,
      approved: 0,
      all_chosen: true,
      signature_pending: false,
      complete: true,
    };
  }
  const chosen = rows.filter((s) => s.chosen_choice_id != null).length;
  const approved = rows.filter((s) => s.status === "approved").length;
  return {
    required: true,
    total: rows.length,
    chosen,
    approved,
    all_chosen: chosen === rows.length,
    signature_pending: rows.some((s) => s.status === "sent"),
    complete: approved === rows.length,
  };
}

export async function assertQuoteSelectionsComplete(env: Env, estimateId: string): Promise<Response | null> {
  const progress = await getQuoteSelectionProgress(env, estimateId);
  if (!progress.complete) {
    return err(
      409,
      "selections_incomplete",
      progress.required
        ? `Please approve all material selections (${progress.approved} of ${progress.total} complete) before signing or paying.`
        : "Selections are not complete.",
    );
  }
  return null;
}

/** Apply overages from quote-stage-approved selections when the job is first created. */
export async function applyQuoteStageSelectionOverages(
  env: Env,
  jobId: string,
  estimateId: string,
): Promise<number> {
  const sels = await env.DB.prepare(
    `SELECT id, allowance_amount FROM selections WHERE estimate_id = ? AND status = 'approved'`,
  )
    .bind(estimateId)
    .all<{ id: string; allowance_amount: number }>();

  let totalOverage = 0;
  for (const sel of sels.results ?? []) {
    const choice = await env.DB.prepare(
      `SELECT price FROM selection_choices WHERE selection_id = ? AND approved = 1 LIMIT 1`,
    )
      .bind(sel.id)
      .first<{ price: number }>();
    if (!choice) continue;
    const overage = Math.round(Math.max(0, choice.price - sel.allowance_amount) * 100) / 100;
    totalOverage += overage;
  }
  totalOverage = Math.round(totalOverage * 100) / 100;
  if (totalOverage > 0) {
    await env.DB.prepare(
      `UPDATE jobs
          SET contract_total = COALESCE(contract_total, 0) + ?,
              total = COALESCE(total, 0) + ?
        WHERE id = ?`,
    )
      .bind(totalOverage, totalOverage, jobId)
      .run();
    console.log(
      `[selections] quote_stage_overages applied: job=${jobId} estimate=${estimateId} total_overage=$${totalOverage}`,
    );
  }
  return totalOverage;
}

async function executeSelectionApproval(
  env: Env,
  ctx: SelectionClientContext,
  selectionId: string,
  choiceId: string,
  redirectPath: string,
  origin: string,
): Promise<Response> {
  const sel = await env.DB.prepare(
    `SELECT * FROM selections
      WHERE id = ?
        AND ((? != '' AND estimate_id = ?) OR (? IS NOT NULL AND job_id = ?))
      LIMIT 1`,
  )
    .bind(selectionId, ctx.estimateId, ctx.estimateId, ctx.jobId, ctx.jobId ?? "__none__")
    .first<SelectionRow>();
  if (!sel) return err(404, "selection_not_found");
  if (sel.status === "approved") return err(409, "already_approved", "This selection has already been approved.");

  const choice = await env.DB.prepare(
    `SELECT * FROM selection_choices WHERE id = ? AND selection_id = ?`,
  )
    .bind(choiceId, selectionId)
    .first<ChoiceRow>();
  if (!choice) return err(404, "choice_not_found");
  if (choice.approved === 1) return err(409, "choice_already_approved");

  const clientEmail = ctx.clientEmail;
  const clientName = ctx.clientName;

  if (!clientEmail) {
    return err(
      422,
      "client_email_missing",
      "The client does not have an email address on file. Add an email to send the e-signature request.",
    );
  }

  try {
    const config = await getBoldSignConfig(env);
    if (!config) {
      return err(503, "boldsign_not_configured", "BOLDSIGN_API_KEY is not set. Cannot send e-signature request.");
    }

    const templateObj = await env.FILES.get(SELECTION_APPROVAL_TEMPLATE_R2);
    if (!templateObj) {
      console.error(`[selections] Selection approval template missing from R2: ${SELECTION_APPROVAL_TEMPLATE_R2}`);
      return err(
        503,
        "selection_template_missing",
        "The Selection Choice Approval template is not configured. Please upload it to R2 and try again.",
      );
    }

    const mergeFields = await buildSelectionApprovalMergeFields(env, ctx, sel, choice);
    const docBytes = await generateDocument(await templateObj.arrayBuffer(), mergeFields);
    const docBlob = new Blob([docBytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const safeTitle = `${sel.title}-${choice.title}`.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 80);
    const docFilename = `Selection-Approval-${safeTitle}.docx`;

    const sendResult = await sendDocumentForSignature(config, {
      fileBlob: docBlob,
      filename: docFilename,
      title: `Selection Approval: ${sel.title} — ${choice.title}`,
      message: `Please approve your selection for ${sel.title}: ${choice.title} ($${choice.price.toFixed(2)})`,
      signerEmail: clientEmail,
      signerName: clientName,
      useTextTags: true,
    });
    const boldSignDocumentId = sendResult.documentId;

    const docId = crypto.randomUUID();
    const r2Key = `selection-approvals/${sel.id}/${choiceId}/${docId}.pdf`;
    const sigData = JSON.stringify({
      boldsign_document_id: boldSignDocumentId,
      selection_id: sel.id,
      choice_id: choiceId,
      job_id: ctx.jobId,
      estimate_id: ctx.estimateId,
    });
    await env.DB.prepare(
      `INSERT INTO documents
         (id, title, file_type, file_size, r2_key, r2_url, context_type, document_category,
          client_id, job_id, estimate_id, signature_data, is_active, created_at, updated_at)
       VALUES (?, ?, 'application/pdf', NULL, ?, ?, 'selection', 'selection_approval',
               ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    )
      .bind(
        docId,
        `Selection Approval: ${sel.title} — ${choice.title}`,
        r2Key,
        r2Key,
        ctx.clientId,
        ctx.jobId,
        ctx.estimateId || sel.estimate_id,
        sigData,
      )
      .run();

    await env.DB.prepare(
      `UPDATE selection_choices SET client_signature_document_id = ? WHERE id = ?`,
    )
      .bind(docId, choiceId)
      .run();

    await env.DB.prepare(`UPDATE selections SET status = 'sent' WHERE id = ?`)
      .bind(selectionId)
      .run();

    let signLink: string | null = null;
    const redirectUrl = `${origin}${redirectPath}`;
    signLink = await fetchEmbeddedSignLinkWithRetry(
      config,
      boldSignDocumentId,
      clientEmail,
      redirectUrl,
    );

    return json({
      ok: true,
      signature_pending: true,
      boldsign_document_id: boldSignDocumentId,
      sign_link: signLink,
      message: "Signature request sent. Your selection will be confirmed once you sign the document.",
    });
  } catch (e) {
    console.error(`[selections] BoldSign send failed for selection ${selectionId}:`, (e as Error).message);
    return err(502, "signature_send_failed", (e as Error).message.slice(0, 200));
  }
}

// ── POST /api/estimates/:id/selections ───────────────────────────────────────

export async function handleCreateEstimateSelection(
  request: Request,
  env: Env,
  estimateId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  // Estimate lock check — block if the estimate has been sent
  const estimate = await env.DB.prepare(
    `SELECT id, status, client_id FROM estimates WHERE id = ?`,
  )
    .bind(estimateId)
    .first<{ id: string; status: string; client_id: string | null }>();
  if (!estimate) return err(404, "estimate_not_found");
  if (LOCKED_STATUSES.has(estimate.status)) {
    return err(409, "estimate_locked", `Cannot add selections to an estimate with status '${estimate.status}'. Selections must be created before the estimate is sent.`);
  }

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const title = str(body.title);
  if (!title) return err(400, "title_required");
  const allowanceAmount = num(body.allowance_amount);
  if (allowanceAmount === null || allowanceAmount < 0) return err(400, "allowance_amount_required");

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO selections
       (id, estimate_id, job_id, estimate_sub_item_id, title, category, location,
        allowance_amount, is_shared_allowance, shared_allowance_group_id, required,
        deadline_date, public_instructions, internal_notes, status, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  )
    .bind(
      id,
      estimateId,
      str(body.estimate_sub_item_id),
      title,
      str(body.category),
      str(body.location),
      allowanceAmount,
      body.is_shared_allowance ? 1 : 0,
      str(body.shared_allowance_group_id),
      body.required === false ? 0 : 1,
      str(body.deadline_date),
      str(body.public_instructions),
      str(body.internal_notes),
    )
    .run();

  // Create initial choices if provided
  const rawChoices = Array.isArray(body.choices) ? (body.choices as Record<string, unknown>[]) : [];
  for (const c of rawChoices) {
    const choiceTitle = str(c.title);
    const choicePrice = num(c.price);
    if (!choiceTitle || choicePrice === null) continue;
    await env.DB.prepare(
      `INSERT INTO selection_choices (id, selection_id, title, description, price, photo_ids, vendor_name, is_client_added, approved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))`,
    )
      .bind(
        crypto.randomUUID(),
        id,
        choiceTitle,
        str(c.description),
        choicePrice,
        c.photo_ids ? JSON.stringify(c.photo_ids) : null,
        str(c.vendor_name),
      )
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'selection_created', 'selection', ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), authed.user.email, id, JSON.stringify({ title, estimate_id: estimateId }))
    .run();

  const sel = await env.DB.prepare(`SELECT * FROM selections WHERE id = ?`)
    .bind(id)
    .first<SelectionRow>();
  const choices = await loadChoices(env, id);
  return json(shapeSelection(sel!, choices), 201);
}

// ── POST /api/jobs/:id/selections (mid-job) ───────────────────────────────────

export async function handleCreateJobSelection(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const job = await env.DB.prepare(`SELECT id, estimate_id, status FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<{ id: string; estimate_id: string | null; status: string }>();
  if (!job) return err(404, "job_not_found");
  if (!job.estimate_id) {
    return err(
      409,
      "job_not_converted",
      "This job has no linked estimate — allowances can only be added after quote-to-job conversion.",
    );
  }

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const title = str(body.title);
  if (!title) return err(400, "title_required");
  const allowanceAmount = num(body.allowance_amount);
  if (allowanceAmount === null || allowanceAmount < 0) return err(400, "allowance_amount_required");

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO selections
       (id, estimate_id, job_id, estimate_sub_item_id, title, category, location,
        allowance_amount, is_shared_allowance, shared_allowance_group_id, required,
        deadline_date, public_instructions, internal_notes, status, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  )
    .bind(
      id,
      job.estimate_id,
      str(body.estimate_sub_item_id),
      title,
      str(body.category),
      str(body.location),
      allowanceAmount,
      body.is_shared_allowance ? 1 : 0,
      str(body.shared_allowance_group_id),
      body.required === false ? 0 : 1,
      str(body.deadline_date),
      str(body.public_instructions),
      str(body.internal_notes),
    )
    .run();

  const rawChoices = Array.isArray(body.choices) ? (body.choices as Record<string, unknown>[]) : [];
  for (const c of rawChoices) {
    const choiceTitle = str(c.title);
    const choicePrice = num(c.price);
    if (!choiceTitle || choicePrice === null) continue;
    await env.DB.prepare(
      `INSERT INTO selection_choices (id, selection_id, title, description, price, photo_ids, vendor_name, is_client_added, approved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))`,
    )
      .bind(
        crypto.randomUUID(),
        id,
        choiceTitle,
        str(c.description),
        choicePrice,
        c.photo_ids ? JSON.stringify(c.photo_ids) : null,
        str(c.vendor_name),
      )
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'selection_created_mid_job', 'selection', ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      authed.user.email,
      id,
      JSON.stringify({ title, job_id: jobId, estimate_id: job.estimate_id }),
    )
    .run();

  const sel = await env.DB.prepare(`SELECT * FROM selections WHERE id = ?`)
    .bind(id)
    .first<SelectionRow>();
  const choices = await loadChoices(env, id);
  return json(shapeSelection(sel!, choices), 201);
}

// ── POST /api/selections/:id/choices ─────────────────────────────────────────

export async function handleAddChoice(
  request: Request,
  env: Env,
  selectionId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const sel = await env.DB.prepare(`SELECT * FROM selections WHERE id = ?`)
    .bind(selectionId)
    .first<SelectionRow>();
  if (!sel) return err(404, "selection_not_found");
  if (sel.status === "approved") return err(409, "selection_approved", "Cannot add choices to an already-approved selection.");

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const title = str(body.title);
  const price = num(body.price);
  if (!title) return err(400, "title_required");
  if (price === null || price < 0) return err(400, "price_required");

  const choiceId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO selection_choices (id, selection_id, title, description, price, photo_ids, vendor_name, is_client_added, approved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
  )
    .bind(
      choiceId,
      selectionId,
      title,
      str(body.description),
      price,
      body.photo_ids ? JSON.stringify(body.photo_ids) : null,
      str(body.vendor_name),
      body.is_client_added ? 1 : 0,
    )
    .run();

  const choice = await env.DB.prepare(`SELECT * FROM selection_choices WHERE id = ?`)
    .bind(choiceId)
    .first<ChoiceRow>();
  return json({ choice }, 201);
}

function selectionEditBlocked(sel: SelectionRow): string | null {
  if (sel.status === "approved") return "This selection has been approved and signed — it cannot be edited.";
  if (sel.status === "sent") return "A signature request is pending for this selection — cancel or complete signing before editing.";
  return null;
}

// ── PUT /api/selections/:id ──────────────────────────────────────────────────

export async function handleUpdateSelection(
  request: Request,
  env: Env,
  selectionId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const sel = await env.DB.prepare(`SELECT * FROM selections WHERE id = ?`)
    .bind(selectionId)
    .first<SelectionRow>();
  if (!sel) return err(404, "selection_not_found");

  const blocked = selectionEditBlocked(sel);
  if (blocked) return err(409, "selection_locked", blocked);

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const title = str(body.title);
  if (!title) return err(400, "title_required");
  const allowanceAmount = num(body.allowance_amount);
  if (allowanceAmount === null || allowanceAmount < 0) return err(400, "allowance_amount_required");

  await env.DB.prepare(
    `UPDATE selections
        SET title = ?, category = ?, location = ?, allowance_amount = ?,
            required = ?, deadline_date = ?, public_instructions = ?
      WHERE id = ?`,
  )
    .bind(
      title,
      str(body.category),
      str(body.location),
      allowanceAmount,
      body.required === false ? 0 : 1,
      str(body.deadline_date),
      str(body.public_instructions),
      selectionId,
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'selection_updated', 'selection', ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      authed.user.email,
      selectionId,
      JSON.stringify({ title, allowance_amount: allowanceAmount }),
    )
    .run();

  const updated = await env.DB.prepare(`SELECT * FROM selections WHERE id = ?`)
    .bind(selectionId)
    .first<SelectionRow>();
  const choices = await loadChoices(env, selectionId);
  return json(shapeSelection(updated!, choices));
}

// ── PUT /api/selections/:id/choices/:choiceId ────────────────────────────────

export async function handleUpdateChoice(
  request: Request,
  env: Env,
  selectionId: string,
  choiceId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const sel = await env.DB.prepare(`SELECT * FROM selections WHERE id = ?`)
    .bind(selectionId)
    .first<SelectionRow>();
  if (!sel) return err(404, "selection_not_found");

  const blocked = selectionEditBlocked(sel);
  if (blocked) return err(409, "selection_locked", blocked);

  const choice = await env.DB.prepare(
    `SELECT * FROM selection_choices WHERE id = ? AND selection_id = ?`,
  )
    .bind(choiceId, selectionId)
    .first<ChoiceRow>();
  if (!choice) return err(404, "choice_not_found");
  if (choice.approved === 1) {
    return err(409, "choice_approved", "This choice has been approved and signed — it cannot be edited.");
  }

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const title = str(body.title);
  const price = num(body.price);
  if (!title) return err(400, "title_required");
  if (price === null || price < 0) return err(400, "price_required");

  await env.DB.prepare(
    `UPDATE selection_choices
        SET title = ?, description = ?, price = ?, photo_ids = ?, vendor_name = ?
      WHERE id = ?`,
  )
    .bind(
      title,
      str(body.description),
      price,
      body.photo_ids ? JSON.stringify(body.photo_ids) : null,
      str(body.vendor_name),
      choiceId,
    )
    .run();

  const updated = await env.DB.prepare(`SELECT * FROM selection_choices WHERE id = ?`)
    .bind(choiceId)
    .first<ChoiceRow>();
  return json({ choice: updated });
}

// ── GET /api/estimates/:id/selections ────────────────────────────────────────

export async function handleListEstimateSelections(
  request: Request,
  env: Env,
  estimateId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const sels = await env.DB.prepare(
    `SELECT * FROM selections WHERE estimate_id = ? ORDER BY created_at ASC`,
  )
    .bind(estimateId)
    .all<SelectionRow>();

  const result = await Promise.all(
    (sels.results ?? []).map(async (s) => shapeSelection(s, await loadChoices(env, s.id))),
  );
  return json({ selections: result });
}

// ── GET /api/jobs/:id/selections ─────────────────────────────────────────────

export async function handleListJobSelections(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  // Include selections tied to job directly AND selections from the estimate that became this job
  const sels = await env.DB.prepare(
    `SELECT DISTINCT s.*
       FROM selections s
      WHERE s.job_id = ?
         OR s.estimate_id = (SELECT estimate_id FROM jobs WHERE id = ?)
      ORDER BY s.created_at ASC`,
  )
    .bind(jobId, jobId)
    .all<SelectionRow>();

  const result = await Promise.all(
    (sels.results ?? []).map(async (s) => shapeSelection(s, await loadChoices(env, s.id))),
  );
  return json({ selections: result });
}

// ── GET /api/portal/:token/selections (client-facing) ─────────────────────────

export async function handlePortalSelectionsList(
  env: Env,
  token: string,
): Promise<Response> {
  const ctx = await loadJobClientContext(env, token);
  if (!ctx) return err(404, "invalid_token");
  const result = await listClientSelections(env, ctx);
  return json({ selections: result });
}

// ── GET /api/public/quote/:token/selections (quote stage, pre-job) ─────────────

export async function handleQuoteSelectionsList(
  env: Env,
  token: string,
): Promise<Response> {
  const ctx = await loadQuoteClientContext(env, token);
  if (!ctx) return err(404, "invalid_token");
  const result = await listClientSelections(env, ctx);
  return json({ selections: result });
}

// ── POST /api/portal/:token/selections/:id/approve (client-facing) ───────────

export async function handlePortalSelectionsApprove(
  request: Request,
  env: Env,
  token: string,
  selectionId: string,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const ctx = await loadJobClientContext(env, token);
  if (!ctx) return err(404, "invalid_token");

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const choiceId = str(body.choice_id);
  if (!choiceId) return err(400, "choice_id_required");

  return executeSelectionApproval(
    env,
    ctx,
    selectionId,
    choiceId,
    `/portal/${token}?selection_signed=1`,
    origin,
  );
}

// ── GET /api/portal/:token/selections/:id/sign-link ─────────────────────────

export async function handlePortalSelectionSignLink(
  request: Request,
  env: Env,
  token: string,
  selectionId: string,
): Promise<Response> {
  const ctx = await loadJobClientContext(env, token);
  if (!ctx) return err(404, "invalid_token");

  const sel = await env.DB.prepare(
    `SELECT id, status FROM selections
      WHERE id = ?
        AND ((? != '' AND estimate_id = ?) OR (? IS NOT NULL AND job_id = ?))
      LIMIT 1`,
  )
    .bind(selectionId, ctx.estimateId, ctx.estimateId, ctx.jobId, ctx.jobId ?? "__none__")
    .first<{ id: string; status: string }>();
  if (!sel) return err(404, "selection_not_found");
  if (sel.status !== "sent") {
    return err(404, "no_pending_signature", "No signature is pending for this selection.");
  }

  const docInfo = await loadIndividualSelectionSignDocument(env, selectionId);
  if (!docInfo) {
    return err(404, "signature_document_not_found", "Signature document not found.");
  }

  if (!ctx.clientEmail) {
    return err(
      422,
      "client_email_missing",
      "The client does not have an email address on file.",
    );
  }

  const config = await getBoldSignConfig(env);
  if (!config) {
    return err(503, "boldsign_not_configured", "BOLDSIGN_API_KEY is not set.");
  }

  const origin = new URL(request.url).origin;
  const redirectUrl = `${origin}/portal/${token}?selection_signed=1`;
  const signLink = await fetchEmbeddedSignLinkWithRetry(
    config,
    docInfo.boldsign_document_id,
    ctx.clientEmail,
    redirectUrl,
  );
  if (!signLink) {
    return err(
      502,
      "sign_link_unavailable",
      "Could not generate an embedded signing link. Please try again in a few seconds.",
    );
  }

  return json({ sign_link: signLink });
}

// ── POST /api/public/quote/:token/selections/:id/approve ─────────────────────

export async function handleQuoteSelectionsApprove(
  request: Request,
  env: Env,
  token: string,
  selectionId: string,
): Promise<Response> {
  const ctx = await loadQuoteClientContext(env, token);
  if (!ctx) return err(404, "invalid_token");

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const choiceId = str(body.choice_id);
  if (!choiceId) return err(400, "choice_id_required");

  // Legacy quote approve route — choose only; combined signing uses confirm-all.
  return executeSelectionChoose(env, ctx, selectionId, choiceId);
}

// ── POST /api/public/quote/:token/selections/:id/choose ─────────────────────

export async function handleQuoteSelectionsChoose(
  request: Request,
  env: Env,
  token: string,
  selectionId: string,
): Promise<Response> {
  const ctx = await loadQuoteClientContext(env, token);
  if (!ctx) return err(404, "invalid_token");

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");
  const choiceId = str(body.choice_id);
  if (!choiceId) return err(400, "choice_id_required");

  return executeSelectionChoose(env, ctx, selectionId, choiceId);
}

// ── POST /api/public/quote/:token/selections/confirm-all ────────────────────

export async function handleQuoteSelectionsConfirmAll(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const ctx = await loadQuoteClientContext(env, token);
  if (!ctx) return err(404, "invalid_token");

  return executeCombinedSelectionApproval(
    env,
    ctx,
    `/quote/${token}?selection_signed=1`,
    origin,
  );
}

// ── GET /api/public/quote/:token/selections/sign-link ─────────────────────────

/** True when BoldSign derived a collapsed signature field (1pt-shrink regression). */
async function boldSignSignatureFieldUnusable(
  config: NonNullable<Awaited<ReturnType<typeof getBoldSignConfig>>>,
  documentId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.boldsign.com/v1/document/properties?documentId=${encodeURIComponent(documentId)}`,
      { headers: { "X-API-KEY": config.apiKey } },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as {
      signerDetails?: Array<{
        formFields?: Array<{
          type?: string;
          fieldType?: string;
          bounds?: { width?: number; height?: number };
          Bounds?: { Width?: number; Height?: number };
        }>;
      }>;
    };
    const fields = (data.signerDetails ?? []).flatMap((s) => s.formFields ?? []);
    const sig = fields.find((f) =>
      String(f.type ?? f.fieldType ?? "").toLowerCase().includes("sign"),
    );
    if (!sig) return false;
    const b = sig.bounds ?? sig.Bounds ?? {};
    const w = (b as { width?: number; Width?: number }).width ?? (b as { Width?: number }).Width ?? 0;
    const h =
      (b as { height?: number; Height?: number }).height ?? (b as { Height?: number }).Height ?? 0;
    return w < 40 || h < 10;
  } catch {
    return false;
  }
}

export async function handleQuoteCombinedSelectionsSignLink(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const ctx = await loadQuoteClientContext(env, token);
  if (!ctx) return err(404, "invalid_token");
  if (!ctx.estimateId) return err(400, "estimate_required");

  const pending = await env.DB.prepare(
    `SELECT id FROM selections WHERE estimate_id = ? AND status = 'sent' LIMIT 1`,
  )
    .bind(ctx.estimateId)
    .first<{ id: string }>();
  if (!pending) {
    return err(404, "no_pending_signature", "No combined selection signature is pending.");
  }

  const docRow = await loadCombinedSelectionSignDocument(env, ctx.estimateId);
  if (!docRow) {
    return err(404, "signature_document_not_found", "Combined signature document not found.");
  }

  let sigData: { boldsign_document_id?: string };
  try {
    sigData = JSON.parse(docRow.signature_data) as { boldsign_document_id?: string };
  } catch {
    return err(500, "invalid_signature_data");
  }
  let boldSignDocumentId = sigData.boldsign_document_id;
  if (!boldSignDocumentId) {
    return err(404, "signature_document_not_found", "BoldSign document id missing.");
  }

  if (!ctx.clientEmail) {
    return err(
      422,
      "client_email_missing",
      "The client does not have an email address on file.",
    );
  }

  const config = await getBoldSignConfig(env);
  if (!config) {
    return err(503, "boldsign_not_configured", "BOLDSIGN_API_KEY is not set.");
  }

  const origin = new URL(request.url).origin;
  const redirectUrl = `${origin}/quote/${token}?selection_signed=1`;

  // Auto-heal docs sent during the 1pt tag-shrink window (tiny unusable Sign Here).
  if (await boldSignSignatureFieldUnusable(config, boldSignDocumentId)) {
    console.warn(
      `[selections] combined doc ${boldSignDocumentId} has collapsed signature field — force resending`,
    );
    const resent = await executeCombinedSelectionApproval(
      env,
      ctx,
      `/quote/${token}?selection_signed=1`,
      origin,
      { forceResend: true },
    );
    if (resent.status >= 400) return resent;
    const body = (await resent.clone().json()) as { sign_link?: string | null };
    if (body.sign_link) return json({ sign_link: body.sign_link, resent: true });
    // Fall through to fetch from the new document row.
    const newDoc = await loadCombinedSelectionSignDocument(env, ctx.estimateId);
    if (newDoc) {
      try {
        boldSignDocumentId = (
          JSON.parse(newDoc.signature_data) as { boldsign_document_id?: string }
        ).boldsign_document_id;
      } catch {
        /* ignore */
      }
    }
  }

  if (!boldSignDocumentId) {
    return err(502, "sign_link_unavailable", "Could not prepare a usable signing document.");
  }

  const signLink = await fetchEmbeddedSignLinkWithRetry(
    config,
    boldSignDocumentId,
    ctx.clientEmail,
    redirectUrl,
  );
  if (!signLink) {
    return err(
      502,
      "sign_link_unavailable",
      "Could not generate an embedded signing link. Please try again in a few seconds.",
    );
  }

  return json({ sign_link: signLink });
}

async function loadEstimateSelectionContext(
  env: Env,
  estimateId: string,
): Promise<{ ctx: SelectionClientContext; portalToken: string } | null> {
  const row = await env.DB.prepare(
    `SELECT e.id AS estimate_id, e.estimate_number, e.title AS estimate_title, e.client_id,
            e.portal_token, c.first_name, c.last_name, c.email
       FROM estimates e
       LEFT JOIN clients c ON c.id = e.client_id
      WHERE e.id = ?`,
  )
    .bind(estimateId)
    .first<{
      estimate_id: string;
      estimate_number: number | null;
      estimate_title: string | null;
      client_id: string | null;
      portal_token: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>();
  if (!row?.portal_token) return null;
  return {
    portalToken: row.portal_token,
    ctx: {
      estimateId: row.estimate_id,
      jobId: null,
      clientId: row.client_id,
      clientEmail: row.email,
      clientName: [row.first_name, row.last_name].filter(Boolean).join(" ") || "Client",
      estimateNumber: row.estimate_number,
      estimateTitle: row.estimate_title,
    },
  };
}

/** Ops/manual: force-resend combined selection approval for an estimate. */
export async function resendCombinedSelectionApprovalForEstimate(
  env: Env,
  estimateId: string,
  origin: string,
): Promise<Response> {
  const loaded = await loadEstimateSelectionContext(env, estimateId);
  if (!loaded) return err(404, "estimate_not_found");
  return executeCombinedSelectionApproval(
    env,
    loaded.ctx,
    `/quote/${loaded.portalToken}?selection_signed=1`,
    origin,
    { forceResend: true },
  );
}

/** Ops: first-time combined selection send (choices already selected, status pending). */
export async function sendCombinedSelectionApprovalForEstimate(
  env: Env,
  estimateId: string,
  origin: string,
): Promise<Response> {
  const loaded = await loadEstimateSelectionContext(env, estimateId);
  if (!loaded) return err(404, "estimate_not_found");
  return executeCombinedSelectionApproval(
    env,
    loaded.ctx,
    `/quote/${loaded.portalToken}?selection_signed=1`,
    origin,
  );
}

// ── Internal: complete selection choice approval (called from BoldSign webhook) ──

interface SelectionApprovalSigData {
  boldsign_document_id: string;
  combined?: boolean;
  selection_id?: string;
  choice_id?: string;
  estimate_id?: string | null;
  job_id?: string | null;
  selections?: Array<{ selection_id: string; choice_id: string }>;
}

function selectionApprovalR2Key(
  docId: string,
  sigData: SelectionApprovalSigData,
): string {
  if (sigData.combined && sigData.estimate_id) {
    return `selection-approvals/combined/${sigData.estimate_id}/${docId}.pdf`;
  }
  return `selection-approvals/${sigData.selection_id}/${sigData.choice_id}/${docId}.pdf`;
}

/**
 * Download the signed PDF from BoldSign and mark the selection approval document
 * client-visible (is_signed, job/estimate linkage, signed_r2_key in signature_data).
 */
export async function finalizeSelectionApprovalDocument(
  env: Env,
  docId: string,
  boldSignDocumentId: string,
  sigData: SelectionApprovalSigData,
  signedAt: string,
): Promise<void> {
  const r2Key = selectionApprovalR2Key(docId, sigData);
  const signedOn = signedAt.slice(0, 10);
  let meta: Record<string, unknown> = { ...sigData, signed_r2_key: r2Key, signature_completed_at: signedAt };

  const config = await getBoldSignConfig(env);
  if (!config) {
    console.error("[selections] BOLDSIGN not configured — cannot download signed selection PDF");
    await env.DB.prepare(
      `UPDATE documents
          SET is_signed = 1, signed_date = ?, job_id = COALESCE(job_id, ?),
              estimate_id = COALESCE(estimate_id, ?), signature_data = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(signedOn, sigData.job_id ?? null, sigData.estimate_id ?? null, JSON.stringify(meta), docId)
      .run();
    return;
  }

  try {
    const pdfBytes = await downloadSignedDocument(config, boldSignDocumentId);
    await env.FILES.put(r2Key, pdfBytes, {
      httpMetadata: { contentType: "application/pdf" },
    });
    meta = { ...meta, signed_r2_key: r2Key };
    await env.DB.prepare(
      `UPDATE documents
          SET r2_key = ?, file_type = 'application/pdf', file_size = ?,
              is_signed = 1, signed_date = ?, job_id = COALESCE(job_id, ?),
              estimate_id = COALESCE(estimate_id, ?), signature_data = ?,
              mirror_status = 'pending', google_drive_id = NULL, google_drive_url = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(
        r2Key,
        pdfBytes.byteLength,
        signedOn,
        sigData.job_id ?? null,
        sigData.estimate_id ?? null,
        JSON.stringify(meta),
        docId,
      )
      .run();
    console.log(`[selections] signed selection PDF stored: doc="${docId}" r2="${r2Key}"`);
  } catch (dlErr) {
    console.warn(
      `[selections] selection PDF download failed for doc="${docId}": ${(dlErr as Error).message}`,
    );
    await env.DB.prepare(
      `UPDATE documents
          SET is_signed = 1, signed_date = ?, job_id = COALESCE(job_id, ?),
              estimate_id = COALESCE(estimate_id, ?), signature_data = ?,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(signedOn, sigData.job_id ?? null, sigData.estimate_id ?? null, JSON.stringify(meta), docId)
      .run();
  }
}

/**
 * Called by the BoldSign webhook on "Completed" for a selection-context document.
 * Marks the choice approved, marks selection approved, and applies budget delta.
 * Exported so webhooks-boldsign.ts can call it directly.
 */
export async function applySelectionChoiceApproval(
  env: Env,
  sigData: {
    boldsign_document_id: string;
    selection_id: string;
    choice_id: string;
    job_id?: string | null;
    estimate_id?: string | null;
  },
  signedAt: string,
): Promise<void> {
  const sel = await env.DB.prepare(`SELECT * FROM selections WHERE id = ?`)
    .bind(sigData.selection_id)
    .first<SelectionRow>();
  const choice = await env.DB.prepare(`SELECT * FROM selection_choices WHERE id = ?`)
    .bind(sigData.choice_id)
    .first<ChoiceRow>();
  if (!sel || !choice) {
    console.warn(`[selections] applySelectionChoiceApproval: missing selection/choice for ${sigData.choice_id}`);
    return;
  }

  // Idempotency guard
  if (choice.approved === 1) {
    console.log(`[selections] choice ${sigData.choice_id} already approved — skipping`);
    return;
  }

  // Mark choice approved
  await env.DB.prepare(
    `UPDATE selection_choices SET approved = 1, approved_at = ? WHERE id = ?`,
  )
    .bind(signedAt, sigData.choice_id)
    .run();

  // Mark selection approved
  await env.DB.prepare(
    `UPDATE selections SET status = 'approved' WHERE id = ?`,
  )
    .bind(sigData.selection_id)
    .run();

  // ── Budget delta: apply immediately when a job exists; defer to conversion otherwise ──
  const overage = Math.round((choice.price - sel.allowance_amount) * 100) / 100;
  if (overage > 0 && sigData.job_id) {
    await env.DB.prepare(
      `UPDATE jobs SET contract_total = COALESCE(contract_total, 0) + ? WHERE id = ?`,
    )
      .bind(overage, sigData.job_id)
      .run();
    console.log(
      `[selections] budget_delta applied: job=${sigData.job_id} overage=$${overage} (choice=$${choice.price} allowance=$${sel.allowance_amount})`,
    );
  } else if (overage > 0) {
    console.log(
      `[selections] quote_stage overage deferred until job conversion: estimate=${sigData.estimate_id ?? sel.estimate_id} overage=$${overage}`,
    );
  }

  // ── Owner in-app notification ──────────────────────────────────────────────
  let clientName = "Client";
  let linkPath = sigData.job_id ? `/jobs/${sigData.job_id}` : `/estimates/${sel.estimate_id ?? sigData.estimate_id ?? ""}`;
  if (sigData.job_id) {
    const clientRow = await env.DB.prepare(
      `SELECT c.first_name, c.last_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.id = ?`,
    )
      .bind(sigData.job_id)
      .first<{ first_name: string | null; last_name: string | null }>();
    clientName =
      [clientRow?.first_name, clientRow?.last_name].filter(Boolean).join(" ") || "Client";
  } else if (sel.estimate_id) {
    const clientRow = await env.DB.prepare(
      `SELECT c.first_name, c.last_name FROM estimates e LEFT JOIN clients c ON c.id = e.client_id WHERE e.id = ?`,
    )
      .bind(sel.estimate_id)
      .first<{ first_name: string | null; last_name: string | null }>();
    clientName =
      [clientRow?.first_name, clientRow?.last_name].filter(Boolean).join(" ") || "Client";
  }

  await createOwnerInApp(env, {
    message: `${clientName} approved "${choice.title}" for ${sel.title} ($${choice.price.toFixed(2)})${overage > 0 && sigData.job_id ? ` — $${overage.toFixed(2)} overage added to job budget` : overage > 0 ? ` — $${overage.toFixed(2)} overage will apply at job start` : ""}.`,
    linkPath,
    dedupe: `selection-approved:${sigData.choice_id}`,
  });
}

/**
 * Called by the BoldSign webhook when a combined quote-stage selection document completes.
 * Approves every selection/choice in the batch atomically.
 */
export async function applyCombinedSelectionApproval(
  env: Env,
  sigData: {
    boldsign_document_id: string;
    combined: true;
    estimate_id: string;
    job_id?: string | null;
    selections: Array<{ selection_id: string; choice_id: string }>;
  },
  signedAt: string,
): Promise<void> {
  for (const item of sigData.selections) {
    await applySelectionChoiceApproval(
      env,
      {
        boldsign_document_id: sigData.boldsign_document_id,
        selection_id: item.selection_id,
        choice_id: item.choice_id,
        job_id: sigData.job_id,
        estimate_id: sigData.estimate_id,
      },
      signedAt,
    );
  }
}
