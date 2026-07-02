/**
 * job-documents.ts — Sprint 19/20/21: Document Auto-Fill + Review Queue + E-Signature routes.
 *
 *   POST /api/jobs/:id/documents/generate                                (O/PM) manual .docx generation
 *   GET  /api/jobs/:id/generated-documents                               (O/PM/OA) list job_documents rows
 *   GET  /api/jobs/:id/documents/:doc_id/download                        (O/PM/OA) stream .docx from R2
 *   GET  /api/jobs/:id/generated-documents/:doc_id/view-url              (O/PM) HMAC-signed view URL
 *   DELETE /api/jobs/:id/generated-documents/:doc_id                     (O/PM) soft-delete row
 *   POST /api/jobs/:id/generated-documents/:doc_id/approve               (O/PM) approve queued doc
 *   POST /api/jobs/:id/generated-documents/:doc_id/discard               (O/PM) discard queued doc
 *   GET  /api/documents/review-queue                                      (O/PM) pending_review docs
 *   POST /api/jobs/:id/generated-documents/:doc_id/send-for-signature    (O/PM) Sprint 21
 *   GET  /api/jobs/:id/generated-documents/:doc_id/signature-status      (O/PM) Sprint 21
 *   POST /api/jobs/:id/generated-documents/:doc_id/remind                (O/PM) Sprint 21
 *   POST /api/jobs/:id/generated-documents/:doc_id/revoke                (O/PM) Sprint 21
 *   GET  /api/esignature/status                                           (O/PM) Sprint 21 mode gate
 *
 * R2 paths:
 *   templates  → documents/templates/{slug}.docx
 *   generated  → documents/generated/{job_id}/{filename}
 *   signed PDF → documents/signed/{job_id}/{filename}.pdf
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import {
  generateDocument,
  formatCurrency,
  formatDate,
  formatToday,
  formatDatePlusOneYear,
  formatPercent,
} from "../lib/document-generator.js";
import {
  getBoldSignConfig,
  resolveESignatureMode,
  sendDocumentForSignature,
  sendReminder,
  revokeDocument,
  SETTING_ESIGNATURE_MODE,
  BOLDSIGN_API_BASE,
} from "../lib/boldsign.js";
import { applyPmFields, resolvePmFields } from "../lib/pm-fields.js";
import { loadWorkingAgreementAttachment } from "../lib/working-agreement.js";

const OWNER_PM = ["owner", "project_manager"] as const;
const READ_ROLES = ["owner", "project_manager", "office_admin"] as const;

export type TemplateType =
  | "service_agreement"
  | "cost_plus_agreement"
  | "change_order"
  | "lien_waiver_conditional"
  | "lien_waiver_sub_unconditional"
  | "warranty_certificate";

export const TEMPLATE_R2_KEYS: Record<TemplateType, string> = {
  service_agreement: "documents/templates/service-agreement.docx",
  cost_plus_agreement: "documents/templates/cost-plus-agreement.docx",
  change_order: "documents/templates/change-order.docx",
  lien_waiver_conditional: "documents/templates/lien-waiver-conditional.docx",
  lien_waiver_sub_unconditional: "documents/templates/lien-waiver-sub-unconditional.docx",
  warranty_certificate: "documents/templates/warranty-certificate.docx",
};

const VALID_TYPES = new Set<string>(Object.keys(TEMPLATE_R2_KEYS));

function json(body: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

// ─── Job + client data types ─────────────────────────────────────────────────

export interface JobRow {
  id: string;
  job_number: string;
  title: string;
  client_id: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  start_date: string | null;
  target_end_date: string | null;
  actual_end_date: string | null;
  contract_total: number | null;
  deposit_amount: number | null;
  notes: string | null;
  billing_model: string | null;
  warranty_expiration: string | null;
  assigned_to: string | null;
}

interface ClientRow {
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_postal: string | null;
}

interface SubRow {
  company_name: string | null;
  city_state: string | null;
  trade: string | null;
  phone: string | null;
}

// ─── Merge field resolution ──────────────────────────────────────────────────

export async function resolveMergeFields(
  env: Env,
  job: JobRow,
  overrides: Record<string, string>,
  templateType: TemplateType,
): Promise<Record<string, string>> {
  const fields: Record<string, string> = {};

  // Job address
  const addrParts = [
    job.property_address,
    job.property_city,
    job.property_state,
    job.property_zip,
  ].filter(Boolean);
  fields.job_address = addrParts.join(", ");
  fields.job_number = job.job_number ?? "";
  fields.job_name = job.title ?? "";
  fields.contract_date = overrides.contract_date ?? formatToday();
  fields.start_date = formatDate(job.start_date);
  // completion_date prefers actual_end_date, then target_end_date
  const completionRaw = job.actual_end_date ?? job.target_end_date ?? null;
  fields.completion_date = formatDate(completionRaw);
  fields.contract_amount = formatCurrency(job.contract_total);
  fields.deposit_amount = formatCurrency(job.deposit_amount);
  fields.management_fee_rate = ""; // no management_fee_percent column in jobs table
  fields.estimated_budget = ""; // no estimated_cost column in jobs table
  fields.work_description = job.notes ?? job.title ?? "";
  fields.certificate_number = `WC-${job.job_number ?? "000"}-${new Date().getFullYear()}`;
  fields.warranty_expiry = formatDatePlusOneYear(completionRaw);

  // Client
  if (job.client_id) {
    const client = await env.DB.prepare(
      `SELECT first_name, last_name, name, phone, email,
              address_street, address_city, address_state, address_postal
         FROM clients WHERE id = ?`,
    )
      .bind(job.client_id)
      .first<ClientRow>();

    if (client) {
      const fn = client.first_name ?? "";
      const ln = client.last_name ?? "";
      fields.client_name = (fn || ln)
        ? `${fn} ${ln}`.trim()
        : (client.name ?? "");
      fields.client_phone = client.phone ?? "";
      fields.client_email = client.email ?? "";
      const clientAddrParts = [
        client.address_street,
        client.address_city,
        client.address_state,
        client.address_postal,
      ].filter(Boolean);
      fields.client_address = clientAddrParts.join(", ");
    }
  }

  // Company info (warranty certificate footer block + other templates)
  const companySettings = await env.DB.prepare(
    `SELECT key, value FROM system_settings
     WHERE key IN (
       'company_name', 'company_address', 'company_phone',
       'company_email', 'company_license'
     )`,
  ).all<{ key: string; value: string }>();
  const company: Record<string, string> = {};
  for (const row of companySettings.results ?? []) {
    company[row.key] = row.value;
  }
  fields.company_name = company.company_name ?? "Columbus Home Solutions, LLC";
  fields.company_address =
    company.company_address ?? "4414 North Olive Street, North Little Rock, AR 72116";
  fields.company_phone = company.company_phone ?? "(501) 551-1814";
  fields.company_email = company.company_email ?? "tony@homesolutionsar.com";
  fields.company_license = company.company_license ?? "0437210327";

  // Contractor/owner info (pre-fills CHS side of signature blocks)
  const contractorRow = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'contractor_name'",
  ).first<{ value: string }>();
  fields.contractor_name = contractorRow?.value?.trim() || "Tony Columbus, Owner";

  if (templateType === "warranty_certificate" || templateType === "lien_waiver_conditional") {
    fields.contractor_date = formatToday();
  }

  const pm = await resolvePmFields(env, job.assigned_to);
  Object.assign(fields, applyPmFields({}, pm));

  // Subcontractor (if sub_id provided in overrides)
  if (overrides.sub_id) {
    const sub = await env.DB.prepare(
      "SELECT company_name, city_state, trade, phone FROM subcontractors WHERE id = ?",
    )
      .bind(overrides.sub_id)
      .first<SubRow>();
    if (sub) {
      fields.sub_company_name = sub.company_name ?? "";
      fields.sub_address = sub.city_state ?? "";
      fields.sub_trade = sub.trade ?? "";
    }
  }

  // Validate required override fields for each template type
  const missingRequired: string[] = [];

  if (templateType === "change_order") {
    for (const f of ["change_order_number", "change_description"]) {
      if (!overrides[f] && !fields[f]) missingRequired.push(f);
    }
    fields.change_order_number = overrides.change_order_number ?? "";
    fields.change_description = overrides.change_description ?? "";
    fields.original_contract_amount = overrides.original_contract_amount
      ? formatCurrency(parseFloat(overrides.original_contract_amount))
      : fields.contract_amount;
    fields.net_change = overrides.net_change
      ? formatCurrency(parseFloat(overrides.net_change))
      : "";
    fields.revised_total = overrides.revised_total
      ? formatCurrency(parseFloat(overrides.revised_total))
      : "";
  }

  if (templateType === "lien_waiver_conditional" || templateType === "lien_waiver_sub_unconditional") {
    for (const f of ["payment_amount", "payment_date"]) {
      if (!overrides[f]) missingRequired.push(f);
    }
    if (templateType === "lien_waiver_conditional" && !overrides.through_date) {
      missingRequired.push("through_date");
    }
    fields.payment_amount = overrides.payment_amount
      ? formatCurrency(parseFloat(overrides.payment_amount))
      : "";
    fields.payment_date = overrides.payment_date
      ? formatDate(overrides.payment_date)
      : "";
    fields.through_date = overrides.through_date
      ? formatDate(overrides.through_date)
      : "";
  }

  if (templateType === "lien_waiver_sub_unconditional") {
    if (!overrides.sub_id && !overrides.sub_company_name) {
      missingRequired.push("sub_company_name (or sub_id)");
    }
    // Apply overrides for sub fields that weren't resolved from DB
    if (overrides.sub_company_name) fields.sub_company_name = overrides.sub_company_name;
    if (overrides.sub_address) fields.sub_address = overrides.sub_address;
    if (overrides.sub_trade) fields.sub_trade = overrides.sub_trade;
    if (!fields.sub_company_name) fields.sub_company_name = "";
    if (!fields.sub_address) fields.sub_address = "";
    if (!fields.sub_trade) fields.sub_trade = "";
  }

  if (missingRequired.length > 0) {
    throw new MissingFieldsError(missingRequired);
  }

  // Apply caller overrides (overrides always win, except certificate_number which is auto-generated)
  for (const [k, v] of Object.entries(overrides)) {
    if (k === "certificate_number") continue; // business rule 6
    if (k === "sub_id") continue; // not a merge field
    fields[k] = v;
  }

  // Business rule 5: ensure all values are strings (not null/undefined)
  for (const k of Object.keys(fields)) {
    if (!fields[k]) fields[k] = "";
  }

  return fields;
}

export class MissingFieldsError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing required fields: ${missing.join(", ")}`);
    this.name = "MissingFieldsError";
  }
}

// ─── Shared generation helper ─────────────────────────────────────────────────

export interface GenerateAndStoreOptions {
  /** Mark the document as contractor-signed immediately (used for auto-generated lien waivers). */
  signImmediately?: boolean;
  /** Set auto_generated = 1 and review_status = 'pending_review'. */
  autoGenerated?: boolean;
  /** Value for trigger_event column (e.g. 'client_payment'). */
  triggerEvent?: string;
  /** Value for related_record_id column (e.g. invoice/payment ID). */
  relatedRecordId?: string;
}

