/**
 * Bridge: HighLevel → CHS one-time lead mirror.
 *
 * Google LSA leads currently land in HighLevel via call tracking. This job
 * copies each open HL opportunity into native estimate_requests once (keyed by
 * high_level_opportunity_id) so they also appear on the CHS Leads Kanban.
 *
 * Tied to the open HighLevel wind-down decision — replace with a direct
 * Twilio-tracked Google LSA number once that resolves. Do NOT evolve this into
 * bidirectional stage sync; mirrored rows are never updated after creation.
 *
 * Reads the same HL opportunities/search endpoint the HL Kanban tab uses
 * (via /api/hl proxy) — same auth headers, no second API client design.
 */

import type { Env } from "../env.js";
import { findClientByPhone } from "./client-dedup.js";
import { HL_MIRROR_STAGE_IDS, HL_MIRROR_STAGE_TO_CHS, isFreshHlStageChange, type MirroredLeadStatus } from "./hl-stages.js";
import { applyLeadStageChange } from "./lead-stage.js";
import { allocateNextRequestNumber } from "./number-counters.js";
import { createOwnerInApp } from "./notification-engine.js";
import { triggerLeadCreated } from "./wc/triggers.js";

const HL_BASE = "https://services.leadconnectorhq.com";
const JOB_ERROR = "hl_lead_mirror_error";

export interface HlOpportunityLite {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  status: string | null;
  pipelineStageId: string | null;
  lastStageChangeAt: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function logDlq(env: Env, entityId: string | null, payload: unknown, message: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sync_dead_letters
       (job_name, entity_type, entity_id, payload, error_message,
        first_seen_at, last_seen_at, attempts, last_attempt_status, resolved_at)
     VALUES (?, 'webhook_capture', ?, ?, ?, ?, ?, 1, 'captured', ?)`,
  )
    .bind(JOB_ERROR, entityId ?? crypto.randomUUID(), JSON.stringify(payload), message.slice(0, 1000), now, now, now)
    .run();
}

/** Same auth shape as src/routes/hl.ts proxy — PIT never leaves the Worker. */
async function hlGet(env: Env, pathAndQuery: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  if (!env.HL_PRIVATE_TOKEN) {
    return { ok: false, status: 500, json: { error: "hl_not_configured" } };
  }
  const resp = await fetch(`${HL_BASE}${pathAndQuery}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.HL_PRIVATE_TOKEN}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });
  const text = await resp.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { ok: resp.ok, status: resp.status, json };
}

function pickPhone(opp: Record<string, unknown>): string | null {
  const contact = (opp.contact ?? {}) as Record<string, unknown>;
  return (
    str(opp.phone) ??
    str(contact.phone) ??
    str(contact.phoneNo) ??
    str(contact.phone_number) ??
    null
  );
}

function pickEmail(opp: Record<string, unknown>): string | null {
  const contact = (opp.contact ?? {}) as Record<string, unknown>;
  return (
    str(opp.email) ??
    str(contact.email) ??
    str(contact.emailAddress) ??
    str(contact.email_address) ??
    null
  );
}

/** Google LSA often puts the dialed number in the opportunity name. */
function isInventedLeadName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "unknown lead" || n === "google lsa" || n === "google lsa lead";
}

/** An email address, or a title that is only an email plus a label, is not a person's name. */
function looksLikeEmailName(name: string): boolean {
  return name.includes("@");
}

function looksLikePhoneName(name: string): boolean {
  const digits = name.replace(/\D/g, "");
  if (digits.length < 7) return false;
  const compact = name.replace(/[\s().+\-]/g, "");
  return digits.length / Math.max(compact.length, 1) >= 0.7;
}

function pickAddress(opp: Record<string, unknown>): {
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const contact = (opp.contact ?? {}) as Record<string, unknown>;
  const address =
    str(opp.address) ??
    str(contact.address1) ??
    str(contact.address) ??
    null;
  return {
    address,
    city: str(opp.city) ?? str(contact.city),
    state: str(opp.state) ?? str(contact.state),
    zip: str(opp.postalCode) ?? str(opp.zip) ?? str(contact.postalCode) ?? str(contact.postal),
  };
}

