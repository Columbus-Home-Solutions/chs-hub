/**
 * Wealthy Contractor (WC) workbook auto-sync.
 *
 * Writes D1-derived KPI rollups into two tabs of the WC Google Sheet:
 *
 *   Tab 1 — "Monthly Net Profits"
 *     Fills B4:C15 with (Total Income, Net Profits) for months Jan-Dec
 *     of the current year. Cash basis: income = payments collected that
 *     month; profit = income - expenses incurred - proportional line-item
 *     costs of invoices paid that month.
 *
 *   Tab 2 — "Key Business Performance Indicators"
 *     Reads col A (week start as Sheets serial date) to find each
 *     pre-seeded weekly row, then fills only C (New Sales $ — quote converted
 *     to a job that week), D (Weekly Collections — payment dates), F
 *     (Appointments/Estimates), and G (Closed) for weeks
 *     that we have data for. Leaves E (Leads), H (Closed %, a formula),
 *     and I (Google Reviews) untouched — those come from HighLevel / GBP
 *     integrations we haven't built yet.
 *
 *   Tab 4 — "Weekly Marketing Tallies" (DEFERRED)
 *     Skipped in this iteration. The tab doesn't have pre-seeded weekly
 *     rows, and most of its columns depend on Google Ads / Meta / LSA API
 *     integrations. We'll add it once those are in.
 *
 * The sync is idempotent — re-running just overwrites the same cells with
 * fresh values. Safe to call on every cron tick.
 */

import type { Env } from "../../env.js";
import { SheetsClient } from "../google/sheets.js";
import { computeMonthly, computeWeekly } from "./compute.js";

export const WC_SHEET_ID = "1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo";

// Tab titles as they appear in the workbook. Trailing spaces are real —
// the user's tab is literally named "Weekly Marketing Tallies " with a
// trailing space, so we match loosely (see findTabByTitle).
const TAB_MONTHLY = "Monthly Net Profits";
const TAB_KBPI = "Key Business Performance Indicators";

// Google Sheets serial-date epoch: Dec 30, 1899 (NOT Dec 31 — Sheets has
// the Lotus 1-2-3 1900 leap-year bug baked in).
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

export interface SyncResult {
  ok: boolean;
  duration_ms: number;
  monthly: { rows_written: number; skipped?: string };
  kbpi: { weeks_matched: number; weeks_skipped_no_row: number; skipped?: string };
  errors: string[];
}

export async function syncWorkbook(env: Env): Promise<SyncResult> {
  const t0 = Date.now();
  const result: SyncResult = {
    ok: true,
    duration_ms: 0,
    monthly: { rows_written: 0 },
    kbpi: { weeks_matched: 0, weeks_skipped_no_row: 0 },
    errors: [],
  };

  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    result.ok = false;
    result.errors.push("GOOGLE_SERVICE_ACCOUNT_JSON not configured");
    result.duration_ms = Date.now() - t0;
    return result;
  }

  const client = new SheetsClient(env.GOOGLE_SERVICE_ACCOUNT_JSON, WC_SHEET_ID);

  // Year to sync = current year (the active "YTD" in both tabs).
  const year = new Date().getUTCFullYear();

  // ── Tab 1: Monthly Net Profits ─────────────────────────────────────
  try {
    const monthly = await computeMonthly(env, year);
    // Rows 4..15 are Jan..Dec. Write just B:C for those 12 rows.
    const values: (string | number | null)[][] = monthly.map((m) => [
      m.income, // col B
      m.profit, // col C
    ]);
    await client.writeRange(`${q(TAB_MONTHLY)}!B4:C15`, values);
    result.monthly.rows_written = values.length;
  } catch (err) {
    result.ok = false;
    result.monthly.skipped = (err as Error).message;
    result.errors.push(`monthly: ${(err as Error).message}`);
  }

  // ── Tab 2: KBPI weekly ─────────────────────────────────────────────
  try {
    const weeks = await computeWeekly(env, year);
    const weeksByStart = new Map(weeks.map((w) => [w.week_start, w]));

    // Read col A (week start as Sheets serial date) + col B (week end)
    // to find which rows correspond to which week.
    const existing = await client.readRange(`${q(TAB_KBPI)}!A3:B60`);
    const updates: { range: string; values: (string | number | null)[][] }[] = [];
    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < existing.length; i++) {
      const serial = existing[i]?.[0];
      if (typeof serial !== "number") continue;
      const weekStart = serialToIso(serial);
      const week = weeksByStart.get(weekStart);
      if (!week) continue;
      // Don't write into future weeks — leave them blank so the user can
      // see at a glance which weeks have data vs. haven't happened yet.
      if (week.week_start > today) continue;
      const sheetRow = 3 + i; // A3 is row 3; i=0 → row 3, etc.
      updates.push({
        range: `${q(TAB_KBPI)}!C${sheetRow}:D${sheetRow}`,
        values: [[week.new_sales, week.collections]],
      });
      updates.push({
        range: `${q(TAB_KBPI)}!F${sheetRow}:G${sheetRow}`,
        values: [[week.estimates, week.closed]],
      });
      result.kbpi.weeks_matched++;
    }

    // Count weeks that have data but no pre-seeded row (user may need to
    // extend the sheet manually if this grows).
    for (const w of weeks) {
      if (w.week_start > today) continue;
      if (w.new_sales === 0 && w.collections === 0 && w.estimates === 0 && w.closed === 0) continue;
      const hasRow = existing.some((r) => {
        const s = r?.[0];
        return typeof s === "number" && serialToIso(s) === w.week_start;
      });
      if (!hasRow) result.kbpi.weeks_skipped_no_row++;
    }

    if (updates.length > 0) {
      await client.batchUpdate(updates);
    }
  } catch (err) {
    result.ok = false;
    result.kbpi.skipped = (err as Error).message;
    result.errors.push(`kbpi: ${(err as Error).message}`);
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

// ─── helpers ──────────────────────────────────────────────────────────

/** Quote a sheet name for A1 notation: "Month KPI's" → 'Month KPI''s' */
function q(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** Sheets serial date → ISO YYYY-MM-DD (UTC). */
function serialToIso(serial: number): string {
  const ms = SHEETS_EPOCH_MS + serial * 86400 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}
