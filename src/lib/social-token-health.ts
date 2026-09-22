/**
 * Nightly Facebook/Instagram token health check.
 *
 * Folded into the existing nightly cron (`15 7 * * *`). No extra trigger.
 * Uses Graph `debug_token` with the stored token inspecting itself — confirmed
 * to work for the Page token without an app secret. A still-valid token with
 * `expires_at` inside 7 days warns early. An invalid token alerts the same
 * night. After the first alert, the same problem re-alerts at most once every
 * 7 days. A healthy result clears that state.
 *
 * The token value is never logged and never included in the notification.
 */

import type { Env } from "../env.js";
import { createOwnerInApp } from "./notification-engine.js";
import {
  getSetting,
  SETTING_FB_TOKEN,
  SETTING_IG_USER_TOKEN,
  SETTING_SOCIAL_TOKEN_HEALTH,
} from "./social.js";

const GRAPH_DEBUG = "https://graph.facebook.com/v21.0/debug_token";
const ALERT_WINDOW_DAYS = 7;
const COOLDOWN_MS = ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export interface DebugTokenPayload {
  data?: { is_valid?: boolean; expires_at?: number };
  error?: { code?: number; message?: string };
}

export type TokenVerdict = "ok" | "expired" | "expiring" | "unknown";

export interface InterpretedToken {
  verdict: TokenVerdict;
  daysLeft: number | null;
}

/** Classify a debug_token body. `expires_at` 0 means the token does not expire. */
export function interpretDebugToken(payload: DebugTokenPayload, nowMs: number): InterpretedToken {
  if (payload.error) {
    if (payload.error.code === 190) return { verdict: "expired", daysLeft: null };
    return { verdict: "unknown", daysLeft: null };
  }
  const data = payload.data;
  if (!data || typeof data.is_valid !== "boolean") return { verdict: "unknown", daysLeft: null };
  if (data.is_valid === false) return { verdict: "expired", daysLeft: null };
  const expiresAt = data.expires_at ?? 0;
  if (!expiresAt) return { verdict: "ok", daysLeft: null };
  const daysLeft = Math.ceil((expiresAt * 1000 - nowMs) / 86_400_000);
  if (daysLeft <= 0) return { verdict: "expired", daysLeft };
  if (daysLeft <= ALERT_WINDOW_DAYS) return { verdict: "expiring", daysLeft };
  return { verdict: "ok", daysLeft };
}

export type TokenSubject = "facebook" | "instagram" | "both";

export interface TokenProblem {
  health: "ok" | "expired" | "expiring" | "unknown";
  subject: TokenSubject | null;
  daysLeft: number | null;
  message: string | null;
}

export function tokenAlertMessage(
  subject: TokenSubject,
  health: "expired" | "expiring",
  daysLeft: number | null,
): string {
  if (subject === "instagram") {
    if (health === "expired") {
      return "Instagram access token is invalid — Instagram publishing is currently broken.";
    }
    const days = daysLeft ?? ALERT_WINDOW_DAYS;
    const unit = days === 1 ? "day" : "days";
    return `Instagram access token expires in ${days} ${unit} — regenerate it before publishing breaks.`;
  }
  if (health === "expired") {
    return "Facebook/Instagram token has expired — social publishing is currently broken.";
  }
  const days = daysLeft ?? ALERT_WINDOW_DAYS;
  const unit = days === 1 ? "day" : "days";
  return `Facebook/Instagram token expires in ${days} ${unit} — regenerate it before publishing breaks.`;
}

/** Pick the worse of the Page token and the optional Instagram user token. */
export function summarizeTokenHealth(
  page: InterpretedToken,
  instagram: InterpretedToken | null,
): TokenProblem {
  const pieces: Array<{ subject: "facebook" | "instagram"; token: InterpretedToken }> = [
    { subject: "facebook", token: page },
  ];
  if (instagram) pieces.push({ subject: "instagram", token: instagram });

  const rank = (v: TokenVerdict) => (v === "expired" ? 3 : v === "expiring" ? 2 : v === "ok" ? 1 : 0);
  const known = pieces.filter((p) => p.token.verdict !== "unknown");
  if (known.length === 0) {
    return { health: "unknown", subject: null, daysLeft: null, message: null };
  }
  const worst = known.reduce((a, b) => (rank(b.token.verdict) > rank(a.token.verdict) ? b : a));
  if (worst.token.verdict === "ok") {
    return { health: "ok", subject: null, daysLeft: worst.token.daysLeft, message: null };
  }
  const bad = known.filter((p) => p.token.verdict === worst.token.verdict);
  const subject: TokenSubject =
    bad.length > 1 ? "both" : bad[0]!.subject === "facebook" ? "facebook" : "instagram";
  const health = worst.token.verdict === "expired" ? "expired" : "expiring";
  const daysLeft = bad.reduce<number | null>((min, piece) => {
    if (piece.token.daysLeft == null) return min;
    return min == null ? piece.token.daysLeft : Math.min(min, piece.token.daysLeft);
  }, null);
  return {
    health,
    subject,
    daysLeft,
    message: tokenAlertMessage(subject, health, daysLeft),
  };
}

