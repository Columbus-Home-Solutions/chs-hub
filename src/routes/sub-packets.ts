/**
 * Subcontractor Onboarding Packets API (Sprint 39 Runs 1–2).
 *
 * Owner-facing (authenticated):
 *   POST /api/subcontractors/:id/packets        create + send packet to sub
 *   GET  /api/subcontractors/:id/packets        list all packets for a sub (current + history)
 *   POST /api/packets/:id/approve              owner approves submitted packet → populates subcontractors row
 *   POST /api/packets/:id/send-agreement       owner sends BoldSign agreement for sub signature
 *
 * Sub-facing (no-login, token-gated):
 *   GET  /api/packet/:token                     sub views packet + already-uploaded docs
 *   POST /api/packet/:token/documents           sub uploads a document (multipart)
 *   POST /api/packet/:token/workers-comp-exempt  sub declares WC exemption (mutually exclusive with WC doc)
 *   POST /api/packet/:token/submit              sub marks packet complete (validation gate)
 *
 * Status lifecycle (Sprint 39 Run 2):
 *   sent → in_progress → submitted → approved → awaiting_signature → signed
 *   approved         = owner reviewed and approved all uploaded documents
 *   awaiting_signature = owner sent BoldSign agreement; sub has not yet signed
 *   signed           = sub completed the agreement signature (terminal state)
 *
 * Workers' Comp mutual exclusivity:
 *   Uploading a coi_workers_comp doc clears any existing exemption declaration.
 *   Declaring exemption removes any existing coi_workers_comp packet_document row.
 *   The second action wins — no ambiguous half-state.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { createOwnerInApp, sendSubEmail } from "../lib/notification-engine.js";
import { getTwilioConfig, isConfigured as twilioConfigured, sendSms } from "../lib/twilio.js";
import { getBoldSignConfig, sendDocumentForSignature } from "../lib/boldsign.js";
import { generateDocument, formatToday } from "../lib/document-generator.js";

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

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** 32-char unguessable hex token — same pattern as bid-requests.ts */
function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

// ── types ─────────────────────────────────────────────────────────────────────

interface PacketRow {
  id: string;
  sub_id: string;
  portal_token: string;
  status: string;
  workers_comp_exempt: number;
  workers_comp_exemption_reason: string | null;
  sent_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  signed_at: string | null;
  agreement_document_id: string | null;
  created_at: string;
}

interface PacketDocRow {
  id: string;
  packet_id: string;
  document_type: string;
  document_id: string | null;
  expiration_date: string | null;
  captured_tax_id: string | null;
  captured_license_number: string | null;
  uploaded_at: string;
}

interface SubRow {
  id: string;
  company_name: string | null;
  company: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  phone: string | null;
  email: string | null;
}

async function loadPacketDocs(env: Env, packetId: string): Promise<(PacketDocRow & { file_type: string | null })[]> {
  const res = await env.DB.prepare(
    `SELECT spd.*, d.file_type
       FROM subcontractor_packet_documents spd
       LEFT JOIN documents d ON d.id = spd.document_id
      WHERE spd.packet_id = ?
      ORDER BY spd.uploaded_at ASC`,
  )
    .bind(packetId)
    .all<PacketDocRow & { file_type: string | null }>();
  return res.results ?? [];
}

function subName(sub: SubRow): string {
  return (
    sub.contact_name ||
    sub.primary_contact ||
    sub.company_name ||
    sub.company ||
    "Subcontractor"
  ).trim();
}

