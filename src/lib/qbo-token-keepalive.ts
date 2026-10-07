/**
 * QuickBooks OAuth keepalive.
 *
 * Intuit refresh tokens last 100 days (rolling) and rotate on every refresh:
 * the previous refresh token dies as soon as a new one is returned. The nightly
 * sweep never calls the token endpoint while the invoice, payment, and expense
 * push gates are off, so a connected realm can sit until invalid_grant.
 *
 * This step runs inside the existing 2:15 AM Central cron, before the sweep,
 * and only talks to the OAuth token endpoint via getValidAccessToken. It does
 * not push invoices, payments, or expenses, and it does not write a dead letter.
 *
 * Cadence: every Monday, plus any night the last successful refresh is older
 * than half the 100-day lifetime (50 days). The 5-year hard maximum on
 * accounting-scope tokens (hard-expiry starts October 2028 for tokens issued
 * in October 2023) is not the binding constraint.
 */

import type { Env } from "../env.js";
import { createOwnerInApp } from "./notification-engine.js";
import {
  getValidAccessToken,
  loadConnection,
  SETTING_QBO_LAST_TOKEN_REFRESH,
} from "./qbo-auth.js";

/** Intuit's rolling refresh-token lifetime, in days. */
export const QBO_REFRESH_TOKEN_LIFETIME_DAYS = 100;
/** Refresh once the stored token is older than half that lifetime. */
export const QBO_KEEPALIVE_STALE_DAYS = QBO_REFRESH_TOKEN_LIFETIME_DAYS / 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_KEY = "qbo_token_keepalive_state";
const ALERT_MESSAGE = "QuickBooks connection needs attention — token refresh failing";

interface KeepaliveState {
  status: "ok" | "fail" | "none";
  streak: number;
  notified: boolean;
  last_attempt_at: string | null;
}

export interface QboTokenKeepaliveResult {
  ran: boolean;
  ok?: boolean;
  notified?: boolean;
  reason?: string;
  error?: string | null;
  token_expiry?: string | null;
  last_token_refresh?: string | null;
  access_token_len?: number;
  refresh_token_len?: number;
}

const NONE: KeepaliveState = { status: "none", streak: 0, notified: false, last_attempt_at: null };

/**
 * Monday (UTC, matching the 07:15 UTC cron) or last refresh older than 50 days.
 * A missing marker means we have never recorded a refresh and should run.
 */
export function keepaliveDue(now: Date, lastRefresh: string | null): boolean {
  if (now.getUTCDay() === 1) return true;
  if (!lastRefresh) return true;
  const then = Date.parse(lastRefresh);
  if (!Number.isFinite(then)) return true;
  return now.getTime() - then >= QBO_KEEPALIVE_STALE_DAYS * DAY_MS;
}

/**
 * First failure is silent. The second consecutive failure alerts once.
 * Further failures stay quiet until a success resets the streak.
 */
export function decideKeepaliveAlert(
  prev: { status: "ok" | "fail" | "none"; streak: number; notified: boolean },
  ok: boolean,
): { state: { status: "ok" | "fail"; streak: number; notified: boolean }; notify: boolean } {
  if (ok) {
    return { state: { status: "ok", streak: 0, notified: false }, notify: false };
  }
  const streak = prev.status === "fail" ? prev.streak + 1 : 1;
  const notify = streak >= 2 && !prev.notified;
  return {
    state: { status: "fail", streak, notified: prev.notified || notify },
    notify,
  };
}

async function readSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM system_settings WHERE key = ?`)
    .bind(key)
    .first<{ value: string | null }>();
  const value = (row?.value ?? "").trim();
  return value || null;
}

async function readState(env: Env): Promise<KeepaliveState> {
  const raw = await readSetting(env, STATE_KEY);
  if (!raw) return NONE;
  try {
    const parsed = JSON.parse(raw) as Partial<KeepaliveState>;
    const status = parsed.status === "ok" || parsed.status === "fail" ? parsed.status : "none";
    return {
      status,
      streak: typeof parsed.streak === "number" ? parsed.streak : 0,
      notified: parsed.notified === true,
      last_attempt_at: typeof parsed.last_attempt_at === "string" ? parsed.last_attempt_at : null,
    };
  } catch {
    return NONE;
  }
}

async function writeState(
  env: Env,
  state: { status: "ok" | "fail"; streak: number; notified: boolean },
  at: string,
): Promise<void> {
  const stored: KeepaliveState = { ...state, last_attempt_at: at };
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'json', 'integrations', 'QuickBooks token keepalive',
             'Failure streak for the OAuth keepalive. Not edited by hand.', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(STATE_KEY, JSON.stringify(stored))
    .run();
}

/**
 * Refresh the stored OAuth token. `force` is the manual button; the cron omits
 * it and runs only on Monday or when the token is older than 50 days.
 * Shares getValidAccessToken's in-isolate lock, so a sweep in the same tick
 * does not refresh a second time.
 */
export async function runQboTokenKeepalive(
  env: Env,
  opts: { now?: Date; force?: boolean } = {},
): Promise<QboTokenKeepaliveResult> {
  const now = opts.now ?? new Date();
  const conn = await loadConnection(env);
  if (!conn?.refresh_token) {
    return { ran: false, reason: "not_connected" };
  }

  const storedRefresh = await readSetting(env, SETTING_QBO_LAST_TOKEN_REFRESH);
  const marker = storedRefresh ?? conn.token_expiry;
  if (!opts.force && !keepaliveDue(now, marker)) {
    return { ran: false, reason: "not_due" };
  }

  try {
    await getValidAccessToken(env, { forceRefresh: true });
    const after = await loadConnection(env);
    const last = await readSetting(env, SETTING_QBO_LAST_TOKEN_REFRESH);
    const prev = await readState(env);
    const decided = decideKeepaliveAlert(prev, true);
    await writeState(env, decided.state, now.toISOString());
    return {
      ran: true,
      ok: true,
      notified: false,
      token_expiry: after?.token_expiry ?? null,
      last_token_refresh: last,
      access_token_len: after?.access_token?.length ?? 0,
      refresh_token_len: after?.refresh_token?.length ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[qbo] token keepalive failed: ${msg}`);
    const prev = await readState(env);
    const decided = decideKeepaliveAlert(prev, false);
    await writeState(env, decided.state, now.toISOString());
    if (decided.notify) {
      await createOwnerInApp(env, {
        message: ALERT_MESSAGE,
        linkPath: "/app/settings",
        dedupe: `qbo_token_keepalive:${now.toISOString().slice(0, 10)}`,
        triggerEvent: "qbo_token_keepalive",
      });
    }
    return { ran: true, ok: false, notified: decided.notify, error: msg };
  }
}
