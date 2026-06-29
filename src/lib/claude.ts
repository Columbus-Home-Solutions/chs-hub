/**
 * Claude / Anthropic wrapper (Sprint 8).
 *
 * chs-hub already talks to Claude — but only client-side, via the public
 * chs-claude-proxy worker (the dashboard Smart Notes card + the capture PWA
 * both POST an Anthropic Messages body to it). This module is the server-side
 * equivalent so the receipt + smart-note pipelines can run inside the Worker.
 *
 * Resolution order (see env.ts):
 *   1. ANTHROPIC_API_KEY  → call api.anthropic.com/v1/messages directly.
 *   2. CLAUDE_PROXY_URL (or the known default) → POST the same body to the
 *      proxy, which attaches the key server-side.
 *
 * Graceful degradation is the contract: every entry point returns a result
 * object (never throws for "AI unavailable"), so callers can persist the row,
 * mark it failed/pending, and let the user enter values manually — mirroring
 * the Sprint 7 simulate discipline. Local dev needs no key.
 */

import type { Env } from "../env.js";

const DEFAULT_PROXY_URL = "https://chs-claude-proxy.tony-bc5.workers.dev";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Match the model the existing dashboard/PWA proxy calls use.
export const CLAUDE_MODEL = "claude-sonnet-4-20250514";

export type ClaudeBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeBlock[];
}

export interface ClaudeCallResult {
  ok: boolean;
  /** Concatenated text content across all text blocks of the reply. */
  text: string | null;
  /** Why the call didn't produce text — for logging / processing_status. */
  error: string | null;
  /** True when no key and no proxy were available (vs. a runtime failure). */
  unconfigured: boolean;
}

/** Is any Claude path available at all? */
export function claudeConfigured(env: Env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_PROXY_URL || DEFAULT_PROXY_URL);
}

function proxyUrl(env: Env): string {
  return (env.CLAUDE_PROXY_URL && env.CLAUDE_PROXY_URL.trim()) || DEFAULT_PROXY_URL;
}

/**
 * Low-level call. Returns text (or an error reason) — never throws for
 * transport/credential problems.
 */
export async function claudeMessages(
  env: Env,
  opts: { system: string; messages: ClaudeMessage[]; maxTokens?: number; model?: string },
): Promise<ClaudeCallResult> {
  const body = {
    model: opts.model ?? CLAUDE_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: opts.messages,
  };

  const useDirect = Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim());
  const url = useDirect ? ANTHROPIC_URL : proxyUrl(env);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useDirect) {
    headers["x-api-key"] = env.ANTHROPIC_API_KEY!.trim();
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        text: null,
        error: `claude_http_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        unconfigured: false,
      };
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    if (!text) {
      return { ok: false, text: null, error: "claude_empty_response", unconfigured: false };
    }
    return { ok: true, text, error: null, unconfigured: false };
  } catch (e) {
    // Network error: in local dev with no egress this is the graceful path.
    return {
      ok: false,
      text: null,
      error: `claude_unreachable: ${(e as Error).message}`,
      unconfigured: false,
    };
  }
}

/**
 * Parse a JSON object out of a Claude text reply. Strips ```json fences and
 * tolerates leading/trailing prose. Returns null on any parse failure so the
 * caller can mark the row failed without throwing.
 */
export function extractJson<T = Record<string, unknown>>(text: string | null): T | null {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  // First try the whole thing, then fall back to the first {...} span.
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
