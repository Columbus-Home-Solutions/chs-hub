/**
 * GET /api/debug/sheets-inspect
 *
 * One-off helper that dumps the structure of each tab in the WC workbook
 * (title, dimensions, first ~25 rows and first ~10 columns) so we can see
 * exactly which cells to populate with the auto-sync. Intended to be run
 * once during development; safe to leave in as a diagnostic.
 *
 * Guarded behind the SYNC_TRIGGER_SECRET so random visitors can't read the
 * sheet through our Worker.
 */

import type { Env } from "../env.js";
import { SheetsClient } from "../lib/google/sheets.js";

const WC_SHEET_ID = "1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo";

// Only introspect the four tabs we actually care about. Match is trim()ed
// to tolerate stray trailing spaces in the sheet's tab name.
const ACTIVE_TABS = [
  "Monthly Net Profits",
  "Key Business Performance Indicators",
  "Month KPI's",
  "Weekly Marketing Tallies",
];

function isActiveTab(title: string): boolean {
  const t = title.trim().toLowerCase();
  return ACTIVE_TABS.some((a) => a.trim().toLowerCase() === t);
}

export async function handleSheetsInspect(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");
  if (secret !== env.SYNC_TRIGGER_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return json({ error: "GOOGLE_SERVICE_ACCOUNT_JSON not configured" }, 500);
  }

  const client = new SheetsClient(env.GOOGLE_SERVICE_ACCOUNT_JSON, WC_SHEET_ID);

  const tabs = await client.listSheets();
  const dump: Record<string, unknown> = {};
  for (const tab of tabs) {
    if (!isActiveTab(tab.title)) {
      dump[tab.title] = {
        _skipped: true,
        rowCount: tab.rowCount,
        columnCount: tab.columnCount,
      };
      continue;
    }
    // Read a generous chunk (A1:W30) to capture headers + nearby data.
    const rangeA1 = `${quoteTabName(tab.title)}!A1:W30`;
    let values: (string | number | null)[][] = [];
    try {
      values = await client.readRange(rangeA1);
    } catch (err) {
      dump[tab.title] = { _error: (err as Error).message };
      continue;
    }
    dump[tab.title] = {
      sheetId: tab.sheetId,
      rowCount: tab.rowCount,
      columnCount: tab.columnCount,
      sample_A1_J30: values,
    };
  }

  return json({
    spreadsheet_id: WC_SHEET_ID,
    tabs_in_workbook: tabs.map((t) => t.title),
    introspected: dump,
  });
}

// Sheet names with spaces or apostrophes need single-quoted + escaped A1
// references (e.g. "Month KPI's" → "'Month KPI''s'!A1:J30").
function quoteTabName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
