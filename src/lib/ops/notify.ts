/**
 * Operational notifications via Resend.
 *
 * Single entry point for every alert, heartbeat, and daily summary the
 * Worker emits. Centralising here means:
 *   - One place to throttle / dedupe (via kv_cache)
 *   - One place to swap providers later (Resend → SES → Twilio etc.)
 *   - Dry-run mode for staging/local without spamming the real inbox
 *
 * Configuration (set via `wrangler secret put` unless noted):
 *   RESEND_API_KEY      Resend API key (re_…)
 *   ALERT_EMAIL_FROM    "alerts@homesolutionsar.com" (must be verified in Resend)
 *   ALERT_EMAIL_TO      "ops@homesolutionsar.com" (group/alias preferred)
 *   RESEND_DRY_RUN      "1" to skip the API call and just log (wrangler.toml var)
 *
 * If any required value is missing, we fall through to dry-run rather than
 * crash the calling cron — operational alerts must never themselves take
 * down the sync.
 */

import type { Env } from "../../env.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type NotifySeverity = "info" | "warning" | "error";

export interface NotifyMessage {
  subject: string;
  text: string;
  html?: string;
  severity?: NotifySeverity;
  /** Optional dedupe key. If set, the same key won't fire again until the window passes. */
  dedupeKey?: string;
  /** Default 4 hours. Only used when dedupeKey is set. */
  dedupeWindowMs?: number;
}

export interface NotifyResult {
  sent: boolean;
  reason?:
    | "dry_run"
    | "missing_config"
    | "deduped"
    | "resend_error"
    | "send_exception";
  detail?: string;
  resendId?: string;
}

const DEFAULT_DEDUPE_WINDOW_MS = 4 * 60 * 60 * 1000;

export async function notify(env: Env, msg: NotifyMessage): Promise<NotifyResult> {
  if (msg.dedupeKey) {
    const window = msg.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
    const recent = await wasRecentlySent(env, msg.dedupeKey, window);
    if (recent) {
      return { sent: false, reason: "deduped" };
    }
  }

  const dryRun = env.RESEND_DRY_RUN === "1";
  const apiKey = env.RESEND_API_KEY;
  const from = env.ALERT_EMAIL_FROM;
  const to = env.ALERT_EMAIL_TO;

  if (dryRun || !apiKey || !from || !to) {
    const reason: NotifyResult["reason"] = dryRun ? "dry_run" : "missing_config";
    console.log(
      `[notify ${reason}] ${msg.severity ?? "info"} | ${msg.subject}\n${msg.text}`,
    );
    if (msg.dedupeKey) {
      await markSent(env, msg.dedupeKey).catch(() => undefined);
    }
    return { sent: false, reason };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: prefixSubject(msg.severity, msg.subject),
        text: msg.text,
        html: msg.html ?? plainHtml(msg.text),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[notify resend_error] ${res.status} ${msg.subject} :: ${body.slice(0, 500)}`,
      );
      return { sent: false, reason: "resend_error", detail: `${res.status} ${body}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    if (msg.dedupeKey) {
      await markSent(env, msg.dedupeKey).catch(() => undefined);
    }
    return { sent: true, resendId: data.id };
  } catch (err) {
    const detail = (err as Error).message;
    console.error(`[notify send_exception] ${msg.subject} :: ${detail}`);
    return { sent: false, reason: "send_exception", detail };
  }
}

function prefixSubject(severity: NotifySeverity | undefined, subject: string): string {
  if (severity === "error") return `[chs-hub error] ${subject}`;
  if (severity === "warning") return `[chs-hub warn] ${subject}`;
  return `[chs-hub] ${subject}`;
}

function plainHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:pre-wrap;line-height:1.5">${escaped}</pre>`;
}

// ─── Dedupe via kv_cache ───────────────────────────────────────────
// Storing the last-sent timestamp keyed by `notify:<dedupeKey>`. We don't
// care about precise consistency — at-most-one false positive is fine.

async function wasRecentlySent(
  env: Env,
  key: string,
  windowMs: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT updated_at FROM kv_cache WHERE key = ?`,
  )
    .bind(`notify:${key}`)
    .first<{ updated_at: string }>();
  if (!row?.updated_at) return false;
  const last = new Date(row.updated_at).getTime();
  if (Number.isNaN(last)) return false;
  return Date.now() - last < windowMs;
}

async function markSent(env: Env, key: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO kv_cache (key, value, updated_at)
     VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
  )
    .bind(`notify:${key}`, new Date().toISOString())
    .run();
}