/**
 * Core document generation + storage logic, callable from both the HTTP route handler
 * and background triggers (e.g. completion-triggers.ts) without requiring an HTTP request.
 */
export async function generateAndStoreDocument(
  env: Env,
  jobId: string,
  templateType: TemplateType,
  overrides: Record<string, string>,
  generatedBy: string,
  opts?: GenerateAndStoreOptions,
): Promise<{ docId: string; filename: string; r2Key: string; downloadUrl: string }> {
  // Load job row
  const job = await env.DB.prepare(
    `SELECT id, job_number, title, client_id,
            property_address, property_city, property_state, property_zip,
            start_date, target_end_date, actual_end_date,
            contract_total, deposit_amount, notes, billing_model, warranty_expiration,
            assigned_to
       FROM jobs WHERE id = ?`,
  )
    .bind(jobId)
    .first<JobRow>();

  if (!job) throw new Error("job_not_found");

  // Resolve merge fields
  const mergeFields = await resolveMergeFields(env, job, overrides, templateType);

  // Fetch template from R2
  const r2TemplateKey = TEMPLATE_R2_KEYS[templateType];
  console.log(`[job-documents] fetching template: key="${r2TemplateKey}" bucket=FILES`);
  const templateObj = await env.FILES.get(r2TemplateKey);
  console.log(`[job-documents] R2 get result: ${templateObj ? `found (size=${templateObj.size})` : "null — NOT FOUND"}`);
  if (!templateObj) throw new Error(`template_not_found: ${r2TemplateKey}`);
  const templateBuffer = await templateObj.arrayBuffer();

  // Generate document — contractor signature embedded for warranty + lien_waiver_conditional
  const docBytes = await generateDocument(templateBuffer, mergeFields, {
    embedContractorSignature:
      templateType === "warranty_certificate" || templateType === "lien_waiver_conditional",
  });

  // Build filename and R2 key
  const today = new Date().toISOString().slice(0, 10);
  const slugType = templateType.replace(/_/g, "-");
  const jobNum = (job.job_number ?? jobId).toString().replace(/\s+/g, "-");
  const filename = `${slugType}-${jobNum}-${today}.docx`;
  const generatedKey = `documents/generated/${jobId}/${filename}`;

  // Upload to R2
  await env.FILES.put(generatedKey, docBytes, {
    httpMetadata: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  });

  // Insert job_documents row
  const docId = crypto.randomUUID();
  const reviewStatus = opts?.autoGenerated ? "pending_review" : "manual";
  const signedNow = opts?.signImmediately === true;
  const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);

  await env.DB.prepare(
    `INSERT INTO job_documents
       (id, job_id, template_type, filename, r2_key, generated_at, generated_by,
        auto_generated, trigger_event, related_record_id, review_status,
        signature_status, signature_completed_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      docId, jobId, templateType, filename, generatedKey, generatedBy,
      opts?.autoGenerated ? 1 : 0,
      opts?.triggerEvent ?? null,
      opts?.relatedRecordId ?? null,
      reviewStatus,
      signedNow ? "completed" : "none",
      signedNow ? nowIso : null,
    )
    .run();

  return {
    docId,
    filename,
    r2Key: generatedKey,
    downloadUrl: `/api/jobs/${jobId}/documents/${docId}/download`,
  };
}

// ─── POST /api/jobs/:id/documents/generate ───────────────────────────────────

export async function handleGenerateJobDocument(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json");
  }

  const templateType = body.template_type as string;
  if (!templateType || !VALID_TYPES.has(templateType)) {
    return err(400, "invalid_template_type", `Must be one of: ${[...VALID_TYPES].join(", ")}`);
  }

  const overrides: Record<string, string> = {};
  if (body.overrides && typeof body.overrides === "object") {
    for (const [k, v] of Object.entries(body.overrides as Record<string, unknown>)) {
      if (typeof v === "string") overrides[k] = v;
      else if (v != null) overrides[k] = String(v);
    }
  }

  // lien_waiver_conditional is contractor-signed at generation time (no external signature step)
  const signImmediately = templateType === "lien_waiver_conditional";

  let result: { docId: string; filename: string; r2Key: string; downloadUrl: string };
  try {
    result = await generateAndStoreDocument(env, jobId, templateType as TemplateType, overrides, user.email, {
      signImmediately,
    });
  } catch (e) {
    if (e instanceof MissingFieldsError) {
      return err(400, "missing_required_fields", e.missing.join(", "));
    }
    if (e instanceof Error && e.message === "job_not_found") return err(404, "job_not_found");
    if (e instanceof Error && e.message.startsWith("template_not_found:")) {
      return err(500, "template_not_found", e.message);
    }
    throw e;
  }

  return json(
    { id: result.docId, filename: result.filename, r2_key: result.r2Key, download_url: result.downloadUrl },
    { status: 201 },
  );
}

// ─── GET /api/jobs/:id/generated-documents ───────────────────────────────────

export async function handleListGeneratedDocuments(env: Env, jobId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, job_id, template_type, filename, r2_key, generated_at, generated_by, notes,
            review_status, auto_generated, trigger_event, related_record_id, reviewed_at, reviewed_by,
            signature_status, boldsign_document_id, signature_sent_at, signature_completed_at,
            signed_r2_key, signer_email, signer_name
       FROM job_documents
      WHERE job_id = ?
      ORDER BY datetime(generated_at) DESC`,
  )
    .bind(jobId)
    .all<Record<string, unknown>>();

  return json({ documents: results ?? [] });
}

