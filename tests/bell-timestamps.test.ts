import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "../frontend/src/lib/format";

describe("bell timestamps in Central time", () => {
  it("shows a D1 timestamp as 7:57 AM Central on Oct 10 (CDT)", () => {
    const shown = formatDateTime("2026-10-10 12:57:00");
    expect(shown).toContain("Oct");
    expect(shown).toContain("10");
    expect(shown).toContain("2026");
    expect(shown).toContain("7:57");
    expect(shown).toContain("AM");
  });

  it("shows a Z timestamp as the same hour", () => {
    expect(formatDateTime("2026-10-10T12:57:00.000Z")).toBe(formatDateTime("2026-10-10 12:57:00"));
  });

  it("uses the winter offset after daylight saving ends", () => {
    const shown = formatDateTime("2026-11-02 13:57:00");
    expect(shown).toContain("Nov");
    expect(shown).toContain("2");
    expect(shown).toContain("7:57");
    expect(shown).toContain("AM");
    expect(formatDateTime("2026-11-02 12:57:00")).toContain("6:57");
  });

  it("does not shift a date-only value", () => {
    expect(formatDate("2026-10-10")).toBe("Oct 10, 2026");
    expect(formatDate("2026-08-23")).toBe("Aug 23, 2026");
  });
});
