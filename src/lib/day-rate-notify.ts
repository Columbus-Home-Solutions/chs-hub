/**
 * Day-rate schedule and punch texts. One queued row per worker per hold window,
 * so several edits collapse into a single message. Dispatch still follows
 * NOTIFICATIONS_DISPATCH_MODE (local stays SIMULATE). Check-ins are never notified.
 */

import type { Env } from "../env.js";
import { centralDate } from "../../shared/labor-week.js";

const HOLD_MS = 15 * 60 * 1000;

export function nextDayRateSendAt(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = Number(get("hour"));
  if (hour >= 7 && hour < 20) return new Date(now.getTime() + HOLD_MS).toISOString();
  const today = centralDate(now);
  const [y, m, d] = today.split("-").map(Number);
  const targetDay = hour >= 20 ? d + 1 : d;
  // 07:00 America/Chicago is 12:00 UTC during CDT and 13:00 UTC during CST.
  // October is CDT (UTC-5), so 07:00 Central = 12:00 UTC. Use a fixed offset
  // lookup from the formatted hour rather than guessing DST: build the instant
  // by stepping until Central hour is 7.
  const guess = new Date(Date.UTC(y, m - 1, targetDay, 12, 0, 0));
  const centralHour = (at: Date) => {
    const hp = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    return Number(hp.find((p) => p.type === "hour")?.value ?? "0");
  };
  const delta = 7 - centralHour(guess);
  return new Date(guess.getTime() + delta * 3600_000).toISOString();
}

export type WorkerLang = "en" | "es";

export function workerLang(value: string | null | undefined): WorkerLang {
  return value === "es" ? "es" : "en";
}

/** Weekday and month in the worker's language. Job titles are not passed through here. */
export function formatWorkerDate(iso: string, lang: WorkerLang): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const formatted = new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(dt);
  return lang === "es" ? formatted.replace(/\./g, "").toLowerCase() : formatted;
}

export interface DayRateMessage {
  kind: "schedule" | "punch";
  count: number;
  label: string;
  when?: string;
  status?: string | null;
  added?: boolean;
  link: string;
  language?: WorkerLang;
}

/** Draft Spanish. STOP stays the English keyword. Job names in `label` are copied as typed. */
export function dayRateMessage(message: DayRateMessage): string {
  const lang = workerLang(message.language);
  const stop = lang === "es" ? "Responde STOP para cancelar." : "Reply STOP to opt out.";
  if (message.kind === "punch") {
    const line = lang === "es"
      ? `CHS: Nuevo pendiente en ${message.label}. ${message.link}/punch`
      : `CHS: New punch list item on ${message.label}. ${message.link}/punch`;
    return `${line}\n${stop}`;
  }
  if (message.count > 1) {
    const line = lang === "es"
      ? `CHS: Tony actualizó tu horario (${message.count} cambios). Míralo aquí: ${message.link}/schedule`
      : `CHS: Tony updated your schedule (${message.count} changes). See it: ${message.link}/schedule`;
    return `${line}\n${stop}`;
  }
  const when = message.when ? formatWorkerDate(message.when, lang) : "";
  let line: string;
  if (lang === "es") {
    if (message.added) line = `CHS: Tony agregó ${message.label} a tu horario para el ${when}. Míralo aquí: ${message.link}/schedule`;
    else if (message.status === "weather_delay") line = `CHS: Cambio de horario. ${message.label} el ${when} tiene retraso por clima. ${message.link}/schedule`;
    else if (message.status === "cancelled") line = `CHS: Cambio de horario. ${message.label} el ${when} fue cancelado. ${message.link}/schedule`;
    else line = `CHS: Cambio de horario. ${message.label} el ${when}. ${message.link}/schedule`;
  } else if (message.added) {
    line = `CHS: Tony added ${message.label} to your schedule for ${when}. See it: ${message.link}/schedule`;
  } else if (message.status === "weather_delay") {
    line = `CHS: Schedule change. ${message.label} on ${when} is on a weather delay. ${message.link}/schedule`;
  } else if (message.status === "cancelled") {
    line = `CHS: Schedule change. ${message.label} on ${when} was cancelled. ${message.link}/schedule`;
  } else {
    line = `CHS: Schedule change for ${message.label} on ${when}. ${message.link}/schedule`;
  }
  return `${line}\n${stop}`;
}

export function inviteText(link: string, language?: string | null): string {
  if (workerLang(language) === "es") {
    return `Habla Tony. Toca este enlace cada día que trabajes, elige el trabajo y toca Día completo o Medio día. Guárdalo en tu pantalla de inicio para entrar con un toque: ${link}`;
  }
  return `Tony here. Tap this link each day you work, pick the job, and tap Full day or Half day. Save it to your home screen: ${link}`;
}

/** UCS-2 when any character is outside GSM-7. Accents, ñ, and ¿ force the shorter segments. */
export function smsSegmentCount(text: string): { segments: number; encoding: "gsm" | "ucs2" } {
  const gsm = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà");
  const extended = new Set("^{}\\[~]|€");
  let units = 0;
  let ucs2 = false;
  for (const ch of text) {
    if (gsm.has(ch)) units += 1;
    else if (extended.has(ch)) units += 2;
    else ucs2 = true;
  }
  if (ucs2) {
    const len = [...text].length;
    return { segments: len <= 70 ? 1 : Math.ceil(len / 67), encoding: "ucs2" };
  }
  return { segments: units <= 160 ? 1 : Math.ceil(units / 153), encoding: "gsm" };
}