// ─── GET /api/jobs/:id/documents/:doc_id/download ────────────────────────────

export async function handleDownloadJobDocument(
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT filename, r2_key FROM job_documents WHERE id = ? AND job_id = ?",
  )
    .bind(docId, jobId)
    .first<{ filename: string; r2_key: string }>();

  if (!row) return err(404, "document_not_found");

  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return err(404, "file_not_found", "R2 object missing");

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${row.filename}"`,
      "Cache-Control": "private, no-cache",
    },
  });
}

// ─── GET /api/jobs/:id/doc-preview ───────────────────────────────────────────

export async function handleJobDocPreview(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare(
    `SELECT j.job_number, j.title, j.contract_total,
            j.property_address, j.property_city, j.property_state, j.property_zip,
            c.first_name, c.last_name, c.name AS client_name_full, c.email AS client_email
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.id = ?`,
  )
    .bind(jobId)
    .first<{
      job_number: string;
      title: string;
      contract_total: number | null;
      property_address: string | null;
      property_city: string | null;
      property_state: string | null;
      property_zip: string | null;
      first_name: string | null;
      last_name: string | null;
      client_name_full: string | null;
      client_email: string | null;
    }>();

  if (!job) return err(404, "job_not_found");

  const addrParts = [job.property_address, job.property_city, job.property_state, job.property_zip].filter(Boolean);
  const fn = job.first_name ?? "";
  const ln = job.last_name ?? "";
  const clientName = (fn || ln) ? `${fn} ${ln}`.trim() : (job.client_name_full ?? "");

  return json({
    job_number: job.job_number ?? "",
    title: job.title ?? "",
    client_name: clientName,
    client_email: job.client_email ?? "",
    job_address: addrParts.join(", "),
    contract_amount: formatCurrency(job.contract_total),
  });
}

