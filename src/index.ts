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
import { runWcSpreadsheetSync, getWcStatus } from "./services/wc-spreadsheet.js";
import { runQboSweep, getQboStatus } from "./lib/qbo-sync.js";
import {
  handleIntegrationsList,
  handleIntegrationDetail,
  handleQboConnect,
  handleQboCallback,
  handleQboDisconnect,
  handleQboTest,
  handleQboReference,
  handleQboMapping,
  handleQboStatus,
  handleQboSync,
} from "./routes/integrations.js";
import {
  handleWcSpreadsheetSync,
  handleWcSpreadsheetStatus,
} from "./routes/wc-spreadsheet.js";
import { handleDrill } from "./routes/drill.js";
import { handleHLProxy } from "./routes/hl.js";
import { handleJobDetail as handleLegacyJobDetail, handleJobsList as handleLegacyJobsList } from "./routes/jobs.js";
import {
  handleJobList,
  handleJobPipeline,
  handleJobDetail,
  handleJobUpdate,
  handleJobStatus,
  handleJobReverseConversion,
  handleTaskList,
  handleTaskCreate,
  handleTaskUpdate,
  handleTaskComplete,
} from "./routes/jobs-api.js";
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
  handlePhotoBatch,
  handlePhotoDelete,
  handlePhotoList,
  handlePhotoPatch,
  handlePhotoPut,
  handlePhotoMeta,
  handlePhotoStream,
  handlePhotoAnnotate,
  handleJobPhotos,
  handleReceiptCreate,
  handleReceiptGet,
  handleReceiptConfirm,
} from "./routes/photos.js";
import {
  handleSmartNoteCreate,
  handleSmartNoteList,
  handleSmartNoteGet,
  handleSmartNoteProcess,
  handleSmartNoteAcceptTask,
  handleSmartNoteAcceptExpense,
  handleSmartNoteAcceptChangeOrder,
} from "./routes/smart-notes.js";
import {
  handleDailyLogList,
  handleDailyLogCreate,
  handleDailyLogUpdate,
} from "./routes/daily-logs.js";
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
  handleExpenseCreateJson,
  handleExpenseUpdate,
  handleExpenseDelete,
  handleFullExpenseList,
  handleJobExpenses,
  handleExpensePatch,
  handleExpenseReceipt,
  handleExpensePush,
} from "./routes/expenses.js";
import {
  handleTimeEntryClockIn,
  handleTimeEntryUpdate,
  handleJobTimeEntries,
  handleActiveTimeEntries,
} from "./routes/time-entries.js";
import {
  handleMileageList,
  handleMileageCreate,
  handleMileageUpdate,
} from "./routes/mileage.js";
import {
  handleVendorMaterialList,
  handleVendorMaterialCreate,
  handleVendorMaterialUpdate,
} from "./routes/vendor-materials.js";
import { handleJobCosting } from "./routes/costing.js";
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
import { handleMe, handleClockableUsers } from "./routes/me.js";
import {
  handleClientCreate,
  handleClientGet,
  handleClientList,
  handleClientSummary,
  handleClientUpdate,
  handleCommunicationCreate,
  handleCommunicationList,
  handleJobCommunicationList,
  handlePropertyCreate,
  handlePropertyList,
  handlePropertyUpdate,
} from "./routes/clients.js";
import {
  handleTemplateList as handleNotifTemplateList,
  handleTemplateGet as handleNotifTemplateGet,
  handleTemplateUpdate as handleNotifTemplateUpdate,
  handleTemplatePreview,
  handleTemplateTest,
  handleLogList as handleNotifLogList,
  handleLogRetry as handleNotifLogRetry,
  handleInbox,
  handleInboxRead,
  handleInboxReadAll,
} from "./routes/notifications.js";
import { handleTwilioInbound, handleTwilioStatus } from "./routes/webhooks-twilio.js";
import { processNotifications } from "./lib/notification-engine.js";
import { runLateFeeCalculator, runInvoiceDueCheck } from "./lib/invoicing.js";
import {
  handleSubcontractorCreate,
  handleSubcontractorGet,
  handleSubcontractorList,
  handleSubcontractorUpdate,
} from "./routes/subcontractors.js";
import {
  handleEstimateRequestList,
  handleEstimateRequestPipeline,
  handleEstimateRequestGet,
  handleEstimateRequestCreate,
  handleEstimateRequestUpdate,
  handleEstimateRequestAppointment,
  handleEstimateRequestLost,
  handleEstimateRequestWin,
} from "./routes/estimate-requests.js";
import {
  handleEstimateList,
  handleEstimateGet,
  handleEstimateCreate,
  handleEstimateUpdate,
  handleEstimateSend,
  handleEstimateRevise,
  handleEstimateLost,
  handleLineItemList,
  handleLineItemCreate,
  handleLineItemUpdate,
  handleLineItemDelete,
  handleLineItemReorder,
  handleSubItemCreate,
  handleSubItemUpdate,
  handleSubItemDelete,
  handlePaymentScheduleGet,
  handlePaymentScheduleReplace,
  handleTemplateList,
  handleTemplateGet,
  handleTemplateCreate,
  handleTemplateUpdate,
  handleApplyTemplate,
  handleReviewList,
  handleReviewCreate,
  handleReviewUpdate,
  handleReviewDelete,
  handleMaterialSearch,
} from "./routes/estimates.js";
import {
  handlePublicQuoteGet,
  handlePublicQuoteSign,
  handlePublicQuoteRequestChanges,
  handlePublicQuotePayIntent,
  handlePublicQuotePayCheck,
  handleStripeWebhook,
} from "./routes/public-quote.js";
import {
  handleInvoiceList,
  handleInvoiceGet,
  handleInvoiceCreate,
  handleInvoiceUpdate,
  handleInvoiceSend,
  handleInvoiceVoid,
  handleJobInvoices,
} from "./routes/invoices.js";
import { handlePaymentList, handlePaymentCreate, handleJobPayments } from "./routes/payments.js";
import {
  handleCycleList,
  handleCycleGet,
  handleCycleCreate,
  handleCycleUpdate,
  handleCycleGenerateInvoice,
  handleCycleReconcile,
  handleCycleBillFinal,
} from "./routes/billing-cycles.js";
import { handlePublicPayGet, handlePublicPayIntent } from "./routes/public-pay.js";
import { handlePortalApi } from "./routes/portal.js";
import {
  handleJobChangeOrders,
  handleChangeOrderCreate,
  handleChangeOrderUpdate,
  handleChangeOrderSend,
  handleChangeOrderReject,
} from "./routes/change-orders.js";
import {
  handleJobSchedule,
  handleScheduleFeed,
  handleScheduleCreate,
  handleScheduleUpdate,
  handleScheduleDelete,
} from "./routes/schedule.js";
import {
  handleJobPermits,
  handlePermitCreate,
  handlePermitUpdate,
  handlePermitDelete,
} from "./routes/permits.js";
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

    // ── Public-host routing guard (Sprint 9 hotfix) ──────────────────────
    // client.homesolutionsar.com is a NON-Access custom domain that serves ONLY
    // the token-gated public surface: the pay/quote SPA shells, their public
    // APIs, and the Stripe webhook. Everything else — the internal /app SPA, the
    // full authenticated /api surface, ops/debug/health routes — must 404 here so
    // an open hostname can never reach internal data. The token is the security
    // boundary (unguessable random per-invoice/quote), so no Access is needed.
    //
    // Additive: fires ONLY on this host. dashboard.* and *.workers.dev fall
    // through to the existing handler completely unchanged.
    //
    // /app/assets/* IS allowed: the public pay.html / quote.html shells load
    // their JS/CSS bundles from /app/assets/ (without it the pages render blank).
    // The /app entry itself (/app, /app/index.html) is NOT on the allowlist, so
    // the internal dashboard SPA stays unreachable on this host.
    if (url.hostname === "client.homesolutionsar.com") {
      const p = url.pathname;
      const allowed =
        p === "/pay" || p.startsWith("/pay/") ||
        p === "/quote" || p.startsWith("/quote/") ||
        p === "/portal" || p.startsWith("/portal/") ||
        p.startsWith("/app/assets/") ||
        p.startsWith("/api/public/pay/") ||
        p.startsWith("/api/public/quote/") ||
        p.startsWith("/api/portal/") ||
        p === "/api/webhooks/stripe";
      if (!allowed) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/health") {
      return handleHealth(env);
    }

    if (url.pathname === "/api/health/heartbeat" && request.method === "GET") {
      return handleHeartbeat(env);
    }

    // ── Public quote delivery + Stripe webhook (Sprint 5) ────────────
    // UNAUTHENTICATED on purpose: gated only by the estimate's portal_token
    // (or, for the webhook, the Stripe signature). No guard()/Access here.
    // Matched early so the token paths never fall through to auth'd routes.
    if (url.pathname === "/api/webhooks/stripe" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }
    // Inbound Twilio (SMS + delivery status). PUBLIC — gated only by the Twilio
    // signature, like the Stripe webhook. Matched early so they never fall
    // through to the auth'd routes / Cloudflare Access.
    if (url.pathname === "/api/webhooks/twilio/inbound" && request.method === "POST") {
      return handleTwilioInbound(request, env);
    }
    if (url.pathname === "/api/webhooks/twilio/status" && request.method === "POST") {
      return handleTwilioStatus(request, env);
    }
    const pqSign = url.pathname.match(/^\/api\/public\/quote\/([^/]+)\/sign$/);
    if (pqSign && request.method === "POST") {
      return handlePublicQuoteSign(request, env, decodeURIComponent(pqSign[1]));
    }
    const pqChanges = url.pathname.match(/^\/api\/public\/quote\/([^/]+)\/request-changes$/);
    if (pqChanges && request.method === "POST") {
      return handlePublicQuoteRequestChanges(request, env, decodeURIComponent(pqChanges[1]));
    }
    const pqPayIntent = url.pathname.match(/^\/api\/public\/quote\/([^/]+)\/pay\/intent$/);
    if (pqPayIntent && request.method === "POST") {
      return handlePublicQuotePayIntent(request, env, decodeURIComponent(pqPayIntent[1]));
    }
    const pqPayCheck = url.pathname.match(/^\/api\/public\/quote\/([^/]+)\/pay\/check$/);
    if (pqPayCheck && request.method === "POST") {
      return handlePublicQuotePayCheck(request, env, decodeURIComponent(pqPayCheck[1]));
    }
    const pqGet = url.pathname.match(/^\/api\/public\/quote\/([^/]+)$/);
    if (pqGet && request.method === "GET") {
      return handlePublicQuoteGet(env, decodeURIComponent(pqGet[1]));
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

    // ── Integrations / QuickBooks Online (Sprint 14) ─────────────────
    if (url.pathname === "/api/integrations" && request.method === "GET") {
      return handleIntegrationsList(request, env);
    }
    if (url.pathname === "/api/integrations/quickbooks/connect" && request.method === "POST") {
      return handleQboConnect(request, env);
    }
    // Callback is Access-gated (browser redirect); matched before the generic
    // /api/integrations/:service detail route.
    if (url.pathname === "/api/integrations/quickbooks/callback" && request.method === "GET") {
      return handleQboCallback(request, env);
    }
    if (url.pathname === "/api/integrations/quickbooks/disconnect" && request.method === "POST") {
      return handleQboDisconnect(request, env);
    }
    if (url.pathname === "/api/integrations/quickbooks/test" && request.method === "POST") {
      return handleQboTest(request, env);
    }
    if (url.pathname === "/api/integrations/quickbooks/reference" && request.method === "GET") {
      return handleQboReference(request, env);
    }
    if (url.pathname === "/api/integrations/quickbooks/mapping" && request.method === "POST") {
      return handleQboMapping(request, env);
    }
    const integrationDetail = url.pathname.match(/^\/api\/integrations\/([^/]+)$/);
    if (integrationDetail && request.method === "GET") {
      return handleIntegrationDetail(request, env, decodeURIComponent(integrationDetail[1]));
    }
    if (url.pathname === "/api/quickbooks/status" && request.method === "GET") {
      return handleQboStatus(request, env);
    }
    if (url.pathname === "/api/quickbooks/sync" && request.method === "POST") {
      return handleQboSync(request, env);
    }

    // ── WC Spreadsheet (Sprint 14 rebuild) ───────────────────────────
    if (url.pathname === "/api/wc-spreadsheet/sync" && request.method === "POST") {
      return handleWcSpreadsheetSync(request, env);
    }
    if (url.pathname === "/api/wc-spreadsheet/status" && request.method === "GET") {
      return handleWcSpreadsheetStatus(request, env);
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

    // ── Legacy Jobber jobs view (old dashboard at dashboard.* host) ──
    // The native Job Management API (Sprint 6) owns /api/jobs; the legacy
    // Jobber-rollup list/detail the old dashboard reads lives under
    // /api/legacy/jobs so the two coexist without shape conflicts.
    if (url.pathname === "/api/legacy/jobs" && request.method === "GET") {
      const payload = await handleLegacyJobsList(env, url);
      return jsonResponse(payload);
    }
    const legacyJobDetail = url.pathname.match(/^\/api\/legacy\/jobs\/([^/]+)$/);
    if (legacyJobDetail && request.method === "GET") {
      try {
        const payload = await handleLegacyJobDetail(env, decodeURIComponent(legacyJobDetail[1]));
        return jsonResponse(payload);
      } catch (err) {
        const code = (err as { code?: number }).code ?? 500;
        return jsonResponse(
          { error: code === 404 ? "not_found" : "internal", message: (err as Error).message },
          { status: code === 404 ? 404 : 500 },
        );
      }
    }

    // ── Native Job Management (Sprint 6) ─────────────────────────────
    // Fixed/sub-resource paths before the bare :id route.
    if (url.pathname === "/api/jobs" && request.method === "GET") {
      return handleJobList(env, url);
    }
    if (url.pathname === "/api/jobs/pipeline" && request.method === "GET") {
      return handleJobPipeline(env);
    }
    // /api/jobs/active (legacy capture PWA) must match before /api/jobs/:id.
    if (url.pathname === "/api/jobs/active" && request.method === "GET") {
      return handleActiveJobs(env);
    }
    const jobTasks = url.pathname.match(/^\/api\/jobs\/([^/]+)\/tasks$/);
    if (jobTasks) {
      const jid = decodeURIComponent(jobTasks[1]);
      if (request.method === "GET") return handleTaskList(env, jid, url);
      if (request.method === "POST") return handleTaskCreate(request, env, jid);
    }
    const jobStatus = url.pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
    if (jobStatus && request.method === "PUT") {
      return handleJobStatus(request, env, decodeURIComponent(jobStatus[1]));
    }
    const jobReverse = url.pathname.match(/^\/api\/jobs\/([^/]+)\/reverse-conversion$/);
    if (jobReverse && request.method === "POST") {
      return handleJobReverseConversion(request, env, decodeURIComponent(jobReverse[1]));
    }
    const jobComms = url.pathname.match(/^\/api\/jobs\/([^/]+)\/communications$/);
    if (jobComms && request.method === "GET") {
      return handleJobCommunicationList(env, decodeURIComponent(jobComms[1]), url);
    }
    // Photo timeline per job (Sprint 8).
    const jobPhotos = url.pathname.match(/^\/api\/jobs\/([^/]+)\/photos$/);
    if (jobPhotos && request.method === "GET") {
      return handleJobPhotos(env, decodeURIComponent(jobPhotos[1]), url);
    }
    // Invoices + payments per job (Sprint 9).
    const jobInvoices = url.pathname.match(/^\/api\/jobs\/([^/]+)\/invoices$/);
    if (jobInvoices && request.method === "GET") {
      return handleJobInvoices(env, decodeURIComponent(jobInvoices[1]));
    }
    const jobPayments = url.pathname.match(/^\/api\/jobs\/([^/]+)\/payments$/);
    if (jobPayments && request.method === "GET") {
      return handleJobPayments(request, env, decodeURIComponent(jobPayments[1]));
    }
    // Daily logs per job (Sprint 8).
    const jobDailyLogs = url.pathname.match(/^\/api\/jobs\/([^/]+)\/daily-logs$/);
    if (jobDailyLogs) {
      const jid = decodeURIComponent(jobDailyLogs[1]);
      if (request.method === "GET") return handleDailyLogList(env, jid);
      if (request.method === "POST") return handleDailyLogCreate(env, request, jid);
    }
    // Expenses + job costing + time entries per job (Sprint 10).
    const jobExpenses = url.pathname.match(/^\/api\/jobs\/([^/]+)\/expenses$/);
    if (jobExpenses && request.method === "GET") {
      return handleJobExpenses(env, decodeURIComponent(jobExpenses[1]), url);
    }
    const jobCosting = url.pathname.match(/^\/api\/jobs\/([^/]+)\/costing$/);
    if (jobCosting && request.method === "GET") {
      return handleJobCosting(env, decodeURIComponent(jobCosting[1]));
    }
    // Cost-plus billing cycles per job (Sprint 11).
    const jobCycles = url.pathname.match(/^\/api\/jobs\/([^/]+)\/billing-cycles$/);
    if (jobCycles) {
      const jid = decodeURIComponent(jobCycles[1]);
      if (request.method === "GET") return handleCycleList(env, jid);
      if (request.method === "POST") return handleCycleCreate(request, env, jid);
    }
    const jobTimeEntries = url.pathname.match(/^\/api\/jobs\/([^/]+)\/time-entries$/);
    if (jobTimeEntries && request.method === "GET") {
      return handleJobTimeEntries(env, decodeURIComponent(jobTimeEntries[1]));
    }
    // Change orders per job (Sprint 13).
    const jobChangeOrders = url.pathname.match(/^\/api\/jobs\/([^/]+)\/change-orders$/);
    if (jobChangeOrders) {
      const jid = decodeURIComponent(jobChangeOrders[1]);
      if (request.method === "GET") return handleJobChangeOrders(env, jid);
      if (request.method === "POST") return handleChangeOrderCreate(request, env, jid);
    }
    // Schedule entries per job (Sprint 13).
    const jobSchedule = url.pathname.match(/^\/api\/jobs\/([^/]+)\/schedule$/);
    if (jobSchedule) {
      const jid = decodeURIComponent(jobSchedule[1]);
      if (request.method === "GET") return handleJobSchedule(env, jid);
      if (request.method === "POST") return handleScheduleCreate(request, env, jid);
    }
    // Permits per job (Sprint 13).
    const jobPermits = url.pathname.match(/^\/api\/jobs\/([^/]+)\/permits$/);
    if (jobPermits) {
      const jid = decodeURIComponent(jobPermits[1]);
      if (request.method === "GET") return handleJobPermits(env, jid);
      if (request.method === "POST") return handlePermitCreate(request, env, jid);
    }
    const jobById = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobById) {
      const jid = decodeURIComponent(jobById[1]);
      if (request.method === "GET") return handleJobDetail(env, jid);
      if (request.method === "PUT") return handleJobUpdate(request, env, jid);
    }
    const taskById = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskById && request.method === "PUT") {
      return handleTaskUpdate(request, env, decodeURIComponent(taskById[1]));
    }
    const taskComplete = url.pathname.match(/^\/api\/tasks\/([^/]+)\/complete$/);
    if (taskComplete && request.method === "PUT") {
      return handleTaskComplete(request, env, decodeURIComponent(taskComplete[1]));
    }

    // ── Invoices (Sprint 9) ──────────────────────────────────────────
    if (url.pathname === "/api/invoices") {
      if (request.method === "GET") return handleInvoiceList(env, url);
      if (request.method === "POST") return handleInvoiceCreate(request, env);
    }
    const invoiceSend = url.pathname.match(/^\/api\/invoices\/([^/]+)\/send$/);
    if (invoiceSend && request.method === "POST") {
      return handleInvoiceSend(request, env, decodeURIComponent(invoiceSend[1]));
    }
    const invoiceVoid = url.pathname.match(/^\/api\/invoices\/([^/]+)\/void$/);
    if (invoiceVoid && request.method === "POST") {
      return handleInvoiceVoid(request, env, decodeURIComponent(invoiceVoid[1]));
    }
    const invoiceById = url.pathname.match(/^\/api\/invoices\/([^/]+)$/);
    if (invoiceById) {
      const iid = decodeURIComponent(invoiceById[1]);
      if (request.method === "GET") return handleInvoiceGet(env, iid);
      if (request.method === "PUT") return handleInvoiceUpdate(request, env, iid);
    }

    // ── Change Orders (Sprint 13) ────────────────────────────────────
    const coSend = url.pathname.match(/^\/api\/change-orders\/([^/]+)\/send$/);
    if (coSend && request.method === "POST") {
      return handleChangeOrderSend(request, env, decodeURIComponent(coSend[1]));
    }
    const coReject = url.pathname.match(/^\/api\/change-orders\/([^/]+)\/reject$/);
    if (coReject && request.method === "POST") {
      return handleChangeOrderReject(request, env, decodeURIComponent(coReject[1]));
    }
    const coById = url.pathname.match(/^\/api\/change-orders\/([^/]+)$/);
    if (coById && request.method === "PUT") {
      return handleChangeOrderUpdate(request, env, decodeURIComponent(coById[1]));
    }

    // ── Scheduling (Sprint 13) ───────────────────────────────────────
    if (url.pathname === "/api/schedule" && request.method === "GET") {
      return handleScheduleFeed(env, url);
    }
    const scheduleById = url.pathname.match(/^\/api\/schedule\/([^/]+)$/);
    if (scheduleById) {
      const sid = decodeURIComponent(scheduleById[1]);
      if (request.method === "PUT") return handleScheduleUpdate(request, env, sid);
      if (request.method === "DELETE") return handleScheduleDelete(request, env, sid);
    }

    // ── Permits (Sprint 13) ──────────────────────────────────────────
    const permitById = url.pathname.match(/^\/api\/permits\/([^/]+)$/);
    if (permitById) {
      const pid = decodeURIComponent(permitById[1]);
      if (request.method === "PUT") return handlePermitUpdate(request, env, pid);
      if (request.method === "DELETE") return handlePermitDelete(request, env, pid);
    }

    // ── Cost-Plus Billing Cycles (Sprint 11) ────────────────────────
    const cycleGenInvoice = url.pathname.match(/^\/api\/billing-cycles\/([^/]+)\/generate-invoice$/);
    if (cycleGenInvoice && request.method === "POST") {
      return handleCycleGenerateInvoice(request, env, decodeURIComponent(cycleGenInvoice[1]));
    }
    const cycleReconcile = url.pathname.match(/^\/api\/billing-cycles\/([^/]+)\/reconcile$/);
    if (cycleReconcile && request.method === "POST") {
      return handleCycleReconcile(request, env, decodeURIComponent(cycleReconcile[1]));
    }
    const cycleBillFinal = url.pathname.match(/^\/api\/billing-cycles\/([^/]+)\/bill-final$/);
    if (cycleBillFinal && request.method === "POST") {
      return handleCycleBillFinal(request, env, decodeURIComponent(cycleBillFinal[1]));
    }
    const cycleById = url.pathname.match(/^\/api\/billing-cycles\/([^/]+)$/);
    if (cycleById) {
      const cid = decodeURIComponent(cycleById[1]);
      if (request.method === "GET") return handleCycleGet(env, cid);
      if (request.method === "PUT") return handleCycleUpdate(request, env, cid);
    }

    // ── Payments (Sprint 9) ──────────────────────────────────────────
    if (url.pathname === "/api/payments") {
      if (request.method === "GET") return handlePaymentList(request, env, url);
      if (request.method === "POST") return handlePaymentCreate(request, env);
    }

    // ── Public payment page (Sprint 9, token-gated, unauthenticated) ──
    const publicPay = url.pathname.match(/^\/api\/public\/pay\/([^/]+)$/);
    if (publicPay && request.method === "GET") {
      return handlePublicPayGet(env, decodeURIComponent(publicPay[1]));
    }
    const publicPayIntent = url.pathname.match(/^\/api\/public\/pay\/([^/]+)\/intent$/);
    if (publicPayIntent && request.method === "POST") {
      return handlePublicPayIntent(request, env, decodeURIComponent(publicPayIntent[1]));
    }

    // ── Client Portal API (Sprint 12, PUBLIC token-gated) ────────────
    // All /api/portal/* routes (landing, photos, invoices, pay, budget,
    // messages, deferred seams). The dispatcher returns null when nothing
    // matches so non-portal paths fall through to the auth'd routes.
    if (url.pathname.startsWith("/api/portal/")) {
      const portalRes = await handlePortalApi(request, env, url);
      if (portalRes) return portalRes;
    }

    // ── Photos (PWA capture + Sprint 8 timeline/receipts) ────────────
    // Fixed sub-paths (batch, receipt) must match BEFORE /api/photos/:id.
    if (url.pathname === "/api/photos/batch" && request.method === "POST") {
      return handlePhotoBatch(env, request);
    }
    if (url.pathname === "/api/photos/receipt" && request.method === "POST") {
      return handleReceiptCreate(env, request);
    }
    if (url.pathname === "/api/photos") {
      if (request.method === "POST") return handlePhotoCreate(env, request);
      if (request.method === "GET") return handlePhotoList(env, url);
    }
    // /thumb + /meta + /annotate suffixes must match BEFORE the bare :id pattern.
    // HEAD is accepted alongside GET so probing tools (curl -I, SW caches)
    // get the right status; Workers auto-strips the body on HEAD responses.
    const photoThumb = url.pathname.match(/^\/api\/photos\/([^/]+)\/thumb$/);
    if (photoThumb && (request.method === "GET" || request.method === "HEAD")) {
      return handlePhotoStream(env, decodeURIComponent(photoThumb[1]), "thumb");
    }
    const photoMeta = url.pathname.match(/^\/api\/photos\/([^/]+)\/meta$/);
    if (photoMeta && request.method === "GET") {
      return handlePhotoMeta(env, decodeURIComponent(photoMeta[1]));
    }
    // Deferred seam (Sprint 18) — returns 501 so callers know it's not wired.
    const photoAnnotate = url.pathname.match(/^\/api\/photos\/([^/]+)\/annotate$/);
    if (photoAnnotate && request.method === "PUT") {
      return handlePhotoAnnotate(env, decodeURIComponent(photoAnnotate[1]));
    }
    const photoDetail = url.pathname.match(/^\/api\/photos\/([^/]+)$/);
    if (photoDetail) {
      const photoId = decodeURIComponent(photoDetail[1]);
      if (request.method === "GET" || request.method === "HEAD") {
        return handlePhotoStream(env, photoId, "original");
      }
      if (request.method === "PUT") {
        return handlePhotoPut(env, request, photoId);
      }
      if (request.method === "DELETE") {
        return handlePhotoDelete(env, request, photoId);
      }
      if (request.method === "PATCH") {
        return handlePhotoPatch(env, photoId, request);
      }
    }

    // ── Receipt photos (Sprint 8) ────────────────────────────────────
    const receiptConfirm = url.pathname.match(/^\/api\/receipt-photos\/([^/]+)\/confirm$/);
    if (receiptConfirm && request.method === "POST") {
      return handleReceiptConfirm(env, request, decodeURIComponent(receiptConfirm[1]));
    }
    const receiptById = url.pathname.match(/^\/api\/receipt-photos\/([^/]+)$/);
    if (receiptById && request.method === "GET") {
      return handleReceiptGet(env, decodeURIComponent(receiptById[1]));
    }

    // ── Daily logs (Sprint 8) — bare :id update ──────────────────────
    const dailyLogById = url.pathname.match(/^\/api\/daily-logs\/([^/]+)$/);
    if (dailyLogById && request.method === "PUT") {
      return handleDailyLogUpdate(env, request, decodeURIComponent(dailyLogById[1]));
    }

    // ── Smart notes (Sprint 8) — new smart_notes table ───────────────
    // NOTE: distinct from legacy /api/notes (the `notes` table).
    if (url.pathname === "/api/smart-notes") {
      if (request.method === "POST") return handleSmartNoteCreate(env, request);
      if (request.method === "GET") return handleSmartNoteList(env, url);
    }
    const snAcceptTask = url.pathname.match(/^\/api\/smart-notes\/([^/]+)\/accept-task$/);
    if (snAcceptTask && request.method === "POST") {
      return handleSmartNoteAcceptTask(env, request, decodeURIComponent(snAcceptTask[1]));
    }
    const snAcceptExpense = url.pathname.match(/^\/api\/smart-notes\/([^/]+)\/accept-expense$/);
    if (snAcceptExpense && request.method === "POST") {
      return handleSmartNoteAcceptExpense(env, request, decodeURIComponent(snAcceptExpense[1]));
    }
    const snAcceptCO = url.pathname.match(/^\/api\/smart-notes\/([^/]+)\/accept-change-order$/);
    if (snAcceptCO && request.method === "POST") {
      return handleSmartNoteAcceptChangeOrder(env, request, decodeURIComponent(snAcceptCO[1]));
    }
    const snProcess = url.pathname.match(/^\/api\/smart-notes\/([^/]+)\/process$/);
    if (snProcess && request.method === "POST") {
      return handleSmartNoteProcess(env, request, decodeURIComponent(snProcess[1]));
    }
    const snById = url.pathname.match(/^\/api\/smart-notes\/([^/]+)$/);
    if (snById && request.method === "GET") {
      return handleSmartNoteGet(env, decodeURIComponent(snById[1]));
    }

    // ── Expenses (Sprint 8 PWA capture + Sprint 10 full CRUD) ─────────
    if (url.pathname === "/api/expenses") {
      // JSON body → Sprint 10 full expense form; multipart → legacy PWA capture.
      if (request.method === "POST") {
        const ct = request.headers.get("content-type") ?? "";
        return ct.includes("application/json")
          ? handleExpenseCreateJson(env, request)
          : handleExpenseCreate(env, request);
      }
      if (request.method === "GET") return handleFullExpenseList(env, url);
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
      if (request.method === "PUT") return handleExpenseUpdate(env, request, eid);
      if (request.method === "DELETE") return handleExpenseDelete(env, eid);
      if (request.method === "PATCH") return handleExpensePatch(env, eid, request);
    }

    // ── Time entries (Sprint 10) ─────────────────────────────────────
    if (url.pathname === "/api/time-entries" && request.method === "POST") {
      return handleTimeEntryClockIn(env, request);
    }
    if (url.pathname === "/api/time-entries/active" && request.method === "GET") {
      return handleActiveTimeEntries(env, url);
    }
    const timeEntryById = url.pathname.match(/^\/api\/time-entries\/([^/]+)$/);
    if (timeEntryById && request.method === "PUT") {
      return handleTimeEntryUpdate(env, request, decodeURIComponent(timeEntryById[1]));
    }

    // ── Mileage (Sprint 10) ──────────────────────────────────────────
    if (url.pathname === "/api/mileage") {
      if (request.method === "GET") return handleMileageList(env, url);
      if (request.method === "POST") return handleMileageCreate(env, request);
    }
    const mileageById = url.pathname.match(/^\/api\/mileage\/([^/]+)$/);
    if (mileageById && request.method === "PUT") {
      return handleMileageUpdate(env, request, decodeURIComponent(mileageById[1]));
    }

    // ── Vendor / material price book (Sprint 10) ─────────────────────
    if (url.pathname === "/api/vendor-materials") {
      if (request.method === "GET") return handleVendorMaterialList(env, url);
      if (request.method === "POST") return handleVendorMaterialCreate(env, request);
    }
    const vendorMaterialById = url.pathname.match(/^\/api\/vendor-materials\/([^/]+)$/);
    if (vendorMaterialById && request.method === "PUT") {
      return handleVendorMaterialUpdate(env, request, decodeURIComponent(vendorMaterialById[1]));
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
    // Clockable users — all roles; populates the time-tracker worker dropdown.
    if (url.pathname === "/api/users/clockable" && request.method === "GET") {
      return handleClockableUsers(request, env);
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

    // ── Notifications (Sprint 7) ─────────────────────────────────────
    // Fixed / sub-resource paths before bare :id routes.
    if (url.pathname === "/api/notification-templates" && request.method === "GET") {
      return handleNotifTemplateList(env, request);
    }
    const notifTplTest = url.pathname.match(/^\/api\/notification-templates\/([^/]+)\/test$/);
    if (notifTplTest && request.method === "POST") {
      return handleTemplateTest(request, env, decodeURIComponent(notifTplTest[1]));
    }
    const notifTplPreview = url.pathname.match(/^\/api\/notification-templates\/([^/]+)\/preview$/);
    if (notifTplPreview && request.method === "POST") {
      return handleTemplatePreview(request, env, decodeURIComponent(notifTplPreview[1]));
    }
    const notifTplById = url.pathname.match(/^\/api\/notification-templates\/([^/]+)$/);
    if (notifTplById) {
      const tid = decodeURIComponent(notifTplById[1]);
      if (request.method === "GET") return handleNotifTemplateGet(env, request, tid);
      if (request.method === "PUT") return handleNotifTemplateUpdate(request, env, tid);
    }

    if (url.pathname === "/api/notification-logs" && request.method === "GET") {
      return handleNotifLogList(env, request, url);
    }
    const notifLogRetry = url.pathname.match(/^\/api\/notification-logs\/([^/]+)\/retry$/);
    if (notifLogRetry && request.method === "POST") {
      return handleNotifLogRetry(request, env, decodeURIComponent(notifLogRetry[1]));
    }

    // In-app inbox (per-user; all roles). read-all before the bare :id route.
    if (url.pathname === "/api/notifications/inbox" && request.method === "GET") {
      return handleInbox(request, env);
    }
    if (url.pathname === "/api/notifications/read-all" && request.method === "PUT") {
      return handleInboxReadAll(request, env);
    }
    const notifRead = url.pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
    if (notifRead && request.method === "PUT") {
      return handleInboxRead(request, env, decodeURIComponent(notifRead[1]));
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

    // ── Estimate requests (Estimating Pipeline — Sprint 3) ───────────
    // Sub-resource / fixed paths must be tested before the bare :id route.
    if (url.pathname === "/api/estimate-requests") {
      if (request.method === "GET") return handleEstimateRequestList(env, url);
      if (request.method === "POST") return handleEstimateRequestCreate(request, env);
    }
    if (url.pathname === "/api/estimate-requests/pipeline" && request.method === "GET") {
      return handleEstimateRequestPipeline(env);
    }
    const erAppointment = url.pathname.match(/^\/api\/estimate-requests\/([^/]+)\/appointment$/);
    if (erAppointment && request.method === "PUT") {
      return handleEstimateRequestAppointment(request, env, decodeURIComponent(erAppointment[1]));
    }
    const erLost = url.pathname.match(/^\/api\/estimate-requests\/([^/]+)\/lost$/);
    if (erLost && request.method === "PUT") {
      return handleEstimateRequestLost(request, env, decodeURIComponent(erLost[1]));
    }
    const erWin = url.pathname.match(/^\/api\/estimate-requests\/([^/]+)\/win$/);
    if (erWin && request.method === "POST") {
      return handleEstimateRequestWin(request, env, decodeURIComponent(erWin[1]));
    }
    const erById = url.pathname.match(/^\/api\/estimate-requests\/([^/]+)$/);
    if (erById) {
      const erid = decodeURIComponent(erById[1]);
      if (request.method === "GET") return handleEstimateRequestGet(env, erid);
      if (request.method === "PUT") return handleEstimateRequestUpdate(request, env, erid);
    }

    // ── Estimate Builder (Sprint 4) ──────────────────────────────────
    // Sub-resource / fixed paths must be tested before the bare :id routes.

    // Estimate templates (tested before /api/estimates to avoid prefix clashes).
    if (url.pathname === "/api/estimate-templates") {
      if (request.method === "GET") return handleTemplateList(env, url);
      if (request.method === "POST") return handleTemplateCreate(request, env);
    }
    const templateById = url.pathname.match(/^\/api\/estimate-templates\/([^/]+)$/);
    if (templateById) {
      const tid = decodeURIComponent(templateById[1]);
      if (request.method === "GET") return handleTemplateGet(env, tid);
      if (request.method === "PUT") return handleTemplateUpdate(request, env, tid);
    }

    // Saved reviews.
    if (url.pathname === "/api/reviews") {
      if (request.method === "GET") return handleReviewList(env, url);
      if (request.method === "POST") return handleReviewCreate(request, env);
    }
    const reviewById = url.pathname.match(/^\/api\/reviews\/([^/]+)$/);
    if (reviewById) {
      const rid = decodeURIComponent(reviewById[1]);
      if (request.method === "PUT") return handleReviewUpdate(request, env, rid);
      if (request.method === "DELETE") return handleReviewDelete(request, env, rid);
    }

    // Material/vendor search (read-only this sprint).
    if (url.pathname === "/api/materials/search" && request.method === "GET") {
      return handleMaterialSearch(env, url);
    }

    // Estimates: nested paths first, bare :id last.
    if (url.pathname === "/api/estimates") {
      if (request.method === "GET") return handleEstimateList(env, url);
      if (request.method === "POST") return handleEstimateCreate(request, env);
    }
    const estLineReorder = url.pathname.match(/^\/api\/estimates\/([^/]+)\/line-items\/reorder$/);
    if (estLineReorder && request.method === "PUT") {
      return handleLineItemReorder(request, env, decodeURIComponent(estLineReorder[1]));
    }
    const estLineItems = url.pathname.match(/^\/api\/estimates\/([^/]+)\/line-items$/);
    if (estLineItems) {
      const eid = decodeURIComponent(estLineItems[1]);
      if (request.method === "GET") return handleLineItemList(env, eid);
      if (request.method === "POST") return handleLineItemCreate(request, env, eid);
    }
    const estSchedule = url.pathname.match(/^\/api\/estimates\/([^/]+)\/payment-schedule$/);
    if (estSchedule) {
      const eid = decodeURIComponent(estSchedule[1]);
      if (request.method === "GET") return handlePaymentScheduleGet(env, eid);
      if (request.method === "PUT") return handlePaymentScheduleReplace(request, env, eid);
    }
    const estSend = url.pathname.match(/^\/api\/estimates\/([^/]+)\/send$/);
    if (estSend && request.method === "POST") {
      return handleEstimateSend(request, env, decodeURIComponent(estSend[1]));
    }
    const estRevise = url.pathname.match(/^\/api\/estimates\/([^/]+)\/revise$/);
    if (estRevise && request.method === "POST") {
      return handleEstimateRevise(request, env, decodeURIComponent(estRevise[1]));
    }
    const estLost = url.pathname.match(/^\/api\/estimates\/([^/]+)\/lost$/);
    if (estLost && request.method === "POST") {
      return handleEstimateLost(request, env, decodeURIComponent(estLost[1]));
    }
    const estApplyTemplate = url.pathname.match(
      /^\/api\/estimates\/([^/]+)\/apply-template\/([^/]+)$/,
    );
    if (estApplyTemplate && request.method === "POST") {
      return handleApplyTemplate(
        request,
        env,
        decodeURIComponent(estApplyTemplate[1]),
        decodeURIComponent(estApplyTemplate[2]),
      );
    }
    const estById = url.pathname.match(/^\/api\/estimates\/([^/]+)$/);
    if (estById) {
      const eid = decodeURIComponent(estById[1]);
      if (request.method === "GET") return handleEstimateGet(env, eid);
      if (request.method === "PUT") return handleEstimateUpdate(request, env, eid);
    }

    // Line item sub-resources (sub-items) before the bare line-item :id route.
    const lineSubItems = url.pathname.match(/^\/api\/line-items\/([^/]+)\/sub-items$/);
    if (lineSubItems && request.method === "POST") {
      return handleSubItemCreate(request, env, decodeURIComponent(lineSubItems[1]));
    }
    const lineItemById = url.pathname.match(/^\/api\/line-items\/([^/]+)$/);
    if (lineItemById) {
      const lid = decodeURIComponent(lineItemById[1]);
      if (request.method === "PUT") return handleLineItemUpdate(request, env, lid);
      if (request.method === "DELETE") return handleLineItemDelete(request, env, lid);
    }
    const subItemById = url.pathname.match(/^\/api\/sub-items\/([^/]+)$/);
    if (subItemById) {
      const sid = decodeURIComponent(subItemById[1]);
      if (request.method === "PUT") return handleSubItemUpdate(request, env, sid);
      if (request.method === "DELETE") return handleSubItemDelete(request, env, sid);
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

    // ── Public client quote page (Sprint 5) ──────────────────────────
    // /quote/:token is a STANDALONE, no-auth, no-app-shell page (its own Vite
    // entry, built to public/app/quote.html). The page reads the token from the
    // URL and calls /api/public/quote/:token. Served on every host; no Access.
    if (url.pathname === "/quote" || url.pathname.startsWith("/quote/")) {
      const quoteHtmlUrl = new URL(request.url);
      quoteHtmlUrl.pathname = "/app/quote.html";
      return env.ASSETS.fetch(new Request(quoteHtmlUrl.toString(), { method: "GET" }));
    }

    // ── Public invoice payment page (Sprint 9) ───────────────────────
    // /pay/:token — the invoice analogue of /quote/:token. Standalone, no-auth,
    // own Vite entry (public/app/pay.html). Reads the token and calls
    // /api/public/pay/:token. Served on every host; no Access.
    if (url.pathname === "/pay" || url.pathname.startsWith("/pay/")) {
      const payHtmlUrl = new URL(request.url);
      payHtmlUrl.pathname = "/app/pay.html";
      return env.ASSETS.fetch(new Request(payHtmlUrl.toString(), { method: "GET" }));
    }

    // ── Client Portal app (Sprint 12) ────────────────────────────────
    // /portal/:token is the token-gated, light-theme, mobile-first Preact app
    // (its own Vite entry, public/app/portal.html). Reads the token from the
    // URL and calls /api/portal/:token. Served on every host; no Access.
    if (url.pathname === "/portal" || url.pathname.startsWith("/portal/")) {
      const portalHtmlUrl = new URL(request.url);
      portalHtmlUrl.pathname = "/app/portal.html";
      return env.ASSETS.fetch(new Request(portalHtmlUrl.toString(), { method: "GET" }));
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
    case "*/15 * * * *":
      await runNotificationProcessor(env);
      return;
    case "15 * * * *":
      await runHourly(env);
      return;
    case "15 7 * * *":
      await runNightly(env);
      // Invoice billing piggybacks on the nightly window (02:15 Central) rather
      // than its own cron — the account is capped at 5 cron triggers, and running
      // here keeps late fees fresh for the 07:00 Central daily summary. Order is
      // backup → billing so a backup captures pre-fee state.
      await runInvoiceBilling(env);
      // QBO push sweep also folds into the nightly window (Sprint 14) — the
      // 5-cron cap means no standalone "0 0 * * * QBO Sync" trigger. Runs after
      // billing so freshly-accrued invoices/late-fees are included in the push.
      await runQboSyncSweep(env);
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

// Invoice billing (Sprint 9): accrue $50/day late fees on overdue invoices, then
// enqueue due-reminder / past-due notices. Order matters — fees first so the
// past-due notice carries the up-to-date balance. Runs inside the nightly
// (15 7 * * *) tick because the account is capped at 5 cron triggers. Non-fatal.
async function runInvoiceBilling(env: Env): Promise<void> {
  try {
    const fees = await runLateFeeCalculator(env);
    const due = await runInvoiceDueCheck(env);
    console.log(
      `[cron 15 7 * * *] invoice_billing: late_fees scanned=${fees.scanned} updated=${fees.updated} past_due=${fees.marked_past_due}; due_check scanned=${due.scanned} reminders=${due.reminders} past_due_notices=${due.past_due}`,
    );
  } catch (err) {
    console.error("[cron 15 7 * * *] invoice_billing failed:", (err as Error).message);
  }
}

// QBO push sweep (Sprint 14) — selects unsynced invoices/payments/expenses and
// pushes each to QuickBooks (idempotent, keyed on the qbo_*_id columns). Folded
// into the nightly tick rather than its own cron (5-cron cap). Non-fatal: a
// disconnected/error connection is a no-op; per-record failures land in the
// qbo_sync DLQ and the next sweep retries.
async function runQboSyncSweep(env: Env): Promise<void> {
  try {
    const r = await runQboSweep(env);
    if (!r.ran) {
      console.log(`[cron 15 7 * * *] qbo_sync: skipped (${r.reason ?? "not_connected"})`);
      return;
    }
    console.log(
      `[cron 15 7 * * *] qbo_sync: inv=${r.invoices.pushed}/${r.invoices.skipped}/${r.invoices.failed} ` +
        `pay=${r.payments.pushed}/${r.payments.skipped}/${r.payments.failed} ` +
        `exp=${r.expenses.pushed}/${r.expenses.skipped}/${r.expenses.failed} (pushed/skipped/failed) in ${r.duration_ms}ms`,
    );
  } catch (err) {
    console.error("[cron 15 7 * * *] qbo_sync failed:", (err as Error).message);
  }
}

// Notification Processor (Sprint 7) — drains the queued notification_logs rows
// that are due, after recomputing time-based triggers (quote follow-ups,
// work_starting, appointment reminders) from D1. Failures are non-fatal.
async function runNotificationProcessor(env: Env): Promise<void> {
  try {
    const s = await processNotifications(env);
    console.log(
      `[cron */15 * * * *] notifications: enqueued=${s.scanned_enqueued} sent=${s.sent} simulated=${s.simulated} deferred=${s.deferred} suppressed=${s.suppressed} failed=${s.failed} dlq=${s.dead_lettered} in ${s.duration_ms}ms`,
    );
  } catch (err) {
    console.error("[cron */15 * * * *] notifications failed:", (err as Error).message);
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

  // WC Spreadsheet sync (Sprint 14 rebuild) piggybacks on the */30 tick so the
  // sheet always reflects the freshest D1 state. Failures here are non-fatal
  // (logged to sync_log + DLQ inside the service).
  try {
    const wc = await runWcSpreadsheetSync(env);
    console.log(
      `[cron ${cron}] wc_spreadsheet: status=${wc.status} updated=[${wc.tabs_updated.join(",")}] failed=[${wc.tabs_failed.join(",")}] in ${wc.duration_ms}ms`,
    );
  } catch (err) {
    console.error(`[cron ${cron}] wc_spreadsheet failed:`, (err as Error).message);
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

  // Integration sync status (Sprint 14) — QBO connection + last sweep, WC last
  // sync. Non-fatal: never flip overall health on an integration read.
  const integrations: Record<string, unknown> = {};
  try {
    integrations.quickbooks = await getQboStatus(env);
  } catch (err) {
    integrations.quickbooks = { error: (err as Error).message };
  }
  try {
    integrations.wc_spreadsheet = await getWcStatus(env);
  } catch (err) {
    integrations.wc_spreadsheet = { error: (err as Error).message };
  }

  return jsonResponse(
    { ...checks, integrations },
    {
      status: checks.ok ? 200 : 503,
      headers: { "x-total-ms": String(Date.now() - startedAt) },
    },
  );
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
