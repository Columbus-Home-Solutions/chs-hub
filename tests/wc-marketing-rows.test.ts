import { describe, expect, it } from "vitest";
import {
  findLastMarketingDataRow,
  findMarketingRowInGrids,
  marketingDataColumnLetters,
  nextMarketingWeekRow,
} from "../src/services/wc-marketing-rows.js";
import { formatMarketingWeekLabel } from "../src/services/wc-dates.js";

const settings = {
  marketingTab: "Weekly Marketing Tallies",
  marketingWeekCol: "A",
  marketingWeekEndCol: "B",
  marketingFinancialCols: "C:E",
  marketingLeadCols: {
    organic: "G",
    adwords: "H",
    lsa: "J",
    facebook: "L",
    referral: "N",
    repeat: "O",
    other: "P",
  },
  marketingConvertedCol: "R",
  marketingFirstRow: 4,
  marketingActiveWeekRow: null,
};

describe("formatMarketingWeekLabel", () => {
  it("formats ISO week bounds as M/D labels", () => {
    expect(formatMarketingWeekLabel("2026-07-19", "2026-07-25")).toBe("7/19 - 7/25");
  });
});

describe("findMarketingRowInGrids", () => {
  const today = { year: 2026, month: 7, day: 19 };

  it("finds a row with separate A/B week dates", () => {
    const weekGrid = [[null, null], ["7/19", "7/25"]];
    const row = findMarketingRowInGrids(weekGrid, weekGrid, settings, "2026-07-19", "2026-07-25", today);
    expect(row).toBe(5);
  });

  it("finds a row with a merged-style label in column A", () => {
    const weekGrid = [["7/19 - 7/25", ""]];
    const row = findMarketingRowInGrids(weekGrid, weekGrid, settings, "2026-07-19", "2026-07-25", today);
    expect(row).toBe(4);
  });

  it("returns null when A/B labels are blank (production quirk)", () => {
    const weekGrid = [[null, null], [null, null]];
    const row = findMarketingRowInGrids(weekGrid, weekGrid, settings, "2026-07-19", "2026-07-25", today);
    expect(row).toBeNull();
  });

  it("does not match a different week", () => {
    const weekGrid = [["7/12", "7/18"]];
    const row = findMarketingRowInGrids(weekGrid, weekGrid, settings, "2026-07-19", "2026-07-25", today);
    expect(row).toBeNull();
  });
});

describe("findLastMarketingDataRow", () => {
  it("returns the highest row with CHS-written data", () => {
    const dataGrid = [[79700, null, 20050], [], [0, 0, 20350]];
    expect(findLastMarketingDataRow(dataGrid, settings)).toBe(6);
  });

  it("returns null when no data rows exist", () => {
    expect(findLastMarketingDataRow([], settings)).toBeNull();
  });
});

describe("nextMarketingWeekRow", () => {
  it("places a new week after the last data row", () => {
    expect(nextMarketingWeekRow(6, 4)).toBe(7);
  });

  it("uses the first data row when the sheet is empty", () => {
    expect(nextMarketingWeekRow(null, 4)).toBe(4);
  });
});

describe("marketingDataColumnLetters", () => {
  it("includes financial and lead columns", () => {
    const cols = marketingDataColumnLetters(settings);
    expect(cols).toContain("C");
    expect(cols).toContain("E");
    expect(cols).toContain("G");
    expect(cols).toContain("R");
  });
});
