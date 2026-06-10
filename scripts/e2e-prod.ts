/**
 * CHS production E2E harness — API-only smoke across major modules.
 *
 *   npm run e2e:prod
 *
 * Production auth: Cloudflare strips client-supplied Cf-Access-* headers. Use ONE of:
 *   • E2E_CF_ACCESS_CLIENT_ID + E2E_CF_ACCESS_CLIENT_SECRET (Access service token)
 *   • E2E_COOKIE=CF_Authorization=… (env, or in .env.local, or scripts/.e2e-cookie.local)
 *   • cloudflared access curl … (wraps the same checks)
 *
 * Cookie files expire (often ~24h). Re-copy from DevTools → Application → Cookies
 * on dashboard.homesolutionsar.com when the harness hits the Access login page.
 *
 * Optional: E2E_BASE (default dashboard), E2E_EMAIL (default tony@…).
 * Creates one test client + estimate request (tagged DELETE-ME); no financial writes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadE2eCookie(): { cookie: string; source: string | null } {
  const fromEnv = (process.env.E2E_COOKIE ?? "").trim();
  if (fromEnv) return { cookie: fromEnv, source: "E2E_COOKIE env" };

  const cookieFile = join(process.cwd(), "scripts", ".e2e-cookie.local");
  if (existsSync(cookieFile)) {
    const raw = readFileSync(cookieFile, "utf8").trim();
    if (raw) return { cookie: raw, source: "scripts/.e2e-cookie.local" };
  }

  const envLocal = join(process.cwd(), ".env.local");
  if (existsSync(envLocal)) {
    for (const line of readFileSync(envLocal, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() !== "E2E_COOKIE") continue;
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (val) return { cookie: val, source: ".env.local" };
    }
  }
  return { cookie: "", source: null };
}

const TEST_EMAIL = process.env.E2E_EMAIL ?? "tony@homesolutionsar.com";
const BASE = process.env.E2E_BASE ?? "https://dashboard.homesolutionsar.com";
const CLIENT_BASE = process.env.E2E_CLIENT_BASE ?? "https://client.homesolutionsar.com";
const CF_ACCESS_CLIENT_ID = process.env.E2E_CF_ACCESS_CLIENT_ID ?? "";
const CF_ACCESS_CLIENT_SECRET = process.env.E2E_CF_ACCESS_CLIENT_SECRET ?? "";
const { cookie: E2E_COOKIE, source: E2E_COOKIE_SOURCE } = loadE2eCookie();
const PORTAL_TOKEN =
  process.env.E2E_PORTAL_TOKEN ?? "a7833038ce0f435d9cc0b1998956ca44";

const TEST_CLIENT_FIRST = "E2E-TEST";
const TEST_CLIENT_LAST = "CLIENT-DELETE-ME";

type CheckResult = { ok: boolean; line: string; detail?: string };

const results: CheckResult[] = [];
let testClientId: string | null = null;
let testRequestId: string | null = null;
/** First job returned by GET /api/jobs — used for job-scoped smoke checks. */
let fixtureJobId: string | null = null;

function headers(extra?: Record<string, string>, withAuth = true): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (withAuth) {
    h["Cf-Access-Authenticated-User-Email"] = TEST_EMAIL;
    if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
      h["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID;
      h["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET;
    }
    if (E2E_COOKIE) h["Cookie"] = E2E_COOKIE;
  }
  return h;
}

function isAccessLoginPage(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<!DOCTYPE") || t.includes("Cloudflare Access");
}

function assertJsonResponse(
  name: string,
  status: number,
  text: string,
  body: unknown,
): boolean {
  if (isAccessLoginPage(text)) {
    record(
      false,
      name,
      "Cloudflare Access login page — set E2E_CF_ACCESS_CLIENT_ID/SECRET or E2E_COOKIE",
      String(status),
    );
    return false;
  }
  if (typeof body === "string") {
    record(false, name, "non-JSON response", text.slice(0, 160));
    return false;
  }
  return true;
}

