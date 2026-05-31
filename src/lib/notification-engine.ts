/**
 * Notification engine (Sprint 7) — the SINGLE path every notification flows
 * through. Lives in src/lib/ to match the built reality (quote-to-job.ts,
 * wc/*) rather than the cursorrules `src/services/` ideal — there is no
 * src/services layer in this codebase.
 *
 * Pipeline:
 *   trigger → active-template lookup → merge-field render → enqueue
 *           → (every-15-min cron) due-check + stop/preference/rate re-check → send
 *           → log → auto-log to communications
 *
 * Mirrors the WC "log intent at the event site, recompute/process on cron"
 * split: trigger sites call triggerNotification() which only WRITES a queued
 * notification_logs row. Nothing is sent inline in a request handler — the
 * Notification Processor cron (processNotifications) does all dispatching.
 *
 * Idempotency / no-double-send: every enqueue carries a deterministic
 * dedupe_key (trigger_event + entity id + channel + instance key). A UNIQUE
 * partial index on notification_logs(dedupe_key) backstops a check-before-insert
 * so webhook redelivery or a re-running status save can never produce a second
 * message to a client.
 *
 * Dev / no-credentials mode (mirrors Stripe test-mode discipline): unless
 * NOTIFICATIONS_DISPATCH_MODE='live' AND the channel's credentials are present,
 * a send is SIMULATED — the row is marked status='sent' with
 * external_id='simulated:<uuid>' and no external API is touched. Default local
 * behavior never sends a real SMS/email to a client.
 */

import type { Env } from "../env.js";
import { getTwilioConfig, isConfigured as twilioConfigured, sendSms } from "./twilio.js";

// ─── events ─────────────────────────────────────────────────────────────────

/** Triggers WIRED this sprint (their source events exist). */
export const WIRED_EVENTS = [
  "lead_created",
  "appointment_confirmed",
  "appointment_reminder",
  "estimate_sent",
  "quote_follow_up_1",
  "quote_follow_up_2",
  "quote_expiring",
  "deposit_received",
  "welcome_portal",
  "work_starting",
] as const;

/**
 * Transactional events that CANNOT be opted out of (§6.2). Everything else that
 * is opt-out-eligible (marketing/informational) consults
 * clients.notification_preferences (§6.3). Quote follow-ups + expiring are
 * sales nudges → opt-out-eligible.
 */
const TRANSACTIONAL_EVENTS = new Set([
  "lead_created",
  "appointment_confirmed",
  "appointment_reminder",
  "estimate_sent",
  "deposit_received",
  "welcome_portal",
  "work_starting",
  "payment_received",
  "invoice_due_reminder",
  "invoice_past_due",
  "cost_plus_cycle_report",
  "job_completion_package",
  "sub_scheduled",
  "sub_schedule_change",
  "sub_schedule_cancelled",
]);

/** Quote-follow-up family — re-checked against stop conditions at send time. */
const FOLLOW_UP_EVENTS = new Set(["quote_follow_up_1", "quote_follow_up_2", "quote_expiring"]);

const SMS_DAILY_LIMIT = 5;
const MAX_RETRIES = 3;
// Exponential backoff per the spec (§6.5): 1 min / 5 min / 30 min.
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];

// ─── context passed by trigger sites ──────────────────────────────────────────

export interface TriggerContext {
  clientId?: string | null;
  jobId?: string | null;
  estimateRequestId?: string | null;
  estimateId?: string | null;
  /** Logical instance key for dedupe (e.g. "follow_up_1", an appointment ISO date). */
  instanceKey?: string | null;
  /** Explicit ISO time the row becomes due. Defaults to delay math, then now. */
  scheduledFor?: string | null;
  /** Reference time for negative-delay (before-event) templates, e.g. appointment_date. */
  referenceTime?: string | null;
  /** Merge-field overrides layered on top of the record-derived context. */
  merge?: Record<string, string | number | null | undefined>;
  /** Deep-link target for in_app rows (app path, e.g. /app/jobs/<id>). */
  linkPath?: string | null;
}

interface TemplateRow {
  id: string;
  trigger_event: string;
  name: string;
  recipient_type: string;
  channel: string;
  subject: string | null;
  body_template: string;
  merge_fields: string;
  is_active: number;
  delay_minutes: number | null;
  send_time: string | null;
  phase: string | null;
}

// ─── public: enqueue ──────────────────────────────────────────────────────────

export interface TriggerResult {
  enqueued: number;
  skipped: number;
  reasons: string[];
}

/**
 * Look up every ACTIVE template for `event`, render it against the assembled
 * context, and enqueue one queued notification_logs row per template (idempotent
 * on dedupe_key). Does NOT send — the cron does.
 */
