/**
 * webhooks-boldsign.ts — BoldSign webhook receiver (Sprint 21).
 *
 *   POST /api/integrations/boldsign/webhook
 *
 * PUBLIC route (no CF Access). Verified by HMAC-SHA256 X-BoldSign-Signature
 * header (same multi-entry approach as Stripe: accept if s0 OR s1 matches).
 *
 * Business rules:
 *  - Respond 200 within 10s; ALL heavy work deferred via ctx.waitUntil().
 *  - Handle the BoldSign Verification handshake immediately (200 before verify).
 *  - Reject 401 on bad signature (log reason, never log the secret).
 *  - Every event inserts a signature_events audit row.
 *  - On Completed: download the signed PDF, store in R2, create a documents row
 *    so it joins the existing portal / Drive mirror pipeline.
 */

import type { Env } from "../env.js";
import { verifyBoldSignWebhook, getBoldSignConfig, downloadSignedDocument } from "../lib/boldsign.js";
import { triggerNotification } from "../lib/notification-engine.js";
import {
  parseSignatureMeta,
  serializeSignatureMeta,
  type EstimateSignatureMeta,
} from "../lib/estimate-contract-document.js";
import { applySelectionChoiceApproval, applyCombinedSelectionApproval, finalizeSelectionApprovalDocument } from "./selections.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

interface BoldSignEventData {
  object?: string;
  documentId?: string;
  templateId?: string;
  errorMessage?: string;
  signerDetails?: Array<{
    signerEmail?: string;
    signerName?: string;
    status?: string;
    signedOn?: string;
  }>;
}

interface BoldSignEvent {
  Event?: {
    EventType?: string;
    EventTime?: string;
    Document?: {
      DocumentId?: string;
      DocumentStatus?: string;
      SignerDetails?: Array<{
        SignerEmail?: string;
        SignerName?: string;
        Status?: string;
        SignedOn?: string;
      }>;
    };
  };
  event?: {
    eventType?: string;
  };
  data?: BoldSignEventData;
  Data?: BoldSignEventData;
  // Verification handshake
  IsHandshake?: boolean;
}

function getEventType(event: BoldSignEvent): string | undefined {
  return event.Event?.EventType ?? event.event?.eventType;
}

function getDocumentId(event: BoldSignEvent): string | undefined {
  return event.Event?.Document?.DocumentId ?? event.data?.documentId ?? event.Data?.documentId;
}

function getEventData(event: BoldSignEvent): BoldSignEventData | undefined {
  return event.data ?? event.Data;
}

function getSignerDetails(event: BoldSignEvent): Array<{
  SignerEmail?: string;
  SignerName?: string;
  Status?: string;
  SignedOn?: string;
}> | undefined {
  const legacy = event.Event?.Document?.SignerDetails;
  if (legacy) return legacy;
  const modern = getEventData(event)?.signerDetails;
  if (!modern) return undefined;
  return modern.map((s) => ({
    SignerEmail: s.signerEmail,
    SignerName: s.signerName,
    Status: s.status,
    SignedOn: s.signedOn,
  }));
}

/** Map BoldSign event types to our signature_status values. */
function mapEventToStatus(eventType: string): string | null {
  const map: Record<string, string> = {
    Sent: "sent",
    Viewed: "viewed",
    Signed: "signed",
    Completed: "completed",
    Declined: "declined",
    Revoked: "revoked",
    Expired: "expired",
    SendFailed: "failed",
    DeliveryFailed: "failed",
  };
  return map[eventType] ?? null;
}

export async function handleBoldSignWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Read raw body before any parsing (required for HMAC).
  const rawBody = await request.text();

  // Parse early to detect the Verification handshake (must respond before verify).
  let event: BoldSignEvent;
  try {
    event = JSON.parse(rawBody) as BoldSignEvent;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  // BoldSign URL-verification handshake — respond 200 immediately, no signature required.
  if (event.IsHandshake === true || getEventType(event) === "Verification") {
    console.log("[boldsign_webhook] verification_handshake: responding 200");
    return json({ ok: true, message: "Webhook verification successful" });
  }

  // Verify HMAC signature.
  const sigHeader = request.headers.get("X-BoldSign-Signature");
  const secret = (env.BOLDSIGN_WEBHOOK_SECRET ?? "").trim() || null;
  const verified = await verifyBoldSignWebhook(rawBody, sigHeader, secret);

  if (!verified.ok) {
    console.warn(`[boldsign_webhook] signature_rejected: reason=${verified.reason}`);
    return json({ error: "invalid_signature", reason: verified.reason }, { status: 401 });
  }

  // Respond 200 immediately; do heavy work in waitUntil.
  ctx.waitUntil(processWebhookEvent(env, event, rawBody));
  return json({ ok: true });
}

