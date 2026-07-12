/**
 * working-agreement.ts — Working Agreement generation at fixed-price job conversion.
 *
 * Generates a merged .docx from the prepped template, stores it in R2 + documents,
 * and delivers it alongside the Service Agreement BoldSign send (attachment when
 * BoldSign is sent after conversion; companion Resend email when BoldSign was
 * already sent at estimate phase).
 *
 * Non-blocking: callers wrap in try/catch + ctx.waitUntil(); errors log only.
 */

import type { Env } from "../env.js";
import { insertDocument } from "../routes/documents.js";
import { generateDocument, formatToday } from "./document-generator.js";
import { applyPmFields, resolvePmFields } from "./pm-fields.js";

export const WORKING_AGREEMENT_TEMPLATE_R2 = "documents/templates/working-agreement.docx";

export interface WorkingAgreementAttachment {
  blob: Blob;
  filename: string;
}

/** True for fixed-price and trade-by-trade; false for cost-plus. */
export function shouldGenerateWorkingAgreement(billingModel: string | null | undefined): boolean {
  return billingModel !== "cost_plus";
}

/** Dedup: skip if an active working_agreement row already exists for the job. */
export async function jobHasWorkingAgreement(env: Env, jobId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM documents
      WHERE job_id = ?
        AND document_category = 'working_agreement'
        AND COALESCE(is_active, 1) = 1
      LIMIT 1`,
  )
    .bind(jobId)
    .first<{ id: string }>();
  return !!row;
}

interface JobContextRow {
  id: string;
  title: string | null;
  client_id: string | null;
  billing_model: string | null;
  assigned_to: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
}

async function resolveWorkingAgreementMergeFields(
  env: Env,
  job: JobContextRow,
): Promise<Record<string, string>> {
  const pm = await resolvePmFields(env, job.assigned_to);
  const propertyAddress = [
    job.property_address,
    job.property_city,
    job.property_state,
    job.property_zip,
  ]
    .filter(Boolean)
    .join(", ");

  let clientName = "";
  if (job.client_id) {
    const c = await env.DB.prepare(
      "SELECT first_name, last_name, name FROM clients WHERE id = ?",
    )
      .bind(job.client_id)
      .first<{ first_name: string | null; last_name: string | null; name: string | null }>();
    if (c) {
      clientName =
        [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || (c.name ?? "").trim();
    }
  }

  return applyPmFields(
    {
      client_name: clientName,
      property_address: propertyAddress,
      today_date: formatToday(),
    },
    pm,
  );
}

/** Load the working agreement file for BoldSign attachment, if one exists. */
export async function loadWorkingAgreementAttachment(
  env: Env,
  jobId: string,
): Promise<WorkingAgreementAttachment | null> {
  const row = await env.DB.prepare(
    `SELECT title, r2_key FROM documents
      WHERE job_id = ?
        AND document_category = 'working_agreement'
        AND COALESCE(is_active, 1) = 1
      ORDER BY datetime(created_at) DESC
      LIMIT 1`,
  )
    .bind(jobId)
    .first<{ title: string; r2_key: string }>();

  if (!row) return null;
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) return null;

  const bytes = await obj.arrayBuffer();
  const ext = row.title.toLowerCase().endsWith(".pdf") ? "pdf" : "docx";
  const mime =
    ext === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  return {
    blob: new Blob([bytes], { type: mime }),
    filename: row.title.endsWith(`.${ext}`) ? row.title : `${row.title}.${ext}`,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** True when the estimate-phase service agreement is fully signed. */
async function estimateServiceAgreementSigned(env: Env, jobId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT d.is_signed, d.signature_data
       FROM jobs j
       JOIN documents d ON d.estimate_id = j.estimate_id
      WHERE j.id = ?
        AND d.context_type = 'estimate'
        AND d.document_category = 'contract'
        AND COALESCE(d.is_active, 1) = 1
      ORDER BY datetime(d.created_at) DESC
      LIMIT 1`,
  )
    .bind(jobId)
    .first<{ is_signed: number | null; signature_data: string | null }>();

  if (!row) return false;
  if (row.is_signed) return true;
  if (!row.signature_data) return false;
  try {
    const meta = JSON.parse(row.signature_data) as { signature_status?: string };
    return meta.signature_status === "completed";
  } catch {
    return false;
  }
}

function companionEmailBody(serviceAgreementSigned: boolean): string {
  if (serviceAgreementSigned) {
    return (
      "Attached is an overview of how we work together — for your reference as your project gets underway.\n\n" +
      "Columbus Home Solutions, LLC"
    );
  }
  return (
    "Attached is an overview of how we work together — please read before signing your Service Agreement.\n\n" +
    "Columbus Home Solutions, LLC"
  );
}

