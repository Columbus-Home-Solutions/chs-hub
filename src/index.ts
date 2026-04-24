/**
 * chs-hub Worker — operational hub backend.
 *
 * Routing strategy:
 *   Static assets (index.html, docs/*.md, etc.) are served directly by the
 *   Workers runtime before this Worker code runs. Anything that doesn't match
 *   a static asset falls through to this fetch handler, which either handles
 *   the request as an API route or delegates back to the static assets service
 *   (so SPA-style deep links still resolve to index.html).
 *
 * Bindings (see wrangler.toml):
 *   env.DB      — D1 database (chs-hub-db)
 *   env.FILES   — R2 bucket   (chs-hub-files)
 *   env.ASSETS  — static assets fetcher
 *
 * Secrets (set via `wrangler secret put`):
 *   env.JOBBER_CLIENT_ID / JOBBER_CLIENT_SECRET / JOBBER_REFRESH_TOKEN
 *   env.SYNC_TRIGGER_SECRET
 */

import type { Env } from "./env.js";
import { syncJobberToD1 } from "./lib/jobber/sync.js";
import { syncWorkbook } from "./lib/wc/sync.js";
import { handleDrill } from "./routes/drill.js";
import { handleJobDetail, handleJobsList } from "./routes/jobs.js";
import { handleKpis } from "./routes/kpis.js";
import { handleSearch } from "./routes/search.js";
import { handleSheetsInspect } from "./routes/sheets-debug.js";
import { handleJobberSync } from "./routes/sync.js";
import { handleWcSync } from "./routes/wc-sync.js";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return handleHealth(env);
    }

    if (url.pathname === "/api/kpis" && request.method === "GET") {
      const payload = await handleKpis(env);
      return jsonResponse(payload);
    }

    if (url.pathname === "/api/search" && request.method === "GET") {
      const payload = await handleSearch(env, url);
      return jsonResponse({ results: payload });
    }

    if (url.pathname === "/api/drill" && request.method === "GET") {
      try {
        const payload = await handleDrill(env, url);
        return jsonResponse(payload);
      } catch (err) {
        return jsonResponse(
          { error: "bad_request", message: (err as Error).message },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/sync/jobber" && request.method === "POST") {
      return handleJobberSync(request, env);
    }

    if (url.pathname === "/api/debug/sheets-inspect" && request.method === "GET") {
      return handleSheetsInspect(request, env);
    }

    if (url.pathname === "/api/wc/sync" && request.method === "POST") {
      return handleWcSync(request, env);
    }

    if (url.pathname === "/api/jobs" && request.method === "GET") {
      const payload = await handleJobsList(env, url);
      return jsonResponse(payload);
    }

    const jobDetail = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobDetail && request.method === "GET") {
      try {
        const payload = await handleJobDetail(env, decodeURIComponent(jobDetail[1]));
        return jsonResponse(payload);
      } catch (err) {
        const code = (err as { code?: number }).code ?? 500;
        return jsonResponse(
          { error: code === 404 ? "not_found" : "internal", message: (err as Error).message },
          { status: code === 404 ? 404 : 500 },
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "not_found", path: url.pathname }, { status: 404 });
    }

    // Hostname-based routing:
    //   dashboard.homesolutionsar.com  → /dashboard/* (Access-protected in CF)
    //   anything else (docs.*, workers.dev root) → /* (current docs site)
    // The dashboard host rewrites the URL so that "/" maps to
    // "/dashboard/index.html", letting the dashboard act as its own origin
    // without exposing the /dashboard/ prefix to the browser.
    const host = url.hostname;
    const isDashboardHost =
      host === "dashboard.homesolutionsar.com" ||
      host === "dash.homesolutionsar.com"; // legacy alias, harmless to keep
    if (isDashboardHost && !url.pathname.startsWith("/dashboard")) {
      const rewritten = new URL(request.url);
      rewritten.pathname = "/dashboard" + (url.pathname === "/" ? "/" : url.pathname);
      return env.ASSETS.fetch(new Request(rewritten.toString(), request));
    }

    return env.ASSETS.fetch(request);
  },

  // Scheduled handler — invoked by Cloudflare cron triggers (see wrangler.toml).
  // Runs the Jobber sync autonomously so the dashboard stays fresh without any
  // manual intervention.
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const stats = await syncJobberToD1(env);
          console.log(
            `[cron ${controller.cron}] jobber_full: ${stats.jobs_written} jobs in ${stats.duration_ms}ms`,
          );
        } catch (err) {
          console.error(
            `[cron ${controller.cron}] jobber_full failed:`,
            (err as Error).message,
          );
        }

        // WC sync piggybacks on the Jobber tick so the sheet always
        // reflects the freshest D1 state. Failures here are non-fatal.
        try {
          const wc = await syncWorkbook(env);
          console.log(
            `[cron ${controller.cron}] wc_sync: monthly=${wc.monthly.rows_written} weeks=${wc.kbpi.weeks_matched} in ${wc.duration_ms}ms ok=${wc.ok}`,
          );
          if (wc.errors.length > 0) {
            console.warn(`[cron ${controller.cron}] wc_sync errors:`, wc.errors);
          }
        } catch (err) {
          console.error(
            `[cron ${controller.cron}] wc_sync failed:`,
            (err as Error).message,
          );
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

async function handleHealth(env: Env): Promise<Response> {
  const startedAt = Date.now();
  const checks: {
    ok: boolean;
    timestamp: string;
    d1: { status: "connected" | "error"; latency_ms?: number; error?: string };
    r2: { status: "connected" | "error"; latency_ms?: number; error?: string };
    version: string;
  } = {
    ok: true,
    timestamp: new Date().toISOString(),
    d1: { status: "error" },
    r2: { status: "error" },
    version: "0.1.0",
  };

  try {
    const t0 = Date.now();
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (row?.ok !== 1) throw new Error("unexpected D1 response");
    checks.d1 = { status: "connected", latency_ms: Date.now() - t0 };
  } catch (err) {
    checks.ok = false;
    checks.d1 = { status: "error", error: (err as Error).message };
  }

  try {
    const t0 = Date.now();
    await env.FILES.head("__healthcheck__");
    checks.r2 = { status: "connected", latency_ms: Date.now() - t0 };
  } catch (err) {
    checks.ok = false;
    checks.r2 = { status: "error", error: (err as Error).message };
  }

  return jsonResponse(checks, {
    status: checks.ok ? 200 : 503,
    headers: { "x-total-ms": String(Date.now() - startedAt) },
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}
