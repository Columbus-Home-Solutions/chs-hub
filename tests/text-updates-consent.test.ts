import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { queueDayRateNotice } from "../src/lib/day-rate-notify.js";
import { dispatchRow } from "../src/lib/notification-engine.js";
import { handleTextUpdates } from "../src/routes/labor-checkin.js";
import { handleSubcontractorGet } from "../src/routes/subcontractors.js";
import { stopWorkerTexts } from "../src/routes/webhooks-twilio.js";
import { textUpdatesSwitchLabel } from "../frontend/src/lib/text-updates";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const AFTERNOON = new Date("2026-10-09T19:00:00Z");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function db(
  handler: (sql: string, args: unknown[]) => {
    first?: () => unknown;
    all?: () => unknown;
    run?: () => unknown;
  },
): Env {
  return {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            args = bound;
            return this;
          },
          async first() {
            const row = handler(sql, args);
            return row.first ? row.first() : null;
          },
          async all() {
            const row = handler(sql, args);
            return row.all ? row.all() : { results: [] };
          },
          async run() {
            const row = handler(sql, args);
            return row.run ? row.run() : { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
  } as unknown as Env;
}

function worker(textUpdates: number, isActive = 1) {
  return {
    id: "w1",
    company: "ZZ",
    company_name: "ZZ",
    contact_name: null,
    primary_contact: null,
    phone: "(501) 555-0100",
    email: "worker@example.com",
    is_active: isActive,
    worker_type: "day_rate_labor",
    text_updates_enabled: textUpdates,
    text_updates_enabled_at: textUpdates ? "2026-10-09 11:55:41" : null,
    text_updates_enabled_by: textUpdates ? "staff@example.com" : null,
    preferred_language: "en",
    created_at: "2026-10-09 11:00:00",
    updated_at: "2026-10-09 11:26:07",
  };
}

describe("worker page reads the saved switch", () => {
  it("API returns text_updates_enabled on for 1 and off for 0", async () => {
    for (const flag of [1, 0]) {
      const env = db((sql) => ({
        first: () => (sql.includes("FROM subcontractors") ? worker(flag) : null),
        all: () => ({ results: [] }),
      }));
      const res = await handleSubcontractorGet(env, "w1");
      const body = (await res.json()) as {
        subcontractor: { text_updates_enabled: boolean };
      };
      expect(body.subcontractor.text_updates_enabled).toBe(flag === 1);
    }
  });

  it("a fresh load shows ON when the column is 1 and OFF when it is 0", () => {
    expect(textUpdatesSwitchLabel(true)).toBe("ON");
    expect(textUpdatesSwitchLabel(false)).toBe("OFF");
    const src = readFileSync(
      join(repoRoot, "frontend/src/views/subcontractors/SubcontractorDetail.tsx"),
      "utf8",
    );
    const card = src.slice(src.indexOf("function CheckinLinkCard"));
    expect(card).toMatch(/const \[texts, setTexts\] = useState\(textUpdatesEnabled\)/);
    expect(card).toContain("textUpdatesSwitchLabel(texts)");
    expect(src).toContain("textUpdatesEnabled={s.text_updates_enabled === true}");
  });
});

function noticeRow(trigger: string, contact = "(501) 555-0100", clientId: string | null = null) {
  return {
    id: "log-1",
    template_id: "nt-day-rate-schedule",
    trigger_event: trigger,
    recipient_type: clientId ? "client" : "subcontractor",
    recipient_name: "ZZ",
    recipient_contact: contact,
    recipient_user_id: null,
    channel: "sms",
    subject: null,
    body: "CHS: schedule",
    status: "queued",
    retry_count: 0,
    scheduled_for: "2026-10-09T19:00:00.000Z",
    job_id: null,
    client_id: clientId,
    estimate_request_id: null,
    link_path: null,
  };
}

function liveEnv(
  workerRow: ReturnType<typeof worker> | null,
  writes: { sql: string; args: unknown[] }[],
): Env {
  const env = db((sql, args) => ({
    first: () => (sql.includes("FROM subcontractors") ? workerRow : null),
    run: () => {
      writes.push({ sql, args });
      return { success: true, meta: { changes: 1 } };
    },
  }));
  env.TWILIO_ACCOUNT_SID = "ACtest";
  env.TWILIO_AUTH_TOKEN = "token";
  env.TWILIO_FROM_NUMBER = "+15015550199";
  env.NOTIFICATIONS_DISPATCH_MODE = "live";
  return env;
}

describe("send-time re-check", () => {
  it("skips a queued day-rate text when the switch is off and sends nothing", async () => {
    const writes: { sql: string; args: unknown[] }[] = [];
    let sent = 0;
    globalThis.fetch = (async () => {
      sent += 1;
      return new Response(JSON.stringify({ sid: "SM_TEST" }), { status: 200 });
    }) as typeof fetch;
    const env = liveEnv(worker(0), writes);
    const stats = { suppressed: 0, sent: 0, simulated: 0, deferred: 0, failed: 0, dead_lettered: 0, scanned_enqueued: 0, duration_ms: 0 };
    await dispatchRow(env, noticeRow("day_rate_schedule"), stats, { now: AFTERNOON });
    expect(sent).toBe(0);
    expect(stats.suppressed).toBe(1);
    expect(writes.some((w) => w.args.includes("suppressed:text_updates_off"))).toBe(true);
  });

  it("sends one day-rate text when the switch is on", async () => {
    const writes: { sql: string; args: unknown[] }[] = [];
    let sent = 0;
    globalThis.fetch = (async () => {
      sent += 1;
      return new Response(JSON.stringify({ sid: "SM_ON" }), { status: 200 });
    }) as typeof fetch;
    const env = liveEnv(worker(1), writes);
    const stats = { suppressed: 0, sent: 0, simulated: 0, deferred: 0, failed: 0, dead_lettered: 0, scanned_enqueued: 0, duration_ms: 0 };
    await dispatchRow(env, noticeRow("day_rate_punch"), stats, { now: AFTERNOON });
    expect(sent).toBe(1);
    expect(stats.sent).toBe(1);
    expect(writes.some((w) => w.args.includes("suppressed:text_updates_off"))).toBe(false);
  });

  it("leaves true subcontractor and customer texts alone", async () => {
    const writes: { sql: string; args: unknown[] }[] = [];
    let sent = 0;
    globalThis.fetch = (async () => {
      sent += 1;
      return new Response(JSON.stringify({ sid: "SM_OTHER" }), { status: 200 });
    }) as typeof fetch;
    const env = liveEnv(worker(0), writes);
    const stats = { suppressed: 0, sent: 0, simulated: 0, deferred: 0, failed: 0, dead_lettered: 0, scanned_enqueued: 0, duration_ms: 0 };
    await dispatchRow(env, noticeRow("sub_scheduled"), stats, { now: AFTERNOON });
    await dispatchRow(env, noticeRow("estimate_sent", "+15015550100", "client-1"), stats, { now: AFTERNOON });
    expect(sent).toBe(2);
    expect(writes.some((w) => String(w.args).includes("text_updates_off"))).toBe(false);
  });
});

describe("STOP and uncheck cancel queued rows", () => {
  it("stopWorkerTexts cancels queued rows and later notices queue nothing", async () => {
    const writes: { sql: string; args: unknown[] }[] = [];
    const env = db((sql, args) => ({
      first: () =>
        sql.includes("FROM subcontractors")
          ? { id: "w1", worker_type: "day_rate_labor", phone: "5015550100", email: null, text_updates_enabled: 0, is_active: 1, name: "ZZ" }
          : null,
      run: () => {
        writes.push({ sql, args });
        return { success: true, meta: { changes: 1 } };
      },
    }));
    await stopWorkerTexts(env, "5015550100");
    expect(writes.some((w) => w.sql.includes("text_updates_enabled = 0") && w.sql.includes("inbound_stop"))).toBe(true);
    expect(writes.some((w) => w.sql.includes("notification_logs") && w.args.includes("suppressed:inbound_stop"))).toBe(true);
    const queued = await queueDayRateNotice(env, {
      subId: "w1",
      kind: "schedule",
      label: "added",
      link: "https://client.homesolutionsar.com/sub/abc",
    });
    expect(queued).toEqual({ queued: false, reason: "text_updates_off" });
    expect(writes.some((w) => w.sql.includes("INSERT INTO notification_logs"))).toBe(false);
  });

  it("unchecking in the app cancels queued rows", async () => {
    const writes: { sql: string; args: unknown[] }[] = [];
    const env = db((sql, args) => ({
      first: () => {
        if (sql.includes("FROM users")) {
          return { id: "u1", email: "tony@example.com", first_name: "Tony", last_name: "C", role: "owner", is_active: 1 };
        }
        if (sql.includes("FROM subcontractors")) return { phone: "(501) 555-0100", email: "worker@example.com" };
        return null;
      },
      run: () => {
        writes.push({ sql, args });
        return { success: true, meta: { changes: 2 } };
      },
    }));
    const req = new Request("https://dashboard.example/api/labor/workers/w1/text-updates", {
      method: "PUT",
      headers: { "Cf-Access-Authenticated-User-Email": "tony@example.com", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await handleTextUpdates(req, env, "w1");
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.sql.includes("text_updates_enabled") && w.args[0] === 0)).toBe(true);
    expect(writes.some((w) => w.args.includes("suppressed:text_updates_off"))).toBe(true);
  });
});