// ─── DELETE /api/jobs/:id/generated-documents/:doc_id ───────────────────────

export async function handleDeleteGeneratedDocument(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare(
    "SELECT id FROM job_documents WHERE id = ? AND job_id = ?",
  )
    .bind(docId, jobId)
    .first<{ id: string }>();

  if (!row) return err(404, "document_not_found");

  await env.DB.prepare("DELETE FROM signature_events WHERE job_document_id = ?")
    .bind(docId)
    .run();
  await env.DB.prepare("DELETE FROM job_documents WHERE id = ?").bind(docId).run();

  return json({ ok: true });
}

// ─── POST /api/jobs/:id/generated-documents/:doc_id/approve ─────────────────

export async function handleApproveDocument(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare(
    "SELECT id, review_status FROM job_documents WHERE id = ? AND job_id = ?",
  )
    .bind(docId, jobId)
    .first<{ id: string; review_status: string }>();

  if (!row) return err(404, "document_not_found");

  await env.DB.prepare(
    `UPDATE job_documents
        SET review_status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ?`,
  )
    .bind(user.email, docId)
    .run();

  const updated = await env.DB.prepare(
    `SELECT id, job_id, template_type, filename, r2_key, generated_at, generated_by, notes,
            review_status, auto_generated, trigger_event, related_record_id, reviewed_at, reviewed_by,
            signature_status, boldsign_document_id, signature_sent_at, signature_completed_at,
            signed_r2_key, signer_email, signer_name
       FROM job_documents WHERE id = ?`,
  )
    .bind(docId)
    .first<Record<string, unknown>>();

  return json({ document: updated });
}

