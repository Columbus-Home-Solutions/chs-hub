import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { dayRateMessage, nextDayRateSendAt } from "../src/lib/day-rate-notify.js";
import { runPunchListReminderSweep } from "../src/lib/punch-list-reminders.js";
import { handlePunchListRenotify, handlePunchListSend } from "../src/routes/punch-lists.js";

const USER = {
  id: "user-1",
  email: "tony@example.com",
  first_name: "Tony",
  last_name: "Columbus",
  role: "owner",
  is_active: 1,
};

function utcDay(offset = 0): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

interface Notice {
  body: string;
  when: string;
}

function harness(opts: {
  workerType: "day_rate_labor" | "subcontractor";
  textUpdates: number;
  language?: "en" | "es";
  scheduledDate?: string;
}) {
  const notices: Notice[] = [];
  const sms: string[] = [];
  let reminderSent: string | null = null;
  let followupSent: string | null = null;
  const logs: string[] = [];
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sms.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ sid: "SM_TEST" }), { status: 200 });
  }) as typeof fetch;

  const worker = {
    id: "w1",
    worker_type: opts.workerType,
    phone: "5015550100",
    email: null,
    text_updates_enabled: opts.textUpdates,
    is_active: 1,
    preferred_language: opts.language ?? "en",
    name: "ZZ",
    company_name: "ZZ Co",
    contact_name: "Sam",
  };
  const scheduledDate = opts.scheduledDate ?? utcDay(0);

  const env = {
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "token",
    TWILIO_FROM_NUMBER: "MGTEST",
    NOTIFICATIONS_DISPATCH_MODE: "simulate",
    FILES: { async put() {} },
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            args = bound;
            return this;
          },
          async first() {
            if (sql.includes("FROM users")) return USER;
            if (sql.includes("FROM punch_lists")) {
              return {
                id: "pl1",
                job_id: "j1",
                name: "Punch List",
                status: "sent",
                sent_at: "2026-10-01T00:00:00Z",
                scheduled_date: scheduledDate,
                job_title: "Pergola",
                property_address: "1 Main",
              };
            }
            if (sql.includes("FROM jobs")) return { data_source: null, status: "in_progress" };
            if (sql.includes("FROM subcontractors")) return worker;
            if (sql.includes("FROM punch_list_sub_tokens")) {
              return { token: "punch-token", id: "pst1", reminder_sent_at: reminderSent, followup_sent_at: followupSent };
            }
            if (sql.includes("FROM sub_access_tokens")) return { token: "persist" };
            if (sql.includes("COUNT(*)")) return { n: 1 };
            if (sql.includes("FROM notification_logs")) {
              return notices[0]
                ? { id: "n1", body: notices[0].body, error_message: notices[0].body }
                : null;
            }
            return null;
          },
          async all() {
            if (sql.includes("punch_list_sub_tokens")) {
              return {
                results: [{
                  id: "pst1",
                  sub_id: "w1",
                  token: "punch-token",
                  reminder_sent_at: reminderSent,
                  followup_sent_at: followupSent,
                  phone: worker.phone,
                  email: worker.email,
                  worker_type: worker.worker_type,
                  company_name: worker.company_name,
                  contact_name: worker.contact_name,
                  is_active: 1,
                }],
              };
            }
            if (sql.includes("FROM punch_lists")) {
              return {
                results: [{
                  id: "pl1",
                  job_id: "j1",
                  scheduled_date: scheduledDate,
                  sent_at: "2026-10-01",
                  job_title: "Pergola",
                  property_address: "1 Main",
                }],
              };
            }
            if (sql.includes("DISTINCT sub_id")) return { results: [{ sub_id: "w1" }] };
            if (sql.includes("punch_list_items")) {
              return { results: [{ id: "i1", sub_id: "w1", description: "Paint", sort_order: 1, created_at: "2026-10-02" }] };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("INSERT INTO notification_logs")) {
              notices.push({ body: String(args[7]), when: String(args[8]) });
            }
            if (sql.includes("UPDATE notification_logs SET body")) {
              if (notices[0]) notices[0] = { body: String(args[0]), when: String(args[1]) };
            }
            if (sql.includes("reminder_sent_at")) reminderSent = "now";
            if (sql.includes("followup_sent_at")) followupSent = "now";
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
  } as unknown as Env;

  const request = new Request("https://dashboard.example/api/punch-lists/pl1/send", {
    method: "POST",
    headers: { "Cf-Access-Authenticated-User-Email": USER.email },
  });

  return {
    env,
    notices,
    sms,
    logs,
    request,
    restore() {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
    },
  };
}

function heldUntilQuietHours(when: string): void {
  const before = Date.parse(nextDayRateSendAt());
  const stamp = Date.parse(when);
  const after = Date.parse(nextDayRateSendAt());
  expect(stamp).toBeGreaterThanOrEqual(before - 2000);
  expect(stamp).toBeLessThanOrEqual(after + 2000);
}