export async function triggerNotification(
  env: Env,
  event: string,
  ctx: TriggerContext,
): Promise<TriggerResult> {
  const result: TriggerResult = { enqueued: 0, skipped: 0, reasons: [] };
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM notification_templates WHERE trigger_event = ? AND is_active = 1",
    )
      .bind(event)
      .all<TemplateRow>();
    const templates = results ?? [];
    if (templates.length === 0) {
      result.reasons.push(`no_active_template:${event}`);
      return result;
    }

    const merge = await buildMergeContext(env, ctx);

    for (const tpl of templates) {
      const recipient = await resolveRecipient(env, tpl, ctx, merge);
      if (!recipient) {
        result.skipped++;
        result.reasons.push(`no_recipient:${tpl.channel}`);
        continue;
      }

      const subject = tpl.subject ? renderTemplate(tpl.subject, merge).text : null;
      const rendered = renderTemplate(tpl.body_template, merge);
      if (rendered.missing.length > 0) {
        console.warn(
          `[notify] template ${tpl.id} (${event}) missing merge tokens: ${rendered.missing.join(", ")}`,
        );
      }

      const scheduledFor = computeScheduledFor(tpl, ctx);
      const dedupeKey = buildDedupeKey(event, ctx, tpl.channel);

      const inserted = await enqueueRow(env, {
        template: tpl,
        event,
        recipientName: recipient.name,
        recipientContact: recipient.contact,
        recipientUserId: recipient.userId,
        channel: tpl.channel,
        subject,
        body: rendered.text,
        scheduledFor,
        dedupeKey,
        clientId: ctx.clientId ?? null,
        jobId: ctx.jobId ?? null,
        estimateRequestId: ctx.estimateRequestId ?? null,
        linkPath: ctx.linkPath ?? null,
      });
      if (inserted) result.enqueued++;
      else {
        result.skipped++;
        result.reasons.push(`duplicate:${dedupeKey}`);
      }
    }
  } catch (err) {
    console.error(`[notify] triggerNotification(${event}) failed:`, (err as Error).message);
    result.reasons.push(`error:${(err as Error).message}`);
  }
  return result;
}

interface EnqueueArgs {
  template: TemplateRow;
  event: string;
  recipientName: string;
  recipientContact: string;
  recipientUserId: string | null;
  channel: string;
  subject: string | null;
  body: string;
  scheduledFor: string;
  dedupeKey: string;
  clientId: string | null;
  jobId: string | null;
  estimateRequestId: string | null;
  linkPath: string | null;
}

/** Insert a queued row. Returns false when the dedupe key already exists. */
async function enqueueRow(env: Env, a: EnqueueArgs): Promise<boolean> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_logs (
        id, template_id, trigger_event, recipient_type, recipient_name, recipient_contact,
        recipient_user_id, channel, subject, body, status, scheduled_for, dedupe_key,
        is_read, retry_count, job_id, client_id, estimate_request_id, link_path, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, 0, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      a.template.id,
      a.event,
      a.template.recipient_type,
      a.recipientName,
      a.recipientContact,
      a.recipientUserId,
      a.channel,
      a.subject,
      a.body,
      a.scheduledFor,
      a.dedupeKey,
      a.jobId,
      a.clientId,
      a.estimateRequestId,
      a.linkPath,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

function buildDedupeKey(event: string, ctx: TriggerContext, channel: string): string {
  const entity =
    ctx.jobId ?? ctx.estimateRequestId ?? ctx.estimateId ?? ctx.clientId ?? "noentity";
  const instance = ctx.instanceKey ?? "";
  return `${event}:${entity}:${channel}:${instance}`;
}

function computeScheduledFor(tpl: TemplateRow, ctx: TriggerContext): string {
  if (ctx.scheduledFor) return ctx.scheduledFor;
  const delay = tpl.delay_minutes ?? 0;
  if (delay !== 0) {
    const base = ctx.referenceTime ? new Date(ctx.referenceTime) : new Date();
    if (!Number.isNaN(base.getTime())) {
      return new Date(base.getTime() + delay * 60_000).toISOString();
    }
  }
  return new Date().toISOString();
}

// ─── merge rendering ──────────────────────────────────────────────────────────

/** Replace {{token}} tokens; unknown tokens render empty and are reported. */
export function renderTemplate(
  template: string,
  ctx: Record<string, string>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = ctx[key];
    if (v === undefined || v === null || v === "") {
      missing.push(key);
      return "";
    }
    return String(v);
  });
  return { text, missing };
}

/**
 * Assemble the merge context from whatever records the trigger references.
 * Every value is a string; absent fields are simply not set (renderer treats
 * them as missing and renders empty). Caller overrides via ctx.merge win.
 */
