import type { Env } from "../../env.js";
import { getAccessToken } from "./auth.js";

/**
 * Low-level Jobber GraphQL client with throttle-aware retries.
 *
 * Mirrors the retry strategy from chs-dashboard/jobber_sync.py:
 *   - Detect throttle by `extensions.code` and/or message text (Jobber often
 *     returns `"Throttled"` without `THROTTLED` in extensions).
 *   - On throttle, prefer Jobber's `throttleStatus` hint:
 *     (requestedQueryCost - currentlyAvailable) / restoreRate
 *   - Fall back to exponential backoff when hints aren't present
 *   - Cap waits at 5 min to avoid runaway loops
 */

const JOBBER_API = "https://api.getjobber.com/api/graphql";
const API_VERSION = "2025-04-16";

export interface JobberError {
  message: string;
  extensions?: {
    code?: string;
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: {
        maximumAvailable?: number;
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
}

export interface JobberResponse<T> {
  data?: T;
  errors?: JobberError[];
}

export class JobberClientError extends Error {
  constructor(
    message: string,
    public readonly errors?: JobberError[],
  ) {
    super(message);
    this.name = "JobberClientError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeThrottleWaitMs(errors: JobberError[], fallbackMs: number): number {
  for (const err of errors) {
    const cost = err.extensions?.cost;
    const status = cost?.throttleStatus;
    const requested = cost?.requestedQueryCost ?? 0;
    const available = status?.currentlyAvailable ?? 0;
    const restoreRate = status?.restoreRate ?? 0;
    if (requested > available && restoreRate > 0) {
      const deficitSeconds = (requested - available) / restoreRate;
      return Math.min(Math.ceil(deficitSeconds * 1250) + 2000, 300_000);
    }
  }
  return fallbackMs;
}

/** Jobber sometimes returns message "Throttled" without `extensions.code === "THROTTLED"`. */
function isThrottledError(e: JobberError): boolean {
  const code = e.extensions?.code?.toUpperCase();
  if (code === "THROTTLED") return true;
  return /\bthrottl/i.test(e.message ?? "");
}

interface QueryOptions {
  variables?: Record<string, unknown>;
  maxRetries?: number;
  /**
   * When set, HTTP 401 from GraphQL (expired access token mid-sync) triggers
   * `getAccessToken(env)` and retries. Long full syncs exceed ~60m JWT TTL.
   */
  env?: Env;
  /** If set, `current` is overwritten whenever a fresh token is obtained. */
  tokenOut?: { current: string };
}

export async function jobberQuery<T>(
  accessToken: string,
  query: string,
  opts: QueryOptions = {},
): Promise<T> {
  const { variables, maxRetries = 12, env, tokenOut } = opts;
  let token = accessToken;
  if (tokenOut) tokenOut.current = token;
  let backoffMs = 20_000;
  let authRefreshAttempts = 0;
  const maxAuthRefresh = 4;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch(JOBBER_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-jobber-graphql-version": API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (
        res.status === 401 &&
        env &&
        authRefreshAttempts < maxAuthRefresh &&
        /expired|invalid|unauthorized|access token/i.test(body)
      ) {
        authRefreshAttempts++;
        console.log(
          `[jobber] HTTP ${res.status} — refreshing access token (auth retry ${authRefreshAttempts}/${maxAuthRefresh})`,
        );
        token = await getAccessToken(env);
        if (tokenOut) tokenOut.current = token;
        continue;
      }
      throw new JobberClientError(
        `Jobber HTTP ${res.status}: ${body.slice(0, 300)}`,
      );
    }

    const payload = (await res.json()) as JobberResponse<T>;
    const errors = payload.errors ?? [];
    const throttled = errors.some(isThrottledError);

    if (throttled && attempt < maxRetries) {
      const waitMs = computeThrottleWaitMs(errors, backoffMs);
      console.log(
        `[jobber] throttled — waiting ${(waitMs / 1000).toFixed(1)}s before retry ${attempt + 1}/${maxRetries}`,
      );
      await sleep(waitMs);
      backoffMs *= 2;
      continue;
    }

    if (errors.length > 0) {
      throw new JobberClientError(
        `Jobber GraphQL errors: ${errors.map((e) => e.message).join("; ")}`,
        errors,
      );
    }

    if (!payload.data) {
      throw new JobberClientError("Jobber returned no data and no errors");
    }

    return payload.data;
  }

  throw new JobberClientError(
    "Jobber rate limit: still throttled after retries — wait a few minutes and run sync again",
  );
}