function shapePacket(packet: PacketRow, docs: PacketDocRow[]) {
  return {
    id: packet.id,
    sub_id: packet.sub_id,
    status: packet.status,
    workers_comp_exempt: packet.workers_comp_exempt === 1,
    workers_comp_exemption_reason: packet.workers_comp_exemption_reason,
    sent_at: packet.sent_at,
    submitted_at: packet.submitted_at,
    approved_at: packet.approved_at,
    signed_at: packet.signed_at,
    agreement_document_id: packet.agreement_document_id,
    created_at: packet.created_at,
    documents: docs.map((d) => ({
      id: d.id,
      document_type: d.document_type,
      document_id: d.document_id,
      file_type: (d as PacketDocRow & { file_type?: string | null }).file_type ?? null,
      expiration_date: d.expiration_date,
      captured_tax_id: d.captured_tax_id,
      captured_license_number: d.captured_license_number,
      uploaded_at: d.uploaded_at,
    })),
  };
}

// ── POST /api/subcontractors/:id/packets ────────────────────────────────────

export async function handleSendPacket(
  request: Request,
  env: Env,
  subId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const sub = await env.DB.prepare(
    `SELECT id, company_name, company, contact_name, primary_contact, phone, email
       FROM subcontractors WHERE id = ?`,
  )
    .bind(subId)
    .first<SubRow>();
  if (!sub) return err(404, "sub_not_found");

  const packetId = crypto.randomUUID();
  const token = generateToken();
  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
  const packetLink = `${origin}/packet/${token}`;

  await env.DB.prepare(
    `INSERT INTO subcontractor_packets (id, sub_id, portal_token, status, created_at)
     VALUES (?, ?, ?, 'sent', datetime('now'))`,
  )
    .bind(packetId, subId, token)
    .run();

  const name = subName(sub);
  const smsBody = `CHS: Hi ${name}, please complete your onboarding packet here: ${packetLink}`;
  const emailBody =
    `Hi ${name},\n\nPlease complete your Columbus Home Solutions onboarding packet at the link below.\n\n` +
    `You'll need to upload:\n` +
    `• W-9 form\n` +
    `• Certificate of Insurance — General Liability\n` +
    `• Certificate of Insurance — Workers' Compensation (or declare exemption if you're a sole proprietor with no employees)\n` +
    `• Contractor/Business License\n\n` +
    `Complete your packet here: ${packetLink}\n\n` +
    `Thank you,\nColumbus Home Solutions`;

  // SMS (primary)
  if (sub.phone) {
    const cfg = await getTwilioConfig(env);
    if (twilioConfigured(cfg)) {
      const r = await sendSms(cfg, sub.phone, smsBody);
      if (!r.ok) console.warn(`[sub-packet] SMS to ${sub.phone} failed: ${r.error}`);
    }
  }

  // Email (additive)
  if (sub.email) {
    await sendSubEmail(env, sub.email, "Complete Your CHS Onboarding Packet", emailBody);
  }

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'packet_sent', 'subcontractor_packet', ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), authed.user.email, packetId, JSON.stringify({ sub_id: subId }))
    .run();

  return json({ ok: true, packet_id: packetId, packet_link: packetLink }, 201);
}

// ── GET /api/subcontractors/:id/packets ──────────────────────────────────────

export async function handleListPackets(
  request: Request,
  env: Env,
  subId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager", "office_admin"]);
  if (authed instanceof Response) return authed;

  const packets = await env.DB.prepare(
    `SELECT * FROM subcontractor_packets WHERE sub_id = ? ORDER BY created_at DESC`,
  )
    .bind(subId)
    .all<PacketRow>();

  const result = await Promise.all(
    (packets.results ?? []).map(async (p) => shapePacket(p, await loadPacketDocs(env, p.id))),
  );
  return json({ packets: result });
}

// ── POST /api/packets/:id/approve ────────────────────────────────────────────

