/**
 * Estimate-phase Service Agreement generation + BoldSign send (Sprint 22).
 *
 * Contract documents attach to the estimate via documents.context_type='estimate'.
 * BoldSign metadata lives in documents.signature_data (JSON) — no migration needed.
 */

import type { Env } from "../env.js";
import { insertDocument } from "../routes/documents.js";
import {
  TEMPLATE_R2_KEYS,
  type TemplateType,
} from "../routes/job-documents.js";
import {
  generateDocument,
  formatCurrency,
  formatDate,
  formatToday,
} from "./document-generator.js";
import { depositFromSchedule } from "./deposit-from-schedule.js";
import { paymentScheduleMergeFields } from "./payment-schedule-merge.js";
import { ensureServiceAgreementTemplate } from "./service-agreement-template.js";
import { getBoldSignConfig, getDocumentProperties, getEmbeddedSignLink, mapBoldSignDocumentStatus, sendDocumentForSignature } from "./boldsign.js";
import { applyPmFields, resolvePmFields } from "./pm-fields.js";
import { loadWorkingAgreementAttachment } from "./working-agreement.js";

export interface EstimateSignatureMeta {
  template_type?: string;
  boldsign_document_id?: string;
  signature_status?: string;
  signature_error?: string;
  signer_email?: string;
  signer_name?: string;
  signature_sent_at?: string;
  signature_completed_at?: string;
  signed_r2_key?: string;
}

export interface EstimateContractDocRow {
  id: string;
  estimate_id: string | null;
  title: string;
  r2_key: string;
  signature_data: string | null;
  is_signed: number | null;
  signed_date: string | null;
}

const CONTRACT_TEXT_TAG_TYPES = new Set(["service_agreement", "cost_plus_agreement"]);

const TEMPLATE_LABELS: Record<string, string> = {
  service_agreement: "Service Agreement",
  cost_plus_agreement: "Cost-Plus Billing Agreement",
};

/** Map estimate builder contract dropdown → job-documents template type. */
export function resolveEstimateTemplateType(
  contractTemplateId: string | null,
  billingModel: string | null,
): TemplateType {
  if (contractTemplateId === "cost_plus_billing_agreement" || billingModel === "cost_plus") {
    return "cost_plus_agreement";
  }
  return "service_agreement";
}

export function parseSignatureMeta(raw: string | null | undefined): EstimateSignatureMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as EstimateSignatureMeta;
  } catch {
    return {};
  }
}

export function serializeSignatureMeta(meta: EstimateSignatureMeta): string {
  return JSON.stringify(meta);
}

/** Latest active estimate-phase contract document, if any. */
export async function loadEstimateContractDoc(
  env: Env,
  estimateId: string,
): Promise<EstimateContractDocRow | null> {
  return env.DB.prepare(
    `SELECT id, estimate_id, title, r2_key, signature_data, is_signed, signed_date
       FROM documents
      WHERE estimate_id = ?
        AND context_type = 'estimate'
        AND document_category = 'contract'
        AND COALESCE(is_active, 1) = 1
      ORDER BY datetime(created_at) DESC
      LIMIT 1`,
  )
    .bind(estimateId)
    .first<EstimateContractDocRow>();
}