function normalizeOpportunity(raw: Record<string, unknown>): HlOpportunityLite | null {
  const id = str(raw.id);
  if (!id) return null;
  const contact = (raw.contact ?? {}) as Record<string, unknown>;
  const contactName =
    [str(contact.firstName) ?? str(contact.first_name), str(contact.lastName) ?? str(contact.last_name)]
      .filter(Boolean)
      .join(" ")
      .trim() || str(contact.name);
  const titled = str(raw.name) ?? contactName;
  // Prefer a real contact name when the opportunity title is just a phone number.
  // Blank stays blank — never invent "Unknown Lead" or "Google LSA".
  const name = titled
    ? looksLikePhoneName(titled) && contactName && !looksLikePhoneName(contactName)
      ? contactName
      : titled
    : null;
  const addr = pickAddress(raw);
  const notesBits = [str(raw.name), str(raw.source) ? `HL source: ${raw.source}` : null].filter(Boolean);
  return {
    id,
    name,
    phone: pickPhone(raw),
    email: pickEmail(raw),
    source: str(raw.source),
    status: str(raw.status),
    pipelineStageId: str(raw.pipelineStageId),
    lastStageChangeAt: str(raw.lastStageChangeAt),
    address: addr.address,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    notes: notesBits.join("\n\n") || null,
  };
}

/**
 * One page per mirrorable stage ID. Not the status=open firehose — New, Dead,
 * Job Completed, and the nurture pipeline never come back from these queries.
 * Still read-only. Still not a historical backfill (limit 100 per stage).
 */
export async function fetchMirrorableHlOpportunities(env: Env): Promise<HlOpportunityLite[]> {
  const locationId = (env.HL_LOCATION_ID ?? "").trim();
  if (!locationId) throw new Error("HL_LOCATION_ID not configured");

  const seen = new Set<string>();
  const out: HlOpportunityLite[] = [];
  for (const stageId of HL_MIRROR_STAGE_IDS) {
    const params = new URLSearchParams({
      location_id: locationId,
      pipeline_stage_id: stageId,
      limit: "100",
    });
    const result = await hlGet(env, `/opportunities/search?${params.toString()}`);
    if (!result.ok) {
      throw new Error(
        `HL opportunities/search stage=${stageId} failed (${result.status}): ${JSON.stringify(result.json).slice(0, 300)}`,
      );
    }
    const data = result.json as { opportunities?: Record<string, unknown>[] };
    for (const raw of data.opportunities ?? []) {
      const opp = normalizeOpportunity(raw);
      if (!opp || seen.has(opp.id)) continue;
      if (!opp.pipelineStageId || !HL_MIRROR_STAGE_TO_CHS[opp.pipelineStageId]) continue;
      seen.add(opp.id);
      out.push(opp);
    }
  }
  return out;
}

/** @deprecated Use fetchMirrorableHlOpportunities. Kept so older callers compile. */
export async function fetchOpenHlOpportunities(env: Env): Promise<HlOpportunityLite[]> {
  return fetchMirrorableHlOpportunities(env);
}