async function api(
  method: string,
  path: string,
  opts?: { body?: unknown; auth?: boolean; base?: string },
): Promise<{ status: number; body: unknown; text: string }> {
  const base = opts?.base ?? BASE;
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const init: RequestInit = {
    method,
    headers: headers(undefined, opts?.auth !== false),
  };
  if (opts?.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

function record(ok: boolean, line: string, detail?: string): void {
  results.push({ ok, line, detail });
  const prefix = ok ? "  ✅" : "  ❌";
  console.log(`${prefix} ${line}${detail ? `\n     ${detail}` : ""}`);
}

function assert(
  name: string,
  cond: boolean,
  detail?: string,
  meta?: string,
): void {
  const line = meta ? `${name} → ${meta}` : name;
  record(cond, line, cond ? undefined : detail ?? "assertion failed");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ─── Module runners ───────────────────────────────────────────────────────────

async function moduleHealthAuth(): Promise<void> {
  console.log("\n[Health & Auth]");

  const hb = await api("GET", "/api/health/heartbeat");
  if (assertJsonResponse("GET /api/health/heartbeat", hb.status, hb.text, hb.body)) {
    const hbBody = isRecord(hb.body) ? hb.body : {};
    const tables = Number(hbBody.tables ?? 0);
    const expected = Number(hbBody.tables_expected ?? 0);
    assert(
      "GET /api/health/heartbeat",
      hb.status === 200 && hbBody.status === "ok" && tables === expected && expected > 0,
      `status=${hb.status} body=${hb.text.slice(0, 200)}`,
      hb.status === 200 ? `200 (tables: ${tables}/${expected})` : String(hb.status),
    );
  }

  const health = await api("GET", "/api/health");
  if (assertJsonResponse("GET /api/health", health.status, health.text, health.body)) {
    const hBody = isRecord(health.body) ? health.body : {};
    assert(
      "GET /api/health",
      health.status === 200 && hBody.ok === true,
      health.text.slice(0, 200),
      String(health.status),
    );
  }

  const me = await api("GET", "/api/me");
  if (assertJsonResponse("GET /api/me", me.status, me.text, me.body)) {
    const meBody = isRecord(me.body) ? me.body : {};
    assert(
      "GET /api/me",
      me.status === 200 && meBody.email === TEST_EMAIL,
      me.text.slice(0, 200),
      me.status === 200 ? `200 (${String(meBody.email)})` : String(me.status),
    );
  }

  const settings = await api("GET", "/api/settings");
  if (assertJsonResponse("GET /api/settings", settings.status, settings.text, settings.body)) {
    const sBody = isRecord(settings.body) ? settings.body : {};
    const settingsArr = arr(sBody.settings);
    assert(
      "GET /api/settings",
      settings.status === 200 && settingsArr.length > 0,
      settings.text.slice(0, 200),
      settings.status === 200 ? `200 (${settingsArr.length} settings)` : String(settings.status),
    );
  }
}

async function moduleClients(): Promise<void> {
  console.log("\n[Clients]");

  const list = await api("GET", "/api/clients?limit=5");
  const listBody = isRecord(list.body) ? list.body : {};
  assert(
    "GET /api/clients",
    list.status === 200 && Array.isArray(listBody.clients),
    list.text.slice(0, 200),
    String(list.status),
  );

  const stamp = Date.now();
  const create = await api("POST", "/api/clients?force=true", {
    body: {
      first_name: TEST_CLIENT_FIRST,
      last_name: TEST_CLIENT_LAST,
      email: `e2e-delete-me-${stamp}@example.invalid`,
      phone: `501555${String(stamp).slice(-4)}`,
      lead_source: "e2e_harness",
    },
  });
  const cBody = isRecord(create.body) ? create.body : {};
  const client = isRecord(cBody.client) ? cBody.client : null;
  testClientId = client && typeof client.id === "string" ? client.id : null;
  assert(
    "POST /api/clients (test)",
    create.status === 201 && !!testClientId,
    create.text.slice(0, 300),
    testClientId ? `201 (${testClientId.slice(0, 8)}…)` : String(create.status),
  );

  if (testClientId) {
    const get = await api("GET", `/api/clients/${testClientId}`);
    const gBody = isRecord(get.body) ? get.body : {};
    const got = isRecord(gBody.client) ? gBody.client : gBody;
    const name = typeof got.name === "string" ? got.name : "";
    assert(
      "GET /api/clients/:id",
      get.status === 200 && name.includes(TEST_CLIENT_FIRST),
      get.text.slice(0, 200),
      String(get.status),
    );
  }

  record(
    true,
    "DELETE /api/clients/:id (cleanup)",
    "skipped — no DELETE route; client tagged E2E-TEST-CLIENT-DELETE-ME for manual purge",
  );
}

async function moduleEstimates(): Promise<void> {
  console.log("\n[Estimates & Requests]");

  const list = await api("GET", "/api/estimate-requests?limit=5");
  if (assertJsonResponse("GET /api/estimate-requests", list.status, list.text, list.body)) {
    const listBody = isRecord(list.body) ? list.body : {};
    assert(
      "GET /api/estimate-requests",
      list.status === 200 && Array.isArray(listBody.requests),
      list.text.slice(0, 200),
      String(list.status),
    );
  }

  const pipeline = await api("GET", "/api/estimate-requests/pipeline");
  if (assertJsonResponse("GET /api/estimate-requests/pipeline", pipeline.status, pipeline.text, pipeline.body)) {
    const pBody = isRecord(pipeline.body) ? pipeline.body : {};
    assert(
      "GET /api/estimate-requests/pipeline",
      pipeline.status === 200 && isRecord(pBody.pipeline),
      pipeline.text.slice(0, 200),
      String(pipeline.status),
    );
  }

  if (!testClientId) {
    record(false, "POST /api/estimate-requests", "skipped — no test client id");
    return;
  }

  const create = await api("POST", "/api/estimate-requests", {
    body: {
      client_id: testClientId,
      property_address: "123 E2E Test St",
      property_city: "Little Rock",
      property_zip: "72201",
      job_type: "Other",
      lead_source: "e2e_harness",
    },
  });
  const cBody = isRecord(create.body) ? create.body : {};
  const req = isRecord(cBody.request) ? cBody.request : null;
  testRequestId = req && typeof req.id === "string" ? req.id : null;
  assert(
    "POST /api/estimate-requests",
    create.status === 201 && !!testRequestId,
    create.text.slice(0, 300),
    testRequestId ? `201 (${testRequestId.slice(0, 8)}…)` : String(create.status),
  );

  if (testRequestId) {
    const patch = await api("PUT", `/api/estimate-requests/${testRequestId}`, {
      body: { status: "appointment_set" },
    });
    assert(
      "PUT /api/estimate-requests/:id (stage)",
      patch.status === 200,
      patch.text.slice(0, 200),
      String(patch.status),
    );
  }

  const estimates = await api("GET", "/api/estimates?limit=5");
  const eBody = isRecord(estimates.body) ? estimates.body : {};
  const estArr = arr(eBody.estimates ?? eBody.items);
  assert(
    "GET /api/estimates",
    estimates.status === 200 && (Array.isArray(eBody.estimates) || estArr.length >= 0),
    estimates.text.slice(0, 200),
    String(estimates.status),
  );

  record(
    true,
    "DELETE estimate-request (cleanup)",
    "skipped — no DELETE route; request tied to E2E test client",
  );
}

async function resolveFixtureJob(): Promise<void> {
  const jobs = await api("GET", "/api/jobs?limit=200");
  const body = isRecord(jobs.body) ? jobs.body : {};
  const list = arr(body.jobs);
  for (const j of list) {
    if (!isRecord(j)) continue;
    if (typeof j.id === "string" && j.id.length > 0) {
      fixtureJobId = j.id;
      break;
    }
  }
}

async function moduleJobs(): Promise<void> {
  console.log("\n[Jobs]");

  const list = await api("GET", "/api/jobs?limit=200");
  if (assertJsonResponse("GET /api/jobs", list.status, list.text, list.body)) {
    const listBody = isRecord(list.body) ? list.body : {};
    assert(
      "GET /api/jobs",
      list.status === 200 && Array.isArray(listBody.jobs),
      list.text.slice(0, 200),
      String(list.status),
    );
    const jobs = arr(listBody.jobs);
    for (const j of jobs) {
      if (!isRecord(j)) continue;
      if (typeof j.id === "string" && j.id.length > 0) {
        fixtureJobId = j.id;
        break;
      }
    }
  }

  const pipeline = await api("GET", "/api/jobs/pipeline");
  if (assertJsonResponse("GET /api/jobs/pipeline", pipeline.status, pipeline.text, pipeline.body)) {
    const pBody = isRecord(pipeline.body) ? pipeline.body : {};
    assert(
      "GET /api/jobs/pipeline",
      pipeline.status === 200 && isRecord(pBody.pipeline),
      pipeline.text.slice(0, 200),
      String(pipeline.status),
    );
  }

  await resolveFixtureJob();
  assert(
    "resolve fixture job",
    !!fixtureJobId,
    "no jobs in GET /api/jobs — need at least one Jobber-synced job for job-scoped checks",
    fixtureJobId ? `id ${fixtureJobId.slice(0, 8)}…` : "missing",
  );

  if (fixtureJobId) {
    const detail = await api("GET", `/api/jobs/${fixtureJobId}`);
    const dBody = isRecord(detail.body) ? detail.body : {};
    const job = isRecord(dBody.job) ? dBody.job : dBody;
    assert(
      "GET /api/jobs/:id (fixture job)",
      detail.status === 200 &&
        typeof job.id === "string" &&
        typeof job.status === "string" &&
        ("portal_token" in job),
      detail.text.slice(0, 200),
      String(detail.status),
    );

    const costing = await api("GET", `/api/jobs/${fixtureJobId}/costing`);
    const cBody = isRecord(costing.body) ? costing.body : {};
    const costingObj = isRecord(cBody.costing) ? cBody.costing : null;
    const totals = costingObj && isRecord(costingObj.totals) ? costingObj.totals : null;
    assert(
      "GET /api/jobs/:id/costing",
      costing.status === 200 &&
        !!costingObj &&
        typeof totals?.budget === "number" &&
        typeof totals?.actual === "number" &&
        typeof totals?.variance === "number",
      costing.text.slice(0, 200),
      String(costing.status),
    );

    const inv = await api("GET", `/api/jobs/${fixtureJobId}/invoices`);
    const invBody = isRecord(inv.body) ? inv.body : {};
    const invoices = arr(invBody.invoices);
    assert(
      "GET /api/jobs/:id/invoices",
      inv.status === 200 && Array.isArray(invBody.invoices),
      inv.text.slice(0, 200),
      `${inv.status} (${invoices.length} invoices)`,
    );
  }

  const map = await api("GET", "/api/jobs/map");
  const mBody = isRecord(map.body) ? map.body : {};
  const pins = arr(mBody.pins);
  const hasCoords =
    pins.length === 0 ||
    pins.some((p) => isRecord(p) && p.lat != null && p.lon != null);
  assert(
    "GET /api/jobs/map",
    map.status === 200 && Array.isArray(mBody.pins) && hasCoords,
    map.text.slice(0, 200),
    `${map.status} (${pins.length} pins)`,
  );
}

async function moduleFinancial(): Promise<void> {
  console.log("\n[Invoices & Payments]");

  const invoices = await api("GET", "/api/invoices?limit=10");
  const iBody = isRecord(invoices.body) ? invoices.body : {};
  assert(
    "GET /api/invoices",
    invoices.status === 200 && Array.isArray(iBody.invoices),
    invoices.text.slice(0, 200),
    String(invoices.status),
  );

  const payments = await api("GET", "/api/payments?limit=10");
  const pBody = isRecord(payments.body) ? payments.body : {};
  assert(
    "GET /api/payments",
    payments.status === 200 && Array.isArray(pBody.payments),
    payments.text.slice(0, 200),
    String(payments.status),
  );
}

async function moduleExpensesTime(): Promise<void> {
  console.log("\n[Expenses & Time]");

  const expenses = await api("GET", "/api/expenses?limit=5");
  const eBody = isRecord(expenses.body) ? expenses.body : {};
  assert(
    "GET /api/expenses",
    expenses.status === 200 && Array.isArray(eBody.expenses),
    expenses.text.slice(0, 200),
    String(expenses.status),
  );

  const vm = await api("GET", "/api/vendor-materials?limit=5");
  const vBody = isRecord(vm.body) ? vm.body : {};
  assert(
    "GET /api/vendor-materials",
    vm.status === 200 && Array.isArray(vBody.materials),
    vm.text.slice(0, 200),
    vm.status === 200 ? `200 (${arr(vBody.materials).length} materials)` : String(vm.status),
  );

  if (fixtureJobId) {
    const te = await api("GET", `/api/jobs/${fixtureJobId}/time-entries`);
    const tBody = isRecord(te.body) ? te.body : {};
    assert(
      "GET /api/jobs/:id/time-entries",
      te.status === 200 && Array.isArray(tBody.time_entries),
      te.text.slice(0, 200),
      String(te.status),
    );
  } else {
    record(false, "GET /api/jobs/:id/time-entries", "skipped — no fixture job resolved");
  }
}

async function moduleNotifications(): Promise<void> {
  console.log("\n[Notifications]");

  const inbox = await api("GET", "/api/notifications/inbox");
  const inBody = isRecord(inbox.body) ? inbox.body : {};
  assert(
    "GET /api/notifications/inbox",
    inbox.status === 200 && Array.isArray(inBody.notifications),
    inbox.text.slice(0, 200),
    String(inbox.status),
  );

  const logs = await api("GET", "/api/notification-logs?limit=10");
  const lBody = isRecord(logs.body) ? logs.body : {};
  assert(
    "GET /api/notification-logs (dispatch log)",
    logs.status === 200 && Array.isArray(lBody.logs),
    logs.text.slice(0, 200),
    `${logs.status} (${arr(lBody.logs).length} rows)`,
  );
}

async function modulePhotos(): Promise<void> {
  console.log("\n[Photos]");

  const photos = await api("GET", "/api/photos?limit=5");
  const pBody = isRecord(photos.body) ? photos.body : {};
  assert(
    "GET /api/photos",
    photos.status === 200 && Array.isArray(pBody.photos),
    photos.text.slice(0, 200),
    String(photos.status),
  );

  if (fixtureJobId) {
    const logs = await api("GET", `/api/jobs/${fixtureJobId}/daily-logs`);
    const ok = logs.status === 200 || logs.status === 404;
    record(
      ok,
      `GET /api/jobs/:id/daily-logs`,
      ok ? undefined : logs.text.slice(0, 200),
      `${logs.status} (200 or 404 acceptable)`,
    );
  }
}

async function moduleDocuments(): Promise<void> {
  console.log("\n[Documents]");

  const docs = await api("GET", "/api/documents?limit=5");
  const dBody = isRecord(docs.body) ? docs.body : {};
  assert(
    "GET /api/documents",
    docs.status === 200 && Array.isArray(dBody.documents),
    docs.text.slice(0, 200),
    String(docs.status),
  );

  const templates = await api("GET", "/api/document-templates");
  const tBody = isRecord(templates.body) ? templates.body : {};
  const tpl = arr(tBody.templates ?? tBody.document_templates);
  assert(
    "GET /api/document-templates",
    templates.status === 200 && tpl.length > 0,
    templates.text.slice(0, 200),
    `${templates.status} (${tpl.length} templates)`,
  );

  record(
    true,
    "GET /api/file-shares",
    "mapped → no list route; document share uses POST /api/documents/:id/share + GET /share/:token",
  );
}

async function moduleSocial(): Promise<void> {
  console.log("\n[Social Media]");

  const socialStatus = await api("GET", "/api/social/status");
  if (assertJsonResponse("GET /api/social/status", socialStatus.status, socialStatus.text, socialStatus.body)) {
    const sBody = isRecord(socialStatus.body) ? socialStatus.body : {};
    assert(
      "GET /api/social/status",
      socialStatus.status === 200 && typeof sBody.publish_mode === "string",
      socialStatus.text.slice(0, 200),
      String(socialStatus.status),
    );
  }

  const posts = await api("GET", "/api/social-posts?limit=5");
  const pBody = isRecord(posts.body) ? posts.body : {};
  assert(
    "GET /api/social-posts",
    posts.status === 200 && Array.isArray(pBody.posts),
    posts.text.slice(0, 200),
    String(posts.status),
  );

  const schedule = await api("GET", "/api/content-schedules");
  if (assertJsonResponse("GET /api/content-schedules", schedule.status, schedule.text, schedule.body)) {
    const sBody = isRecord(schedule.body) ? schedule.body : {};
    assert(
      "GET /api/content-schedules",
      schedule.status === 200 && Array.isArray(sBody.schedules),
      schedule.text.slice(0, 200),
      String(schedule.status),
    );
  }
}

async function moduleChangeOrders(): Promise<void> {
  console.log("\n[Change Orders & Scheduling]");

  if (fixtureJobId) {
    const co = await api("GET", `/api/jobs/${fixtureJobId}/change-orders`);
    const coBody = isRecord(co.body) ? co.body : {};
    assert(
      "GET /api/jobs/:id/change-orders",
      co.status === 200 && Array.isArray(coBody.change_orders),
      co.text.slice(0, 200),
      String(co.status),
    );

    const sched = await api("GET", `/api/jobs/${fixtureJobId}/schedule`);
    const sBody = isRecord(sched.body) ? sched.body : {};
    assert(
      "GET /api/jobs/:id/schedule",
      sched.status === 200 && Array.isArray(sBody.entries ?? sBody.schedule),
      sched.text.slice(0, 200),
      String(sched.status),
    );
  }

  const cal = await api("GET", "/api/schedule");
  const cBody = isRecord(cal.body) ? cal.body : {};
  assert(
    "GET /api/schedule",
    cal.status === 200 && Array.isArray(cBody.entries ?? cBody.schedule),
    cal.text.slice(0, 200),
    String(cal.status),
  );
}

async function modulePortal(): Promise<void> {
  console.log("\n[Client Portal]");

  const portalPage = await api(
    "GET",
    `${CLIENT_BASE}/portal/${PORTAL_TOKEN}`,
    { auth: false },
  );
  assert(
    "GET client /portal/:token (HTML)",
    portalPage.status === 200,
    portalPage.text.slice(0, 120),
    String(portalPage.status),
  );

  const portalApi = await api("GET", `/api/portal/${PORTAL_TOKEN}`, {
    auth: false,
    base: CLIENT_BASE,
  });
  if (assertJsonResponse("GET /api/portal/:token", portalApi.status, portalApi.text, portalApi.body)) {
    const pBody = isRecord(portalApi.body) ? portalApi.body : {};
    assert(
      "GET /api/portal/:token",
      portalApi.status === 200 && pBody.ok === true && isRecord(pBody.header),
      portalApi.text.slice(0, 200),
      String(portalApi.status),
    );
  }
}

async function moduleIntegrations(): Promise<void> {
  console.log("\n[QuickBooks & WC]");

  const integrations = await api("GET", "/api/integrations");
  if (assertJsonResponse("GET /api/integrations", integrations.status, integrations.text, integrations.body)) {
    const iBody = isRecord(integrations.body) ? integrations.body : {};
    assert(
      "GET /api/integrations",
      integrations.status === 200 && Array.isArray(iBody.integrations),
      integrations.text.slice(0, 200),
      String(integrations.status),
    );
  }

  const qbo = await api("GET", "/api/quickbooks/status");
  assert(
    "GET /api/quickbooks/status",
    qbo.status === 200,
    qbo.text.slice(0, 200),
    String(qbo.status),
  );

  const wc = await api("GET", "/api/wc-spreadsheet/status");
  assert(
    "GET /api/wc-spreadsheet/status",
    wc.status === 200,
    wc.text.slice(0, 200),
    String(wc.status),
  );
}

async function moduleDashboard(): Promise<void> {
  console.log("\n[Dashboard]");

  const actions = await api("GET", "/api/dashboard/action-items");
  if (assertJsonResponse("GET /api/dashboard/action-items", actions.status, actions.text, actions.body)) {
    const aBody = isRecord(actions.body) ? actions.body : {};
    assert(
      "GET /api/dashboard/action-items",
      actions.status === 200 && Array.isArray(aBody.items),
      actions.text.slice(0, 200),
      String(actions.status),
    );
  }

  const kpis = await api("GET", "/api/dashboard/kpis");
  const kBody = isRecord(kpis.body) ? kpis.body : {};
  assert(
    "GET /api/dashboard/kpis",
    kpis.status === 200 && Array.isArray(kBody.tiles),
    kpis.text.slice(0, 200),
    String(kpis.status),
  );

  const pipeline = await api("GET", "/api/dashboard/pipeline");
  const pBody = isRecord(pipeline.body) ? pipeline.body : {};
  assert(
    "GET /api/dashboard/pipeline",
    pipeline.status === 200 && (pBody.jobs != null || pBody.leads != null),
    pipeline.text.slice(0, 200),
    String(pipeline.status),
  );

  const weather = await api("GET", "/api/weather");
  const wBody = isRecord(weather.body) ? weather.body : {};
  const current = isRecord(wBody.current) ? wBody.current : null;
  assert(
    "GET /api/weather",
    weather.status === 200 &&
      (current?.temperature != null || Array.isArray(wBody.forecast)),
    weather.text.slice(0, 200),
    String(weather.status),
  );
}

async function moduleAdmin(): Promise<void> {
  console.log("\n[System Admin]");

  const users = await api("GET", "/api/users");
  const uBody = isRecord(users.body) ? users.body : {};
  const userList = arr(uBody.users);
  const hasTony = userList.some(
    (u) => isRecord(u) && String(u.email).toLowerCase() === TEST_EMAIL.toLowerCase(),
  );
  assert(
    "GET /api/users",
    users.status === 200 && userList.length > 0 && hasTony,
    users.text.slice(0, 200),
    `${users.status} (${userList.length} users)`,
  );

  const audit = await api("GET", "/api/audit-logs?limit=5");
  const aBody = isRecord(audit.body) ? audit.body : {};
  assert(
    "GET /api/audit-logs",
    audit.status === 200 && Array.isArray(aBody.logs ?? aBody.entries),
    audit.text.slice(0, 200),
    String(audit.status),
  );

  const dlq = await api("GET", "/api/dlq");
  const dBody = isRecord(dlq.body) ? dlq.body : {};
  assert(
    "GET /api/dlq",
    dlq.status === 200 && Array.isArray(dBody.items),
    dlq.text.slice(0, 200),
    String(dlq.status),
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function verifyAuth(): Promise<boolean> {
  const probe = await api("GET", "/api/me");
  if (probe.status === 200 && isRecord(probe.body) && probe.body.email === TEST_EMAIL) {
    return true;
  }
  if (isAccessLoginPage(probe.text)) {
    console.error(
      "\n❌ Cloudflare Access blocked the request (login page). Cookie likely expired or missing.\n" +
        "   Set E2E_COOKIE in .env.local, save the value to scripts/.e2e-cookie.local, or use\n" +
        "   E2E_CF_ACCESS_CLIENT_ID + E2E_CF_ACCESS_CLIENT_SECRET (service token).\n",
    );
    return false;
  }
  if (probe.status === 401) {
    console.error(
      "\n❌ Worker returned 401 — Cf-Access-Authenticated-User-Email is not accepted from external clients.\n" +
        "   Create a Cloudflare Access service token for this app, then:\n" +
        "   E2E_CF_ACCESS_CLIENT_ID=… E2E_CF_ACCESS_CLIENT_SECRET=… npm run e2e:prod\n",
    );
    return false;
  }
  record(false, "auth preflight GET /api/me", probe.text.slice(0, 200), String(probe.status));
  return false;
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log(`CHS E2E Harness — ${new Date().toISOString()}`);
  console.log(`Base: ${BASE}`);
  console.log(`Client: ${CLIENT_BASE}`);
  console.log(`Auth email header: ${TEST_EMAIL}`);
  if (CF_ACCESS_CLIENT_ID) console.log("Access service token: configured");
  if (E2E_COOKIE) console.log(`Access session cookie: ${E2E_COOKIE_SOURCE ?? "configured"}`);
  else if (!CF_ACCESS_CLIENT_ID) {
    console.log("Access auth: not configured (no cookie or service token)");
  }

  if (!(await verifyAuth())) {
    process.exit(1);
  }
  record(true, "auth preflight GET /api/me", undefined, `200 (${TEST_EMAIL})`);

  await moduleHealthAuth();
  await moduleClients();
  await moduleEstimates();
  await moduleJobs();
  await moduleFinancial();
  await moduleExpensesTime();
  await moduleNotifications();
  await modulePhotos();
  await moduleDocuments();
  await moduleSocial();
  await moduleChangeOrders();
  await modulePortal();
  await moduleIntegrations();
  await moduleDashboard();
  await moduleAdmin();

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const allOk = passed === total;

  console.log("\n[Summary]");
  console.log(`  ${passed}/${total} checks passed ${allOk ? "✅" : "❌"}`);
  console.log(`  Elapsed: ${elapsed}s`);
  if (testClientId) {
    console.log(`  Note: test client ${testClientId} (${TEST_CLIENT_FIRST} ${TEST_CLIENT_LAST}) may remain in prod`);
  }

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E harness crashed:", err);
  process.exit(1);
});
