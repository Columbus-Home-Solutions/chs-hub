import { describe, expect, it } from "vitest";
import { datePart, timePart } from "../src/lib/calendar-colors.js";
import { pickNextUp, pickRightNow, type SchedulePick } from "../frontend/src/lib/schedule-next.js";

function ev(partial: Partial<SchedulePick> & Pick<SchedulePick, "id" | "date">): SchedulePick {
  return { start_time: null, status: null, ...partial };
}

describe("Google Meet clocks are Central", () => {
  it("reads a 9:00 AM daylight-time meeting as 09:00 on that Central day, not 14:00 UTC", () => {
    const stored = "2026-10-20T09:00:00-05:00";
    expect(datePart(stored)).toBe("2026-10-20");
    expect(timePart(stored)).toBe("09:00");
  });

  it("keeps a clock just after midnight Central on that Central day", () => {
    const stored = "2026-10-20T05:05:00.000Z";
    expect(datePart(stored)).toBe("2026-10-20");
    expect(timePart(stored)).toBe("00:05");
  });

  it("keeps a standard-time clock just after midnight on that Central day", () => {
    const stored = "2027-01-20T06:05:00.000Z";
    expect(datePart(stored)).toBe("2027-01-20");
    expect(timePart(stored)).toBe("00:05");
  });

  it("leaves an all-day sentinel on its date with no clock", () => {
    const stored = "2026-10-20T00:00:00.000Z";
    expect(datePart(stored)).toBe("2026-10-20");
    expect(timePart(stored)).toBeNull();
  });

  it("does not shift a date-only job day", () => {
    expect(datePart("2026-10-20")).toBe("2026-10-20");
    expect(timePart("2026-10-20")).toBeNull();
    expect(timePart("12:00")).toBe("12:00");
  });
});

describe("Today Next Up", () => {
  const today = "2026-10-19";
  const tomorrow = "2026-10-20";

  it("puts tomorrow's 9:00 AM meeting ahead of a noon estimate", () => {
    const events = [
      ev({ id: "karen", date: tomorrow, start_time: "12:00" }),
      ev({ id: "meet", date: tomorrow, start_time: "09:00" }),
    ];
    expect(pickNextUp(events, today, null)?.id).toBe("meet");
  });

  it("picks a meeting later today ahead of tomorrow", () => {
    const todayEvents = [
      ev({ id: "noon", date: today, start_time: "12:00" }),
      ev({ id: "later", date: today, start_time: "15:00" }),
    ];
    const rightNow = pickRightNow(todayEvents);
    expect(rightNow?.id).toBe("noon");
    const events = [...todayEvents, ev({ id: "tomorrow", date: tomorrow, start_time: "09:00" })];
    expect(pickNextUp(events, today, rightNow)?.id).toBe("later");
  });

  it("does not let an all-day item hide the 9:00 AM meeting", () => {
    const events = [
      ev({ id: "all-day", date: tomorrow, start_time: null }),
      ev({ id: "meet", date: tomorrow, start_time: "09:00" }),
      ev({ id: "karen", date: tomorrow, start_time: "12:00" }),
    ];
    expect(pickNextUp(events, today, null)?.id).toBe("meet");
  });

  it("puts a just-after-midnight item first on that day", () => {
    const events = [
      ev({ id: "meet", date: tomorrow, start_time: "09:00" }),
      ev({ id: "midnight", date: tomorrow, start_time: "00:05" }),
    ];
    expect(pickNextUp(events, today, null)?.id).toBe("midnight");
  });
});
