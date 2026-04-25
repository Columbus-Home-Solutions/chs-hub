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
import { runBackup } from "./lib/ops/backup.js";
import { sendDailySummary } from "./lib/ops/daily-summary.js";
import { replayDeadLetters } from "./lib/ops/dlq.js";
import { checkHeartbeat } from "./lib/ops/heartbeat.js";
import { syncWorkbook } from "./lib/wc/sync.js";
import { handleDrill } from "./routes/drill.js";
import { handleHLProxy } from "./routes/hl.js";
import { handleJobDetail, handleJobsList } from "./routes/jobs.js";
import { handleKpis } from "./routes/kpis.js";
import {
  handleNoteCreate,
  handleNoteDelete,
  handleNoteGet,
  handleNoteList,
  handleNotePatch,
} from "./routes/notes.js";
import {
  handleAlertTest,
  handleBackupLatest,
  handleBackupRun,
  handleDlqReplay,
  handleDlqSummary,
  handleHeartbeatCheck,
  handleSummarySend,
} from "./routes/ops.js";
import {
  handleActiveJobs,
  handlePhotoCreate,
  handlePhotoList,
  handlePhotoStream,
} from "./routes/photos.js";
import {
  handleSubCreate,
  handleSubDelete,
  handleSubGet,
  handleSubList,
  handleSubPatch,
} from "./routes/subs.js";
import { handleSearch } from "./routes/search.js";
import { handleSheetsInspect } from "./routes/sheets-debug.js";
import { handleJobberSync, handleSyncNow } from "./routes/sync.js";
import {
  handleExpenseCreate,
  handleExpenseList,
  handleExpenseReceipt,
} from "./routes/expenses.js";
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

    if (url.pathname === "/api/sync/now" && request.method === "POST") {
      return handleSyncNow(request, env);
    }

    if (url.pathname === "/api/debug/sheets-inspect" && request.method === "GET") {
      return handleSheetsInspect(request, env);
    }

    if (url.pathname === "/api/wc/sync" && request.method === "POST") {
      return handleWcSync(request, env);
    }

    // ── Ops / reliability routes ─────────────────────────────────────
    // All gated by SYNC_TRIGGER_SECRET. See src/routes/ops.ts.
    if (url.pathname === "/api/ops/heartbeat" && request.method === "GET") {
      return handleHeartbeatCheck(request, env);
    }
    if (url.pathname === "/api/ops/dlq" && request.method === "GET") {
      return handleDlqSummary(request, env);
    }
    if (url.pathname === "/api/ops/dlq/replay" && request.method === "POST") {
      return handleDlqReplay(request, env);
    }
    if (url.pathname === "/api/ops/backup" && request.method === "POST") {
      return handleBackupRun(request, env);
    }
    if (url.pathname === "/api/ops/backup/latest" && request.method === "GET") {
      return handleBackupLatest(request, env);
    }
    if (url.pathname === "/api/ops/summary" && request.method === "POST") {
      return handleSummarySend(request, env);
    }
    if (url.pathname === "/api/ops/alert-test" && request.method === "POST") {
      return handleAlertTest(request, env);
    }

    if (url.pathname === "/api/jobs" && request.method === "GET") {
      const payload = await handleJobsList(env, url);
      return jsonResponse(payload);
    }

    // /api/jobs/active must match BEFORE the /api/jobs/:id regex below,
    // otherwise "active" is treated as a Jobber job ID.
    if (url.pathname === "/api/jobs/active" && request.method === "GET") {
      return handleActiveJobs(env);
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

    // ── Photos (PWA capture) ─────────────────────────────────────────
    if (url.pathname === "/api/photos") {
      if (request.method === "POST") return handlePhotoCreate(env, request);
      if (request.method === "GET") return handlePhotoList(env, url);
    }
    // /thumb suffix must match BEFORE the bare :id pattern.
    // HEAD is accepted alongside GET so probing tools (curl -I, SW caches)
    // get the right status; Workers auto-strips the body on HEAD responses.
    const photoThumb = url.pathname.match(/^\/api\/photos\/([^/]+)\/thumb$/);
    if (photoThumb && (request.method === "GET" || request.method === "HEAD")) {
      return handlePhotoStream(env, decodeURIComponent(photoThumb[1]), "thumb");
    }
    const photoDetail = url.pathname.match(/^\/api\/photos\/([^/]+)$/);
    if (photoDetail && (request.method === "GET" || request.method === "HEAD")) {
      return handlePhotoStream(env, decodeURIComponent(photoDetail[1]), "original");
    }

    // ── Expenses (PWA capture) ───────────────────────────────────────
    if (url.pathname === "/api/expenses") {
      if (request.method === "POST") return handleExpenseCreate(env, request);
      if (request.method === "GET") return handleExpenseList(env, url);
    }
    const expenseReceipt = url.pathname.match(/^\/api\/expenses\/([^/]+)\/receipt$/);
    if (expenseReceipt && (request.method === "GET" || request.method === "HEAD")) {
      return handleExpenseReceipt(env, decodeURIComponent(expenseReceipt[1]));
    }

    // ── Smart Notes ──────────────────────────────────────────────────
    if (url.pathname === "/api/notes") {
      if (request.method === "POST") return handleNoteCreate(env, request);
      if (request.method === "GET") return handleNoteList(env, url);
    }
    const noteMatch = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
    if (noteMatch) {
      const id = decodeURIComponent(noteMatch[1]);
      if (request.method === "GET") return handleNoteGet(env, id);
      if (request.method === "PATCH") return handleNotePatch(env, id, request);
      if (request.method === "DELETE") return handleNoteDelete(env, id);
    }

    // ── Subcontractor reference list ─────────────────────────────────
    if (url.pathname === "/api/subs") {
      if (request.method === "POST") return handleSubCreate(env, request);
      if (request.method === "GET") return handleSubList(env, url);
    }
    const subMatch = url.pathname.match(/^\/api\/subs\/([^/]+)$/);
    if (subMatch) {
      const id = decodeURIComponent(subMatch[1]);
      if (request.method === "GET") return handleSubGet(env, id);
      if (request.method === "PATCH") return handleSubPatch(env, id, request);
      if (request.method === "DELETE") return handleSubDelete(env, id);
    }

    // ── HighLevel API proxy ──────────────────────────────────────────
    // Forwards /api/hl/* to services.leadconnectorhq.com with the PIT
    // attached server-side. Keeps the token off the client + dodges CORS.
    if (url.pathname.startsWith("/api/hl/")) {
      return handleHLProxy(env, request, url);
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
  //
  // We have four cron schedules (as of the Phase 7 reliability pass):
  //
  //   "*/30 * * * *"  → Jobber sync + WC workbook export
  //   "15 * * * *"    → heartbeat check + DLQ replay
  //   "15 7 * * *"    → nightly D1 → R2 backup + 30-day retention sweep
  //   "0 12 * * *"    → daily summary email (7 AM Central)
  //
  // Cloudflare passes the literal cron string in controller.cron, which we
  // dispatch on. Anything not recognised falls through to the legacy
  // every-30-min path so accidental cron additions don't disable the sync.
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const cron = controller.cron;
    ctx.waitUntil(dispatchCron(cron, env));
  },
} satisfies ExportedHandler<Env>;