export async function handleApprovePacket(
  request: Request,
  env: Env,
  packetId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager"]);
  if (authed instanceof Response) return authed;

  const packet = await env.DB.prepare(`SELECT * FROM subcontractor_packets WHERE id = ?`)
    .bind(packetId)
    .first<PacketRow>();
  if (!packet) return err(404, "packet_not_found");
  if (packet.status !== "submitted") {
    return err(409, "not_submitted", `Packet status is '${packet.status}'; only 'submitted' packets can be approved.`);
  }

  const docs = await loadPacketDocs(env, packetId);

  // Build update map from packet documents
  const docMap: Record<string, PacketDocRow> = {};
  for (const d of docs) docMap[d.document_type] = d;

  const now = new Date().toISOString();

  // Approve the packet
  await env.DB.prepare(
    `UPDATE subcontractor_packets SET status = 'approved', approved_at = ? WHERE id = ?`,
  )
    .bind(now, packetId)
    .run();

  // Copy submitted values into the real subcontractors row.
  // Each column now holds exactly one kind of value (fixed in 0082 migration):
  //   captured_tax_id          — W-9 EIN/SSN
  //   captured_license_number  — contractor license number
  //   expiration_date          — real YYYY-MM-DD date (or null for w9)

  const updates: string[] = [];
  const binds: (string | number | null)[] = [];

  // W-9 → w9_on_file = 1; captured_tax_id carries the EIN/SSN
  if (docMap["w9"]) {
    updates.push("w9_on_file = 1");
    if (docMap["w9"].captured_tax_id) {
      updates.push("tax_id = ?");
      binds.push(docMap["w9"].captured_tax_id);
    }
  }

  // GL COI → insurance_on_file = 1; expiration_date = real date
  if (docMap["coi_general_liability"]) {
    updates.push("insurance_on_file = 1");
    if (docMap["coi_general_liability"].expiration_date) {
      updates.push("coi_expiration_date = ?");
      binds.push(docMap["coi_general_liability"].expiration_date);
    }
  }

  // License → captured_license_number + expiration_date (both now separate columns)
  if (docMap["license"]) {
    if (docMap["license"].captured_license_number) {
      updates.push("license_number = ?");
      binds.push(docMap["license"].captured_license_number);
    }
    if (docMap["license"].expiration_date) {
      updates.push("license_expiration_date = ?");
      binds.push(docMap["license"].expiration_date);
    }
  }

  updates.push("updated_at = datetime('now')");

  if (updates.length > 1) {
    await env.DB.prepare(
      `UPDATE subcontractors SET ${updates.join(", ")} WHERE id = ?`,
    )
      .bind(...binds, packet.sub_id)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'packet_approved', 'subcontractor_packet', ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      authed.user.email,
      packetId,
      JSON.stringify({ sub_id: packet.sub_id }),
    )
    .run();

  return json({ ok: true });
}

// ── GET /api/packet/:token (sub-facing) ──────────────────────────────────────

export async function handlePacketLanding(
  env: Env,
  token: string,
): Promise<Response> {
  const packet = await env.DB.prepare(
    `SELECT sp.*, s.company_name, s.company, s.contact_name, s.primary_contact
       FROM subcontractor_packets sp
       JOIN subcontractors s ON s.id = sp.sub_id
      WHERE sp.portal_token = ?`,
  )
    .bind(token)
    .first<
      PacketRow & {
        company_name: string | null;
        company: string | null;
        contact_name: string | null;
        primary_contact: string | null;
      }
    >();
  if (!packet) return err(404, "invalid_token");

  const docs = await loadPacketDocs(env, packet.id);
  const name = (
    packet.contact_name ||
    packet.primary_contact ||
    packet.company_name ||
    packet.company ||
    "Subcontractor"
  ).trim();

  return json({
    ok: true,
    packet_id: packet.id,
    sub_name: name,
    status: packet.status,
    workers_comp_exempt: packet.workers_comp_exempt === 1,
    workers_comp_exemption_reason: packet.workers_comp_exemption_reason,
    submitted_at: packet.submitted_at,
    approved_at: packet.approved_at,
    documents: docs.map((d) => ({
      id: d.id,
      document_type: d.document_type,
      expiration_date: d.expiration_date,
      captured_tax_id: d.captured_tax_id,
      captured_license_number: d.captured_license_number,
      uploaded_at: d.uploaded_at,
    })),
  });
}