describe("punch reminder wording", () => {
  const link = "https://client.homesolutionsar.com/sub/persist";

  it("keeps the new-item sentence and adds a short reminder and yesterday line", () => {
    const added = dayRateMessage({ kind: "punch", count: 1, label: "Pergola", link, language: "es" });
    expect(added).toContain("Nuevo pendiente en Pergola");
    expect(added.endsWith("Responde STOP para cancelar.")).toBe(true);
    const reminder = dayRateMessage({ kind: "punch", count: 1, label: "Pergola", link, status: "reminder" });
    expect(reminder).toBe(`CHS: Reminder. Open punch items on Pergola. ${link}/punch\nReply STOP to opt out.`);
    const due = dayRateMessage({ kind: "punch", count: 1, label: "Pergola", link, status: "past_due", language: "es" });
    expect(due).toBe(`CHS: Los pendientes en Pergola vencieron ayer. ${link}/punch\nResponde STOP para cancelar.`);
  });
});

describe("day-rate punch texts honor Text updates", () => {
  afterEach(() => {
    /* restored per harness */
  });

  it("sends nothing and logs a skip when Text updates is off, including STOP", async () => {
    const box = harness({ workerType: "day_rate_labor", textUpdates: 0 });
    try {
      await handlePunchListSend(box.env, box.request, "pl1");
      await handlePunchListRenotify(box.env, box.request, "pl1");
      await runPunchListReminderSweep(box.env);
      expect(box.notices).toEqual([]);
      expect(box.sms).toEqual([]);
      expect(box.logs.filter((line) => line.includes("reason=text_updates_off"))).toHaveLength(3);
    } finally {
      box.restore();
    }
  });

  it("queues one punch text per event in the worker language, and a second pass does not add another", async () => {
    const box = harness({ workerType: "day_rate_labor", textUpdates: 1, language: "es" });
    try {
      await handlePunchListSend(box.env, box.request, "pl1");
      await handlePunchListSend(box.env, box.request, "pl1");
      expect(box.notices).toHaveLength(1);
      expect(box.notices[0].body).toContain("Nuevo pendiente en Pergola");
      expect(box.notices[0].body).toContain("/sub/persist/punch");
      expect(box.notices[0].body.endsWith("Responde STOP para cancelar.")).toBe(true);
      heldUntilQuietHours(box.notices[0].when);
      expect(box.sms).toEqual([]);

      await handlePunchListRenotify(box.env, box.request, "pl1");
      await handlePunchListRenotify(box.env, box.request, "pl1");
      expect(box.notices).toHaveLength(1);
      expect(box.sms).toEqual([]);
    } finally {
      box.restore();
    }
  });

  it("queues the day-of reminder once, held for quiet hours", async () => {
    const box = harness({ workerType: "day_rate_labor", textUpdates: 1, language: "en" });
    try {
      await runPunchListReminderSweep(box.env);
      await runPunchListReminderSweep(box.env);
      expect(box.notices).toHaveLength(1);
      expect(box.notices[0].body).toContain("Reminder. Open punch items on Pergola");
      expect(box.notices[0].body).toContain("/punch");
      expect(box.notices[0].body.endsWith("Reply STOP to opt out.")).toBe(true);
      heldUntilQuietHours(box.notices[0].when);
      expect(box.sms).toEqual([]);
    } finally {
      box.restore();
    }
  });

  it("queues the day-after reminder in Spanish and does not text twice", async () => {
    const box = harness({
      workerType: "day_rate_labor",
      textUpdates: 1,
      language: "es",
      scheduledDate: utcDay(-1),
    });
    try {
      await runPunchListReminderSweep(box.env);
      await runPunchListReminderSweep(box.env);
      expect(box.notices).toHaveLength(1);
      expect(box.notices[0].body).toContain("vencieron ayer");
      expect(box.notices[0].body.endsWith("Responde STOP para cancelar.")).toBe(true);
      expect(box.sms).toEqual([]);
    } finally {
      box.restore();
    }
  });
});

describe("true subcontractors keep the old punch texts", () => {
  it("sends the old wording on all three paths even when Text updates is off", async () => {
    const box = harness({ workerType: "subcontractor", textUpdates: 0 });
    try {
      await handlePunchListSend(box.env, box.request, "pl1");
      await handlePunchListRenotify(box.env, box.request, "pl1");
      await runPunchListReminderSweep(box.env);
      expect(box.notices).toEqual([]);
      expect(box.logs.some((line) => line.includes("text_updates_off"))).toBe(false);
      const sent = box.sms.map((body) => decodeURIComponent(body.replace(/\+/g, " "))).join("\n");
      expect(sent).toContain("Tony from Columbus Home Solutions has a Punch List punch list");
      expect(sent).toContain("Tony added new items to your punch list");
      expect(sent).toContain("reminder: you have 1 open punch list item");
      expect(sent).not.toContain("Reply STOP to opt out");
    } finally {
      box.restore();
    }
  });
});