// ─── POST /api/jobs/:id/generated-documents/:doc_id/discard ─────────────────

export async function handleDiscardDocument(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await env.DB.prepare(
    "SELECT id FROM job_documents WHERE id = ? AND job_id = ?",
  )
    .bind(docId, jobId)
    .first<{ id: string }>();

  if (!row) return err(404, "document_not_found");

  await env.DB.prepare(
    `UPDATE job_documents
        SET review_status = 'discarded', reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ?`,
  )
    .bind(user.email, docId)
    .run();

  const updated = await env.DB.prepare(
    `SELECT id, job_id, template_type, filename, r2_key, generated_at, generated_by, notes,
            review_status, auto_generated, trigger_event, related_record_id, reviewed_at, reviewed_by,
            signature_status, boldsign_document_id, signature_sent_at, signature_completed_at,
            signed_r2_key, signer_email, signer_name
       FROM job_documents WHERE id = ?`,
  )
    .bind(docId)
    .first<Record<string, unknown>>();

  return json({ document: updated });
}

// ─── GET /api/documents/review-queue ────────────────────────────────────────

interface ReviewQueueRow {
  id: string;
  job_id: string;
  job_number: string;
  job_title: string;
  client_name: string;
  template_type: string;
  filename: string;
  trigger_event: string | null;
  generated_at: string;
}

export async function handleReviewQueue(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;

  const { results } = await env.DB.prepare(
    `SELECT d.id, d.job_id, j.job_number, j.title AS job_title,
            COALESCE(c.first_name || ' ' || c.last_name, c.name, '') AS client_name,
            d.template_type, d.filename, d.trigger_event, d.generated_at,
            d.related_record_id
       FROM job_documents d
       JOIN jobs j ON j.id = d.job_id
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE d.review_status = 'pending_review'
      ORDER BY datetime(d.generated_at) DESC`,
  )
    .all<ReviewQueueRow & { related_record_id: string | null }>();

  const items = (results ?? []).map((r) => ({
    ...r,
    download_url: `/api/jobs/${r.job_id}/documents/${r.id}/download`,
  }));

  return json({ items });
}

// ─── GET /api/jobs/:id/generated-documents/:doc_id/view-url ──────────────────
// Returns a short-lived (5 min) HMAC-signed URL that Google Docs Viewer can
// fetch without Cloudflare Access. Uses the same FILE_LINK_SECRET / /api/f
// mechanism as the existing file-sharing system.

function b64uEncode(data: string): string {
  return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacB64u(secret: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return b64uEncode(s);
}

export async function handleDocViewUrl(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare(
    "SELECT id, filename FROM job_documents WHERE id = ? AND job_id = ?",
  ).bind(docId, jobId).first<{ id: string; filename: string }>();
  if (!row) return err(404, "document_not_found");

  const secret = (env as unknown as { FILE_LINK_SECRET?: string }).FILE_LINK_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return err(503, "file_link_unconfigured", "Set the FILE_LINK_SECRET wrangler secret to enable doc viewing.");
  }

  const ttl = 300; // 5 minutes
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const payload = { v: 1, k: "gendoc", i: docId, e: expiry };
  const j = b64uEncode(JSON.stringify(payload));
  const sig = await hmacB64u(secret, j);
  const token = `${j}.${sig}`;

  // Use HUB_FILE_LINK_ORIGIN (workers.dev) so Google Docs Viewer can reach it without CF Access.
  const origin =
    (env as unknown as { HUB_FILE_LINK_ORIGIN?: string }).HUB_FILE_LINK_ORIGIN?.trim().replace(/\/$/, "") ??
    new URL(request.url).origin;

  const fileUrl = `${origin}/api/f?t=${token}`;
  const viewerUrl = `https://docs.google.com/gview?url=${encodeURIComponent(fileUrl)}&embedded=true`;

  return json({ view_url: viewerUrl, file_url: fileUrl, filename: row.filename, expires_in: ttl });
}

