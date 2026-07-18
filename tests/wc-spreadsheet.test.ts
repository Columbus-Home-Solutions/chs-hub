import { describe, expect, it } from "vitest";
import { PRODUCTION_SHEET_ID, resolveSheetId, resolveTabTitle } from "../src/services/wc-spreadsheet.js";
import type { Env } from "../src/env.js";

function settings(spreadsheetId = "") {
  return {
    enabled: true,
    spreadsheetId,
    kpiTab: "Key Business Performance Indicators",
    kpiWeekStartCol: "A",
    kpiWeekEndCol: "B",
    kpiDataCols: "C:G",
    kpiFirstRow: 3,
    marketingTab: "Weekly Marketing Tallies ",
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
    monthlyTab: "Monthly Net Profits",
    monthlyMonthCol: "A",
    monthlyDataCols: "B:C",
    monthlyFirstRow: 4,
    monthlyLastRow: 15,
  };
}

describe("resolveSheetId", () => {
  it("uses wc_spreadsheet_id from settings even when WC_TEST_SHEET_ID is set", () => {
    const env = { WC_TEST_SHEET_ID: "test-copy-id" } as Env;
    const resolved = resolveSheetId(settings(PRODUCTION_SHEET_ID), env);
    expect(resolved.id).toBe(PRODUCTION_SHEET_ID);
    expect(resolved.reason).toBeUndefined();
  });

  it("falls back to WC_TEST_SHEET_ID when setting is blank", () => {
    const env = { WC_TEST_SHEET_ID: "test-copy-id" } as Env;
    const resolved = resolveSheetId(settings(""), env);
    expect(resolved.id).toBe("test-copy-id");
  });

  it("refuses production id supplied only via WC_TEST_SHEET_ID", () => {
    const env = { WC_TEST_SHEET_ID: PRODUCTION_SHEET_ID } as Env;
    const resolved = resolveSheetId(settings(""), env);
    expect(resolved.id).toBeNull();
    expect(resolved.reason).toMatch(/wc_spreadsheet_id/);
  });
});

describe("resolveTabTitle", () => {
  it("prefers the tab without trailing whitespace when both exist", () => {
    const titles = ["Weekly Marketing Tallies ", "Weekly Marketing Tallies", "Monthly Net Profits"];
    expect(resolveTabTitle(titles, "Weekly Marketing Tallies ")).toBe("Weekly Marketing Tallies");
  });
});
