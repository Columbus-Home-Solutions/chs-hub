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
import { createOwnerInApp } from "./notification-engine.js";
import { triggerLeadCreated } from "./wc/triggers.js";

const HL_BASE = "https://services.leadconnectorhq.com";
const JOB_ERROR = "hl_lead_mirror_error";

export interface HlOpportunityLite {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  status: string | null;
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
  const rawName = str(raw.name) ?? contactName ?? "Unknown Lead";
  // Prefer a real contact name when the opportunity title is just a phone number.
  const name =
    looksLikePhoneName(rawName) && contactName && !looksLikePhoneName(contactName)
      ? contactName
      : rawName;
  const addr = pickAddress(raw);
  const notesBits = [str(raw.name), str(raw.source) ? `HL source: ${raw.source}` : null].filter(Boolean);
  return {
    id,
    name,
    phone: pickPhone(raw),
    email: pickEmail(raw),
    source: str(raw.source),
    status: str(raw.status),
    address: addr.address,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    notes: notesBits.join("\n\n") || null,
  };
}

/**
 * Fetch current open HL opportunities. Same endpoint the HL Kanban reads
 * through /api/hl/opportunities/search (Kanban uses limit=50).
 *
 * Single page only — this is a bridge for *current* leads, not a historical
 * HL backfill. Deep pagination previously re-fetched duplicates and flooded
 * the tick.
 */
export async function fetchOpenHlOpportunities(env: Env): Promise<HlOpportunityLite[]> {
  const locationId = (env.HL_LOCATION_ID ?? "").trim();
  if (!locationId) throw new Error("HL_LOCATION_ID not configured");

  const params = new URLSearchParams({
    location_id: locationId,
    status: "open",
    limit: "100",
  });

  const result = await hlGet(env, `/opportunities/search?${params.toString()}`);
  if (!result.ok) {
    throw new Error(
      `HL opportunities/search failed (${result.status}): ${JSON.stringify(result.json).slice(0, 300)}`,
    );
  }

  const data = result.json as { opportunities?: Record<string, unknown>[] };
  const seen = new Set<string>();
  const out: HlOpportunityLite[] = [];
  for (const raw of data.opportunities ?? []) {
    const opp = normalizeOpportunity(raw);
    if (!opp || seen.has(opp.id)) continue;
    seen.add(opp.id);
    out.push(opp);
  }
  return out;
}

function splitName(full: string, phone: string | null): { first: string; last: string } {
  if (looksLikePhoneName(full)) {
    return { first: "Google LSA", last: phone ?? "Lead" };
  }
  const cleaned = full.replace(/\s+[—\-–]\s+.*$/, "").trim(); // drop " - Category" tails
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "Unknown", last: "Lead" };
  if (parts.length === 1) return { first: parts[0], last: "Lead" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

async function mirrorOne(env: Env, opp: HlOpportunityLite): Promise<"created" | "skipped"> {
  const existing = await env.DB.prepare(
    "SELECT id FROM estimate_requests WHERE high_level_opportunity_id = ?",
  )
    .bind(opp.id)
    .first<{ id: string }>();
  if (existing) return "skipped";

  const { first, last } = splitName(opp.name, opp.phone);
  const contactName = `${first} ${last}`.trim();
  const now = new Date().toISOString();

  // Link only when phone matches a real existing client — never fabricate placeholders.
  const matched = opp.phone ? await findClientByPhone(env, opp.phone) : null;
  const clientId = matched?.id ?? null;
  const contactPhone = opp.phone && opp.phone !== "unknown" ? opp.phone : null;
  const contactEmail = opp.email?.trim() || null;

  const max = await env.DB.prepare(
    "SELECT COALESCE(MAX(request_number), 0) AS n FROM estimate_requests",
  ).first<{ n: number }>();
  const requestNumber = (max?.n ?? 0) + 1;
  const requestId = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO estimate_requests (
       id, request_number, status, client_id,
       contact_name, contact_phone, contact_email,
       property_address, property_city, property_state, property_zip,
       job_type, lead_source, source, visit_notes,
       high_level_opportunity_id,
       created_at, updated_at, created_by
     ) VALUES (?, ?, 'new_request', ?, ?, ?, ?, ?, ?, ?, ?, 'other', 'google_lsa', 'high_level', ?, ?, ?, ?, ?)`,
  )
    .bind(
      requestId,
      requestNumber,
      clientId,
      contactName || null,
      contactPhone,
      contactEmail,
      opp.address ?? "Unknown",
      opp.city ?? "Unknown",
      opp.state ?? "Arkansas",
      opp.zip ?? "00000",
      opp.notes,
      opp.id,
      now,
      now,
      "hl_lead_mirror",
    )
    .run();

  await createOwnerInApp(env, {
    message: `New lead from Google LSA (via HighLevel): ${contactName}`.trim(),
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
  const opps = await fetchOpenHlOpportunities(env);
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