async function processWebhookEvent(
  env: Env,
  event: BoldSignEvent,
  rawBody: string,
): Promise<void> {
  const eventType = getEventType(event);

  if (eventType === "TemplateSendFailed") {
    await handleTemplateSendFailed(env, event, rawBody);
    return;
  }

  const boldSignDocumentId = getDocumentId(event);

  console.log(`[boldsign_webhook] event_type="${eventType}" documentId="${boldSignDocumentId ?? "unknown"}"`);

  if (!eventType || !boldSignDocumentId) {
    console.warn("[boldsign_webhook] missing eventType or documentId — skipping");
    return;
  }

  // Look up job_documents first, then estimate-phase documents (signature_data JSON).
  const docRow = await env.DB.prepare(
    `SELECT id, job_id, template_type, filename, signer_email, signer_name
       FROM job_documents WHERE boldsign_document_id = ?`,
  )
    .bind(boldSignDocumentId)
    .first<{
      id: string;
      job_id: string;
      template_type: string;
      filename: string;
      signer_email: string | null;
      signer_name: string | null;
    }>();

  if (!docRow) {
    const estimateDoc = await env.DB.prepare(
      `SELECT id, estimate_id, title, r2_key, signature_data, client_id
         FROM documents
        WHERE context_type = 'estimate'
          AND document_category = 'contract'
          AND json_extract(signature_data, '$.boldsign_document_id') = ?
        LIMIT 1`,
    )
      .bind(boldSignDocumentId)
      .first<{
        id: string;
        estimate_id: string | null;
        title: string;
        r2_key: string;
        signature_data: string | null;
        client_id: string | null;
      }>();

    if (estimateDoc) {
      await handleEstimateDocumentEvent(env, estimateDoc, boldSignDocumentId, eventType, event, rawBody);
      return;
    }

    const clientWaiver = await env.DB.prepare(
      `SELECT clw.*, j.client_id, j.id as job_id
         FROM client_lien_waivers clw
         JOIN jobs j ON j.id = clw.job_id
        WHERE clw.boldsign_document_id = ?`,
    )
      .bind(boldSignDocumentId)
      .first<{
        id: string;
        job_id: string;
        client_id: string;
        status: string;
      }>();

    if (clientWaiver) {
      await handleClientLienWaiverEvent(env, clientWaiver, boldSignDocumentId, eventType, event, rawBody);
      return;
    }

    // Selection choice approval document.
    // selection_id / choice_id / job_id are all inside signature_data JSON — no context_id column exists.
    const selectionDoc = await env.DB.prepare(
      `SELECT id, signature_data
         FROM documents
        WHERE context_type = 'selection'
          AND json_extract(signature_data, '$.boldsign_document_id') = ?
        LIMIT 1`,
    )
      .bind(boldSignDocumentId)
      .first<{
        id: string;
        signature_data: string | null;
      }>();

    if (selectionDoc) {
      if (eventType === "Completed" && selectionDoc.signature_data) {
        try {
          const sigData = JSON.parse(selectionDoc.signature_data) as {
            boldsign_document_id: string;
            combined?: boolean;
            selection_id?: string;
            choice_id?: string;
            estimate_id?: string;
            job_id?: string | null;
            selections?: Array<{ selection_id: string; choice_id: string }>;
          };
          const signedAt =
            getSignerDetails(event)?.[0]?.SignedOn ?? new Date().toISOString();
          if (sigData.combined && sigData.selections?.length && sigData.estimate_id) {
            await applyCombinedSelectionApproval(
              env,
              {
                boldsign_document_id: sigData.boldsign_document_id,
                combined: true,
                estimate_id: sigData.estimate_id,
                job_id: sigData.job_id,
                selections: sigData.selections,
              },
              signedAt,
            );
          } else if (sigData.selection_id && sigData.choice_id) {
            await applySelectionChoiceApproval(env, sigData as {
              boldsign_document_id: string;
              selection_id: string;
              choice_id: string;
              job_id?: string | null;
              estimate_id?: string | null;
            }, signedAt);
          }
          await finalizeSelectionApprovalDocument(
            env,
            selectionDoc.id,
            boldSignDocumentId,
            sigData,
            signedAt,
          );
        } catch (applyErr) {
          console.error(`[boldsign_webhook] applySelectionChoiceApproval failed: ${(applyErr as Error).message}`);
        }
      }
      return;
    }

    // Subcontractor agreement document
    const agreementDoc = await env.DB.prepare(
      `SELECT id, signature_data
         FROM documents
        WHERE context_type = 'subcontractor_agreement'
          AND json_extract(signature_data, '$.boldsign_document_id') = ?
        LIMIT 1`,
    )
      .bind(boldSignDocumentId)
      .first<{ id: string; signature_data: string | null }>();

    if (agreementDoc) {
      if (eventType === "Completed" && agreementDoc.signature_data) {
        try {
          const sigData = JSON.parse(agreementDoc.signature_data) as {
            boldsign_document_id: string;
            packet_id: string;
            sub_id: string;
          };
          const signedAt =
            getSignerDetails(event)?.[0]?.SignedOn ?? new Date().toISOString();

          // Download + store signed PDF in R2
          const signedPdfKey = `sub-agreements/${sigData.sub_id}/${sigData.packet_id}/${agreementDoc.id}-signed.pdf`;
          try {
            const agreementConfig = await getBoldSignConfig(env);
            if (agreementConfig) {
              const pdfBlob = await downloadSignedDocument(agreementConfig, boldSignDocumentId);
              await env.FILES.put(signedPdfKey, await pdfBlob.arrayBuffer(), {
                httpMetadata: { contentType: "application/pdf" },
              });
            }
          } catch (dlErr) {
            console.warn(`[boldsign_webhook] agreement PDF download failed: ${(dlErr as Error).message}`);
          }

          const { applyAgreementSigned } = await import("./sub-packets.js");
          await applyAgreementSigned(env, sigData.packet_id, agreementDoc.id, signedPdfKey, signedAt);
        } catch (applyErr) {
          console.error(`[boldsign_webhook] applyAgreementSigned failed: ${(applyErr as Error).message}`);
        }
      }
      return;
    }

    console.warn(`[boldsign_webhook] no document for documentId="${boldSignDocumentId}" — logging only`);
    return;
  }

  // Insert audit event.
  const eventId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO signature_events (id, job_document_id, boldsign_document_id, event_type, raw_payload, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(eventId, docRow.id, boldSignDocumentId, eventType, rawBody.slice(0, 10_000))
    .run();

  // Map event type to status.
  const newStatus = mapEventToStatus(eventType);
  if (!newStatus) {
    console.warn(
      `[BoldSign] Unrecognized eventType: ${eventType} — payload: ${rawBody.slice(0, 500)}`,
    );
    return;
  }

  // Handle Completed: download signed PDF, store in R2, create documents row.
  if (eventType === "Completed") {
    await handleCompleted(env, docRow, boldSignDocumentId, event);
    return;
  }

  // For all other status updates, just update the signature_status column.
  await env.DB.prepare(
    `UPDATE job_documents SET signature_status = ? WHERE id = ?`,
  )
    .bind(newStatus, docRow.id)
    .run();

  console.log(`[boldsign_webhook] updated job_document id="${docRow.id}" signature_status="${newStatus}"`);
}

async function handleTemplateSendFailed(
  env: Env,
  event: BoldSignEvent,
  rawBody: string,
): Promise<void> {
  const data = getEventData(event);
  const failedDocId = data?.documentId;
  const templateId = data?.templateId;
  const errorMsg = data?.errorMessage ?? "Unknown error";

  console.error(
    `[BoldSign] TemplateSendFailed — templateId: ${templateId ?? "none"}, ` +
      `documentId: ${failedDocId ?? "none"}, error: ${errorMsg}`,
  );

  if (!failedDocId) {
    return;
  }

  const docRow = await env.DB.prepare(
    `SELECT id FROM job_documents WHERE boldsign_document_id = ?`,
  )
    .bind(failedDocId)
    .first<{ id: string }>();

  if (!docRow) {
    console.warn(
      `[BoldSign] TemplateSendFailed — no job_documents row for documentId ${failedDocId}`,
    );
    return;
  }

  await env.DB.prepare(
    `UPDATE job_documents SET signature_status = 'failed' WHERE id = ?`,
  )
    .bind(docRow.id)
    .run();

  await env.DB.prepare(
    `INSERT INTO signature_events (id, job_document_id, boldsign_document_id, event_type, raw_payload, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      docRow.id,
      failedDocId,
      "TemplateSendFailed",
      rawBody.slice(0, 10_000),
    )
    .run();

  console.log(
    `[boldsign_webhook] TemplateSendFailed: job_document="${docRow.id}" signature_status="failed"`,
  );
}

async function handleCompleted(
  env: Env,
  docRow: { id: string; job_id: string; template_type: string; filename: string; signer_email: string | null; signer_name: string | null },
  boldSignDocumentId: string,
  event: BoldSignEvent,
): Promise<void> {
  const signerDetails = getSignerDetails(event)?.[0];
  const signedOn = signerDetails?.SignedOn ?? new Date().toISOString();

  // Download signed PDF from BoldSign.
  const config = await getBoldSignConfig(env);
  if (!config) {
    console.error("[boldsign_webhook] BOLDSIGN_API_KEY not configured — cannot download signed PDF");
    // Still update status so the UI reflects completion even without the file.
    await env.DB.prepare(
      `UPDATE job_documents
          SET signature_status = 'completed', signature_completed_at = datetime('now')
        WHERE id = ?`,
    ).bind(docRow.id).run();
    return;
  }

  let pdfBytes: ArrayBuffer;
  try {
    pdfBytes = await downloadSignedDocument(config, boldSignDocumentId);
  } catch (err) {
    console.error(`[boldsign_webhook] download_signed_pdf failed: ${(err as Error).message}`);
    // Mark completed even if download failed — operator can download from BoldSign manually.
    await env.DB.prepare(
      `UPDATE job_documents
          SET signature_status = 'completed', signature_completed_at = datetime('now')
        WHERE id = ?`,
    ).bind(docRow.id).run();
    return;
  }

  // Store signed PDF in R2.
  const today = new Date().toISOString().slice(0, 10);
  const baseName = docRow.filename.replace(/\.docx$/i, "");
  const pdfFilename = `${baseName}-signed-${today}.pdf`;
  const r2Key = `documents/signed/${docRow.job_id}/${pdfFilename}`;
  await env.FILES.put(r2Key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" },
  });
  console.log(`[boldsign_webhook] signed_pdf stored: r2_key="${r2Key}"`);

  // Determine document_category from template_type.
  const categoryMap: Record<string, string> = {
    service_agreement: "contract",
    cost_plus_agreement: "contract",
    change_order: "change_order",
    lien_waiver_conditional: "lien_waiver",
    lien_waiver_sub_unconditional: "lien_waiver",
    warranty_certificate: "contract",
  };
  const category = categoryMap[docRow.template_type] ?? "contract";

  const jobRow = await env.DB.prepare("SELECT client_id FROM jobs WHERE id = ?")
    .bind(docRow.job_id)
    .first<{ client_id: string | null }>();

  // Create a documents row so the signed PDF joins the portal/Drive pipeline.
  // Sub lien waivers (lien_waiver_sub_unconditional) get is_active=0 so they
  // don't appear in the client portal (portal query filters COALESCE(is_active,1)=1).
  const documentsId = crypto.randomUUID();
  const isClientFacing = docRow.template_type !== "lien_waiver_sub_unconditional" ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO documents
       (id, job_id, client_id, title, file_type, file_size, r2_key, context_type,
        document_category, mirror_status, is_signed, signed_date, created_at, is_active)
     VALUES (?, ?, ?, ?, 'pdf', ?, ?, 'job', ?, 'pending', 1, ?, datetime('now'), ?)`,
  )
    .bind(
      documentsId,
      docRow.job_id,
      jobRow?.client_id ?? null,
      pdfFilename,
      pdfBytes.byteLength,
      r2Key,
      category,
      signedOn,
      isClientFacing,
    )
    .run();

  // Update job_documents row.
  await env.DB.prepare(
    `UPDATE job_documents
        SET signature_status = 'completed',
            signature_completed_at = datetime('now'),
            signed_r2_key = ?
      WHERE id = ?`,
  )
    .bind(r2Key, docRow.id)
    .run();

  console.log(
    `[boldsign_webhook] completed: job_document="${docRow.id}" documents="${documentsId}" r2="${r2Key}" is_client_facing=${isClientFacing}`,
  );
}

interface EstimateDocRow {
  id: string;
  estimate_id: string | null;
  title: string;
  r2_key: string;
  signature_data: string | null;
  client_id: string | null;
}

async function handleEstimateDocumentEvent(
  env: Env,
  docRow: EstimateDocRow,
  boldSignDocumentId: string,
  eventType: string,
  event: BoldSignEvent,
  rawBody: string,
): Promise<void> {
  const newStatus = mapEventToStatus(eventType);
  const meta = parseSignatureMeta(docRow.signature_data);

  console.log(
    `[boldsign_webhook] estimate_doc event="${eventType}" doc="${docRow.id}" estimate="${docRow.estimate_id}"`,
  );

  if (eventType === "Completed") {
    await handleEstimateCompleted(env, docRow, boldSignDocumentId, event, meta);
    return;
  }

  if (!newStatus) return;

  meta.signature_status = newStatus;
  if (newStatus === "failed") {
    const errMsg = getEventData(event)?.errorMessage;
    if (errMsg) meta.signature_error = errMsg.slice(0, 500);
    console.error(
      `[boldsign_webhook] estimate_doc SendFailed doc="${docRow.id}" error="${errMsg ?? "unknown"}"`,
    );
  }
  await env.DB.prepare(
    `UPDATE documents SET signature_data = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(serializeSignatureMeta(meta), docRow.id)
    .run();

  // Audit log on estimate entity (signature_events FK requires job_document_id).
  if (docRow.estimate_id) {
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'estimate', ?, ?, datetime('now'))",
    )
      .bind(
        crypto.randomUUID(),
        "system@boldsign-webhook",
        "estimate_contract_signature_update",
        docRow.estimate_id,
        JSON.stringify({ event_type: eventType, status: newStatus, document_id: docRow.id }).slice(0, 4000),
      )
      .run();
  }

  void rawBody;
}

async function handleEstimateCompleted(
  env: Env,
  docRow: EstimateDocRow,
  boldSignDocumentId: string,
  event: BoldSignEvent,
  meta: EstimateSignatureMeta,
): Promise<void> {
  const signerDetails = getSignerDetails(event)?.[0];
  const signedOn = signerDetails?.SignedOn ?? new Date().toISOString().slice(0, 10);
  const signerName = signerDetails?.SignerName ?? meta.signer_name ?? "";

  const config = await getBoldSignConfig(env);
  let signedR2Key: string | null = null;

  if (config) {
    try {
      const pdfBytes = await downloadSignedDocument(config, boldSignDocumentId);
      const today = new Date().toISOString().slice(0, 10);
      const baseName = docRow.title.replace(/\.docx$/i, "");
      const pdfFilename = `${baseName}-signed-${today}.pdf`;
      signedR2Key = `documents/signed/estimate/${docRow.estimate_id}/${pdfFilename}`;
      await env.FILES.put(signedR2Key, pdfBytes, {
        httpMetadata: { contentType: "application/pdf" },
      });
    } catch (err) {
      console.error(`[boldsign_webhook] estimate signed PDF download failed: ${(err as Error).message}`);
    }
  }

  meta.signature_status = "completed";
  meta.signature_completed_at = new Date().toISOString();
  if (signedR2Key) meta.signed_r2_key = signedR2Key;

  if (signedR2Key) {
    await env.DB.prepare(
      `UPDATE documents
          SET signature_data = ?, is_signed = 1, signed_date = ?,
              r2_key = ?, file_type = 'application/pdf',
              mirror_status = 'pending', google_drive_id = NULL, google_drive_url = NULL,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(serializeSignatureMeta(meta), signedOn, signedR2Key, docRow.id)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE documents
          SET signature_data = ?, is_signed = 1, signed_date = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(serializeSignatureMeta(meta), signedOn, docRow.id)
      .run();
  }

  // Mark the estimate as signed. Advance status to 'signed' (not 'approved') —
  // 'approved' is reserved for actual deposit receipt, which is a separate event.
  if (docRow.estimate_id && signerName) {
    await env.DB.prepare(
      `UPDATE estimates
          SET client_signature = ?, signed_date = ?,
              status = CASE WHEN status IN ('sent','viewed') THEN 'signed' ELSE status END,
              updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(signerName, signedOn, docRow.estimate_id)
      .run();
  }

  if (docRow.estimate_id) {
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'estimate', ?, ?, datetime('now'))",
    )
      .bind(
        crypto.randomUUID(),
        "system@boldsign-webhook",
        "estimate_contract_signed",
        docRow.estimate_id,
        JSON.stringify({
          document_id: docRow.id,
          signer_name: signerName,
          signed_date: signedOn,
        }),
      )
      .run();
  }

  console.log(
    `[boldsign_webhook] estimate completed: doc="${docRow.id}" estimate="${docRow.estimate_id}"`,
  );
}

interface ClientLienWaiverRow {
  id: string;
  job_id: string;
  client_id: string;
  status: string;
}

async function handleClientLienWaiverEvent(
  env: Env,
  waiver: ClientLienWaiverRow,
  boldSignDocumentId: string,
  eventType: string,
  event: BoldSignEvent,
  rawBody: string,
): Promise<void> {
  console.log(
    `[boldsign_webhook] client_lien_waiver event="${eventType}" waiver="${waiver.id}" job="${waiver.job_id}"`,
  );

  if (eventType === "Completed") {
    await handleClientLienWaiverCompleted(env, waiver, boldSignDocumentId, event);
    return;
  }

  const newStatus = mapEventToStatus(eventType);
  if (!newStatus) return;

  const statusMap: Record<string, string> = {
    sent: "sent",
    viewed: "sent",
    signed: "sent",
    declined: "declined",
    revoked: "failed",
    expired: "failed",
    failed: "failed",
  };
  const mapped = statusMap[newStatus];
  if (mapped && mapped !== waiver.status) {
    await env.DB.prepare(
      `UPDATE client_lien_waivers SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(mapped, waiver.id)
      .run();
  }

  void rawBody;
}

async function handleClientLienWaiverCompleted(
  env: Env,
  waiver: ClientLienWaiverRow,
  boldSignDocumentId: string,
  event: BoldSignEvent,
): Promise<void> {
  const signerDetails = getSignerDetails(event)?.[0];
  const signedOn = signerDetails?.SignedOn ?? new Date().toISOString();

  const config = await getBoldSignConfig(env);
  if (!config) {
    console.error("[boldsign_webhook] BOLDSIGN_API_KEY not configured — cannot download client lien waiver PDF");
    await env.DB.prepare(
      `UPDATE client_lien_waivers SET status = 'signed', signed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(waiver.id)
      .run();
    return;
  }

  let pdfBytes: ArrayBuffer;
  try {
    pdfBytes = await downloadSignedDocument(config, boldSignDocumentId);
  } catch (err) {
    console.error(`[boldsign_webhook] client lien waiver download failed: ${(err as Error).message}`);
    await env.DB.prepare(
      `UPDATE client_lien_waivers SET status = 'signed', signed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(waiver.id)
      .run();
    return;
  }

  const r2Key = `documents/lien-waivers/client/${waiver.job_id}/${boldSignDocumentId}.pdf`;
  await env.FILES.put(r2Key, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" },
  });

  const documentsId = crypto.randomUUID();
  const pdfTitle = `Conditional Lien Waiver (Signed)`;
  await env.DB.prepare(
    `INSERT INTO documents
       (id, job_id, client_id, title, file_type, file_size, r2_key, context_type,
        document_category, mirror_status, is_signed, signed_date, created_at, is_active)
     VALUES (?, ?, ?, ?, 'pdf', ?, ?, 'job', 'lien_waiver', 'pending', 1, ?, datetime('now'), 1)`,
  )
    .bind(documentsId, waiver.job_id, waiver.client_id, pdfTitle, pdfBytes.byteLength, r2Key, signedOn)
    .run();

  await env.DB.prepare(
    `UPDATE client_lien_waivers
        SET status = 'signed', signed_at = datetime('now'), r2_key = ?, document_id = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(r2Key, documentsId, waiver.id)
    .run();

  await triggerNotification(env, "completion_package_ready", {
    jobId: waiver.job_id,
    clientId: waiver.client_id,
    linkPath: `/app/jobs/${waiver.job_id}/completion-package`,
    instanceKey: waiver.id,
  });

  console.log(`[BoldSign] Client lien waiver signed for job ${waiver.job_id}`);
}