// ─── Sprint 21: E-Signature routes ───────────────────────────────────────────

// ─── GET /api/esignature/status ──────────────────────────────────────────────

export async function handleESignatureStatus(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;

  const mode = await resolveESignatureMode(env);
  const apiKeyPresent = Boolean((env.BOLDSIGN_API_KEY ?? "").trim());
  const webhookSecretPresent = Boolean((env.BOLDSIGN_WEBHOOK_SECRET ?? "").trim());
  const webhookUrl = "https://dashboard.homesolutionsar.com/api/integrations/boldsign/webhook";

  return json({
    mode,
    api_key_present: apiKeyPresent,
    webhook_secret_present: webhookSecretPresent,
    webhook_url: webhookUrl,
    setting_key: SETTING_ESIGNATURE_MODE,
  });
}

// ─── POST /api/jobs/:id/generated-documents/:doc_id/send-for-signature ───────

interface SendForSigBody {
  signer_email?: string;
  signer_name?: string;
  message?: string;
}

interface FullDocRow {
  id: string;
  job_id: string;
  template_type: string;
  filename: string;
  r2_key: string;
  review_status: string;
  signature_status: string;
  boldsign_document_id: string | null;
}

/** Client-facing template types route to client email/name; sub waiver routes to the sub. */
const SUB_TEMPLATE_TYPES = new Set(["lien_waiver_sub_unconditional"]);