async function buildMergeContext(env: Env, ctx: TriggerContext): Promise<Record<string, string>> {
  const m: Record<string, string> = {
    company_name: "Columbus Home Solutions",
    company_phone: "(501) 551-1814",
  };
  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://chs-hub.homesolutionsar.com").replace(/\/$/, "");

  if (ctx.clientId) {
    const c = await env.DB.prepare(
      "SELECT first_name, last_name, name, email, phone FROM clients WHERE id = ?",
    )
      .bind(ctx.clientId)
      .first<{ first_name: string | null; last_name: string | null; name: string | null; email: string | null; phone: string | null }>();
    if (c) {
      const first = c.first_name ?? (c.name ?? "").split(" ")[0] ?? "";
      const full = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.name || "";
      if (first) m.client_first_name = first;
      if (c.last_name) m.client_last_name = c.last_name;
      if (full) m.client_name = full;
    }
  }

  if (ctx.estimateRequestId) {
    const r = await env.DB.prepare(
      "SELECT property_address, property_city, property_state, property_zip, appointment_date, job_type FROM estimate_requests WHERE id = ?",
    )
      .bind(ctx.estimateRequestId)
      .first<Record<string, string | null>>();
    if (r) {
      if (r.property_address) m.property_address = r.property_address;
      if (r.property_city) m.property_city = r.property_city;
      if (r.property_state) m.property_state = r.property_state;
      if (r.property_zip) m.property_zip = r.property_zip;
      if (r.appointment_date) {
        m.appointment_date = formatDate(r.appointment_date);
        m.appointment_time = formatTime(r.appointment_date);
      }
      if (r.job_type) m.job_type = titleCase(r.job_type);
    }
  }

  if (ctx.estimateId) {
    const e = await env.DB.prepare(
      "SELECT title, total, deposit_amount, expiration_date, portal_token FROM estimates WHERE id = ?",
    )
      .bind(ctx.estimateId)
      .first<{ title: string | null; total: number | null; deposit_amount: number | null; expiration_date: string | null; portal_token: string | null }>();
    if (e) {
      if (e.title) m.job_title = e.title;
      if (e.deposit_amount != null) m.deposit_amount = usd(e.deposit_amount);
      if (e.total != null) m.estimate_total = usd(e.total);
      if (e.expiration_date) m.expiration_date = formatDate(e.expiration_date);
      if (e.portal_token) m.estimate_link = `${origin}/quote/${e.portal_token}`;
    }
  }

  if (ctx.jobId) {
    const j = await env.DB.prepare(
      "SELECT title, property_address, property_city, property_state, property_zip, portal_token, contract_total, deposit_amount, start_date FROM jobs WHERE id = ?",
    )
      .bind(ctx.jobId)
      .first<Record<string, string | number | null>>();
    if (j) {
      if (j.title) m.job_title = String(j.title);
      if (j.property_address) m.property_address = String(j.property_address);
      if (j.property_city) m.property_city = String(j.property_city);
      if (j.property_state) m.property_state = String(j.property_state);
      if (j.property_zip) m.property_zip = String(j.property_zip);
      if (j.portal_token) m.portal_link = `${origin}/portal/${j.portal_token}`;
      if (j.contract_total != null) m.contract_total = usd(Number(j.contract_total));
      if (j.deposit_amount != null) m.deposit_amount = usd(Number(j.deposit_amount));
      if (j.start_date) m.start_date = formatDate(String(j.start_date));
    }
  }

  // Caller overrides (already-formatted strings) win.
  if (ctx.merge) {
    for (const [k, v] of Object.entries(ctx.merge)) {
      if (v !== undefined && v !== null && v !== "") m[k] = String(v);
    }
  }
  return m;
}

// ─── recipient resolution ─────────────────────────────────────────────────────

interface Recipient {
  name: string;
  contact: string;
  userId: string | null;
}

async function resolveRecipient(
  env: Env,
  tpl: TemplateRow,
  ctx: TriggerContext,
  merge: Record<string, string>,
): Promise<Recipient | null> {
  if (tpl.recipient_type === "client") {
    if (!ctx.clientId) return null;
    const c = await env.DB.prepare(
      "SELECT first_name, last_name, name, email, phone FROM clients WHERE id = ?",
    )
      .bind(ctx.clientId)
      .first<{ first_name: string | null; last_name: string | null; name: string | null; email: string | null; phone: string | null }>();
    if (!c) return null;
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.name || "Client";
    if (tpl.channel === "sms") {
      return c.phone ? { name, contact: c.phone, userId: null } : null;
    }
    if (tpl.channel === "email") {
      return c.email ? { name, contact: c.email, userId: null } : null;
    }
    return { name, contact: c.email ?? c.phone ?? "", userId: null };
  }

  // owner / internal → the owner user (the only role that receives system mail).
  const owner = await resolveOwner(env);
  if (!owner) return null;
  const name = [owner.first_name, owner.last_name].filter(Boolean).join(" ").trim() || owner.email;
  if (tpl.channel === "sms") {
    return owner.phone ? { name, contact: owner.phone, userId: owner.id } : null;
  }
  if (tpl.channel === "in_app") {
    return { name, contact: owner.email, userId: owner.id };
  }
  return { name, contact: owner.email, userId: owner.id };
}

interface OwnerUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}

export async function resolveOwner(env: Env): Promise<OwnerUser | null> {
  return env.DB.prepare(
    "SELECT id, email, first_name, last_name, phone FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
  ).first<OwnerUser>();
}

// ─── cron: process the queue ──────────────────────────────────────────────────

export interface ProcessStats {
  scanned_enqueued: number;
  sent: number;
  simulated: number;
  failed: number;
  deferred: number;
  suppressed: number;
  dead_lettered: number;
  duration_ms: number;
}

/**
 * The every-15-min Notification Processor. Three phases:
 *   1. scanScheduledTriggers — recompute time-based triggers from D1 (quote
 *      follow-ups, work_starting, appointment_reminder) and enqueue what's due.
 *   2. drain — send every status='queued' row whose scheduled_for <= now.
 *   3. (retries ride on the same queued drain via scheduled_for = next_retry_at.)
 */