interface NoticePayload {
  kind: "schedule" | "punch";
  count: number;
  label: string;
  when?: string;
  status?: string | null;
  added?: boolean;
  link: string;
}

interface QueueArgs {
  subId: string;
  kind: "schedule" | "punch";
  label: string;
  when?: string;
  status?: string | null;
  added?: boolean;
  link: string;
  past?: boolean;
}

/** Queue or fold into the worker's open day-rate text. No-op for other worker types, opt-out, or past dates. */
export async function queueDayRateNotice(env: Env, args: QueueArgs): Promise<{ queued: boolean; reason?: string }> {
  if (args.past) return { queued: false, reason: "past" };
  const sub = await env.DB.prepare(
    `SELECT id, worker_type, phone, email, text_updates_enabled, is_active, preferred_language,
            COALESCE(contact_name, primary_contact, company_name, company) AS name
       FROM subcontractors WHERE id = ?`,
  )
    .bind(args.subId)
    .first<{
      id: string;
      worker_type: string | null;
      phone: string | null;
      email: string | null;
      text_updates_enabled: number | null;
      is_active: number | null;
      preferred_language: string | null;
      name: string | null;
    }>();
  if (!sub || (sub.worker_type ?? "subcontractor") !== "day_rate_labor") {
    return { queued: false, reason: "not_day_rate" };
  }
  if ((sub.text_updates_enabled ?? 0) !== 1) return { queued: false, reason: "text_updates_off" };
  const channel = sub.phone ? "sms" : sub.email ? "email" : null;
  const contact = sub.phone || sub.email;
  if (!channel || !contact) return { queued: false, reason: "no_contact" };

  const event = args.kind === "punch" ? "day_rate_punch" : "day_rate_schedule";
  const open = await env.DB.prepare(
    `SELECT id, body, error_message FROM notification_logs
      WHERE trigger_event = ? AND recipient_contact = ? AND status = 'queued'
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(event, contact)
    .first<{ id: string; body: string | null; error_message: string | null }>();

  const prior = parseNotice(open?.error_message);
  const count = prior
    ? prior.count + 1
    : open
      ? Number(open.body?.match(/\((\d+) (?:changes|cambios)\)/)?.[1] ?? "1") + 1
      : 1;
  const payload: NoticePayload = {
    kind: args.kind,
    count,
    label: args.label,
    when: args.when,
    status: args.status ?? null,
    added: Boolean(args.added),
    link: args.link,
  };
  const body = dayRateMessage({ ...payload, language: workerLang(sub.preferred_language) });
  const when = nextDayRateSendAt();
  const packed = JSON.stringify(payload);
  if (open) {
    await env.DB.prepare(
      `UPDATE notification_logs SET body = ?, scheduled_for = ?, error_message = ? WHERE id = ?`,
    )
      .bind(body, when, packed, open.id)
      .run();
    return { queued: true, reason: "coalesced" };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO notification_logs
       (id, template_id, trigger_event, recipient_type, recipient_name, recipient_contact,
        channel, subject, body, status, scheduled_for, dedupe_key, is_read, retry_count, link_path, error_message, created_at)
     VALUES (?, ?, ?, 'subcontractor', ?, ?, ?, ?, ?, 'queued', ?, ?, 0, 0, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      args.kind === "punch" ? "nt-day-rate-punch" : "nt-day-rate-schedule",
      event,
      sub.name,
      contact,
      channel,
      args.kind === "punch" ? "Punch list" : "Schedule",
      body,
      when,
      `${event}:${sub.id}:${id}`,
      args.kind === "punch" ? `${args.link}/punch` : `${args.link}/schedule`,
      packed,
    )
    .run();
  return { queued: true };
}

function parseNotice(raw: string | null | undefined): NoticePayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NoticePayload;
    if (!parsed || (parsed.kind !== "schedule" && parsed.kind !== "punch") || !parsed.link) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Rebuild a held text in the worker's current language before it is sent. */
export async function retranslateQueuedDayRate(env: Env, subId: string): Promise<void> {
  const sub = await env.DB.prepare(
    `SELECT phone, email, preferred_language FROM subcontractors WHERE id = ?`,
  )
    .bind(subId)
    .first<{ phone: string | null; email: string | null; preferred_language: string | null }>();
  if (!sub) return;
  const lang = workerLang(sub.preferred_language);
  for (const contact of [sub.phone, sub.email]) {
    if (!contact) continue;
    const { results } = await env.DB.prepare(
      `SELECT id, error_message FROM notification_logs
        WHERE recipient_contact = ? AND status = 'queued'
          AND trigger_event IN ('day_rate_schedule', 'day_rate_punch')`,
    )
      .bind(contact)
      .all<{ id: string; error_message: string | null }>();
    for (const row of results ?? []) {
      const payload = parseNotice(row.error_message);
      if (!payload) continue;
      await env.DB.prepare(`UPDATE notification_logs SET body = ? WHERE id = ?`)
        .bind(dayRateMessage({ ...payload, language: lang }), row.id)
        .run();
    }
  }
}
