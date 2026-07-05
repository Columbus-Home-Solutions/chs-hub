/**
 * Selections & Allowances API (Sprint 38 Run 4).
 *
 * Owner-facing (authenticated):
 *   POST  /api/estimates/:id/selections         create selection (LOCKED after estimate sent)
 *   POST  /api/jobs/:id/selections              create selection mid-job
 *   POST  /api/selections/:id/choices           add choices to existing selection
 *   GET   /api/estimates/:id/selections         list selections for estimate
 *   GET   /api/jobs/:id/selections              list selections for job (owner view)
 *
 * Portal / client-facing (token-gated):
 *   GET   /api/portal/:token/selections         client views pending+approved selections
 *   POST  /api/portal/:token/selections/:id/approve  client picks a choice → BoldSign
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
import { getBoldSignConfig, sendDocumentForSignature } from "../lib/boldsign.js";

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
    })),
  };
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
    `INSERT INTO audit_log (id, user_email, action, entity_type, entity_id, details, created_at)
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

  const job = await env.DB.prepare(`SELECT id, status FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<{ id: string; status: string }>();
  if (!job) return err(404, "job_not_found");

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
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  )
    .bind(
      id,
      jobId,
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
  const job = await env.DB.prepare(
    `SELECT j.id AS job_id, j.estimate_id, j.client_id, c.first_name, c.last_name, c.email
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.portal_token = ?`,
  )
    .bind(token)
    .first<{
      job_id: string;
      estimate_id: string | null;
      client_id: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>();
  if (!job) return err(404, "invalid_token");

  const sels = await env.DB.prepare(
    `SELECT DISTINCT s.*
       FROM selections s
      WHERE s.job_id = ?
         OR s.estimate_id = ?
      ORDER BY s.created_at ASC`,
  )
    .bind(job.job_id, job.estimate_id ?? "__none__")
    .all<SelectionRow>();

  const today = new Date().toISOString().slice(0, 10);
  const result = await Promise.all(
    (sels.results ?? []).map(async (s) => {
      const choices = await loadChoices(env, s.id);
      const shaped = shapeSelection(s, choices);
      // Add deadline urgency for UI hints
      const deadlineApproaching = s.deadline_date
        ? s.deadline_date <= new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
        : false;
      const deadlinePassed = s.deadline_date ? s.deadline_date < today : false;
      return { ...shaped, deadline_approaching: deadlineApproaching, deadline_passed: deadlinePassed };
    }),
  );

  return json({ selections: result });
}

// ── POST /api/portal/:token/selections/:id/approve (client-facing) ───────────

export async function handlePortalSelectionsApprove(
  request: Request,
  env: Env,
  token: string,
  selectionId: string,
): Promise<Response> {
  // Resolve job from portal token
  const job = await env.DB.prepare(
    `SELECT j.id AS job_id, j.estimate_id, j.client_id, j.title AS job_title,
            c.first_name, c.last_name, c.email
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.portal_token = ?`,
  )
    .bind(token)
    .first<{
      job_id: string;
      estimate_id: string | null;
      client_id: string | null;
      job_title: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>();
  if (!job) return err(404, "invalid_token");

  // Verify this selection belongs to this job
  const sel = await env.DB.prepare(
    `SELECT * FROM selections
      WHERE id = ?
        AND (job_id = ? OR estimate_id = ?)
      LIMIT 1`,
  )
    .bind(selectionId, job.job_id, job.estimate_id ?? "__none__")
    .first<SelectionRow>();
  if (!sel) return err(404, "selection_not_found");
  if (sel.status === "approved") return err(409, "already_approved", "This selection has already been approved.");

  const body = await readJson(request);
  if (!body) return err(400, "invalid_json");

  const choiceId = str(body.choice_id);
  if (!choiceId) return err(400, "choice_id_required");

  const choice = await env.DB.prepare(
    `SELECT * FROM selection_choices WHERE id = ? AND selection_id = ?`,
  )
    .bind(choiceId, selectionId)
    .first<ChoiceRow>();
  if (!choice) return err(404, "choice_not_found");
  if (choice.approved === 1) return err(409, "choice_already_approved");

  // ── BoldSign e-signature ───────────────────────────────────────────────────
  const clientEmail = job.email;
  const clientName = [job.first_name, job.last_name].filter(Boolean).join(" ") || "Client";

  // Resolve selection approval template from system_settings
  const templateRow = await env.DB.prepare(
    `SELECT value FROM system_settings WHERE key = 'selection_approval_template_id'`,
  )
    .first<{ value: string | null }>();
  const templateId = templateRow?.value?.trim() || null;

  let boldSignDocumentId: string | null = null;

  if (templateId && clientEmail) {
    try {
      const config = await getBoldSignConfig(env);
      if (!config) {
        return err(503, "boldsign_not_configured", "BOLDSIGN_API_KEY is not set. Cannot send e-signature request.");
      }
      const sendResult = await sendDocumentForSignature(config, {
        title: `Selection Approval: ${sel.title} — ${choice.title}`,
        message: `Please approve your selection for ${sel.title}: ${choice.title} ($${choice.price.toFixed(2)})`,
        signerEmail: clientEmail,
        signerName: clientName,
        signerRole: "Client",
        templateId,
      });
      boldSignDocumentId = sendResult.documentId;

      // Create a documents row to track the signature
      const docId = crypto.randomUUID();
      const r2Key = `selection-approvals/${sel.id}/${choiceId}/${docId}.pdf`;
      const sigData = JSON.stringify({
        boldsign_document_id: boldSignDocumentId,
        selection_id: sel.id,
        choice_id: choiceId,
        job_id: job.job_id,
      });
      // selection_id, choice_id, job_id are carried inside signature_data JSON.
      // documents has no context_id column; context_type = 'selection' + signature_data is the lookup key.
      await env.DB.prepare(
        `INSERT INTO documents
           (id, title, file_type, file_size, r2_key, r2_url, context_type, document_category, client_id, signature_data, is_active, created_at, updated_at)
         VALUES (?, ?, 'application/pdf', NULL, ?, ?, 'selection', 'selection_approval', ?, ?, 1, datetime('now'), datetime('now'))`,
      )
        .bind(
          docId,
          `Selection Approval: ${sel.title} — ${choice.title}`,
          r2Key,
          r2Key,
          job.client_id,
          sigData,
        )
        .run();

      // Link choice to document
      await env.DB.prepare(
        `UPDATE selection_choices SET client_signature_document_id = ? WHERE id = ?`,
      )
        .bind(docId, choiceId)
        .run();

      // Mark selection as "sent" (awaiting signature)
      await env.DB.prepare(`UPDATE selections SET status = 'sent' WHERE id = ?`)
        .bind(selectionId)
        .run();

      return json({
        ok: true,
        signature_pending: true,
        boldsign_document_id: boldSignDocumentId,
        message: "Signature request sent. Your selection will be confirmed once you sign the document.",
      });
    } catch (e) {
      console.error(`[selections] BoldSign send failed for selection ${selectionId}:`, (e as Error).message);
      return err(502, "signature_send_failed", (e as Error).message.slice(0, 200));
    }
  } else {
    // No template configured — cannot proceed, return a clear error
    if (!templateId) {
      return err(503, "signature_template_not_configured", "A BoldSign selection approval template must be configured in system_settings (key: selection_approval_template_id) before clients can approve selections.");
    }
    if (!clientEmail) {
      return err(422, "client_email_missing", "The client does not have an email address on file. Add an email to send the e-signature request.");
    }
    // Unreachable, but defensive
    return err(500, "unknown_error");
  }
}

// ── Internal: complete selection choice approval (called from BoldSign webhook) ──

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
    job_id: string;
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

  // ── Budget delta: same UPDATE that applyChangeOrder uses ────────────────
  // Overage = choice.price - allowance_amount. Only positive overages flow.
  const overage = Math.round((choice.price - sel.allowance_amount) * 100) / 100;
  if (overage > 0) {
    await env.DB.prepare(
      `UPDATE jobs SET contract_total = COALESCE(contract_total, 0) + ? WHERE id = ?`,
    )
      .bind(overage, sigData.job_id)
      .run();
    console.log(
      `[selections] budget_delta applied: job=${sigData.job_id} overage=$${overage} (choice=$${choice.price} allowance=$${sel.allowance_amount})`,
    );
  }

  // ── Owner in-app notification ──────────────────────────────────────────────
  const clientRow = await env.DB.prepare(
    `SELECT c.first_name, c.last_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.id = ?`,
  )
    .bind(sigData.job_id)
    .first<{ first_name: string | null; last_name: string | null }>();
  const clientName =
    [clientRow?.first_name, clientRow?.last_name].filter(Boolean).join(" ") || "Client";

  await createOwnerInApp(env, {
    message: `${clientName} approved "${choice.title}" for ${sel.title} ($${choice.price.toFixed(2)})${overage > 0 ? ` — $${overage.toFixed(2)} overage added to job budget` : ""}.`,
    linkPath: `/jobs/${sigData.job_id}`,
    dedupe: `selection-approved:${sigData.choice_id}`,
  });
}
