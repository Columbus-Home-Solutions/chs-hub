import { describe, expect, it } from "vitest";
import {
  calcDaysSince,
  DAY1_BUFFER_MINUTES,
  isDay1BufferSatisfied,
  LEAD_OUTREACH_CANDIDATE_SQL,
} from "../src/lib/new-lead-outreach.js";

describe("LEAD_OUTREACH_CANDIDATE_SQL", () => {
  it("still drops scheduled leads immediately (appointment_date IS NULL)", () => {
    expect(LEAD_OUTREACH_CANDIDATE_SQL).toMatch(/er\.appointment_date IS NULL/);
  });

  it("does not special-case lead source — buffer applies to every candidate", () => {
    expect(LEAD_OUTREACH_CANDIDATE_SQL).not.toMatch(/google_lsa|thumbtack|high_level|source/);
  });
});

describe("calcDaysSince — Day 2/3 timing unchanged", () => {
  it("Day 2 still requires a full 24h (threshold 1)", () => {
    const created = new Date("2026-08-30T14:00:00.000Z");
    expect(calcDaysSince(created.toISOString(), new Date(created.getTime() + 23 * 3600_000))).toBe(0);
    expect(calcDaysSince(created.toISOString(), new Date(created.getTime() + 24 * 3600_000))).toBe(1);
  });

  it("Day 3 still requires 48h (threshold 2)", () => {
    const created = new Date("2026-08-30T14:00:00.000Z");
    expect(calcDaysSince(created.toISOString(), new Date(created.getTime() + 47 * 3600_000))).toBe(1);
    expect(calcDaysSince(created.toISOString(), new Date(created.getTime() + 48 * 3600_000))).toBe(2);
  });
});

describe("isDay1BufferSatisfied — 45-minute rolling buffer", () => {
  it("uses a 45-minute buffer", () => {
    expect(DAY1_BUFFER_MINUTES).toBe(45);
  });

  it("a lead created at T is not Day-1 eligible before T+45", () => {
    const created = "2026-08-30T19:00:00.000Z"; // 2:00pm CDT
    expect(isDay1BufferSatisfied(created, new Date("2026-08-30T19:00:00.000Z"))).toBe(false);
    expect(isDay1BufferSatisfied(created, new Date("2026-08-30T19:14:00.000Z"))).toBe(false);
    expect(isDay1BufferSatisfied(created, new Date("2026-08-30T19:44:59.000Z"))).toBe(false);
  });

  it("a lead created at T is Day-1 eligible at T+45", () => {
    const created = "2026-08-30T19:00:00.000Z";
    expect(isDay1BufferSatisfied(created, new Date("2026-08-30T19:45:00.000Z"))).toBe(true);
    expect(isDay1BufferSatisfied(created, new Date("2026-08-30T20:00:00.000Z"))).toBe(true);
  });

  it("accepts SQLite datetime('now') space format the same as ISO", () => {
    expect(isDay1BufferSatisfied("2026-08-30 19:00:00", new Date("2026-08-30T19:45:00.000Z"))).toBe(
      true,
    );
    expect(isDay1BufferSatisfied("2026-08-30 19:00:00", new Date("2026-08-30T19:10:00.000Z"))).toBe(
      false,
    );
  });

  it("late-evening Central lead (10pm) still waits the full 45 minutes same day", () => {
    // 10:00pm CDT Aug 30 = 03:00 UTC Aug 31; T+45 = 10:45pm CDT
    const created = "2026-08-31T03:00:00.000Z";
    expect(isDay1BufferSatisfied(created, new Date("2026-08-31T03:20:00.000Z"))).toBe(false);
    expect(isDay1BufferSatisfied(created, new Date("2026-08-31T03:45:00.000Z"))).toBe(true);
  });

  it("11:50pm Central: 45 min would cross midnight — send on the last stretch of that Central day", () => {
    // 11:50pm CDT Aug 30 = 04:50 UTC Aug 31; midnight CDT = 05:00 UTC
    const created = "2026-08-31T04:50:00.000Z";
    expect(isDay1BufferSatisfied(created, new Date("2026-08-31T04:55:00.000Z"))).toBe(true);
  });

  it("if the next cron is already the next Central day, Day 1 still sends (does not skip)", () => {
    const created = "2026-08-31T04:50:00.000Z"; // 11:50pm CDT
    expect(isDay1BufferSatisfied(created, new Date("2026-08-31T05:10:00.000Z"))).toBe(true);
  });
});