export interface TokenHealthState {
  problem: "expired" | "expiring" | null;
  subject: TokenSubject | null;
  last_alert_at: string | null;
}

export const EMPTY_TOKEN_HEALTH: TokenHealthState = {
  problem: null,
  subject: null,
  last_alert_at: null,
};

export function parseTokenHealthState(raw: string | null | undefined): TokenHealthState {
  if (!raw) return { ...EMPTY_TOKEN_HEALTH };
  try {
    const parsed = JSON.parse(raw) as Partial<TokenHealthState>;
    const problem = parsed.problem === "expired" || parsed.problem === "expiring" ? parsed.problem : null;
    const subject =
      parsed.subject === "facebook" || parsed.subject === "instagram" || parsed.subject === "both"
        ? parsed.subject
        : null;
    return {
      problem,
      subject,
      last_alert_at: typeof parsed.last_alert_at === "string" ? parsed.last_alert_at : null,
    };
  } catch {
    return { ...EMPTY_TOKEN_HEALTH };
  }
}

/**
 * Alert the first time a problem is seen, then at most once every 7 days
 * while that same problem continues. A healthy check clears the cycle.
 */
export function decideTokenAlert(
  prev: TokenHealthState,
  problem: TokenProblem,
  now: Date,
): { next: TokenHealthState; notify: boolean } {
  if (problem.health === "unknown") return { next: prev, notify: false };
  if (problem.health === "ok") return { next: { ...EMPTY_TOKEN_HEALTH }, notify: false };

  const same =
    prev.problem === problem.health && prev.subject === problem.subject && prev.last_alert_at != null;
  const last = prev.last_alert_at ? Date.parse(prev.last_alert_at) : NaN;
  const cooledDown = !Number.isFinite(last) || now.getTime() - last >= COOLDOWN_MS;
  const notify = !same || cooledDown;
  return {
    next: {
      problem: problem.health,
      subject: problem.subject,
      last_alert_at: notify ? now.toISOString() : prev.last_alert_at,
    },
    notify,
  };
}

/** Strip a token if one ever lands in a Graph error string. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 12) out = out.split(trimmed).join("[redacted]");
  }
  return out.replace(/EAA[A-Za-z0-9]+/g, "[redacted]");
}

async function debugToken(token: string): Promise<DebugTokenPayload> {
  const url = new URL(GRAPH_DEBUG);
  url.searchParams.set("input_token", token);
  url.searchParams.set("access_token", token);
  const res = await fetch(url);
  return (await res.json()) as DebugTokenPayload;
}

async function readState(env: Env): Promise<TokenHealthState> {
  return parseTokenHealthState(await getSetting(env, SETTING_SOCIAL_TOKEN_HEALTH));
}

async function writeState(env: Env, state: TokenHealthState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'json', 'social', 'Social token health', 'Nightly Facebook/Instagram token-check cooldown. Not edited by hand.', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(SETTING_SOCIAL_TOKEN_HEALTH, JSON.stringify(state))
    .run();
}

export interface SocialTokenHealthResult {
  ran: boolean;
  health?: TokenProblem["health"];
  notified?: boolean;
  message?: string | null;
}

/**
 * Every-night check. `debug` is injectable so tests can simulate an expired
 * or soon-to-expire token without calling Graph.
 */
export async function runSocialTokenHealth(
  env: Env,
  opts: {
    now?: Date;
    debug?: (token: string) => Promise<DebugTokenPayload>;
  } = {},
): Promise<SocialTokenHealthResult> {
  const now = opts.now ?? new Date();
  const pageToken = (await getSetting(env, SETTING_FB_TOKEN))?.trim() ?? "";
  if (!pageToken) return { ran: false };

  const igToken = (await getSetting(env, SETTING_IG_USER_TOKEN))?.trim() ?? "";
  const debug = opts.debug ?? debugToken;
  const secrets = [pageToken, igToken].filter(Boolean);

  let page: InterpretedToken;
  let instagram: InterpretedToken | null = null;
  try {
    page = interpretDebugToken(await debug(pageToken), now.getTime());
    if (igToken) instagram = interpretDebugToken(await debug(igToken), now.getTime());
  } catch (err) {
    const detail = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    console.error(`[cron 15 7 * * *] social_token_health: check failed: ${detail}`);
    return { ran: true, health: "unknown", notified: false };
  }

  const problem = summarizeTokenHealth(page, instagram);
  if (problem.message) {
    problem.message = redactSecrets(problem.message, secrets);
  }
  const prev = await readState(env);
  const decision = decideTokenAlert(prev, problem, now);
  await writeState(env, decision.next);

  if (decision.notify && problem.message) {
    await createOwnerInApp(env, {
      message: problem.message,
      linkPath: "/app/settings?tab=integrations",
      dedupe: `social_token:${problem.health}:${problem.subject}:${now.toISOString().slice(0, 10)}`,
      triggerEvent: "social_token_health",
    });
  }

  return { ran: true, health: problem.health, notified: decision.notify, message: problem.message };
}
