import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { decryptToken, encryptToken, getValidAccessToken } from "../src/lib/qbo-auth.js";
import { ensureQboExpenseSyncSetting, runQboSweep } from "../src/lib/qbo-sync.js";
import {
  decideKeepaliveAlert,
  keepaliveDue,
  QBO_KEEPALIVE_STALE_DAYS,
  runQboTokenKeepalive,
} from "../src/lib/qbo-token-keepalive.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCESS = "aaa-access-token";
const REFRESH_V1 = "bbb-refresh-token-v1";
const REFRESH_V2 = "ccc-refresh-token-v2";
const MONDAY = new Date("2026-10-12T07:15:00.000Z");
const WEDNESDAY = new Date("2026-10-07T07:15:00.000Z");
const STALE_WEDNESDAY = new Date("2026-10-14T07:15:00.000Z");

function makeEnv(initial?: { lastRefresh?: string | null; expiry?: string | null }) {
  const settings = new Map<string, string>([
    ["qbo_invoice_sync_enabled", "false"],
    ["qbo_payment_sync_enabled", "false"],
    ["qbo_expense_sync_enabled", "false"],
  ]);
  if (initial?.lastRefresh) settings.set("qbo_last_token_refresh", initial.lastRefresh);

  const state = {
    status: "connected",
    encAccess: null as string | null,
    encRefresh: null as string | null,
    expiry: initial?.expiry ?? "2026-08-21T22:15:20.771Z",
    account_id: "REALM-PROD",
    configuration: JSON.stringify({ environment: "production", company_name: "CHS" }),
    last_error: null as string | null,
    last_sync: null as string | null,
  };
  const sqlLog: string[] = [];
  const alerts: Array<{ message: string; link: string | null }> = [];
  let connectionWrites = 0;

  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...next: unknown[]) {
          args = next;
          return stmt;
        },
        async first() {
          if (sql.includes("integration_connections")) {
            return {
              id: "quickbooks",
              status: state.status,
              access_token: state.encAccess,
              refresh_token: state.encRefresh,
              token_expiry: state.expiry,
              account_id: state.account_id,
              configuration: state.configuration,
              last_sync: state.last_sync,
              last_error: state.last_error,
            };
          }
          if (sql.includes("FROM users")) {
            return {
              id: "owner-1",
              email: "tony@example.com",
              first_name: "Tony",
              last_name: "Columbus",
              phone: null,
            };
          }
          if (sql.includes("system_settings")) {
            const key = String(args[0] ?? "");
            if (!settings.has(key)) return null;
            return { value: settings.get(key) };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          sqlLog.push(sql);
          if (sql.includes("INSERT INTO integration_connections")) {
            connectionWrites += 1;
            state.status = String(args[2]);
            state.encAccess = (args[3] as string | null) ?? null;
            state.encRefresh = (args[4] as string | null) ?? null;
            state.expiry = String(args[5]);
            if (args[6] != null) state.account_id = String(args[6]);
            if (args[7] != null) state.configuration = String(args[7]);
            state.last_error = null;
          } else if (sql.includes("status = 'error'")) {
            state.status = "error";
            state.last_error = String(args[0] ?? "");
          } else if (sql.includes("last_sync")) {
            state.last_sync = String(args[0] ?? "");
          } else if (sql.includes("INSERT INTO system_settings")) {
            const key = String(args[0]);
            if (sql.includes("DO NOTHING")) {
              if (!settings.has(key)) settings.set(key, "false");
            } else {
              settings.set(key, String(args[1]));
            }
          } else if (sql.includes("notification_logs")) {
            alerts.push({
              message: String(args[5] ?? ""),
              link: (args[7] as string | null) ?? null,
            });
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };

  const env = {
    QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key",
    QBO_CLIENT_ID: "id",
    QBO_CLIENT_SECRET: "secret",
    DB: db,
  } as unknown as Env;

  return { env, state, settings, sqlLog, alerts, writes: () => connectionWrites };
}

function tokenResponse(ok: boolean) {
  if (!ok) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  return new Response(
    JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH_V2, expires_in: 3600 }),
    { status: 200 },
  );
}