export async function processNotifications(env: Env): Promise<ProcessStats> {
  const started = Date.now();
  const stats: ProcessStats = {
    scanned_enqueued: 0,
    sent: 0,
    simulated: 0,
    failed: 0,
    deferred: 0,
    suppressed: 0,
    dead_lettered: 0,
    duration_ms: 0,
  };

  try {
    stats.scanned_enqueued = await scanScheduledTriggers(env);
  } catch (err) {
    console.error("[notify] scanScheduledTriggers failed:", (err as Error).message);
  }

  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT * FROM notification_logs
      WHERE status = 'queued' AND (scheduled_for IS NULL OR scheduled_for <= ?)
      ORDER BY scheduled_for ASC LIMIT 200`,
  )
    .bind(now)
    .all<LogRow>();

  for (const row of results ?? []) {
    try {
      await dispatchRow(env, row, stats);
    } catch (err) {
      console.error(`[notify] dispatch ${row.id} threw:`, (err as Error).message);
    }
  }

  stats.duration_ms = Date.now() - started;
  return stats;
}

interface LogRow {
  id: string;
  template_id: string;
  trigger_event: string;
  recipient_type: string;
  recipient_name: string;
  recipient_contact: string;
  recipient_user_id: string | null;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  retry_count: number;
  scheduled_for: string | null;
  job_id: string | null;
  client_id: string | null;
  estimate_request_id: string | null;
  link_path: string | null;
}

/** Send (or simulate) one due row, applying every send-time business rule. */
async function dispatchRow(env: Env, row: LogRow, stats: ProcessStats): Promise<void> {
  // (1) Stop-condition re-check for quote follow-ups (§6.6) — at SEND time.
  if (FOLLOW_UP_EVENTS.has(row.trigger_event)) {
    const stop = await followUpStopReason(env, row.estimate_request_id);
    if (stop) {
      await suppressRow(env, row.id, `stop:${stop}`);
      stats.suppressed++;
      return;
    }
  }

  // (2) Opt-out check for non-transactional sends (§6.3).
  if (!TRANSACTIONAL_EVENTS.has(row.trigger_event) && row.client_id && row.channel !== "in_app") {
    const optedOut = await isOptedOut(env, row.client_id, row.channel);
    if (optedOut) {
      await suppressRow(env, row.id, "opt_out");
      stats.suppressed++;
      return;
    }
  }

  // (3) SMS rate limit (§6.4): max 5/client/day. Over cap → DEFER to tomorrow.
  if (row.channel === "sms" && row.client_id) {
    const sentToday = await smsSentToday(env, row.client_id);
    if (sentToday >= SMS_DAILY_LIMIT) {
      const tomorrow = nextDayMorningIso();
      await env.DB.prepare(
        "UPDATE notification_logs SET scheduled_for = ?, error_message = ? WHERE id = ?",
      )
        .bind(tomorrow, "deferred: SMS daily limit reached", row.id)
        .run();
      stats.deferred++;
      return;
    }
  }

  // (4) Dispatch by channel (with simulate fallback).
  const mode = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase();
  const live = mode === "live";
  const outcome = await sendByChannel(env, row, live);

  if (outcome.kind === "sent" || outcome.kind === "simulated") {
    if (outcome.kind === "simulated") stats.simulated++;
    else stats.sent++;
    const sentStatus = row.channel === "in_app" ? "delivered" : "sent";
    await env.DB.prepare(
      "UPDATE notification_logs SET status = ?, sent_at = datetime('now'), external_id = ?, error_message = NULL WHERE id = ?",
    )
      .bind(sentStatus, outcome.externalId, row.id)
      .run();
    // (5) Auto-log to communications (sms/email only — §6.1 / decision (e)).
    if ((row.channel === "sms" || row.channel === "email") && row.client_id) {
      await autoLogCommunication(env, row);
    }
    return;
  }

  // Failure → retry with backoff, or dead-letter after MAX_RETRIES.
  const nextCount = row.retry_count + 1;
  if (nextCount >= MAX_RETRIES) {
    await env.DB.prepare(
      "UPDATE notification_logs SET status = 'failed', retry_count = ?, error_message = ? WHERE id = ?",
    )
      .bind(nextCount, outcome.error.slice(0, 500), row.id)
      .run();
    await escalateToDeadLetter(env, row, outcome.error);
    await alertOwnerFailure(env, row, outcome.error);
    stats.failed++;
    stats.dead_lettered++;
  } else {
    const backoff = BACKOFF_MS[Math.min(nextCount - 1, BACKOFF_MS.length - 1)];
    const nextAt = new Date(Date.now() + backoff).toISOString();
    await env.DB.prepare(
      "UPDATE notification_logs SET retry_count = ?, next_retry_at = ?, scheduled_for = ?, error_message = ? WHERE id = ?",
    )
      .bind(nextCount, nextAt, nextAt, outcome.error.slice(0, 500), row.id)
      .run();
  }
}

type SendOutcome =
  | { kind: "sent"; externalId: string }
  | { kind: "simulated"; externalId: string }
  | { kind: "failed"; error: string };

async function sendByChannel(env: Env, row: LogRow, live: boolean): Promise<SendOutcome> {
  // in_app: nothing external — the row IS the delivery (the bell reads it).
  if (row.channel === "in_app") {
    return { kind: "sent", externalId: `in_app:${row.id}` };
  }
  // push: documented no-op stub (Capacitor/FCM/APNS is Sprint 18).
  if (row.channel === "push") {
    return { kind: "simulated", externalId: `push_noop:${crypto.randomUUID()}` };
  }

  if (row.channel === "sms") {
    if (!live) return { kind: "simulated", externalId: `simulated:${crypto.randomUUID()}` };
    const cfg = await getTwilioConfig(env);
    if (!twilioConfigured(cfg)) {
      return { kind: "simulated", externalId: `simulated:${crypto.randomUUID()}` };
    }
    const r = await sendSms(cfg, row.recipient_contact, row.body);
    return r.ok
      ? { kind: "sent", externalId: r.sid }
      : { kind: "failed", error: `${r.error}: ${r.details}` };
  }

  if (row.channel === "email") {
    if (!live) return { kind: "simulated", externalId: `simulated:${crypto.randomUUID()}` };
    const from = (env.NOTIFICATIONS_EMAIL_FROM ?? env.ALERT_EMAIL_FROM ?? "").trim();
    const apiKey = (env.RESEND_API_KEY ?? "").trim();
    if (!from || !apiKey || env.RESEND_DRY_RUN === "1") {
      return { kind: "simulated", externalId: `simulated:${crypto.randomUUID()}` };
    }
    const r = await sendResendEmail(apiKey, from, row.recipient_contact, row.subject ?? "", row.body);
    return r.ok
      ? { kind: "sent", externalId: r.id }
      : { kind: "failed", error: r.error };
  }

  return { kind: "failed", error: `unknown_channel:${row.channel}` };
}

/** Minimal Resend send (reuses the established daily-summary Resend HTTP path). */
async function sendResendEmail(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: subject || "Columbus Home Solutions", text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `resend ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id ?? `resend:${crypto.randomUUID()}` };
  } catch (e) {
    return { ok: false, error: `resend_exception: ${(e as Error).message}` };
  }
}

