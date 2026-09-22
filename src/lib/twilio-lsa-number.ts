/**
 * Search + purchase a dedicated Google LSA tracking number via the Twilio REST API.
 * Target closeness: CHS main line 501-263-2050.
 */

import type { Env } from "../env.js";
import { getTwilioConfig } from "./twilio.js";
import { GOOGLE_LSA_TRACKING_SETTING, LSA_VOICE_WEBHOOK_PATH, loadLsaTrackingNumber } from "./google-lsa-capture.js";

export const LSA_TARGET_DIGITS = "5012632050";
export const LSA_VOICE_WEBHOOK_ORIGIN = "https://client.homesolutionsar.com";

export interface AvailableLsaNumber {
  phoneNumber: string;
  friendlyName: string | null;
  locality: string | null;
  region: string | null;
  score: number;
}

/** Higher is closer to 501-263-2050. */
export function scorePhoneCloseness(candidate: string, target = LSA_TARGET_DIGITS): number {
  const a = candidate.replace(/\D/g, "").slice(-10);
  const b = target.replace(/\D/g, "").slice(-10);
  if (a.length !== 10 || b.length !== 10) return -1_000_000;
  let prefix = 0;
  while (prefix < 10 && a[prefix] === b[prefix]) prefix += 1;
  let hamming = 0;
  for (let i = 0; i < 10; i++) if (a[i] !== b[i]) hamming += 1;
  const gap = Math.abs(Number(a.slice(6)) - Number(b.slice(6)));
  return prefix * 10_000 - hamming * 100 - Math.min(gap, 9_999);
}

function basicAuth(sid: string, token: string): string {
  return btoa(`${sid}:${token}`);
}

async function twilioGet(
  sid: string,
  token: string,
  pathAndQuery: string,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${pathAndQuery}`, {
    headers: { Authorization: `Basic ${basicAuth(sid, token)}` },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

async function twilioPost(
  sid: string,
  token: string,
  path: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const body = new URLSearchParams(fields);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(sid, token)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

function parseAvailable(json: Record<string, unknown>): AvailableLsaNumber[] {
  const list = (json.available_phone_numbers ?? json.availablePhoneNumbers ?? []) as Array<
    Record<string, unknown>
  >;
  const out: AvailableLsaNumber[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const phone = String(row.phone_number ?? row.phoneNumber ?? "").trim();
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    out.push({
      phoneNumber: phone,
      friendlyName: row.friendly_name ? String(row.friendly_name) : null,
      locality: row.locality ? String(row.locality) : null,
      region: row.region ? String(row.region) : null,
      score: scorePhoneCloseness(phone),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export async function searchLsaNumbers(env: Env): Promise<{
  ok: boolean;
  error?: string;
  candidates: AvailableLsaNumber[];
}> {
  const cfg = await getTwilioConfig(env);
  if (!cfg.accountSid || !cfg.authToken) {
    return { ok: false, error: "twilio_not_configured", candidates: [] };
  }
  const queries = [
    `/AvailablePhoneNumbers/US/Local.json?AreaCode=501&Contains=2632050&PageSize=20`,
    `/AvailablePhoneNumbers/US/Local.json?AreaCode=501&Contains=263205&PageSize=20`,
    `/AvailablePhoneNumbers/US/Local.json?AreaCode=501&Contains=26320&PageSize=20`,
    `/AvailablePhoneNumbers/US/Local.json?AreaCode=501&Contains=2632&PageSize=20`,
    `/AvailablePhoneNumbers/US/Local.json?AreaCode=501&Contains=263&PageSize=20`,
    `/AvailablePhoneNumbers/US/Local.json?AreaCode=501&NearNumber=%2B1${LSA_TARGET_DIGITS}&Distance=50&PageSize=20`,
  ];
  const merged: AvailableLsaNumber[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const r = await twilioGet(cfg.accountSid, cfg.authToken, q);
    if (!r.ok) continue;
    for (const c of parseAvailable(r.json)) {
      if (seen.has(c.phoneNumber)) continue;
      seen.add(c.phoneNumber);
      merged.push(c);
    }
    if (merged.some((c) => c.score >= 80_000)) break;
  }
  merged.sort((a, b) => b.score - a.score);
  return { ok: true, candidates: merged.slice(0, 15) };
}

export function lsaVoiceUrl(): string {
  return `${LSA_VOICE_WEBHOOK_ORIGIN}${LSA_VOICE_WEBHOOK_PATH}`;
}

export async function purchaseLsaNumber(
  env: Env,
  phoneNumber: string,
): Promise<{ ok: boolean; error?: string; sid?: string; phoneNumber?: string }> {
  const cfg = await getTwilioConfig(env);
  if (!cfg.accountSid || !cfg.authToken) {
    return { ok: false, error: "twilio_not_configured" };
  }
  const r = await twilioPost(cfg.accountSid, cfg.authToken, "/IncomingPhoneNumbers.json", {
    PhoneNumber: phoneNumber,
    FriendlyName: "CHS Google LSA tracking",
    VoiceUrl: lsaVoiceUrl(),
    VoiceMethod: "POST",
  });
  if (!r.ok) {
    return {
      ok: false,
      error: String(r.json.message ?? r.json.code ?? `twilio_${r.status}`).slice(0, 400),
    };
  }
  const bought = String(r.json.phone_number ?? r.json.phoneNumber ?? phoneNumber);
  const sid = r.json.sid ? String(r.json.sid) : undefined;
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'integrations', 'Google LSA tracking number',
             'Dedicated Twilio number Google LSA forwards into. Never use as outbound caller ID.',
             datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(GOOGLE_LSA_TRACKING_SETTING, bought)
    .run();
  return { ok: true, sid, phoneNumber: bought };
}

export async function configureExistingLsaNumber(
  env: Env,
  phoneNumber: string,
): Promise<{ ok: boolean; error?: string; sid?: string }> {
  const cfg = await getTwilioConfig(env);
  if (!cfg.accountSid || !cfg.authToken) {
    return { ok: false, error: "twilio_not_configured" };
  }
  const list = await twilioGet(
    cfg.accountSid,
    cfg.authToken,
    `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
  );
  const incoming = (list.json.incoming_phone_numbers ?? []) as Array<Record<string, unknown>>;
  const sid = incoming[0]?.sid ? String(incoming[0].sid) : "";
  if (!sid) return { ok: false, error: "number_not_in_account" };
  const upd = await twilioPost(cfg.accountSid, cfg.authToken, `/IncomingPhoneNumbers/${sid}.json`, {
    VoiceUrl: lsaVoiceUrl(),
    VoiceMethod: "POST",
    FriendlyName: "CHS Google LSA tracking",
  });
  if (!upd.ok) {
    return { ok: false, error: String(upd.json.message ?? `twilio_${upd.status}`).slice(0, 400) };
  }
  return { ok: true, sid };
}

function pickCallRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    sid: row.sid ?? null,
    parent_call_sid: row.parent_call_sid ?? row.parentCallSid ?? null,
    from: row.from ?? null,
    to: row.to ?? null,
    status: row.status ?? null,
    duration: row.duration ?? null,
    start_time: row.start_time ?? row.startTime ?? null,
    end_time: row.end_time ?? row.endTime ?? null,
    direction: row.direction ?? null,
    forwarded_from: row.forwarded_from ?? row.forwardedFrom ?? null,
    answered_by: row.answered_by ?? row.answeredBy ?? null,
  };
}

/** Read-only Twilio inspect for the dedicated LSA number (ops diagnose). */
export async function inspectLsaVoice(env: Env): Promise<{
  ok: boolean;
  error?: string;
  tracking: string | null;
  number: Record<string, unknown> | null;
  inbound_calls: Record<string, unknown>[];
  child_calls: Record<string, unknown>[];
}> {
  const tracking = await loadLsaTrackingNumber(env);
  const cfg = await getTwilioConfig(env);
  if (!cfg.accountSid || !cfg.authToken) {
    return { ok: false, error: "twilio_not_configured", tracking, number: null, inbound_calls: [], child_calls: [] };
  }
  if (!tracking) {
    return { ok: false, error: "no_tracking_number", tracking, number: null, inbound_calls: [], child_calls: [] };
  }

  const listed = await twilioGet(
    cfg.accountSid,
    cfg.authToken,
    `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(tracking)}`,
  );
  const incoming = (listed.json.incoming_phone_numbers ?? []) as Array<Record<string, unknown>>;
  const num = incoming[0] ?? null;
  const number = num
    ? {
        sid: num.sid ?? null,
        phone_number: num.phone_number ?? num.phoneNumber ?? null,
        voice_url: num.voice_url ?? num.voiceUrl ?? null,
        voice_method: num.voice_method ?? num.voiceMethod ?? null,
        voice_fallback_url: num.voice_fallback_url ?? num.voiceFallbackUrl ?? null,
        status_callback: num.status_callback ?? num.statusCallback ?? null,
        busy: num.busy ?? null,
      }
    : null;

  const inbound = await twilioGet(
    cfg.accountSid,
    cfg.authToken,
    `/Calls.json?To=${encodeURIComponent(tracking)}&PageSize=15`,
  );
  const inboundCalls = ((inbound.json.calls ?? []) as Array<Record<string, unknown>>).map(pickCallRow);

  const childCalls: Record<string, unknown>[] = [];
  for (const parent of inboundCalls.slice(0, 8)) {
    const sid = String(parent.sid ?? "");
    if (!sid) continue;
    const kids = await twilioGet(
      cfg.accountSid,
      cfg.authToken,
      `/Calls.json?ParentCallSid=${encodeURIComponent(sid)}&PageSize=10`,
    );
    for (const kid of (kids.json.calls ?? []) as Array<Record<string, unknown>>) {
      childCalls.push(pickCallRow(kid));
    }
  }

  return {
    ok: listed.ok && inbound.ok,
    error: listed.ok ? undefined : String(listed.json.message ?? `twilio_${listed.status}`).slice(0, 400),
    tracking,
    number,
    inbound_calls: inboundCalls,
    child_calls: childCalls,
  };
}