function stubFetch(ok: boolean) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("quickbooks.api.intuit.com")) {
        throw new Error("accounting API called");
      }
      return tokenResponse(ok);
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("keepalive schedule", () => {
  it("runs on Monday and when the token is older than half the 100-day lifetime", () => {
    expect(QBO_KEEPALIVE_STALE_DAYS).toBe(50);
    expect(keepaliveDue(MONDAY, "2026-10-11T07:15:00.000Z")).toBe(true);
    expect(keepaliveDue(WEDNESDAY, "2026-08-21T22:15:20.771Z")).toBe(false);
    expect(keepaliveDue(STALE_WEDNESDAY, "2026-08-21T22:15:20.771Z")).toBe(true);
    expect(keepaliveDue(WEDNESDAY, null)).toBe(true);
  });

  it("alerts once on the second consecutive failure and resets after success", () => {
    const first = decideKeepaliveAlert({ status: "none", streak: 0, notified: false }, false);
    expect(first.notify).toBe(false);
    const second = decideKeepaliveAlert(first.state, false);
    expect(second.notify).toBe(true);
    const third = decideKeepaliveAlert(second.state, false);
    expect(third.notify).toBe(false);
    const reset = decideKeepaliveAlert(third.state, true);
    expect(reset.notify).toBe(false);
    expect(reset.state).toMatchObject({ status: "ok", streak: 0, notified: false });
    const again = decideKeepaliveAlert(reset.state, false);
    expect(again.notify).toBe(false);
  });
});