// ─── auto-log to communications (§6.1) ────────────────────────────────────────

const CHANNEL_TO_COMM: Record<string, string> = { sms: "text_sms", email: "email" };

async function autoLogCommunication(env: Env, row: LogRow): Promise<void> {
  const commId = crypto.randomUUID();
  const tpl = await env.DB.prepare("SELECT name FROM notification_templates WHERE id = ?")
    .bind(row.template_id)
    .first<{ name: string }>();
  await env.DB.prepare(
    `INSERT INTO communications (
        id, client_id, job_id, channel, direction, summary, body, sent_via, created_at
     ) VALUES (?, ?, ?, ?, 'outbound', ?, ?, 'system_auto', datetime('now'))`,
  )
    .bind(
      commId,
      row.client_id,
      row.job_id,
      CHANNEL_TO_COMM[row.channel] ?? row.channel,
      tpl?.name ?? row.trigger_event,
      row.body,
    )
    .run();
  await env.DB.prepare("UPDATE notification_logs SET communication_id = ? WHERE id = ?")
    .bind(commId, row.id)
    .run();
  await env.DB.prepare(
    "UPDATE clients SET last_interaction_date = datetime('now') WHERE id = ?",
  )
    .bind(row.client_id)
    .run();
}

// ─── send-time guards ─────────────────────────────────────────────────────────

/** Returns a stop reason string if a follow-up must be suppressed, else null. */
async function followUpStopReason(env: Env, requestId: string | null): Promise<string | null> {
  if (!requestId) return null;
  const r = await env.DB.prepare(
    `SELECT er.status AS req_status, e.status AS est_status
       FROM estimate_requests er
       LEFT JOIN estimates e ON e.id = er.estimate_id
      WHERE er.id = ?`,
  )
    .bind(requestId)
    .first<{ req_status: string; est_status: string | null }>();
  if (!r) return "request_missing";
  if (r.req_status === "won") return "won";
  if (r.req_status === "lost") return "lost";
  if (r.est_status === "approved") return "approved";
  return null;
}

async function isOptedOut(env: Env, clientId: string, channel: string): Promise<boolean> {
  const c = await env.DB.prepare("SELECT notification_preferences FROM clients WHERE id = ?")
    .bind(clientId)
    .first<{ notification_preferences: string | null }>();
  if (!c?.notification_preferences) return false; // NULL = all enabled
  try {
    const prefs = JSON.parse(c.notification_preferences) as Record<string, unknown>;
    if (prefs.marketing === false) return true;
    if (channel === "sms" && prefs.sms === false) return true;
    if (channel === "email" && prefs.email === false) return true;
  } catch {
    return false;
  }
  return false;
}

