import { describe, expect, it } from "vitest";
import { isWithinCentralSendWindow, nextCentralSendInstant } from "../src/lib/central-send-window.js";
import { calcDaysSince, LEAD_OUTREACH_CANDIDATE_SQL } from "../src/lib/new-lead-outreach.js";

describe("LEAD_OUTREACH_CANDIDATE_SQL", () => {
  it("still drops scheduled leads immediately (appointment_date IS NULL)", () => {
    expect(LEAD_OUTREACH_CANDIDATE_SQL).toMatch(/er\.appointment_date IS NULL/);
  });

  it("does not special-case lead source", () => {
    expect(LEAD_OUTREACH_CANDIDATE_SQL).not.toMatch(/google_lsa|thumbtack|high_level|source/);
  });

  it("starts from Contacted, and only finishes in-flight new_request sequences", () => {
    expect(LEAD_OUTREACH_CANDIDATE_SQL).toMatch(/er\.status = 'contacted'/);
    expect(LEAD_OUTREACH_CANDIDATE_SQL).toMatch(/er\.contacted_at/);
    expect(LEAD_OUTREACH_CANDIDATE_SQL).toMatch(/er\.lead_outreach_sequence_active = 1/);
    expect(LEAD_OUTREACH_CANDIDATE_SQL).not.toMatch(/lead_outreach_count, 0\) = 0/);
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

describe("Central send window", () => {
  it("11 PM Central waits until 9 AM", () => {
    // 11:00pm CDT Sep 22 = 04:00 UTC Sep 23
    const night = new Date("2026-09-23T04:00:00.000Z");
    expect(isWithinCentralSendWindow(night)).toBe(false);
    const next = nextCentralSendInstant(night);
    expect(isWithinCentralSendWindow(next)).toBe(true);
    expect(next.getTime()).toBeGreaterThan(night.getTime());
  });

  it("2 PM Central sends now", () => {
    const afternoon = new Date("2026-09-22T19:00:00.000Z"); // 2:00pm CDT
    expect(isWithinCentralSendWindow(afternoon)).toBe(true);
    expect(nextCentralSendInstant(afternoon).toISOString()).toBe(afternoon.toISOString());
  });

  it("7:00 PM Central is outside the window", () => {
    // 7:00pm CDT = 00:00 UTC next day
    expect(isWithinCentralSendWindow(new Date("2026-09-23T00:00:00.000Z"))).toBe(false);
  });
});