describe("runQboTokenKeepalive", () => {
  it("persists the rotated refresh token and expiry in one write and leaves realm and environment", async () => {
    const { env, state, settings, writes } = makeEnv();
    state.encAccess = await encryptToken(env, "old-access");
    state.encRefresh = await encryptToken(env, REFRESH_V1);
    const urls = stubFetch(true);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => {
      logs.push(parts.map(String).join(" "));
    });

    const result = await runQboTokenKeepalive(env, { now: MONDAY });

    expect(result.ok).toBe(true);
    expect(writes()).toBe(1);
    expect(await decryptToken(env, state.encAccess)).toBe(ACCESS);
    expect(await decryptToken(env, state.encRefresh)).toBe(REFRESH_V2);
    expect(Date.parse(state.expiry)).toBeGreaterThan(Date.now());
    expect(state.account_id).toBe("REALM-PROD");
    expect(state.configuration).toContain('"environment":"production"');
    expect(state.status).toBe("connected");
    expect(settings.get("qbo_last_token_refresh")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(urls).toEqual(["https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"]);
    expect(logs.join("\n")).toContain("access_len=");
    expect(logs.join("\n")).not.toContain(ACCESS);
    expect(logs.join("\n")).not.toContain(REFRESH_V1);
    expect(logs.join("\n")).not.toContain(REFRESH_V2);
  });

  it("leaves stored tokens, realm, and environment untouched when refresh is rejected", async () => {
    const { env, state, sqlLog, alerts } = makeEnv();
    const encAccess = await encryptToken(env, "old-access");
    const encRefresh = await encryptToken(env, REFRESH_V1);
    state.encAccess = encAccess;
    state.encRefresh = encRefresh;
    stubFetch(false);
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...parts) => {
      logs.push(parts.map(String).join(" "));
    });

    const result = await runQboTokenKeepalive(env, { force: true, now: WEDNESDAY });

    expect(result.ok).toBe(false);
    expect(result.notified).toBe(false);
    expect(state.encAccess).toBe(encAccess);
    expect(state.encRefresh).toBe(encRefresh);
    expect(state.expiry).toBe("2026-08-21T22:15:20.771Z");
    expect(state.status).toBe("error");
    expect(state.account_id).toBe("REALM-PROD");
    expect(state.configuration).toContain('"environment":"production"');
    expect(alerts).toHaveLength(0);
    expect(sqlLog.some((sql) => sql.includes("sync_dead_letters"))).toBe(false);
    expect(logs.join("\n")).not.toContain(REFRESH_V1);
  });

  it("fires one bell on the second failure, stays quiet on the third, and resets after success", async () => {
    const { env, state, alerts } = makeEnv();
    state.encRefresh = await encryptToken(env, REFRESH_V1);
    stubFetch(false);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runQboTokenKeepalive(env, { force: true, now: WEDNESDAY });
    await runQboTokenKeepalive(env, { force: true, now: WEDNESDAY });
    await runQboTokenKeepalive(env, { force: true, now: WEDNESDAY });

    expect(alerts).toEqual([
      {
        message: "QuickBooks connection needs attention — token refresh failing",
        link: "/app/settings",
      },
    ]);

    vi.unstubAllGlobals();
    stubFetch(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const healed = await runQboTokenKeepalive(env, { force: true, now: WEDNESDAY });
    expect(healed.ok).toBe(true);
    expect(alerts).toHaveLength(1);

    vi.unstubAllGlobals();
    stubFetch(false);
    await runQboTokenKeepalive(env, { force: true, now: WEDNESDAY });
    expect(alerts).toHaveLength(1);
    await runQboTokenKeepalive(env, { force: true, now: WEDNESDAY });
    expect(alerts).toHaveLength(2);
  });

  it("refreshes on Monday with every push gate off and makes no accounting API call", async () => {
    const { env, state, sqlLog } = makeEnv();
    state.encAccess = await encryptToken(env, "old-access");
    state.encRefresh = await encryptToken(env, REFRESH_V1);
    const urls = stubFetch(true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const keep = await runQboTokenKeepalive(env, { now: MONDAY });
    const sweep = await runQboSweep(env);
    // The sweep asks for an access token without forcing a refresh. The token
    // the keepalive just stored is still valid, so this must not hit Intuit again.
    const sweepToken = await getValidAccessToken(env);

    expect(keep.ran).toBe(true);
    expect(keep.ok).toBe(true);
    expect(sweep.ran).toBe(true);
    expect(sweepToken).toBe(ACCESS);
    expect(sweep.invoices).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(sweep.payments).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(sweep.expenses).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(urls).toEqual(["https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"]);
    expect(sqlLog.some((sql) => sql.includes("sync_dead_letters"))).toBe(false);
    expect(sqlLog.some((sql) => sql.includes("FROM expenses"))).toBe(false);
    expect(state.account_id).toBe("REALM-PROD");
    expect(state.configuration).toContain('"environment":"production"');

    const indexSrc = readFileSync(join(HERE, "../src/index.ts"), "utf8");
    const keepAt = indexSrc.indexOf("runQboTokenKeepalive(env)");
    const sweepAt = indexSrc.indexOf("runQboSweep(env)");
    expect(keepAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(keepAt);
  });

  it("collapses two overlapping refreshes into one token request", async () => {
    const { env, state } = makeEnv();
    state.encAccess = await encryptToken(env, "old-access");
    state.encRefresh = await encryptToken(env, REFRESH_V1);
    const urls = stubFetch(true);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const [a, b] = await Promise.all([
      getValidAccessToken(env, { forceRefresh: true }),
      getValidAccessToken(env, { forceRefresh: true }),
    ]);

    expect(a).toBe(ACCESS);
    expect(b).toBe(ACCESS);
    expect(urls).toEqual(["https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"]);
    expect(await decryptToken(env, state.encRefresh)).toBe(REFRESH_V2);
  });

  it("skips a mid-week token that is still inside the 50-day window", async () => {
    const { env, state, writes } = makeEnv({
      lastRefresh: "2026-08-21T22:15:20.771Z",
    });
    state.encRefresh = await encryptToken(env, REFRESH_V1);
    const urls = stubFetch(true);

    const result = await runQboTokenKeepalive(env, { now: WEDNESDAY });

    expect(result).toEqual({ ran: false, reason: "not_due" });
    expect(urls).toEqual([]);
    expect(writes()).toBe(0);
  });
});

describe("expense push gate seed", () => {
  it("inserts false once and does not overwrite an existing true", async () => {
    const migration = readFileSync(join(HERE, "../migrations/0133_qbo_expense_sync_enabled.sql"), "utf8");
    expect(migration).toContain("'qbo_expense_sync_enabled'");
    expect(migration).toContain("'false'");
    expect(migration).toContain("ON CONFLICT(key) DO NOTHING");
    expect(migration).not.toMatch(/DO UPDATE/i);

    const settings = new Map<string, string>();
    const env = {
      DB: {
        prepare(sql: string) {
          let args: unknown[] = [];
          return {
            bind(...next: unknown[]) {
              args = next;
              return this;
            },
            async run() {
              expect(sql).toContain("ON CONFLICT(key) DO NOTHING");
              expect(sql).toContain("'false'");
              const key = String(args[0]);
              if (!settings.has(key)) settings.set(key, "false");
              return { success: true };
            },
          };
        },
      },
    } as unknown as Env;

    await ensureQboExpenseSyncSetting(env);
    await ensureQboExpenseSyncSetting(env);
    expect(settings.get("qbo_expense_sync_enabled")).toBe("false");

    settings.set("qbo_expense_sync_enabled", "true");
    await ensureQboExpenseSyncSetting(env);
    expect(settings.get("qbo_expense_sync_enabled")).toBe("true");
  });
});