export async function handleSendForSignature(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare(
    `SELECT id, job_id, template_type, filename, r2_key, review_status, signature_status, boldsign_document_id
       FROM job_documents WHERE id = ? AND job_id = ?`,
  )
    .bind(docId, jobId)
    .first<FullDocRow>();

  if (!row) return err(404, "document_not_found");
  // Allow both approved docs (from review queue) and manual docs (user-generated on demand).
  if (row.review_status !== "approved" && row.review_status !== "manual") {
    return err(400, "not_approved", "Document must be approved (or manually generated) before sending for signature.");
  }
  // Allow resend on terminal states (revoked, declined, expired, failed) but not active ones.
  const RESENDABLE = new Set(["none", "revoked", "declined", "expired", "failed"]);
  if (!RESENDABLE.has(row.signature_status)) {
    return err(400, "already_sent", `Signature request already active (status: ${row.signature_status}). Revoke it first to resend.`);
  }

  // Resolve signer: use body override, else default by template type.
  let body: SendForSigBody = {};
  try { body = (await request.json()) as SendForSigBody; } catch { /* no body is fine */ }

  let signerEmail = body.signer_email?.trim() ?? "";
  let signerName = body.signer_name?.trim() ?? "";

  if (!signerEmail || !signerName) {
    // Auto-resolve from job data.
    if (SUB_TEMPLATE_TYPES.has(row.template_type)) {
      // Sub lien waiver → subcontractor from related expense.
      const sub = await env.DB.prepare(
        `SELECT sc.company_name, sc.contact_name, sc.email
           FROM expenses e
           JOIN subcontractors sc ON sc.id = e.sub_id
          WHERE e.job_id = ?
          ORDER BY e.created_at DESC LIMIT 1`,
      )
        .bind(jobId)
        .first<{ company_name: string | null; contact_name: string | null; email: string | null }>();
      if (sub?.email && !signerEmail) signerEmail = sub.email;
      if (!signerName) signerName = sub?.company_name ?? sub?.contact_name ?? "";
    } else {
      // Client-facing doc → job client.
      const client = await env.DB.prepare(
        `SELECT c.email, c.first_name, c.last_name, c.name
           FROM jobs j JOIN clients c ON c.id = j.client_id
          WHERE j.id = ?`,
      )
        .bind(jobId)
        .first<{ email: string | null; first_name: string | null; last_name: string | null; name: string | null }>();
      if (client?.email && !signerEmail) signerEmail = client.email;
      if (!signerName) {
        const fn = client?.first_name ?? "";
        const ln = client?.last_name ?? "";
        signerName = (fn || ln) ? `${fn} ${ln}`.trim() : (client?.name ?? "");
      }
    }
  }

  if (!signerEmail) {
    return err(400, "signer_email_required", "Could not resolve a signer email. Provide signer_email in the request body.");
  }

  // Fetch the generated .docx from R2.
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return err(404, "file_not_found", `R2 object missing: ${row.r2_key}`);
  const docxBytes = await obj.arrayBuffer();
  const docxBlob = new Blob([docxBytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  // Get BoldSign config.
  const config = await getBoldSignConfig(env);
  if (!config) {
    return err(503, "boldsign_unconfigured", "BOLDSIGN_API_KEY is not set. Configure it via `wrangler secret put BOLDSIGN_API_KEY`.");
  }

  // Resolve title from job.
  const job = await env.DB.prepare("SELECT title, job_number FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ title: string; job_number: string }>();

  const TEMPLATE_LABELS: Record<string, string> = {
    service_agreement: "Service Agreement",
    cost_plus_agreement: "Cost-Plus Billing Agreement",
    change_order: "Change Order",
    lien_waiver_conditional: "Conditional Lien Waiver",
    lien_waiver_sub_unconditional: "Unconditional Lien Waiver (Sub)",
    warranty_certificate: "Warranty Certificate",
  };
  const templateLabel = TEMPLATE_LABELS[row.template_type] ?? row.template_type;
  const title = job ? `${templateLabel} — ${job.title} (#${job.job_number})` : templateLabel;
  const message = body.message?.trim() || "Please review and sign this document at your earliest convenience.";

  // BoldSign template IDs — set via system_settings key `boldsign_template_id_{type}` or
  // fall back to per-type hardcoded IDs. Template IDs encode the drag-and-drop field
  // positions set in the BoldSign dashboard, eliminating coordinate guesswork.
  const BOLDSIGN_TEMPLATE_IDS: Record<string, string> = {
    service_agreement:           "1578f4a8-a7af-4792-b091-6dc2520397a4",
    cost_plus_agreement:         "6e28b9a4-af85-4c1b-a68d-ffb33af9b736",
    change_order:                "3fe5a120-b44e-4c60-8254-28259de7d44e",
    lien_waiver_conditional:     "7d6692c2-21e9-4ae9-ba2a-7f45c1f33eba",
    lien_waiver_sub_unconditional: "82223390-cff1-4f2e-9320-22dee1e4d0f7",
    warranty_certificate:        "cea0d213-836a-4f3b-84f8-6be2f348d918",
  };
  const settingKey = `boldsign_template_id_${row.template_type}`;
  const templateIdFromSettings = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = ?",
  )
    .bind(settingKey)
    .first<{ value: string }>()
    .then((r) => r?.value ?? null)
    .catch(() => null);
  const boldSignTemplateId = templateIdFromSettings ?? BOLDSIGN_TEMPLATE_IDS[row.template_type];

  // BoldSign requires signerRole + roleIndex to match the template definition.
  const isSubLienWaiver = SUB_TEMPLATE_TYPES.has(row.template_type);
  const boldSignRole = isSubLienWaiver ? "Subcontractor" : "Client";
  // Client templates: Contractor=1 (pre-filled), Client=2. Sub waiver: single Subcontractor role=1.
  const boldSignRoleIndex = isSubLienWaiver ? 1 : 2;

  // Send to BoldSign.
  let boldSignResult: { documentId: string };
  const additionalFiles: Array<{ blob: Blob; filename: string }> = [];
  if (row.template_type === "service_agreement") {
    const wa = await loadWorkingAgreementAttachment(env, jobId);
    if (wa) additionalFiles.push({ blob: wa.blob, filename: wa.filename });
  }
  try {
    boldSignResult = await sendDocumentForSignature(config, {
      fileBlob: docxBlob,
      filename: row.filename,
      title,
      message,
      signerEmail,
      signerName,
      signerRole: boldSignRole,
      roleIndex: boldSignRoleIndex,
      templateId: boldSignTemplateId,
      additionalFiles: additionalFiles.length ? additionalFiles : undefined,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[SEND-FOR-SIG] BoldSign error:", msg);
    return err(502, msg, "boldsign_error");
  }

  // Update job_documents row (note: Sent status is confirmed by webhook, but we pre-set 'sent').
  await env.DB.prepare(
    `UPDATE job_documents
        SET boldsign_document_id = ?,
            signature_status = 'sent',
            signature_sent_at = datetime('now'),
            signer_email = ?,
            signer_name = ?
      WHERE id = ?`,
  )
    .bind(boldSignResult.documentId, signerEmail, signerName, docId)
    .run();

  return json({
    ok: true,
    boldsign_document_id: boldSignResult.documentId,
    signature_status: "sent",
    signer_email: signerEmail,
    signer_name: signerName,
    mode: config.mode,
  });
}

// ─── GET /api/jobs/:id/generated-documents/:doc_id/signature-status ──────────

export async function handleSignatureStatus(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare(
    `SELECT id, signature_status, boldsign_document_id, signature_sent_at,
            signature_completed_at, signed_r2_key, signer_email, signer_name
       FROM job_documents WHERE id = ? AND job_id = ?`,
  )
    .bind(docId, jobId)
    .first<Record<string, unknown>>();

  if (!row) return err(404, "document_not_found");

  // Optionally fetch live status from BoldSign if a documentId is stored
  let boldSignStatus: Record<string, unknown> | null = null;
  const bsDocId = row.boldsign_document_id as string | null;
  if (bsDocId) {
    const config = await getBoldSignConfig(env);
    if (config) {
      try {
        const res = await fetch(
          `${BOLDSIGN_API_BASE}/v1/document/properties?documentId=${encodeURIComponent(bsDocId)}`,
          { headers: { "X-API-KEY": config.apiKey } },
        );
        if (res.ok) boldSignStatus = (await res.json()) as Record<string, unknown>;
        else boldSignStatus = { error: `${res.status}`, body: await res.text().catch(() => "") };
      } catch (e) {
        boldSignStatus = { error: (e as Error).message };
      }
    }
  }

  return json({ signature: row, boldsign: boldSignStatus });
}

// ─── POST /api/jobs/:id/generated-documents/:doc_id/remind ───────────────────

export async function handleSendReminder(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare(
    "SELECT id, boldsign_document_id, signature_status FROM job_documents WHERE id = ? AND job_id = ?",
  )
    .bind(docId, jobId)
    .first<{ id: string; boldsign_document_id: string | null; signature_status: string }>();

  if (!row) return err(404, "document_not_found");
  if (!row.boldsign_document_id) return err(400, "not_sent", "No active signature request for this document.");
  if (!["sent", "viewed"].includes(row.signature_status)) {
    return err(400, "invalid_status", `Cannot remind on a document with status "${row.signature_status}".`);
  }

  const config = await getBoldSignConfig(env);
  if (!config) return err(503, "boldsign_unconfigured", "BOLDSIGN_API_KEY is not set.");

  try {
    await sendReminder(config, row.boldsign_document_id);
  } catch (e) {
    const msg = (e as Error).message;
    return err(502, msg, "boldsign_error");
  }

  return json({ ok: true });
}

// ─── GET /api/jobs/:id/generated-documents/:doc_id/signed-pdf ────────────────

export async function handleDownloadSignedPdf(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare(
    "SELECT id, filename, signed_r2_key, signature_status FROM job_documents WHERE id = ? AND job_id = ?",
  )
    .bind(docId, jobId)
    .first<{ id: string; filename: string; signed_r2_key: string | null; signature_status: string }>();

  if (!row) return err(404, "document_not_found");
  if (!row.signed_r2_key) return err(404, "signed_pdf_not_available", "Signed PDF not yet available.");

  const obj = await env.FILES.get(row.signed_r2_key);
  if (!obj) return err(404, "file_not_found", "Signed PDF file missing from R2.");

  const pdfFilename = row.filename.replace(/\.docx$/i, "-signed.pdf");
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFilename}"`,
      "Cache-Control": "private, no-cache",
    },
  });
}