async function smsSentToday(env: Env, clientId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM notification_logs
      WHERE client_id = ? AND channel = 'sms'
        AND status IN ('sent','delivered')
        AND date(COALESCE(sent_at, created_at)) = date('now')`,
  )
    .bind(clientId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Mark a row suppressed (never sends, never retries) without polluting retries. */
async function suppressRow(env: Env, id: string, reason: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE notification_logs SET status = 'failed', retry_count = 99, error_message = ? WHERE id = ?",
  )
    .bind(`suppressed:${reason}`, id)
    .run();
}

async function escalateToDeadLetter(env: Env, row: LogRow, error: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO dead_letter_queue (id, operation, payload, error_message, retry_count, max_retries, status, created_at)
       VALUES (?, 'notification_send', ?, ?, ?, ?, 'dead', datetime('now'))`,
    )
      .bind(
        crypto.randomUUID(),
        JSON.stringify({ notification_log_id: row.id, trigger: row.trigger_event, channel: row.channel }),
        error.slice(0, 500),
        MAX_RETRIES,
        MAX_RETRIES,
      )
      .run();
  } catch (err) {
    console.error("[notify] DLQ escalation failed:", (err as Error).message);
  }
}

/** Owner in-app alert that a notification dead-lettered (§6.5). */
async function alertOwnerFailure(env: Env, row: LogRow, error: string): Promise<void> {
  await createOwnerInApp(env, {
    message: `A ${row.trigger_event} ${row.channel} notification to ${row.recipient_name} failed after ${MAX_RETRIES} attempts: ${error.slice(0, 160)}`,
    linkPath: "/app/settings/notifications/logs",
    dedupe: `failed_alert:${row.id}`,
  });
}

// ─── owner in-app alerts (bell) ───────────────────────────────────────────────

/**
 * Create an owner-facing in_app notification (the bell). Used for inbound SMS
 * surfacing and dead-letter alerts — these don't flow from a client trigger.
 * Reuses the generic 'tmpl-system-alert' template so template_id stays valid.
 */
export async function createOwnerInApp(
  env: Env,
  opts: { message: string; linkPath?: string | null; dedupe?: string | null; clientId?: string | null },
): Promise<void> {
  const owner = await resolveOwner(env);
  if (!owner) return;
  const name = [owner.first_name, owner.last_name].filter(Boolean).join(" ").trim() || owner.email;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_logs (
        id, template_id, trigger_event, recipient_type, recipient_name, recipient_contact,
        recipient_user_id, channel, body, status, is_read, retry_count, client_id,
        link_path, dedupe_key, sent_at, created_at
     ) VALUES (?, 'tmpl-system-alert', 'system_alert', 'owner', ?, ?, ?, 'in_app', ?, 'delivered', 0, 0, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      name,
      owner.email,
      owner.id,
      opts.message,
      opts.clientId ?? null,
      opts.linkPath ?? null,
      opts.dedupe ?? null,
    )
    .run();
}

// ─── preview + test (Templates API) ──────────────────────────────────────────

/** Representative sample data so owners can preview/test any template's render. */
export function sampleMergeContext(): Record<string, string> {
  const origin = "https://chs-hub.homesolutionsar.com";
  return {
    company_name: "Columbus Home Solutions",
    company_phone: "(501) 551-1814",
    client_first_name: "Jordan",
    client_last_name: "Sample",
    client_name: "Jordan Sample",
    property_address: "123 Maple St",
    property_city: "Conway",
    property_state: "Arkansas",
    property_zip: "72034",
    job_title: "Kitchen Remodel",
    job_type: "Kitchen Remodel",
    appointment_date: "March 14, 2026",
    appointment_time: "10:00 AM",
    estimate_link: `${origin}/quote/sample-token`,
    portal_link: `${origin}/portal/sample-token`,
    deposit_amount: "$2,500.00",
    estimate_total: "$25,000.00",
    contract_total: "$25,000.00",
    expiration_date: "March 21, 2026",
    start_date: "March 28, 2026",
  };
}

/** Render a template against sample data (no send, no log) — POST .../preview. */
export async function previewTemplate(
  env: Env,
  templateId: string,
): Promise<{ subject: string | null; body: string; missing: string[] } | null> {
  const tpl = await env.DB.prepare("SELECT * FROM notification_templates WHERE id = ?")
    .bind(templateId)
    .first<TemplateRow>();
  if (!tpl) return null;
  const ctx = sampleMergeContext();
  const subject = tpl.subject ? renderTemplate(tpl.subject, ctx).text : null;
  const rendered = renderTemplate(tpl.body_template, ctx);
  return { subject, body: rendered.text, missing: rendered.missing };
}

/**
 * Send a test of a template to the OWNER (real send if creds + live mode,
 * simulated otherwise). Writes a real notification_logs row for the audit trail
 * (targeted at the owner, not a client — so no communications row). Returns the
 * rendered content + whether it simulated.
 */