async function dispatchCron(cron: string, env: Env): Promise<void> {
  switch (cron) {
    case "15 * * * *":
      await runHourly(env);
      return;
    case "15 7 * * *":
      await runNightly(env);
      return;
    case "0 12 * * *":
      await runMorning(env);
      return;
    case "*/30 * * * *":
    default:
      await runJobberTick(cron, env);
      return;
  }
}

async function runJobberTick(cron: string, env: Env): Promise<void> {
  try {
    const stats = await syncJobberToD1(env);
    console.log(
      `[cron ${cron}] jobber_full: ${stats.jobs_written} jobs in ${stats.duration_ms}ms`,
    );
  } catch (err) {
    console.error(`[cron ${cron}] jobber_full failed:`, (err as Error).message);
  }

  // WC sync piggybacks on the Jobber tick so the sheet always reflects
  // the freshest D1 state. Failures here are non-fatal.
  try {
    const wc = await syncWorkbook(env);
    console.log(
      `[cron ${cron}] wc_sync: monthly=${wc.monthly.rows_written} weeks=${wc.kbpi.weeks_matched} in ${wc.duration_ms}ms ok=${wc.ok}`,
    );
    if (wc.errors.length > 0) {
      console.warn(`[cron ${cron}] wc_sync errors:`, wc.errors);
    }
  } catch (err) {
    console.error(`[cron ${cron}] wc_sync failed:`, (err as Error).message);
  }
}

async function runHourly(env: Env): Promise<void> {
  try {
    const hb = await checkHeartbeat(env);
    console.log(
      `[cron 15 * * * *] heartbeat: healthy=${hb.healthy} age_ms=${hb.age_ms ?? "null"} alerted=${hb.alerted}`,
    );
  } catch (err) {
    console.error(`[cron 15 * * * *] heartbeat failed:`, (err as Error).message);
  }

  try {
    const replay = await replayDeadLetters(env);
    console.log(
      `[cron 15 * * * *] dlq_replay: picked=${replay.picked} ok=${replay.succeeded} fail=${replay.failed} alerted=${replay.alerted}`,
    );
    if (replay.errors.length > 0) {
      console.warn(`[cron 15 * * * *] dlq_replay errors:`, replay.errors);
    }
  } catch (err) {
    console.error(`[cron 15 * * * *] dlq_replay failed:`, (err as Error).message);
  }
}

async function runNightly(env: Env): Promise<void> {
  try {
    const result = await runBackup(env);
    console.log(
      `[cron 15 7 * * *] backup: ok=${result.ok} key=${result.key} rows=${result.total_rows} size_kb=${Math.round(result.size_bytes / 1024)} retention_deleted=${result.retention_deleted} duration_ms=${result.duration_ms}`,
    );
  } catch (err) {
    console.error(`[cron 15 7 * * *] backup failed:`, (err as Error).message);
  }
}

async function runMorning(env: Env): Promise<void> {
  try {
    const { sent } = await sendDailySummary(env);
    console.log(`[cron 0 12 * * *] daily_summary: sent=${sent}`);
  } catch (err) {
    console.error(`[cron 0 12 * * *] daily_summary failed:`, (err as Error).message);
  }
}

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