/** Real name only. A phone-number title or an empty name stays blank. */
export function splitRealName(full: string | null): { first: string | null; last: string | null } {
  if (!full || looksLikePhoneName(full) || looksLikeEmailName(full) || isInventedLeadName(full)) {
    return { first: null, last: null };
  }
  const withoutLsa = full.replace(/^google lsa\b/i, "").trim();
  if (!withoutLsa || looksLikePhoneName(withoutLsa) || looksLikeEmailName(withoutLsa)) {
    return { first: null, last: null };
  }
  const cleaned = withoutLsa.replace(/\s+[—\-–]\s+.*$/, "").trim();
  if (!cleaned || looksLikePhoneName(cleaned)) return { first: null, last: null };
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

async function createHlClient(
  env: Env,
  opp: HlOpportunityLite,
): Promise<string> {
  const { first, last } = splitRealName(opp.name);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO clients (
       id, first_name, last_name, email, phone, lead_source, synced_at, created_at, updated_at, created_by
     ) VALUES (?, ?, ?, ?, ?, 'google_lsa', datetime('now'), ?, ?, 'hl_lead_mirror')`,
  )
    .bind(id, first, last, opp.email, opp.phone, now, now)
    .run();
  return id;
}

function stageLabel(status: MirroredLeadStatus): string {
  if (status === "contacted") return "Contacted";
  if (status === "appointment_set") return "Appointment Set";
  if (status === "building") return "Create Estimate";
  return "Estimate Sent";
}

async function mirrorOne(env: Env, opp: HlOpportunityLite): Promise<"created" | "skipped"> {
  const chsStatus = opp.pipelineStageId ? HL_MIRROR_STAGE_TO_CHS[opp.pipelineStageId] : undefined;
  if (!chsStatus) return "skipped";

  const existing = await env.DB.prepare(
    "SELECT id FROM estimate_requests WHERE high_level_opportunity_id = ?",
  )
    .bind(opp.id)
    .first<{ id: string }>();
  if (existing) return "skipped";

  const { first, last } = splitRealName(opp.name);
  const contactName = [first, last].filter(Boolean).join(" ").trim() || null;
  const now = new Date().toISOString();

  const matched = opp.phone ? await findClientByPhone(env, opp.phone) : null;
  const clientId = matched?.id ?? (await createHlClient(env, opp));
  const contactPhone = opp.phone && opp.phone !== "unknown" ? opp.phone : null;
  const contactEmail = opp.email?.trim() || null;
  const isContacted = chsStatus === "contacted";
  const freshContacted = isContacted && isFreshHlStageChange(opp.lastStageChangeAt);
  // Stale Contacted leads are stored with the sequence already finished so Day 1 never sends.
  const completedAt = isContacted && !freshContacted ? now : null;

  const requestNumber = await allocateNextRequestNumber(env);
  const requestId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO estimate_requests (
       id, request_number, status, client_id,
       contact_name, contact_phone, contact_email,
       property_address, property_city, property_state, property_zip,
       job_type, lead_source, source, visit_notes,
       high_level_opportunity_id,
       contacted_at,
       lead_outreach_sequence_active, lead_outreach_count, lead_outreach_completed_at,
       created_at, updated_at, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'other', 'google_lsa', 'high_level', ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
  )
    .bind(
      requestId,
      requestNumber,
      chsStatus,
      clientId,
      contactName,
      contactPhone,
      contactEmail,
      opp.address ?? "Unknown",
      opp.city ?? "Unknown",
      opp.state ?? "Arkansas",
      opp.zip ?? "00000",
      opp.notes,
      opp.id,
      isContacted ? now : null,
      completedAt,
      now,
      now,
      "hl_lead_mirror",
    )
    .run();

  if (freshContacted) {
    await applyLeadStageChange(env, requestId, null, "contacted");
  }

  const displayName = contactName || contactPhone || "a lead";
  await createOwnerInApp(env, {
    message: `Lead moved to ${stageLabel(chsStatus)} in HighLevel: ${displayName}`,
    linkPath: `/app/estimating/${requestId}`,
    clientId,
    dedupe: `hl_mirror:${opp.id}`,
  });

  triggerLeadCreated(env, requestId);
  return "created";
}

export async function runHlLeadMirror(env: Env): Promise<{
  scanned: number;
  created: number;
  skipped: number;
  errors: number;
}> {
  const opps = await fetchMirrorableHlOpportunities(env);
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const opp of opps) {
    try {
      const result = await mirrorOne(env, opp);
      if (result === "created") created += 1;
      else skipped += 1;
    } catch (err) {
      errors += 1;
      console.error(`[hl_lead_mirror] opp=${opp.id} failed:`, (err as Error).message);
      try {
        await logDlq(env, opp.id, opp, (err as Error).message);
      } catch {
        /* never break the loop on DLQ failure */
      }
    }
  }

  return { scanned: opps.length, created, skipped, errors };
}

/** Cron entry — isolated; never throws out of the every-30-min tick. */
export async function runHlLeadMirrorTick(env: Env): Promise<void> {
  try {
    const result = await runHlLeadMirror(env);
    console.log(
      `[hl_lead_mirror] scanned=${result.scanned} created=${result.created} skipped=${result.skipped} errors=${result.errors}`,
    );
  } catch (err) {
    console.error(`[hl_lead_mirror] failed:`, (err as Error).message);
    try {
      await logDlq(env, null, {}, (err as Error).message);
    } catch {
      /* ignore */
    }
  }
}