export async function sendOwnerTest(
  env: Env,
  templateId: string,
): Promise<{ ok: boolean; simulated: boolean; detail: string; subject: string | null; body: string } | null> {
  const tpl = await env.DB.prepare("SELECT * FROM notification_templates WHERE id = ?")
    .bind(templateId)
    .first<TemplateRow>();
  if (!tpl) return null;
  const owner = await resolveOwner(env);
  if (!owner) return { ok: false, simulated: false, detail: "No active owner user to test against.", subject: null, body: "" };

  const ctx = sampleMergeContext();
  const subject = tpl.subject ? renderTemplate(tpl.subject, ctx).text : null;
  const body = renderTemplate(tpl.body_template, ctx).text;
  const name = [owner.first_name, owner.last_name].filter(Boolean).join(" ").trim() || owner.email;
  const contact = tpl.channel === "sms" ? owner.phone ?? "" : owner.email;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO notification_logs (
        id, template_id, trigger_event, recipient_type, recipient_name, recipient_contact,
        recipient_user_id, channel, subject, body, status, retry_count, is_read, created_at
     ) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?, ?, 'queued', 0, 0, datetime('now'))`,
  )
    .bind(id, tpl.id, `${tpl.trigger_event}_test`, name, contact || "owner", owner.id, tpl.channel, subject, body)
    .run();

  const row: LogRow = {
    id,
    template_id: tpl.id,
    trigger_event: `${tpl.trigger_event}_test`,
    recipient_type: "owner",
    recipient_name: name,
    recipient_contact: contact || "owner",
    recipient_user_id: owner.id,
    channel: tpl.channel,
    subject,
    body,
    status: "queued",
    retry_count: 0,
    scheduled_for: null,
    job_id: null,
    client_id: null,
    estimate_request_id: null,
    link_path: null,
  };

  const mode = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase();
  const outcome = await sendByChannel(env, row, mode === "live");
  if (outcome.kind === "failed") {
    await env.DB.prepare(
      "UPDATE notification_logs SET status = 'failed', error_message = ? WHERE id = ?",
    )
      .bind(outcome.error.slice(0, 500), id)
      .run();
    return { ok: false, simulated: false, detail: outcome.error, subject, body };
  }
  const sentStatus = tpl.channel === "in_app" ? "delivered" : "sent";
  await env.DB.prepare(
    "UPDATE notification_logs SET status = ?, sent_at = datetime('now'), external_id = ? WHERE id = ?",
  )
    .bind(sentStatus, outcome.externalId, id)
    .run();
  return {
    ok: true,
    simulated: outcome.kind === "simulated",
    detail:
      outcome.kind === "simulated"
        ? `Simulated (no real ${tpl.channel} sent — dispatch mode is not 'live' or credentials are absent).`
        : `Sent to ${contact} (${outcome.externalId}).`,
    subject,
    body,
  };
}

// ─── post-conversion triggers (deposit receipt + welcome portal) ─────────────

/**
 * Fire the two job-conversion notifications after convertQuoteToJob() succeeds
 * (called by BOTH the manual Won path and the Stripe deposit webhook — the
 * single shared place so neither caller drifts). deposit_received = receipt
 * email; welcome_portal = portal link email. Both keyed on the job id so a
 * webhook redelivery or re-running the Won action never double-messages.
 */
export async function triggerJobConversionNotifications(env: Env, jobId: string): Promise<void> {
  try {
    const job = await env.DB.prepare("SELECT client_id, estimate_id FROM jobs WHERE id = ?")
      .bind(jobId)
      .first<{ client_id: string | null; estimate_id: string | null }>();
    if (!job?.client_id) return;
    const ctx = { clientId: job.client_id, jobId, estimateId: job.estimate_id };
    await triggerNotification(env, "deposit_received", { ...ctx, instanceKey: "receipt" });
    await triggerNotification(env, "welcome_portal", { ...ctx, instanceKey: "welcome" });
  } catch (err) {
    console.error("[notify] triggerJobConversionNotifications failed:", (err as Error).message);
  }
}

// ─── seam-only triggers (NOT wired this sprint — source events don't exist) ───
// These give Sprints 8/9/13 a ready hook to call. They intentionally do NOT
// enqueue yet; wiring happens when the source module ships. The templates for
// each already exist in the catalog (seam-only rows).

/** Sprint 13 (scheduling): fire when a schedule entry assigns/changes/cancels a sub. */
export function triggerSubScheduled(_env: Env, _scheduleEntryId: string): void {
  // TODO(Sprint 13): schedule-entry CRUD does not exist yet (Schedule tab is a
  // Sprint 6 stub). When POST /api/jobs/:id/schedule lands, call
  // triggerNotification(env, 'sub_scheduled', { jobId, ... }).
}
/** Sprint 9 (invoicing): fire on recorded payment / invoice due / past due. */
export function triggerPaymentReceived(_env: Env, _paymentId: string): void {
  // TODO(Sprint 9): invoices/payments module owns payment_received,
  // invoice_due_reminder, invoice_past_due. Wire triggerNotification here then.
}
/** Sprint 8 (photos): weekly photo summary is a cron over active jobs' photos. */
export function triggerWeeklyPhotoSummary(_env: Env): void {
  // TODO(Sprint 8): weekly_photo_summary depends on the photo timeline per job.
}

// ─── scheduled-trigger scan (cron recompute-from-D1) ──────────────────────────

/**
 * Recompute time-based triggers directly from D1 (mirrors the WC cron pattern)
 * and enqueue what's now due. Idempotency is the dedupe_key — re-running every
 * 15 min never double-enqueues. Returns the number of rows enqueued.
 *
 * Dormant by design (no source module yet): weekly_photo_summary (Sprint 8),
 * all invoice/financial reminders (Sprint 9), sub-scheduling (Sprint 13). Those
 * branches are intentionally absent — see the seam stubs above.
 */
async function scanScheduledTriggers(env: Env): Promise<number> {
  let enqueued = 0;
  enqueued += await scanQuoteFollowUps(env);
  enqueued += await scanAppointmentReminders(env);
  enqueued += await scanWorkStarting(env);
  return enqueued;
}

/** Quote follow-ups Day 3 / 5 / 7 driven by sent_date + the Sprint 5 state. */
async function scanQuoteFollowUps(env: Env): Promise<number> {
  let n = 0;
  const { results } = await env.DB.prepare(
    `SELECT er.id AS request_id, er.client_id, er.estimate_id, er.sent_date,
            er.follow_up_count, e.expiration_date, e.status AS est_status
       FROM estimate_requests er
       LEFT JOIN estimates e ON e.id = er.estimate_id
      WHERE er.status = 'sent' AND er.sent_date IS NOT NULL`,
  ).all<{
    request_id: string;
    client_id: string;
    estimate_id: string | null;
    sent_date: string;
    follow_up_count: number | null;
    expiration_date: string | null;
    est_status: string | null;
  }>();

  for (const r of results ?? []) {
    if (r.est_status === "approved") continue; // stop condition
    const days = daysSince(r.sent_date);
    const ctxBase = {
      clientId: r.client_id,
      estimateRequestId: r.request_id,
      estimateId: r.estimate_id,
      scheduledFor: new Date().toISOString(),
    };
    // Day 3 → follow_up_1; Day 5 → follow_up_2; Day 7 (or expiry) → quote_expiring.
    if (days >= 3) {
      const res = await triggerNotification(env, "quote_follow_up_1", { ...ctxBase, instanceKey: "follow_up_1" });
      n += res.enqueued;
    }
    if (days >= 5) {
      const res = await triggerNotification(env, "quote_follow_up_2", { ...ctxBase, instanceKey: "follow_up_2" });
      n += res.enqueued;
    }
    const expiring = r.expiration_date ? daysUntil(r.expiration_date) <= 0 : days >= 7;
    if (expiring) {
      const res = await triggerNotification(env, "quote_expiring", { ...ctxBase, instanceKey: "expiring" });
      n += res.enqueued;
    }
  }
  return n;
}

/** Appointment reminders: appt within the next 24h gets a reminder enqueued. */
async function scanAppointmentReminders(env: Env): Promise<number> {
  let n = 0;
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id AS request_id, client_id, appointment_date
       FROM estimate_requests
      WHERE appointment_date IS NOT NULL
        AND COALESCE(appointment_completed, 0) = 0
        AND status NOT IN ('won','lost')`,
  ).all<{ request_id: string; client_id: string; appointment_date: string }>();

  for (const r of results ?? []) {
    const appt = new Date(r.appointment_date).getTime();
    if (Number.isNaN(appt)) continue;
    const hoursUntil = (appt - now) / 3_600_000;
    if (hoursUntil > 0 && hoursUntil <= 24) {
      const res = await triggerNotification(env, "appointment_reminder", {
        clientId: r.client_id,
        estimateRequestId: r.request_id,
        instanceKey: r.appointment_date, // one reminder per appointment instance
        scheduledFor: new Date().toISOString(),
      });
      n += res.enqueued;
    }
  }
  return n;
}