// ── POST /api/packet/:token/documents (sub-facing) ───────────────────────────

export async function handleUploadDocument(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const packet = await env.DB.prepare(
    `SELECT * FROM subcontractor_packets WHERE portal_token = ?`,
  )
    .bind(token)
    .first<PacketRow>();
  if (!packet) return err(404, "invalid_token");
  if (packet.status === "approved") return err(409, "packet_approved", "This packet has already been approved.");
  if (packet.status === "submitted") return err(409, "packet_submitted", "This packet has been submitted. Contact CHS to make changes.");

  // Parse multipart form data
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return err(400, "multipart_required", "This endpoint requires multipart/form-data.");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return err(400, "invalid_form_data");
  }

  const docType = str(formData.get("document_type"));
  const validDocTypes = ["w9", "coi_general_liability", "coi_workers_comp", "license"] as const;
  if (!docType || !validDocTypes.includes(docType as (typeof validDocTypes)[number])) {
    return err(400, "invalid_document_type", `document_type must be one of: ${validDocTypes.join(", ")}`);
  }

  // Each column now holds exactly one kind of value (0082 migration):
  //   expiration_date         — real YYYY-MM-DD date, or null (never stores EIN or license numbers)
  //   captured_tax_id         — W-9 EIN/SSN only
  //   captured_license_number — license doc license number only
  const expirationDate = str(formData.get("expiration_date"));
  const capturedTaxId = docType === "w9" ? str(formData.get("captured_tax_id")) : null;
  const capturedLicenseNumber = docType === "license" ? str(formData.get("captured_license_number")) : null;

  const file = formData.get("file") as File | null;

  if (!file || file.size === 0) return err(400, "file_required");
  if (file.size > 25 * 1024 * 1024) return err(413, "file_too_large", "Maximum file size is 25 MB.");

  const fileBytes = await file.arrayBuffer();
  const fileMime = file.type || "application/octet-stream";
  const fileExt = file.name?.split(".").pop()?.toLowerCase() || "pdf";

  // If uploading WC COI — clear any existing exemption declaration
  if (docType === "coi_workers_comp" && packet.workers_comp_exempt === 1) {
    await env.DB.prepare(
      `UPDATE subcontractor_packets SET workers_comp_exempt = 0, workers_comp_exemption_reason = NULL WHERE id = ?`,
    )
      .bind(packet.id)
      .run();
  }

  // Remove any existing packet document of the same type (idempotent re-upload)
  await env.DB.prepare(
    `DELETE FROM subcontractor_packet_documents WHERE packet_id = ? AND document_type = ?`,
  )
    .bind(packet.id, docType)
    .run();

  // Store file in R2
  const docId = crypto.randomUUID();
  const r2Key = `sub-packets/${packet.sub_id}/${packet.id}/${docType}-${docId}.${fileExt}`;
  await env.FILES.put(r2Key, fileBytes, { httpMetadata: { contentType: fileMime } });

  // Create documents row for file tracking
  const documentsId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO documents (id, title, file_type, file_size, r2_key, r2_url, context_type, document_category, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'subcontractor_packet', ?, 1, datetime('now'), datetime('now'))`,
  )
    .bind(
      documentsId,
      `${docType} — ${packet.id}`,
      fileMime,
      file.size,
      r2Key,
      r2Key,
      docType,
    )
    .run();

  // Create packet_document row — expiration_date holds a real date or null, always
  const packetDocId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO subcontractor_packet_documents
       (id, packet_id, document_type, document_id, expiration_date, captured_tax_id, captured_license_number, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(packetDocId, packet.id, docType, documentsId, expirationDate, capturedTaxId, capturedLicenseNumber)
    .run();

  // Advance status to in_progress on first upload
  if (packet.status === "sent") {
    await env.DB.prepare(
      `UPDATE subcontractor_packets SET status = 'in_progress' WHERE id = ?`,
    )
      .bind(packet.id)
      .run();
  }

  return json({ ok: true, document_id: packetDocId, document_type: docType }, 201);
}

// ── POST /api/packet/:token/workers-comp-exempt (sub-facing) ─────────────────

export async function handleWorkersCompExempt(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const packet = await env.DB.prepare(
    `SELECT * FROM subcontractor_packets WHERE portal_token = ?`,
  )
    .bind(token)
    .first<PacketRow>();
  if (!packet) return err(404, "invalid_token");
  if (packet.status === "approved") return err(409, "packet_approved");
  if (packet.status === "submitted") return err(409, "packet_submitted");

  let reason: string | null = null;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    reason = str(body.reason);
  } catch {
    // body optional
  }

  // Remove any existing WC COI document (exemption overwrites it — second action wins)
  const wcDoc = await env.DB.prepare(
    `SELECT document_id FROM subcontractor_packet_documents WHERE packet_id = ? AND document_type = 'coi_workers_comp'`,
  )
    .bind(packet.id)
    .first<{ document_id: string | null }>();

  if (wcDoc) {
    await env.DB.prepare(
      `DELETE FROM subcontractor_packet_documents WHERE packet_id = ? AND document_type = 'coi_workers_comp'`,
    )
      .bind(packet.id)
      .run();
    // Soft-deactivate the documents row if it exists
    if (wcDoc.document_id) {
      await env.DB.prepare(`UPDATE documents SET is_active = 0 WHERE id = ?`)
        .bind(wcDoc.document_id)
        .run();
    }
  }

  await env.DB.prepare(
    `UPDATE subcontractor_packets
        SET workers_comp_exempt = 1, workers_comp_exemption_reason = ?
      WHERE id = ?`,
  )
    .bind(reason, packet.id)
    .run();

  // Advance status to in_progress if still sent
  if (packet.status === "sent") {
    await env.DB.prepare(
      `UPDATE subcontractor_packets SET status = 'in_progress' WHERE id = ?`,
    )
      .bind(packet.id)
      .run();
  }

  return json({ ok: true, workers_comp_exempt: true });
}

// ── POST /api/packet/:token/submit (sub-facing) ───────────────────────────────

export async function handleSubmitPacket(
  env: Env,
  token: string,
): Promise<Response> {
  const packet = await env.DB.prepare(
    `SELECT sp.*, s.company_name, s.company, s.contact_name, s.primary_contact
       FROM subcontractor_packets sp
       JOIN subcontractors s ON s.id = sp.sub_id
      WHERE sp.portal_token = ?`,
  )
    .bind(token)
    .first<
      PacketRow & {
        company_name: string | null;
        company: string | null;
        contact_name: string | null;
        primary_contact: string | null;
      }
    >();
  if (!packet) return err(404, "invalid_token");
  if (packet.status === "submitted") return err(409, "already_submitted");
  if (packet.status === "approved") return err(409, "already_approved");

  const docs = await loadPacketDocs(env, packet.id);
  const uploadedTypes = new Set(docs.map((d) => d.document_type));

  // Validation: surface exactly what's missing
  const missing: string[] = [];
  if (!uploadedTypes.has("w9")) missing.push("W-9");
  if (!uploadedTypes.has("coi_general_liability")) missing.push("Certificate of Insurance — General Liability");
  if (!uploadedTypes.has("coi_workers_comp") && packet.workers_comp_exempt !== 1) {
    missing.push("Certificate of Insurance — Workers' Compensation (or declare exemption)");
  }
  if (!uploadedTypes.has("license")) missing.push("Contractor/Business License");

  if (missing.length > 0) {
    return json({ error: "incomplete_packet", missing }, 422);
  }

  await env.DB.prepare(
    `UPDATE subcontractor_packets SET status = 'submitted', submitted_at = datetime('now') WHERE id = ?`,
  )
    .bind(packet.id)
    .run();

  // Owner in-app notification
  const name = (
    packet.contact_name ||
    packet.primary_contact ||
    packet.company_name ||
    packet.company ||
    "Subcontractor"
  ).trim();

  await createOwnerInApp(env, {
    message: `${name} submitted their onboarding packet. Review and approve in the Subcontractors section.`,
    linkPath: `/subcontractors/${packet.sub_id}`,
    dedupe: `packet-submitted:${packet.id}`,
  });

  return json({ ok: true, status: "submitted" });
}

// ── POST /api/packets/:id/send-agreement (owner-facing) ─────────────────────
//
// Sends the BoldSign Subcontractor Agreement template to the sub for signature.
// Owner-triggered, deliberate action — NOT auto-fired on document approval.
// Loads the subcontractor agreement DOCX template from R2, merges real sub
// data into {{field_name}} placeholders, and sends the filled document to
// BoldSign for the sub's e-signature. No BoldSign template ID is required.

const SUB_AGREEMENT_TEMPLATE_R2 = "documents/templates/subcontractor-agreement.docx";

export async function handleSendAgreement(
  request: Request,
  env: Env,
  packetId: string,
): Promise<Response> {
  const authed = await guard(request, env, ["owner", "project_manager"]);
  if (authed instanceof Response) return authed;

  const packet = await env.DB.prepare(
    `SELECT sp.*,
            s.email, s.company_name, s.company, s.contact_name, s.primary_contact,
            s.trade, s.license_number, s.tax_id
       FROM subcontractor_packets sp
       JOIN subcontractors s ON s.id = sp.sub_id
      WHERE sp.id = ?`,
  )
    .bind(packetId)
    .first<
      PacketRow & {
        email: string | null;
        company_name: string | null;
        company: string | null;
        contact_name: string | null;
        primary_contact: string | null;
        trade: string | null;
        license_number: string | null;
        tax_id: string | null;
      }
    >();
  if (!packet) return err(404, "packet_not_found");

  if (packet.status !== "approved") {
    return err(409, "invalid_status", `Packet status is '${packet.status}'. Only 'approved' packets can have an agreement sent.`);
  }

  const subEmail = packet.email;
  if (!subEmail) {
    return err(422, "sub_email_missing", "This subcontractor does not have an email address on file. Add an email before sending the agreement.");
  }

  const config = await getBoldSignConfig(env);
  if (!config) {
    return err(503, "boldsign_not_configured", "BOLDSIGN_API_KEY is not set. Cannot send e-signature request.");
  }

  const name = (
    packet.contact_name ||
    packet.primary_contact ||
    packet.company_name ||
    packet.company ||
    "Subcontractor"
  ).trim();

  const companyName = (packet.company_name || packet.company || name).trim();

  // Load and merge the agreement DOCX template
  const templateObj = await env.FILES.get(SUB_AGREEMENT_TEMPLATE_R2);
  if (!templateObj) {
    console.error(`[sub-packets] Subcontractor agreement template missing from R2: ${SUB_AGREEMENT_TEMPLATE_R2}`);
    return err(503, "agreement_template_missing", "The Subcontractor Agreement template is not configured. Please upload it to R2 and try again.");
  }

  const mergeFields: Record<string, string> = {
    sub_company_name: companyName,
    sub_contact_name: name,
    sub_trade: packet.trade ?? "",
    sub_license_number: packet.license_number ?? "",
    sub_tax_id: packet.tax_id ?? "",
    today_date: formatToday(),
  };

  const docBytes = await generateDocument(await templateObj.arrayBuffer(), mergeFields);

  const docBlob = new Blob([docBytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const docFilename = `Subcontractor-Agreement-${companyName.replace(/[^a-zA-Z0-9]+/g, "-")}.docx`;

  // Signature and date fields are anchored by BoldSign text tags embedded directly
  // in the DOCX template ({{sign|1|*| |sub_sig}} and {{date|1|*| |sub_date}} in
  // white text at the signature line). UseTextTags=true tells BoldSign to convert
  // those tags to form fields automatically — no coordinate guessing needed.
  let boldSignDocumentId: string;
  try {
    const sendResult = await sendDocumentForSignature(config, {
      fileBlob: docBlob,
      filename: docFilename,
      title: `CHS Subcontractor Agreement — ${name}`,
      message: "Please review and sign the Columbus Home Solutions Subcontractor Agreement to complete your onboarding.",
      signerEmail: subEmail,
      signerName: name,
      useTextTags: true,
    });
    boldSignDocumentId = sendResult.documentId;
  } catch (e) {
    console.error(`[sub-packets] BoldSign send failed for packet ${packetId}:`, (e as Error).message);
    return err(502, "signature_send_failed", (e as Error).message.slice(0, 200));
  }

  // Create documents row to track this agreement
  const docId = crypto.randomUUID();
  const r2Key = `sub-agreements/${packet.sub_id}/${packetId}/${docId}.pdf`;
  const sigData = JSON.stringify({
    boldsign_document_id: boldSignDocumentId,
    packet_id: packetId,
    sub_id: packet.sub_id,
  });

  await env.DB.prepare(
    `INSERT INTO documents
       (id, title, file_type, file_size, r2_key, r2_url, context_type, document_category, signature_data, is_active, created_at, updated_at)
     VALUES (?, ?, 'application/pdf', NULL, ?, ?, 'subcontractor_agreement', 'subcontractor_agreement', ?, 1, datetime('now'), datetime('now'))`,
  )
    .bind(
      docId,
      `Subcontractor Agreement — ${name}`,
      r2Key,
      r2Key,
      sigData,
    )
    .run();

  // Advance packet status to awaiting_signature; record agreement document
  await env.DB.prepare(
    `UPDATE subcontractor_packets
        SET status = 'awaiting_signature', agreement_document_id = ?
      WHERE id = ?`,
  )
    .bind(docId, packetId)
    .run();

  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, 'agreement_sent', 'subcontractor_packet', ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      authed.user.email,
      packetId,
      JSON.stringify({ sub_id: packet.sub_id, boldsign_document_id: boldSignDocumentId }),
    )
    .run();

  return json({ ok: true, status: "awaiting_signature", boldsign_document_id: boldSignDocumentId });
}

// ── applyAgreementSigned — called by BoldSign webhook on completion ───────────

export async function applyAgreementSigned(
  env: Env,
  packetId: string,
  docId: string,
  signedPdfKey: string,
  signedAt: string,
): Promise<void> {
  // Idempotency: only update if still awaiting
  const packet = await env.DB.prepare(
    `SELECT id, status FROM subcontractor_packets WHERE id = ?`,
  )
    .bind(packetId)
    .first<{ id: string; status: string }>();

  if (!packet || packet.status === "signed") return;

  await env.DB.prepare(
    `UPDATE subcontractor_packets SET status = 'signed', signed_at = ? WHERE id = ?`,
  )
    .bind(signedAt, packetId)
    .run();

  // Update the documents row with the real signed PDF r2_key
  await env.DB.prepare(`UPDATE documents SET r2_key = ?, r2_url = ?, is_signed = 1, signed_date = ? WHERE id = ?`)
    .bind(signedPdfKey, signedPdfKey, signedAt, docId)
    .run();

  // Owner in-app notification
  const subRow = await env.DB.prepare(
    `SELECT COALESCE(s.contact_name, s.primary_contact, s.company_name, s.company, 'Subcontractor') AS name
       FROM subcontractor_packets sp
       JOIN subcontractors s ON s.id = sp.sub_id
      WHERE sp.id = ?`,
  )
    .bind(packetId)
    .first<{ name: string }>();

  const subName = subRow?.name ?? "Subcontractor";

  await createOwnerInApp(env, {
    message: `${subName} signed the Subcontractor Agreement. Onboarding is complete.`,
    linkPath: `/subcontractors`,
    dedupe: `agreement-signed:${packetId}`,
  });
}