/** Send companion email when BoldSign was already dispatched before conversion. */
export async function sendWorkingAgreementCompanionEmail(
  env: Env,
  jobId: string,
  attachment: WorkingAgreementAttachment,
): Promise<void> {
  const live = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";
  const from = (env.NOTIFICATIONS_EMAIL_FROM ?? "").trim();
  const apiKey = (env.RESEND_API_KEY ?? "").trim();

  const job = await env.DB.prepare(
    `SELECT j.title, j.client_id, c.email, c.first_name, c.last_name, c.name
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.id = ?`,
  )
    .bind(jobId)
    .first<{
      title: string | null;
      client_id: string | null;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
      name: string | null;
    }>();

  const to = job?.email?.trim() ?? "";
  if (!to) {
    console.warn(`[working-agreement] companion email skipped — no client email job=${jobId}`);
    return;
  }

  const jobTitle = job?.title ?? "Your Project";
  const subject = `Working With Columbus Home Solutions — ${jobTitle}`;
  const saSigned = await estimateServiceAgreementSigned(env, jobId);
  const text = companionEmailBody(saSigned);

  if (!live || !from || !apiKey || env.RESEND_DRY_RUN === "1") {
    console.log(
      `[working-agreement][SIMULATE] companion email to=${to} subject="${subject}" saSigned=${saSigned} attachment=${attachment.filename}`,
    );
    return;
  }

  const buf = await attachment.blob.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      attachments: [{ filename: attachment.filename, content: b64 }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[working-agreement] companion email failed (${res.status}): ${body.slice(0, 300)}`);
    return;
  }
  console.log(`[working-agreement] companion email sent job=${jobId} to=${to}`);
}

/** True when estimate-phase BoldSign service agreement was already sent before conversion. */
async function estimateBoldSignAlreadySent(env: Env, jobId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT d.signature_data
       FROM jobs j
       JOIN documents d ON d.estimate_id = j.estimate_id
      WHERE j.id = ?
        AND d.context_type = 'estimate'
        AND d.document_category = 'contract'
        AND COALESCE(d.is_active, 1) = 1
      ORDER BY datetime(d.created_at) DESC
      LIMIT 1`,
  )
    .bind(jobId)
    .first<{ signature_data: string | null }>();

  if (!row?.signature_data) return false;
  try {
    const meta = JSON.parse(row.signature_data) as { boldsign_document_id?: string };
    return !!meta.boldsign_document_id;
  } catch {
    return false;
  }
}

export interface GenerateWorkingAgreementResult {
  generated: boolean;
  reason?: string;
  docId?: string;
}

/**
 * Generate and store the Working Agreement for a job. Optionally deliver via
 * companion email when BoldSign was already sent at estimate phase.
 */
export async function generateAndAttachWorkingAgreement(
  env: Env,
  jobId: string,
): Promise<GenerateWorkingAgreementResult> {
  const job = await env.DB.prepare(
    `SELECT id, title, client_id, billing_model, assigned_to,
            property_address, property_city, property_state, property_zip
       FROM jobs WHERE id = ?`,
  )
    .bind(jobId)
    .first<JobContextRow>();

  if (!job) return { generated: false, reason: "job_not_found" };
  if (!shouldGenerateWorkingAgreement(job.billing_model)) {
    return { generated: false, reason: "cost_plus_skipped" };
  }
  if (await jobHasWorkingAgreement(env, jobId)) {
    return { generated: false, reason: "already_exists" };
  }

  const templateObj = await env.FILES.get(WORKING_AGREEMENT_TEMPLATE_R2);
  if (!templateObj) {
    console.error(`[working-agreement] template missing: ${WORKING_AGREEMENT_TEMPLATE_R2}`);
    return { generated: false, reason: "template_not_found" };
  }

  const mergeFields = await resolveWorkingAgreementMergeFields(env, job);
  const docBytes = await generateDocument(await templateObj.arrayBuffer(), mergeFields);
  const filename = `Working Agreement — ${job.title ?? "Project"}.docx`;

  const docId = await insertDocument(env, {
    title: filename,
    fileType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileSize: docBytes.byteLength,
    bytes: new Uint8Array(docBytes).buffer,
    contextType: "job",
    jobId,
    clientId: job.client_id,
    category: "working_agreement",
    uploadedBy: "system",
    mirror: true,
    isSigned: false,
  });

  console.log(`[working-agreement] generated docId=${docId} job=${jobId}`);

  // If BoldSign was already sent at estimate phase, deliver via companion email.
  if (await estimateBoldSignAlreadySent(env, jobId)) {
    const attachment = await loadWorkingAgreementAttachment(env, jobId);
    if (attachment) {
      await sendWorkingAgreementCompanionEmail(env, jobId, attachment).catch((e) =>
        console.error("[working-agreement] companion email error:", (e as Error).message),
      );
    }
  }

  return { generated: true, docId };
}

/** Non-blocking entry point for job conversion handlers. */
export function scheduleWorkingAgreementGeneration(
  env: Env,
  jobId: string,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
): void {
  ctx.waitUntil(
    generateAndAttachWorkingAgreement(env, jobId).catch((e) =>
      console.error("[working-agreement] generation failed:", (e as Error).message),
    ),
  );
}
