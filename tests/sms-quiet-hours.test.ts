import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { nextDayRateSendAt, queueDayRateNotice } from "../src/lib/day-rate-notify.js";
import {
  smsQuietDeferral,
  smsQuietOptionsForEvent,
} from "../src/lib/notification-engine.js";

function centralHour(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function centralDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 6:30 AM, 7:05 AM, and 8:05 PM Central on a normal CDT day (Oct 9, 2026). */
const CDT = {
  at630: new Date("2026-10-09T11:30:00.000Z"),
  at700: new Date("2026-10-09T12:00:00.000Z"),
  at705: new Date("2026-10-09T12:05:00.000Z"),
  at730: new Date("2026-10-09T12:30:00.000Z"),
  at805pm: new Date("2026-10-10T01:05:00.000Z"),
  at905pm: new Date("2026-10-10T02:05:00.000Z"),
};

const DEFAULT_EVENTS = [
  "lead_created",
  "estimate_sent",
  "invoice_sent",
  "invoice_due_reminder",
  "review_request",
  "sub_scheduled",
  "sub_schedule_change",
  "sub_schedule_cancelled",
];

function envWithWorker(textUpdates: number) {
  const inserts: { when: string; event: string }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            args = bound;
            return this;
          },
          async first() {
            if (sql.includes("FROM subcontractors")) {
              return {
                id: "w1",
                worker_type: "day_rate_labor",
                phone: "5015550100",
                email: null,
                text_updates_enabled: textUpdates,
                is_active: 1,
                preferred_language: "en",
                name: "ZZ",
              };
            }
            return null;
          },
          async run() {
            if (sql.includes("INSERT INTO notification_logs")) {
              inserts.push({ when: String(args[8]), event: String(args[2]) });
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, inserts };
}

describe("day-rate morning floor", () => {
  it("holds a 6:30 AM text until 7:00 AM and the gate releases it there", async () => {
    const { env, inserts } = envWithWorker(1);
    const queued = await queueDayRateNotice(
      env,
      { subId: "w1", kind: "schedule", label: "102 Kitchen", link: "https://client.homesolutionsar.com/sub/abc" },
      CDT.at630,
    );
    expect(queued.queued).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].event).toBe("day_rate_schedule");
    expect(centralHour(inserts[0].when)).toBe("07");
    expect(centralDate(inserts[0].when)).toBe("2026-10-09");
    expect(smsQuietDeferral("day_rate_schedule", CDT.at630)).toEqual({
      defer: true,
      until: inserts[0].when,
    });
    expect(smsQuietDeferral("day_rate_punch", CDT.at700)).toEqual({ defer: false });
  });

  it("sends a 7:05 AM event in the next 15-minute batch", () => {
    const when = nextDayRateSendAt(CDT.at705);
    expect(Date.parse(when) - CDT.at705.getTime()).toBe(15 * 60 * 1000);
    expect(smsQuietDeferral("day_rate_schedule", CDT.at705)).toEqual({ defer: false });
    expect(smsQuietDeferral("day_rate_punch", new Date(when))).toEqual({ defer: false });
  });

  it("holds an 8:05 PM event until the next 7:00 AM", () => {
    const when = nextDayRateSendAt(CDT.at805pm);
    expect(centralHour(when)).toBe("07");
    expect(centralDate(when)).toBe("2026-10-10");
    expect(smsQuietDeferral("day_rate_schedule", new Date(when))).toEqual({ defer: false });
    expect(smsQuietDeferral("day_rate_punch", CDT.at805pm)).toEqual({ defer: false });
    expect(smsQuietDeferral("sub_scheduled", CDT.at805pm)).toEqual({ defer: false });
    const customerLate = smsQuietDeferral("lead_created", CDT.at905pm);
    expect(customerLate.defer).toBe(true);
    if (customerLate.defer) {
      expect(centralHour(customerLate.until)).toBe("08");
      expect(centralDate(customerLate.until)).toBe("2026-10-10");
    }
    const late = smsQuietDeferral("day_rate_schedule", CDT.at905pm);
    expect(late.defer).toBe(true);
    if (late.defer) {
      expect(centralHour(late.until)).toBe("07");
      expect(centralDate(late.until)).toBe("2026-10-10");
    }
  });

  it("keeps the 8:00 AM floor for customer, lead, and true subcontractor texts at 7:30 AM", () => {
    for (const event of DEFAULT_EVENTS) {
      expect(smsQuietOptionsForEvent(event)).toBeUndefined();
      const hold = smsQuietDeferral(event, CDT.at730);
      expect(hold.defer).toBe(true);
      if (hold.defer) {
        expect(centralHour(hold.until)).toBe("08");
        expect(centralDate(hold.until)).toBe("2026-10-09");
      }
    }
    expect(smsQuietOptionsForEvent("day_rate_schedule")).toEqual({ morningHour: 7 });
    expect(smsQuietOptionsForEvent("day_rate_punch")).toEqual({ morningHour: 7 });
    expect(smsQuietDeferral("day_rate_schedule", CDT.at730)).toEqual({ defer: false });
  });

  it("uses 7:00 AM Central on both sides of the spring and fall clock changes", () => {
    const mornings = [
      { at: new Date("2026-03-07T12:30:00.000Z"), day: "2026-03-07", release: "2026-03-07T13:00:00.000Z" },
      { at: new Date("2026-03-09T11:30:00.000Z"), day: "2026-03-09", release: "2026-03-09T12:00:00.000Z" },
      { at: new Date("2026-10-31T11:30:00.000Z"), day: "2026-10-31", release: "2026-10-31T12:00:00.000Z" },
      { at: new Date("2026-11-02T12:30:00.000Z"), day: "2026-11-02", release: "2026-11-02T13:00:00.000Z" },
    ];
    for (const row of mornings) {
      const queued = nextDayRateSendAt(row.at);
      expect(queued).toBe(row.release);
      expect(centralHour(queued)).toBe("07");
      expect(centralDate(queued)).toBe(row.day);
      const hold = smsQuietDeferral("day_rate_punch", row.at);
      expect(hold).toEqual({ defer: true, until: row.release });
      const customer = smsQuietDeferral("invoice_sent", row.at);
      expect(customer.defer).toBe(true);
      if (customer.defer) {
        expect(centralHour(customer.until)).toBe("08");
        expect(centralDate(customer.until)).toBe(row.day);
      }
    }
  });
});

describe("text updates off", () => {
  it("queues nothing at 6:30 AM, 7:05 AM, or 8:05 PM, including STOP", async () => {
    for (const now of [CDT.at630, CDT.at705, CDT.at805pm]) {
      const { env, inserts } = envWithWorker(0);
      const result = await queueDayRateNotice(
        env,
        { subId: "w1", kind: "punch", label: "Pergola", link: "https://client.homesolutionsar.com/sub/abc" },
        now,
      );
      expect(result).toEqual({ queued: false, reason: "text_updates_off" });
      expect(inserts).toEqual([]);
    }
  });
});
