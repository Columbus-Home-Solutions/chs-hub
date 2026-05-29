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
 *
 * Public dashboard vars (Cloudflare → Worker → Settings, optional in wrangler [vars]):
 *   DASHBOARD_OAUTH_CLIENT_ID (injected into dashboard/index.html — see
 *   src/lib/dashboard-inject.ts, docs/google-oauth-dashboard.md)
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
  handleDriveMirrorRun,
  handleDriveMirrorStatus,
  handleHeartbeatCheck,
  handleSummarySend,
} from "./routes/ops.js";
import { runDriveMirror } from "./lib/ops/drive-mirror.js";
import {
  handleActiveJobs,
  handlePhotoCreate,
  handlePhotoDelete,
  handlePhotoList,
  handlePhotoPatch,
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
import {
  handleFilesBackupDelete,
  handleFilesBackupDownload,
  handleFilesList,
} from "./routes/files.js";
import {
  handleCompanyDocumentCreate,
  handleCompanyDocumentDelete,
  handleCompanyDocumentFile,
  handleCompanyDocumentList,
  handleCompanyDocumentPatch,
} from "./routes/company-documents.js";
import {
  handleJobFileCreate,
  handleJobFileDelete,
  handleJobFileList,
  handleJobFilePatch,
  handleJobFileStream,
} from "./routes/job-files.js";
import { handleSheetsInspect } from "./routes/sheets-debug.js";
import { handleJobberSync, handleSyncNow } from "./routes/sync.js";
import {
  handleExpenseCreate,
  handleExpenseDelete,
  handleExpenseList,
  handleExpensePatch,
  handleExpenseReceipt,
  handleExpensePush,
} from "./routes/expenses.js";
import {
  handleJobberOAuthStart,
  handleJobberOAuthCallback,
  handleJobberStatus,
} from "./routes/oauth-jobber.js";
import { handleWcSync } from "./routes/wc-sync.js";
import { handleFileLinkCreate, handleFileLinkResolve } from "./routes/file-link.js";
import {
  handleSettingGet,
  handleSettingUpdate,
  handleSettingsList,
} from "./routes/settings.js";
import { handleMe } from "./routes/me.js";
import {
  handleClientCreate,
  handleClientGet,
  handleClientList,
  handleClientSummary,
  handleClientUpdate,
  handleCommunicationCreate,
  handleCommunicationList,
  handlePropertyCreate,
  handlePropertyList,
  handlePropertyUpdate,
} from "./routes/clients.js";
import {
  handleSubcontractorCreate,
  handleSubcontractorGet,
  handleSubcontractorList,
  handleSubcontractorUpdate,
} from "./routes/subcontractors.js";
import { maybeInjectDashboardHtml } from "./lib/dashboard-inject.js";

async function fetchAssetWithDashboardInject(
  env: Env,
  assetRequest: Request,
): Promise<Response> {
  const u = new URL(assetRequest.url);
  const res = await env.ASSETS.fetch(assetRequest);
  return maybeInjectDashboardHtml(env, u, assetRequest, res);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return handleHealth(env);
    }

    if (url.pathname === "/api/health/heartbeat" && request.method === "GET") {
      return handleHeartbeat(env);
    }

    if (url.pathname === "/api/kpis" && request.method === "GET") {
      const payload = await handleKpis(env);
      return jsonResponse(payload);
    }

    if (url.pathname === "/api/search" && request.method === "GET") {
      const payload = await handleSearch(env, url);
      return jsonResponse({ results: payload });
    }

    if (url.pathname === "/api/files/backup") {
      if (request.method === "GET" || request.method === "HEAD") {
        return handleFilesBackupDownload(env, url, request.method);
      }
      if (request.method === "DELETE") {
        return handleFilesBackupDelete(env, url);
      }
    }
    if (url.pathname === "/api/files" && request.method === "GET") {
      const items = await handleFilesList(env, url);
      return jsonResponse({ items });
    }

    if (url.pathname === "/api/file-link" && request.method === "POST") {
      return handleFileLinkCreate(env, request, url);
    }
    if (url.pathname === "/api/f") {
      if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
        return handleFileLinkResolve(env, request, url, request.method);
      }
    }

    if (url.pathname === "/api/company-documents") {
      if (request.method === "GET") return handleCompanyDocumentList(env, url);
      if (request.method === "POST") return handleCompanyDocumentCreate(env, request);
    }
    const companyFile = url.pathname.match(/^\/api\/company-documents\/([^/]+)\/file$/);
    if (companyFile && (request.method === "GET" || request.method === "HEAD")) {
      return handleCompanyDocumentFile(env, decodeURIComponent(companyFile[1]), request.method);
    }
    const companyById = url.pathname.match(/^\/api\/company-documents\/([^/]+)$/);
    if (companyById) {
      const cid = decodeURIComponent(companyById[1]);
      if (request.method === "DELETE") return handleCompanyDocumentDelete(env, cid);
      if (request.method === "PATCH") return handleCompanyDocumentPatch(env, cid, request);
    }

    if (url.pathname === "/api/job-files") {
      if (request.method === "GET") return handleJobFileList(env, url);
      if (request.method === "POST") return handleJobFileCreate(env, request);
    }
    const jobFileStream = url.pathname.match(/^\/api\/job-files\/([^/]+)\/file$/);
    if (jobFileStream && (request.method === "GET" || request.method === "HEAD")) {
      return handleJobFileStream(env, decodeURIComponent(jobFileStream[1]), request.method);
    }
    const jobFileById = url.pathname.match(/^\/api\/job-files\/([^/]+)$/);
    if (jobFileById) {
      const jfid = decodeURIComponent(jobFileById[1]);
      if (request.method === "DELETE") return handleJobFileDelete(env, jfid);
      if (request.method === "PATCH") return handleJobFilePatch(env, jfid, request);
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

    // ── Jobber OAuth (operator-facing self-serve re-auth) ───────────
    // Matches /oauth/jobber/* explicitly so the dashboard host rewrite
    // (further down) doesn't fold these into /dashboard/oauth/jobber/*.
    if (url.pathname === "/oauth/jobber/start" && request.method === "GET") {
      return handleJobberOAuthStart(env, request);
    }
    if (url.pathname === "/oauth/jobber/callback" && request.method === "GET") {
      return handleJobberOAuthCallback(env, request);
    }
    if (url.pathname === "/api/jobber/status" && request.method === "GET") {
      return handleJobberStatus(env);
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
    if (url.pathname === "/api/ops/drive-mirror" && request.method === "GET") {
      return handleDriveMirrorStatus(request, env);
    }
    if (url.pathname === "/api/ops/drive-mirror" && request.method === "POST") {
      return handleDriveMirrorRun(request, env);
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
    if (photoDetail) {
      const photoId = decodeURIComponent(photoDetail[1]);
      if (request.method === "GET" || request.method === "HEAD") {
        return handlePhotoStream(env, photoId, "original");
      }
      if (request.method === "DELETE") {
        return handlePhotoDelete(env, photoId);
      }
      if (request.method === "PATCH") {
        return handlePhotoPatch(env, photoId, request);
      }
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
    const expensePush = url.pathname.match(/^\/api\/expenses\/([^/]+)\/push-to-jobber$/);
    if (expensePush && request.method === "POST") {
      return handleExpensePush(env, decodeURIComponent(expensePush[1]));
    }
    const expenseById = url.pathname.match(/^\/api\/expenses\/([^/]+)$/);
    if (expenseById) {
      const eid = decodeURIComponent(expenseById[1]);
      if (request.method === "DELETE") return handleExpenseDelete(env, eid);
      if (request.method === "PATCH") return handleExpensePatch(env, eid, request);
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

    // ── Current user ─────────────────────────────────────────────────
    // /api/me and /api/users/me both resolve the Cloudflare Access identity.
    if (
      (url.pathname === "/api/me" || url.pathname === "/api/users/me") &&
      request.method === "GET"
    ) {
      return handleMe(request, env);
    }

    // ── Clients, properties, communications ──────────────────────────
    // Nested/sub-resource patterns must be tested before the bare :id route.
    if (url.pathname === "/api/clients") {
      if (request.method === "GET") return handleClientList(env, url);
      if (request.method === "POST") return handleClientCreate(request, env);
    }
    const clientProps = url.pathname.match(/^\/api\/clients\/([^/]+)\/properties$/);
    if (clientProps) {
      const cid = decodeURIComponent(clientProps[1]);
      if (request.method === "GET") return handlePropertyList(env, cid);
      if (request.method === "POST") return handlePropertyCreate(request, env, cid);
    }
    const clientComms = url.pathname.match(/^\/api\/clients\/([^/]+)\/communications$/);
    if (clientComms && request.method === "GET") {
      return handleCommunicationList(env, decodeURIComponent(clientComms[1]), url);
    }
    const clientSummary = url.pathname.match(/^\/api\/clients\/([^/]+)\/summary$/);
    if (clientSummary && request.method === "GET") {
      return handleClientSummary(env, decodeURIComponent(clientSummary[1]));
    }
    const clientById = url.pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (clientById) {
      const cid = decodeURIComponent(clientById[1]);
      if (request.method === "GET") return handleClientGet(env, cid);
      if (request.method === "PUT") return handleClientUpdate(request, env, cid);
    }
    const propertyById = url.pathname.match(/^\/api\/properties\/([^/]+)$/);
    if (propertyById && request.method === "PUT") {
      return handlePropertyUpdate(request, env, decodeURIComponent(propertyById[1]));
    }
    if (url.pathname === "/api/communications" && request.method === "POST") {
      return handleCommunicationCreate(request, env);
    }

    // ── Subcontractors (CHS platform schema; coexists with /api/subs) ─
    if (url.pathname === "/api/subcontractors") {
      if (request.method === "GET") return handleSubcontractorList(env, url);
      if (request.method === "POST") return handleSubcontractorCreate(request, env);
    }
    const subcontractorById = url.pathname.match(/^\/api\/subcontractors\/([^/]+)$/);
    if (subcontractorById) {
      const sid = decodeURIComponent(subcontractorById[1]);
      if (request.method === "GET") return handleSubcontractorGet(env, sid);
      if (request.method === "PUT") return handleSubcontractorUpdate(request, env, sid);
    }

    // ── System settings ──────────────────────────────────────────────
    if (url.pathname === "/api/settings" && request.method === "GET") {
      return handleSettingsList(env);
    }
    const settingByKey = url.pathname.match(/^\/api\/settings\/([^/]+)$/);
    if (settingByKey) {
      const key = decodeURIComponent(settingByKey[1]);
      if (request.method === "GET") return handleSettingGet(env, key);
      if (request.method === "PUT") return handleSettingUpdate(request, env, key);
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "not_found", path: url.pathname }, { status: 404 });
    }

    // ── New Preact app (Sprint 2+) ───────────────────────────────────
    // Built by Vite into ./app and served at /app. Handled before the
    // dashboard-host rewrite so it resolves on every host. Deep links
    // (e.g. /app/clients/123) fall back to the app's index.html so the
    // client-side router can take over.
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      return serveApp(env, request, url);
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
      return fetchAssetWithDashboardInject(
        env,
        new Request(rewritten.toString(), request),
      );
    }

    return fetchAssetWithDashboardInject(env, request);
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
      `[cron ${cron}] jobber_full: ${stats.jobs_written} jobs, ${stats.jobber_job_files_written} jobber files, ${stats.duration_ms}ms`,
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

  try {
    const dm = await runDriveMirror(env);
    if (dm.skipped) {
      console.log(
        `[cron 15 * * * *] drive_mirror skipped: ${dm.reason ?? "unknown"}`,
      );
    } else if (
      dm.photos + dm.expenses + dm.job_files + dm.company + dm.job_folder_stubs > 0 ||
      dm.errors.length > 0
    ) {
      console.log(
        `[cron 15 * * * *] drive_mirror: stubs=${dm.job_folder_stubs} photos=${dm.photos} expenses=${dm.expenses} job_files=${dm.job_files} company=${dm.company} err=${dm.errors.length} ms=${dm.duration_ms}`,
      );
    }
    if (dm.errors.length > 0) {
      console.warn(`[cron 15 * * * *] drive_mirror errors:`, dm.errors);
    }
  } catch (err) {
    console.error(`[cron 15 * * * *] drive_mirror failed:`, (err as Error).message);
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
    /** True when Worker has a non-empty DASHBOARD_OAUTH_CLIENT_ID (dashboard Connect Google). */
    dashboard_oauth_client_id_configured: boolean;
    version: string;
  } = {
    ok: true,
    timestamp: new Date().toISOString(),
    d1: { status: "error" },
    r2: { status: "error" },
    dashboard_oauth_client_id_configured: Boolean(
      env.DASHBOARD_OAUTH_CLIENT_ID && String(env.DASHBOARD_OAUTH_CLIENT_ID).trim() !== "",
    ),
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

// GET /api/health/heartbeat — lightweight readiness probe for the CHS
// platform. Confirms D1 connectivity, reports how many of the 40 unified-schema
// tables are present, and the number of seeded system settings.
const PLATFORM_TABLES = [
  "users", "system_settings", "audit_logs", "integration_connections",
  "clients", "properties", "communications",
  "estimate_requests", "estimates", "estimate_line_items", "estimate_sub_items",
  "payment_schedules", "estimate_templates", "saved_reviews",
  "jobs", "tasks", "daily_logs", "change_orders", "schedule_entries", "permits", "warranties",
  "invoices", "payments", "expenses", "time_entries", "billing_cycles", "mileage",
  "lien_waivers", "vendor_materials",
  "photos", "receipt_photos", "documents", "document_templates",
  "notification_templates", "notification_logs",
  "social_posts", "content_schedules",
  "subcontractors", "smart_notes", "dead_letter_queue",
];

async function handleHeartbeat(env: Env): Promise<Response> {
  try {
    const placeholders = PLATFORM_TABLES.map(() => "?").join(",");
    const tableRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    )
      .bind(...PLATFORM_TABLES)
      .first<{ n: number }>();
    const settingsRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM system_settings",
    ).first<{ n: number }>();

    return jsonResponse({
      status: "ok",
      timestamp: new Date().toISOString(),
      tables: tableRow?.n ?? 0,
      tables_expected: PLATFORM_TABLES.length,
      settings: settingsRow?.n ?? 0,
    });
  } catch (err) {
    return jsonResponse(
      { status: "error", timestamp: new Date().toISOString(), error: (err as Error).message },
      { status: 503 },
    );
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

/**
 * Serve the Vite-built Preact app (public/app, served at /app). Tries the requested asset first;
 * for navigations that don't map to a real file (SPA deep links) it falls back
 * to /app/index.html so preact-router can resolve the route client-side.
 */
async function serveApp(env: Env, request: Request, url: URL): Promise<Response> {
  const direct = await env.ASSETS.fetch(request);
  if (direct.status !== 404) return direct;

  // Only fall back for navigation requests (no file extension in the last
  // path segment) — missing JS/CSS/images should keep their 404.
  const lastSegment = url.pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return direct;

  const indexUrl = new URL(request.url);
  indexUrl.pathname = "/app/index.html";
  return env.ASSETS.fetch(new Request(indexUrl.toString(), { method: "GET" }));
}
