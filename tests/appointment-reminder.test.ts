import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  dispatchRow,
  formatAppointmentClock,
  planAppointmentReminder,
} from "../src/lib/notification-engine.js";

const NOON = { appointmentDate: "2026-10-20", appointmentTime: "12:00" };
const AFTERNOON = { appointmentDate: "2026-10-20", appointmentTime: "14:30" };
const EARLY = { appointmentDate: "2026-10-20", appointmentTime: "08:00" };

describe("appointment reminder window", () => {
  it("waits until the visit morning when the visit was booked the afternoon before", () => {
    const bookedAt = "2026-10-19 20:44:47";
    expect(
      planAppointmentReminder({
        ...NOON,
        bookedAt,
        now: new Date("2026-10-19T21:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      planAppointmentReminder({
        ...NOON,
        bookedAt,
        now: new Date("2026-10-20T13:00:00.000Z"),
      }),
    ).toEqual({
      dayWord: "today",
      timeLabel: "12:00 PM",
      instanceKey: "2026-10-20",
    });
  });

  it("waits until the visit morning when the visit was booked days ahead", () => {
    const bookedAt = "2026-10-15T15:00:00.000Z";
    expect(
      planAppointmentReminder({
        ...AFTERNOON,
        bookedAt,
        now: new Date("2026-10-19T21:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      planAppointmentReminder({
        ...AFTERNOON,
        bookedAt,
        now: new Date("2026-10-20T12:59:00.000Z"),
      }),
    ).toBeNull();
    expect(
      planAppointmentReminder({
        ...AFTERNOON,
        bookedAt,
        now: new Date("2026-10-20T13:00:00.000Z"),
      }),
    ).toEqual({
      dayWord: "today",
      timeLabel: "2:30 PM",
      instanceKey: "2026-10-20",
    });
  });

  it("sends no reminder when the visit was booked the same Central day", () => {
    expect(
      planAppointmentReminder({
        ...AFTERNOON,
        bookedAt: "2026-10-20T14:00:00.000Z",
        now: new Date("2026-10-20T14:15:00.000Z"),
      }),
    ).toBeNull();
  });

  it("reminds an 8:00 AM visit the evening before, and not at 8:00 AM", () => {
    const bookedAt = "2026-10-15T15:00:00.000Z";
    expect(
      planAppointmentReminder({
        ...EARLY,
        bookedAt,
        now: new Date("2026-10-19T22:59:00.000Z"),
      }),
    ).toBeNull();
    expect(
      planAppointmentReminder({
        ...EARLY,
        bookedAt,
        now: new Date("2026-10-19T23:00:00.000Z"),
      }),
    ).toEqual({
      dayWord: "tomorrow",
      timeLabel: "8:00 AM",
      instanceKey: "2026-10-20",
    });
    expect(
      planAppointmentReminder({
        ...EARLY,
        bookedAt,
        now: new Date("2026-10-20T13:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("does not treat a date-only visit as midnight UTC", () => {
    expect(
      planAppointmentReminder({
        appointmentDate: "2026-10-20",
        appointmentTime: "12:00",
        bookedAt: "2026-10-19T20:44:47.000Z",
        now: new Date("2026-10-19T21:00:00.000Z"),
      }),
    ).toBeNull();
    expect(formatAppointmentClock("12:00")).toBe("12:00 PM");
    expect(formatAppointmentClock("14:30")).toBe("2:30 PM");
    expect(formatAppointmentClock("8:00 AM")).toBe("8:00 AM");
  });
});

describe("appointment reminder daily cap", () => {
  it("defers the reminder once the client already has 5 texts that day", async () => {
    const held = await sendReminder({ sentToday: 5 });
    expect(held.stats.deferred).toBe(1);
    expect(held.stats.simulated).toBe(0);
    expect(held.messages).toContain("deferred: SMS daily limit reached");

    const allowed = await sendReminder({ sentToday: 4 });
    expect(allowed.stats.deferred).toBe(0);
    expect(allowed.stats.simulated).toBe(1);
    expect(allowed.messages).not.toContain("deferred: SMS daily limit reached");
  });
});

async function sendReminder(opts: { sentToday: number }) {
  const messages: string[] = [];
  const env = {
    NOTIFICATIONS_DISPATCH_MODE: "simulate",
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (sql.startsWith("UPDATE notification_logs SET status = 'queued'")) {
              messages.push(String(args[1]));
            }
            return this;
          },
          async first() {
            if (sql.includes("COUNT(*)")) return { n: opts.sentToday };
            if (sql.includes("notification_preferences")) return { notification_preferences: null };
            if (sql.includes("notification_templates")) return { name: "Appointment Reminder" };
            return null;
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
          async all() {
            return { results: [] };
          },
        };
      },
    },
  } as unknown as Env;
  const stats = {
    scanned_enqueued: 0,
    sent: 0,
    simulated: 0,
    failed: 0,
    deferred: 0,
    suppressed: 0,
    dead_lettered: 0,
    duration_ms: 0,
  };
  await dispatchRow(
    env,
    {
      id: "log-1",
      template_id: "nt-appointment-reminder-sms",
      trigger_event: "appointment_reminder",
      recipient_type: "client",
      recipient_name: "Karen Perry",
      recipient_contact: "5015550100",
      recipient_user_id: null,
      channel: "sms",
      subject: null,
      body: "Hey Karen, just a reminder — Tony from Columbus Home Solutions is looking forward to meeting with you today at 2:30 PM! See you soon.",
      status: "queued",
      retry_count: 0,
      scheduled_for: "2026-10-20T13:00:00.000Z",
      job_id: null,
      client_id: "client-1",
      estimate_request_id: "request-1",
      link_path: null,
    },
    stats,
    { now: new Date("2026-10-20T13:00:00.000Z") },
  );
  return { stats, messages };
}