/** True when the job's estimate already has a signed contract — skip job-phase autogen. */
export async function estimateHasSignedContractForJob(
  env: Env,
  jobId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT d.id
       FROM jobs j
       JOIN documents d ON d.estimate_id = j.estimate_id
      WHERE j.id = ?
        AND d.context_type = 'estimate'
        AND d.document_category = 'contract'
        AND COALESCE(d.is_signed, 0) = 1
        AND COALESCE(d.is_active, 1) = 1
      LIMIT 1`,
  )
    .bind(jobId)
    .first<{ id: string }>();
  return !!row;
}

/** Skip service/cost-plus agreement autogen when estimate-phase contract was signed. */
export async function shouldSkipContractAutogen(
  env: Env,
  jobId: string,
  templateType: string,
): Promise<boolean> {
  if (!CONTRACT_TEXT_TAG_TYPES.has(templateType)) return false;
  return estimateHasSignedContractForJob(env, jobId);
}

interface EstimateContextRow {
  id: string;
  estimate_number: number | null;
  client_id: string | null;
  request_id: string | null;
  title: string | null;
  billing_model: string | null;
  total: number | null;
  deposit_amount: number | null;
  notes: string | null;
  include_contract: number | null;
  contract_template_id: string | null;
  client_name: string | null;
  c_first: string | null;
  c_last: string | null;
  client_phone: string | null;
  client_email: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_postal: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
}

/** Merge fields for estimate-phase contract templates (job-documents field names). */
export async function resolveEstimateMergeFields(
  env: Env,
  estimateId: string,
  contractDate?: string,
): Promise<Record<string, string>> {
  const row = await env.DB.prepare(
    `SELECT e.id, e.estimate_number, e.client_id, e.request_id, e.title, e.billing_model,
            e.total, e.deposit_amount, e.notes, e.include_contract, e.contract_template_id,
            c.name AS client_name, c.first_name AS c_first, c.last_name AS c_last,
            c.phone AS client_phone, c.email AS client_email,
            c.address_street, c.address_city, c.address_state, c.address_postal,
            er.property_address, er.property_city, er.property_state, er.property_zip
       FROM estimates e
       LEFT JOIN clients c ON c.id = e.client_id
       LEFT JOIN estimate_requests er ON er.id = e.request_id
      WHERE e.id = ?`,
  )
    .bind(estimateId)
    .first<EstimateContextRow>();

  if (!row) throw new Error(`estimate not found: ${estimateId}`);

  const schedule = (
    await env.DB.prepare(
      `SELECT description, is_deposit, fixed_amount, percentage, amount, trigger
         FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC`,
    )
      .bind(estimateId)
      .all<{
        description: string | null;
        is_deposit: number | null;
        fixed_amount: number | null;
        percentage: number | null;
        amount: number | null;
        trigger: string | null;
      }>()
  ).results ?? [];

  const total = row.total ?? 0;
  const deposit = depositFromSchedule(schedule, total) || row.deposit_amount || 0;

  const clientName =
    [row.c_first, row.c_last].filter(Boolean).join(" ").trim() || row.client_name || "";
  const clientAddr = [row.address_street, row.address_city, row.address_state, row.address_postal]
    .filter(Boolean)
    .join(", ");
  const jobAddr = [row.property_address, row.property_city, row.property_state, row.property_zip]
    .filter(Boolean)
    .join(", ");

  const contractorRow = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'contractor_name'",
  ).first<{ value: string }>();

  const jobPm = await env.DB.prepare(
    "SELECT assigned_to FROM jobs WHERE estimate_id = ? LIMIT 1",
  )
    .bind(estimateId)
    .first<{ assigned_to: string | null }>();
  const pm = await resolvePmFields(env, jobPm?.assigned_to);

  const estLabel =
    row.estimate_number != null
      ? `EST-${String(row.estimate_number).padStart(3, "0")}`
      : estimateId.slice(0, 8);

  return {
    client_name: clientName,
    client_address: clientAddr,
    client_phone: row.client_phone ?? "",
    client_email: row.client_email ?? "",
    job_address: jobAddr,
    job_name: row.title ?? "",
    job_number: estLabel,
    contract_amount: formatCurrency(total),
    contract_date: contractDate ? formatDate(contractDate) : formatToday(),
    deposit_amount: formatCurrency(deposit),
    work_description: row.notes ?? row.title ?? "",
    contractor_name: contractorRow?.value?.trim() || "Tony Columbus, Owner",
    start_date: "",
    completion_date: "",
    management_fee_rate: "",
    estimated_budget: "",
    certificate_number: "",
    warranty_expiry: "",
    ...applyPmFields({}, pm),
    ...paymentScheduleMergeFields(schedule, total),
  };
}

export interface GenerateEstimateContractResult {
  docId: string | null;
  skipped: boolean;
  reason?: string;
  boldsign_sent?: boolean;
}

/**
 * Generate the Service Agreement .docx, attach to the estimate, and send for
 * BoldSign signature when configured. Non-blocking failures log and return skipped.
 */
export async function generateAndSendEstimateContract(
  env: Env,
  estimateId: string,
  generatedBy: string,
): Promise<GenerateEstimateContractResult> {
  const row = await env.DB.prepare(
    `SELECT id, estimate_number, title, billing_model, include_contract, contract_template_id, client_id
       FROM estimates WHERE id = ?`,
  )
    .bind(estimateId)
    .first<{
      id: string;
      estimate_number: number | null;
      title: string | null;
      billing_model: string | null;
      include_contract: number | null;
      contract_template_id: string | null;
      client_id: string | null;
    }>();

  if (!row) return { docId: null, skipped: true, reason: "estimate_not_found" };
  if ((row.include_contract ?? 1) !== 1) {
    return { docId: null, skipped: true, reason: "no_contract" };
  }

  const templateType = resolveEstimateTemplateType(row.contract_template_id, row.billing_model);
  const mergeFields = await resolveEstimateMergeFields(env, estimateId);
  const r2Key = TEMPLATE_R2_KEYS[templateType];
  const templateObj = await env.FILES.get(r2Key);
  if (!templateObj) {
    console.error(`[estimate-contract] template missing: ${r2Key}`);
    return { docId: null, skipped: true, reason: "template_not_found" };
  }

  let templateBytes = await templateObj.arrayBuffer();
  if (templateType === "service_agreement") {
    templateBytes = ensureServiceAgreementTemplate(templateBytes);
  }

  const docBytes = await generateDocument(templateBytes, mergeFields);
  const today = new Date().toISOString().slice(0, 10);
  const slugType = templateType.replace(/_/g, "-");
  const estNum = row.estimate_number != null ? String(row.estimate_number).padStart(3, "0") : "000";
  const filename = `${slugType}-EST-${estNum}-${today}.docx`;

  // Supersede any prior estimate-phase contract docs on re-send.
  await env.DB.prepare(
    `UPDATE documents
        SET is_active = 0,
            mirror_status = CASE WHEN mirror_status = 'pending' THEN 'skipped' ELSE mirror_status END,
            updated_at = datetime('now')
      WHERE estimate_id = ? AND context_type = 'estimate' AND document_category = 'contract'`,
  )
    .bind(estimateId)
    .run();

  const docId = await insertDocument(env, {
    title: filename,
    fileType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileSize: docBytes.byteLength,
    bytes: new Uint8Array(docBytes).buffer,
    contextType: "estimate",
    estimateId,
    clientId: row.client_id,
    category: "contract",
    uploadedBy: generatedBy,
    mirror: true,
    isSigned: false,
  });

  const meta: EstimateSignatureMeta = { template_type: templateType, signature_status: "none" };
  await env.DB.prepare(
    "UPDATE documents SET signature_data = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(serializeSignatureMeta(meta), docId)
    .run();

  const config = await getBoldSignConfig(env);
  if (!config) {
    console.warn("[estimate-contract] BoldSign not configured — portal will use typed signature fallback");
    return { docId, skipped: false, boldsign_sent: false };
  }

  const client = row.client_id
    ? await env.DB.prepare(
        "SELECT email, first_name, last_name, name FROM clients WHERE id = ?",
      )
        .bind(row.client_id)
        .first<{
          email: string | null;
          first_name: string | null;
          last_name: string | null;
          name: string | null;
        }>()
    : null;

  const signerEmail = client?.email?.trim() ?? "";
  const fn = client?.first_name ?? "";
  const ln = client?.last_name ?? "";
  const signerName = (fn || ln) ? `${fn} ${ln}`.trim() : (client?.name ?? "");

  if (!signerEmail) {
    console.warn("[estimate-contract] client email missing — BoldSign send skipped");
    return { docId, skipped: false, boldsign_sent: false };
  }

  const docRow = await env.DB.prepare("SELECT r2_key FROM documents WHERE id = ?")
    .bind(docId)
    .first<{ r2_key: string }>();
  const obj = docRow ? await env.FILES.get(docRow.r2_key) : null;
  if (!obj) {
    console.error("[estimate-contract] generated doc missing from R2");
    return { docId, skipped: false, boldsign_sent: false };
  }

  const docxBytes = await obj.arrayBuffer();
  const templateLabel = TEMPLATE_LABELS[templateType] ?? templateType;
  const title = `${templateLabel} — ${row.title ?? "Estimate"} (EST-${estNum})`;

  try {
    const additionalFiles: Array<{ blob: Blob; filename: string }> = [];
    if (templateType === "service_agreement") {
      const jobRow = await env.DB.prepare("SELECT id FROM jobs WHERE estimate_id = ? LIMIT 1")
        .bind(estimateId)
        .first<{ id: string }>();
      if (jobRow) {
        const wa = await loadWorkingAgreementAttachment(env, jobRow.id);
        if (wa) additionalFiles.push({ blob: wa.blob, filename: wa.filename });
      }
    }

    const result = await sendDocumentForSignature(config, {
      fileBlob: new Blob([docxBytes], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      filename,
      title,
      message: "Please review and sign your service agreement to proceed with your project.",
      signerEmail,
      signerName,
      useTextTags: true,
      additionalFiles: additionalFiles.length ? additionalFiles : undefined,
    });

    meta.boldsign_document_id = result.documentId;
    // BoldSign document creation is async — wait for Sent webhook before embed link works.
    meta.signature_status = "pending";
    meta.signer_email = signerEmail;
    meta.signer_name = signerName;
    meta.signature_sent_at = new Date().toISOString();

    await env.DB.prepare(
      "UPDATE documents SET signature_data = ?, updated_at = datetime('now') WHERE id = ?",
    )
      .bind(serializeSignatureMeta(meta), docId)
      .run();

    return { docId, skipped: false, boldsign_sent: true };
  } catch (e) {
    console.error("[estimate-contract] BoldSign send failed:", (e as Error).message);
    return { docId, skipped: false, boldsign_sent: false };
  }
}

/** BoldSign statuses where the document exists and an embed link may work. */
const BOLDSIGN_EMBED_READY = new Set(["sent", "viewed", "signed"]);

async function persistEstimateSignatureMeta(
  env: Env,
  docId: string,
  meta: EstimateSignatureMeta,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE documents SET signature_data = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(serializeSignatureMeta(meta), docId)
    .run();
}

/**
 * Poll BoldSign when signature_status is still 'pending' — Sent webhooks can lag
 * or never arrive for document/send, leaving the quote page stuck forever.
 */
export async function refreshEstimateContractSignatureStatus(
  env: Env,
  contractDoc: EstimateContractDocRow,
): Promise<EstimateSignatureMeta> {
  const meta = parseSignatureMeta(contractDoc.signature_data);
  if (!meta.boldsign_document_id || meta.signature_status !== "pending") return meta;

  const config = await getBoldSignConfig(env);
  if (!config) return meta;

  const props = await getDocumentProperties(config, meta.boldsign_document_id);
  if (props?.status) {
    const mapped = mapBoldSignDocumentStatus(props.status);
    if (mapped && mapped !== "pending") {
      meta.signature_status = mapped;
      if (mapped === "failed" && props.errorMessage) {
        meta.signature_error = props.errorMessage.slice(0, 500);
      }
      await persistEstimateSignatureMeta(env, contractDoc.id, meta);
      return meta;
    }
  }

  // Embed link probe: BoldSign may accept signing before status webhook lands.
  if (meta.signer_email) {
    try {
      await getEmbeddedSignLink(config, meta.boldsign_document_id, meta.signer_email);
      meta.signature_status = "sent";
      await persistEstimateSignatureMeta(env, contractDoc.id, meta);
    } catch {
      /* still processing on BoldSign side */
    }
  }

  return meta;
}

const REFRESH_POLL_MS = 1500;
const REFRESH_POLL_ATTEMPTS = 6;

/** Poll BoldSign until status leaves pending (or attempts exhausted). */
export async function refreshEstimateContractSignatureStatusWithRetry(
  env: Env,
  contractDoc: EstimateContractDocRow,
  attempts = REFRESH_POLL_ATTEMPTS,
): Promise<EstimateSignatureMeta> {
  let doc = contractDoc;
  let meta = parseSignatureMeta(doc.signature_data);
  for (let i = 0; i < attempts; i++) {
    meta = await refreshEstimateContractSignatureStatus(env, doc);
    if (meta.signature_status !== "pending") return meta;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, REFRESH_POLL_MS));
      if (doc.estimate_id) {
        const refreshed = await loadEstimateContractDoc(env, doc.estimate_id);
        if (refreshed) doc = refreshed;
      }
    }
  }
  return meta;
}

/** True when signature_data has a BoldSign doc that is ready for embedded signing. */
export function estimateBoldsignEmbedReady(meta: EstimateSignatureMeta): boolean {
  return !!meta.boldsign_document_id && BOLDSIGN_EMBED_READY.has(meta.signature_status ?? "");
}

/** Re-send the estimate contract when BoldSign async processing failed or left a stale ID. */
export async function resendEstimateContractForSigning(
  env: Env,
  estimateId: string,
  triggeredBy: string,
): Promise<{ contractDoc: EstimateContractDocRow; meta: EstimateSignatureMeta } | null> {
  const result = await generateAndSendEstimateContract(env, estimateId, triggeredBy);
  if (!result.boldsign_sent || !result.docId) return null;
  const contractDoc = await loadEstimateContractDoc(env, estimateId);
  if (!contractDoc) return null;
  return { contractDoc, meta: parseSignatureMeta(contractDoc.signature_data) };
}

/** Whether the estimate still needs a signature before deposit payment. */
export function estimateNeedsSignature(
  includeContract: boolean,
  contractDoc: EstimateContractDocRow | null,
): boolean {
  if (!includeContract) return false;
  if (!contractDoc) return true;
  const meta = parseSignatureMeta(contractDoc.signature_data);
  // BoldSign path: require completed status (webhook also sets estimate.client_signature).
  if (meta.boldsign_document_id) {
    return meta.signature_status !== "completed" && (contractDoc.is_signed ?? 0) !== 1;
  }
  // Typed-signature fallback when BoldSign was not sent.
  return true;
}

/** Whether signature is complete (for pay gates). */
export function estimateSignatureComplete(
  includeContract: boolean,
  clientSignature: string | null,
  contractDoc: EstimateContractDocRow | null,
): boolean {
  if (!includeContract) return true;
  if (clientSignature) return true;
  if (!contractDoc) return false;
  const meta = parseSignatureMeta(contractDoc.signature_data);
  if (meta.boldsign_document_id) {
    return meta.signature_status === "completed" || (contractDoc.is_signed ?? 0) === 1;
  }
  return !!clientSignature;
}