/**
 * work_starting: jobs whose start_date is tomorrow, 6 PM the night before.
 * Cloudflare cron is UTC; "6 PM Central" ≈ 23:00–24:00 UTC (CST/CDT). We fire
 * once the UTC hour is >= 23 on the day before start_date. Dedupe on the
 * start_date instance means the 15-min ticks after 23:00 enqueue exactly once.
 */
async function scanWorkStarting(env: Env): Promise<number> {
  let n = 0;
  const nowUtc = new Date();
  if (nowUtc.getUTCHours() < 23) return 0; // only the 6 PM Central window onward
  const tomorrow = new Date(nowUtc.getTime() + 24 * 3_600_000).toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT id AS job_id, client_id, start_date
       FROM jobs
      WHERE substr(start_date, 1, 10) = ?
        AND status IN ('scheduled','deposit_paid')`,
  )
    .bind(tomorrow)
    .all<{ job_id: string; client_id: string; start_date: string }>();

  for (const r of results ?? []) {
    if (!r.client_id) continue;
    const res = await triggerNotification(env, "work_starting", {
      clientId: r.client_id,
      jobId: r.job_id,
      instanceKey: r.start_date,
      scheduledFor: new Date().toISOString(),
    });
    n += res.enqueued;
  }
  return n;
}

// ─── small helpers ────────────────────────────────────────────────────────────

function daysSince(iso: string): number {
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}
function daysUntil(isoDate: string): number {
  const t = new Date(`${isoDate.slice(0, 10)}T23:59:59Z`).getTime();
  if (Number.isNaN(t)) return 9999;
  return Math.ceil((t - Date.now()) / 86_400_000);
}
function nextDayMorningIso(): string {
  const d = new Date(Date.now() + 24 * 3_600_000);
  d.setUTCHours(13, 0, 0, 0); // ~8 AM Central
  return d.toISOString();
}
function formatDate(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || !iso.includes("T")) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
}
function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
