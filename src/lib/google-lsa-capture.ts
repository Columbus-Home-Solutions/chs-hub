/**
 * Auto-create an estimate_requests row for an inbound Google LSA call.
 *
 * Every call to the dedicated tracking number is a paid LSA lead — no whisper,
 * no unknown-caller prompt. Match an existing client by phone; if none, create
 * a phone-only clients row (blank name) so Lead Outreach can JOIN it. Do not
 * invent a first_name — merge-render falls back to "there".
 */

import type { Env } from "../env.js";
import { createPhoneOnlyClient, findClientByPhone, phoneLast10 } from "./client-dedup.js";
import { nextCentralSendInstant } from "./central-send-window.js";
import { createOwnerInApp, triggerNotification } from "./notification-engine.js";
import { triggerLeadCreated } from "./wc/triggers.js";

export const GOOGLE_LSA_TRACKING_SETTING = "google_lsa_tracking_number";
export const LSA_VOICE_WEBHOOK_PATH = "/api/webhooks/twilio/voice-lsa";
/** Kanban label on estimate_requests only — never written to clients.first_name. */
export const GOOGLE_LSA_UNMATCHED_CONTACT_NAME = "Google LSA Lead";

export interface LsaCaptureInput {
  from: string;
  to: string;
  callSid: string;
}

export type LsaCaptureResult =
  | { kind: "created"; requestId: string; clientId: string }
  | { kind: "deduped"; requestId: string; clientId: string | null }
  | { kind: "skipped"; reason: string };

function digitsLast10(phone: string): string {
  return phoneLast10(phone);
}

export function phonesMatchTracking(called: string, trackingNumber: string): boolean {
  const a = digitsLast10(called);
  const b = digitsLast10(trackingNumber);
  return a.length === 10 && a === b;
}

export async function loadLsaTrackingNumber(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = ?",
  )
    .bind(GOOGLE_LSA_TRACKING_SETTING)
    .first<{ value: string | null }>();
  const v = (row?.value ?? "").trim();
  return v || null;
}

async function findOpenLsaLeadByPhone(
  env: Env,
  phone10: string,
): Promise<{ id: string; client_id: string | null } | null> {
  return env.DB.prepare(
    `SELECT er.id, er.client_id
       FROM estimate_requests er
       LEFT JOIN clients c ON c.id = er.client_id
      WHERE er.source = 'google_lsa'
        AND er.status NOT IN ('won', 'lost')
        AND (
          substr(replace(replace(replace(replace(COALESCE(er.contact_phone,''),'(',''),')',''),'-',''),' ',''), -10) = ?
          OR substr(replace(replace(replace(replace(COALESCE(c.phone,''),'(',''),')',''),'-',''),' ',''), -10) = ?
        )
      ORDER BY er.created_at DESC
      LIMIT 1`,
  )
    .bind(phone10, phone10)
    .first();
}

export async function captureGoogleLsaLead(
  env: Env,
  input: LsaCaptureInput,
): Promise<LsaCaptureResult> {
  const phone10 = digitsLast10(input.from);
  if (!phone10) {
    return { kind: "skipped", reason: "no_caller_id" };
  }

  const existing = await findOpenLsaLeadByPhone(env, phone10);
  if (existing) {
    return { kind: "deduped", requestId: existing.id, clientId: existing.client_id };
  }

  const matched = await findClientByPhone(env, input.from);
  let clientId = matched?.id ?? null;
  if (!clientId) {
    clientId = await createPhoneOnlyClient(env, input.from, {
      leadSource: "google_lsa",
      createdBy: "twilio_lsa_webhook",
    });
  }
  const contactName = matched
    ? [matched.first_name, matched.last_name].filter(Boolean).join(" ").trim() || null
    : GOOGLE_LSA_UNMATCHED_CONTACT_NAME;

  const max = await env.DB.prepare(
    "SELECT COALESCE(MAX(request_number), 0) AS n FROM estimate_requests",
  ).first<{ n: number }>();
  const requestNumber = (max?.n ?? 0) + 1;
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();
  const notes = [
    "Google LSA inbound call (dedicated tracking number).",
    `CallSid: ${input.callSid || "(none)"}`,
    `From: ${input.from}`,
    `To: ${input.to}`,
  ].join("\n");

  await env.DB.prepare(
    `INSERT INTO estimate_requests (
       id, request_number, status, client_id,
       contact_name, contact_phone, contact_email,
       property_address, property_city, property_state, property_zip,
       job_type, lead_source, source, visit_notes,
       created_at, updated_at, created_by
     ) VALUES (?, ?, 'new_request', ?, ?, ?, NULL, 'Unknown', 'Unknown', 'Arkansas', '00000',
               'other', 'google_lsa', 'google_lsa', ?, ?, ?, 'twilio_lsa_webhook')`,
  )
    .bind(
      requestId,
      requestNumber,
      clientId,
      contactName,
      input.from,
      notes,
      now,
      now,
    )
    .run();

  await createOwnerInApp(env, {
    message: `New Google LSA lead: ${contactName || input.from}`,
    linkPath: `/app/estimating/${requestId}`,
    clientId,
    dedupe: `google_lsa:${requestId}`,
  });
  triggerLeadCreated(env, requestId);

  await triggerNotification(env, "lead_created", {
    clientId,
    estimateRequestId: requestId,
    instanceKey: "lead",
    scheduledFor: nextCentralSendInstant().toISOString(),
  });

  return { kind: "created", requestId, clientId };
}
