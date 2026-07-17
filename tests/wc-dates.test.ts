import { describe, expect, it } from "vitest";
import {
  ctMonthBounds,
  ctWeekBounds,
  kpiRowMatches,
  leadSourceBucket,
  leadSourceColumn,
  monthLabelMatches,
  parseShortDate,
  sundayOf,
  toCtDate,
} from "../src/services/wc-dates.js";

describe("parseShortDate", () => {
  it("parses M/D strings", () => {
    expect(parseShortDate("5/24")).toEqual({ month: 5, day: 24 });
    expect(parseShortDate("12/28")).toEqual({ month: 12, day: 28 });
    expect(parseShortDate("1/3")).toEqual({ month: 1, day: 3 });
  });
  it("parses Google Sheets serial dates", () => {
    // 2026-05-24 serial = days since 1899-12-30
    const serial = (Date.UTC(2026, 4, 24) - Date.UTC(1899, 11, 30)) / 86400000;
    expect(parseShortDate(serial)).toEqual({ month: 5, day: 24 });
  });
  it("returns null for junk", () => {
    expect(parseShortDate("not a date")).toBeNull();
    expect(parseShortDate(null)).toBeNull();
  });
});

describe("kpiRowMatches — ⭐ row discovery", () => {
  it("matches a normal mid-year week", () => {
    // today 2026-05-27 falls in 5/24 → 5/30
    expect(kpiRowMatches("5/24", "5/30", { year: 2026, month: 5, day: 27 })).toBe(true);
    expect(kpiRowMatches("5/24", "5/30", { year: 2026, month: 6, day: 2 })).toBe(false);
  });

  it("handles a year-boundary week 12/28 → 1/3 from the December side", () => {
    expect(kpiRowMatches("12/28", "1/3", { year: 2025, month: 12, day: 30 })).toBe(true);
  });

  it("handles a year-boundary week 12/28 → 1/3 from the January side", () => {
    // today 2026-01-02 should still match the 12/28→1/3 week
    expect(kpiRowMatches("12/28", "1/3", { year: 2026, month: 1, day: 2 })).toBe(true);
  });

  it("does not match an unrelated week", () => {
    expect(kpiRowMatches("12/28", "1/3", { year: 2026, month: 6, day: 1 })).toBe(false);
  });
});

describe("monthLabelMatches", () => {
  it("matches month names and numbers", () => {
    expect(monthLabelMatches("Jan", 1)).toBe(true);
    expect(monthLabelMatches("January", 1)).toBe(true);
    expect(monthLabelMatches("Dec", 12)).toBe(true);
    expect(monthLabelMatches("3", 3)).toBe(true);
    expect(monthLabelMatches("Feb", 3)).toBe(false);
  });
});

describe("leadSourceBucket", () => {
  it("maps each known lead source to its Marketing bucket", () => {
    expect(leadSourceBucket("organic_google")).toBe("organic");
    expect(leadSourceBucket("google_adwords")).toBe("adwords");
    expect(leadSourceBucket("google_lsa")).toBe("lsa");
    expect(leadSourceBucket("facebook")).toBe("facebook");
    expect(leadSourceBucket("referral")).toBe("referral");
    expect(leadSourceBucket("repeat_client")).toBe("repeat");
  });
  it("buckets thumbtack/website/unknown/null into other", () => {
    expect(leadSourceBucket("thumbtack")).toBe("other");
    expect(leadSourceBucket("website")).toBe("other");
    expect(leadSourceBucket("direct_call")).toBe("other");
    expect(leadSourceBucket(null)).toBe("other");
    expect(leadSourceBucket(undefined)).toBe("other");
  });
});

describe("leadSourceColumn (legacy spec columns)", () => {
  it("maps each known lead source to its Marketing column", () => {
    expect(leadSourceColumn("organic_google")).toBe("F");
    expect(leadSourceColumn("google_adwords")).toBe("G");
    expect(leadSourceColumn("google_lsa")).toBe("I");
    expect(leadSourceColumn("facebook")).toBe("K");
    expect(leadSourceColumn("referral")).toBe("M");
    expect(leadSourceColumn("repeat_client")).toBe("N");
  });
  it("buckets thumbtack/website/unknown/null into Other (O)", () => {
    expect(leadSourceColumn("thumbtack")).toBe("O");
    expect(leadSourceColumn("website")).toBe("O");
    expect(leadSourceColumn("direct_call")).toBe("O");
    expect(leadSourceColumn(null)).toBe("O");
    expect(leadSourceColumn(undefined)).toBe("O");
  });
});

describe("ctWeekBounds — Sun→Sat", () => {
  it("produces a Sunday start and Saturday end", () => {
    // 2026-05-27 is a Wednesday → week 2026-05-24 (Sun) .. 2026-05-30 (Sat)
    const wk = ctWeekBounds(new Date("2026-05-27T18:00:00Z"));
    expect(wk.start).toBe("2026-05-24");
    expect(wk.end).toBe("2026-05-30");
    expect(wk.endExclusive).toBe("2026-05-31");
  });
});

describe("ctMonthBounds", () => {
  it("produces month boundaries + label", () => {
    const mo = ctMonthBounds(new Date("2026-05-27T18:00:00Z"));
    expect(mo.start).toBe("2026-05-01");
    expect(mo.endExclusive).toBe("2026-06-01");
    expect(mo.label).toBe("May");
    expect(mo.monthIndex).toBe(5);
  });
});

describe("sundayOf", () => {
  it("returns the Sunday of the containing week", () => {
    expect(sundayOf("2026-05-27")).toBe("2026-05-24");
    expect(sundayOf("2026-05-24")).toBe("2026-05-24");
    expect(sundayOf("2026-05-30")).toBe("2026-05-24");
  });
});

describe("toCtDate — Central-Time boundary", () => {
  it("buckets a UTC instant just after Sat→Sun CT midnight into Sunday", () => {
    // 2026-05-24 05:30 UTC = 2026-05-24 00:30 CDT (Sunday) → Sunday
    expect(toCtDate("2026-05-24T05:30:00Z")).toBe("2026-05-24");
    // 2026-05-24 04:30 UTC = 2026-05-23 23:30 CDT (still Saturday) → Saturday
    expect(toCtDate("2026-05-24T04:30:00Z")).toBe("2026-05-23");
  });
  it("treats bare dates as that calendar date (no shift)", () => {
    expect(toCtDate("2026-05-24")).toBe("2026-05-24");
  });
});