// ─── POST /api/jobs/:id/generated-documents/:doc_id/revoke ───────────────────

export async function handleRevokeSignature(
  request: Request,
  env: Env,
  jobId: string,
  docId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_PM]);
  if (guarded instanceof Response) return guarded;

  const row = await env.DB.prepare(
    "SELECT id, boldsign_document_id, signature_status FROM job_documents WHERE id = ? AND job_id = ?",
  )
    .bind(docId, jobId)
    .first<{ id: string; boldsign_document_id: string | null; signature_status: string }>();

  if (!row) return err(404, "document_not_found");
  if (!row.boldsign_document_id) return err(400, "not_sent", "No active signature request for this document.");
  if (["completed", "revoked", "declined", "expired"].includes(row.signature_status)) {
    return err(400, "invalid_status", `Cannot revoke a document with status "${row.signature_status}".`);
  }

  let body: { reason?: string } = {};
  try { body = (await request.json()) as { reason?: string }; } catch { /* optional */ }
  const reason = body.reason?.trim() || "Revoked by operator.";

  const config = await getBoldSignConfig(env);
  if (!config) return err(503, "boldsign_unconfigured", "BOLDSIGN_API_KEY is not set.");

  try {
    await revokeDocument(config, row.boldsign_document_id, reason);
  } catch (e) {
    const msg = (e as Error).message;
    return err(502, msg, "boldsign_error");
  }

  // Pre-set to revoked (webhook will confirm).
  await env.DB.prepare("UPDATE job_documents SET signature_status = 'revoked' WHERE id = ?")
    .bind(docId)
    .run();

  return json({ ok: true, signature_status: "revoked" });
}
