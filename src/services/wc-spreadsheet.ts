/**
 * Wealthy Contractor (WC) Spreadsheet sync — Sprint 14 full rebuild.
 *
 * Implements Module-Spec-WC-Spreadsheet.md: native CHS data sources, all
 * auto-populatable data points across the three written tabs, settings-driven
 * cell mappings, label-based row discovery, Central-Time boundaries, kill
 * switch, sync_log + DLQ + consecutive-failure heartbeat.
 *
 * Hard rules (spec §9): one-way (CHS → Sheet); write designated value cells
 * only — never insert/delete rows, never touch formulas/formatting/structure;
 * never write formula columns (Closed %, Converted %, NI%) or manual columns;
 * row-not-found → warn + skip (never create); idempotent (overwrite same cells).
 */

import type { Env } from "../env.js";
import { SheetsClient } from "../lib/google/sheets.js";
import { recordDeadLetter } from "../lib/ops/dlq.js";
import { notify } from "../lib/ops/notify.js";
import {
  ctMonthBounds,
  ctToday,
  ctWeekBounds,
  kpiRowMatches,
  leadSourceBucket,
  type LeadSourceBucket,
  marketingRowMatches,
  marketingRowMatchesWeek,
  monthLabelMatches,
  parseShortDate,
  parseWeekRange,
  sundayOf,
  toCtDate,
} from "./wc-dates.js";

const SYNC_TYPE = "wc_spreadsheet";
const CONSECUTIVE_FAILURE_ALERT = 3;
// Never auto-target the production workbook from code (spec §12 test rule).
export const PRODUCTION_SHEET_ID = "1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo";

export type WcSyncStatus = "success" | "partial_failure" | "failure" | "skipped";

export interface WcSyncResult {
  status: WcSyncStatus;
  reason?: string;
  tabs_updated: string[];
  tabs_failed: string[];
  /** Tabs skipped because the spreadsheet row was not found (ROW_MISSING).
   *  Per spec §8: warn + skip, never DLQ or alert — the coaching team adds
   *  rows manually and the sync will write them on the next cycle they exist. */
  tabs_skipped: string[];
  rows_matched: Record<string, number | null>;
  data_snapshot: Record<string, unknown>;
  error_message?: string;
  duration_ms: number;
}

interface WcSettings {
  enabled: boolean;
  spreadsheetId: string;
  kpiTab: string;
  kpiWeekStartCol: string;
  kpiWeekEndCol: string;
  kpiDataCols: string; // "C:G"
  kpiFirstRow: number;
  marketingTab: string;
  marketingWeekCol: string;
  marketingWeekEndCol: string;
  marketingFinancialCols: string;
  marketingLeadCols: Record<LeadSourceBucket, string>;
  marketingConvertedCol: string;
  marketingFirstRow: number;
  marketingActiveWeekRow: number | null;
  monthlyTab: string;
  monthlyMonthCol: string;
  monthlyDataCols: string; // "B:C"
  monthlyFirstRow: number;
  monthlyLastRow: number;
}

// ─── Settings ─────────────────────────────────────────────────────────────

async function loadSettings(env: Env): Promise<WcSettings> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM system_settings WHERE category = 'wc_spreadsheet'`,
  ).all<{ key: string; value: string }>();
  const m = new Map((results ?? []).map((r) => [r.key, r.value]));
  const s = (k: string, d: string) => m.get(k) ?? d;
  const n = (k: string, d: number) => {
    const v = Number(m.get(k));
    return Number.isFinite(v) ? v : d;
  };
  return {
    enabled: (m.get("wc_sync_enabled") ?? "true") !== "false",
    spreadsheetId: s("wc_spreadsheet_id", ""),
    kpiTab: s("wc_kpi_tab_name", "Key Business Performance Indicators"),
    kpiWeekStartCol: s("wc_kpi_week_start_column", "A"),
    kpiWeekEndCol: s("wc_kpi_week_end_column", "B"),
    kpiDataCols: s("wc_kpi_data_columns", "C:G"),
    kpiFirstRow: n("wc_kpi_first_data_row", 3),
    marketingTab: s("wc_marketing_tab_name", "Weekly Marketing Tallies"),
    marketingWeekCol: s("wc_marketing_week_column", "A"),
    marketingWeekEndCol: s("wc_marketing_week_end_column", "B"),
    marketingFinancialCols: s("wc_marketing_financial_columns", "C:E"),
    marketingLeadCols: {
      organic: s("wc_marketing_lead_organic_column", "G"),
      adwords: s("wc_marketing_lead_adwords_column", "H"),
      lsa: s("wc_marketing_lead_lsa_column", "J"),
      facebook: s("wc_marketing_lead_facebook_column", "L"),
      referral: s("wc_marketing_lead_referral_column", "N"),
      repeat: s("wc_marketing_lead_repeat_column", "O"),
      other: s("wc_marketing_lead_other_column", "P"),
    },
    marketingConvertedCol: s("wc_marketing_converted_column", "R"),
    marketingFirstRow: n("wc_marketing_first_data_row", 4),
    marketingActiveWeekRow: (() => {
      const v = Number(m.get("wc_marketing_active_week_row"));
      return Number.isFinite(v) && v > 0 ? v : null;
    })(),
    monthlyTab: s("wc_monthly_tab_name", "Monthly Net Profits"),
    monthlyMonthCol: s("wc_monthly_month_column", "A"),
    monthlyDataCols: s("wc_monthly_data_columns", "B:C"),
    monthlyFirstRow: n("wc_monthly_first_data_row", 4),
    monthlyLastRow: n("wc_monthly_last_data_row", 15),
  };
}

/** Resolve the sheet to write.
 *  Production uses wc_spreadsheet_id in system_settings. WC_TEST_SHEET_ID is
 *  dev-only fallback when the setting is blank — never silently override an
 *  explicit production id because the secret happens to exist in the Worker. */
export function resolveSheetId(settings: WcSettings, env: Env): { id: string | null; reason?: string } {
  const configured = settings.spreadsheetId.trim();
  if (configured) return { id: configured };

  const testId = env.WC_TEST_SHEET_ID?.trim() || "";
  if (!testId) {
    return { id: null, reason: "no spreadsheet id configured (set wc_spreadsheet_id or WC_TEST_SHEET_ID)" };
  }
  if (testId === PRODUCTION_SHEET_ID) {
    return {
      id: null,
      reason: "refusing production sheet id via WC_TEST_SHEET_ID alone — set wc_spreadsheet_id in system_settings",
    };
  }
  return { id: testId };
}

// ─── Aggregated data (current CT week + month) ──────────────────────────────

export interface WeeklyData {
  new_sales: number;
  weekly_collections: number;
  bank_deposits: number;
  ar_balance: number;
  leads_total: number;
  appointments: number;
  closed: number;
  converted: number;
  lead_by_source: Record<LeadSourceBucket, number>;
}

export interface MonthlyData {
  total_income: number;
  total_expenses: number;
  net_profit: number;
}

async function rowsInWindow(
  env: Env,
  sql: string,
  loIso: string,
  hiIso: string,
): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare(sql).bind(loIso, hiIso).all<Record<string, unknown>>();
  return r.results ?? [];
}

function pad(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export async function computeWeekly(env: Env, now: Date = new Date()): Promise<WeeklyData> {
  const wk = ctWeekBounds(now);
  const inWeek = (ctDate: string) => ctDate >= wk.start && ctDate <= wk.end;
  // Pad the SQL window ±1 day so CT-shifted timestamps near the boundary are
  // still fetched; final bucketing is done precisely in CT below.
  const lo = pad(wk.start, -1);
  const hi = pad(wk.endExclusive, 1);

  const data: WeeklyData = {
    new_sales: 0,
    weekly_collections: 0,
    bank_deposits: 0,
    ar_balance: 0,
    leads_total: 0,
    appointments: 0,
    closed: 0,
    converted: 0,
    lead_by_source: { organic: 0, adwords: 0, lsa: 0, facebook: 0, referral: 0, repeat: 0, other: 0 },
  };

  // Leads + source breakdown
  const leads = await rowsInWindow(
    env,
    `SELECT created_at, lead_source FROM estimate_requests
      WHERE substr(created_at,1,10) >= ? AND substr(created_at,1,10) <= ?`,
    lo,
    hi,
  );
  for (const r of leads) {
    if (!inWeek(toCtDate(r.created_at as string))) continue;
    data.leads_total++;
    const bucket = leadSourceBucket(r.lead_source as string | null);
    data.lead_by_source[bucket]++;
  }

  // Appointments set this week
  const appts = await rowsInWindow(
    env,
    `SELECT appointment_date FROM estimate_requests
      WHERE appointment_date IS NOT NULL
        AND substr(appointment_date,1,10) >= ? AND substr(appointment_date,1,10) <= ?`,
    lo,
    hi,
  );
  for (const r of appts) {
    if (inWeek(toCtDate(r.appointment_date as string))) data.appointments++;
  }

  // Closed deals + new sales (jobs created this week via quote-to-job)
  const jobs = await rowsInWindow(
    env,
    `SELECT created_at, COALESCE(contract_total, total, 0) AS v, status FROM jobs
      WHERE created_at IS NOT NULL
        AND substr(created_at,1,10) >= ? AND substr(created_at,1,10) <= ?`,
    lo,
    hi,
  );
  for (const r of jobs) {
    if ((r.status as string) === "cancelled") continue;
    if (!inWeek(toCtDate(r.created_at as string))) continue;
    data.closed++;
    data.converted++;
    data.new_sales += Number(r.v) || 0;
  }

  // Weekly collections (payments received this week)
  const collections = await rowsInWindow(
    env,
    `SELECT received_date, collected_at, amount FROM payments
      WHERE COALESCE(received_date, collected_at) IS NOT NULL
        AND substr(COALESCE(received_date, collected_at),1,10) >= ?
        AND substr(COALESCE(received_date, collected_at),1,10) <= ?`,
    lo,
    hi,
  );
  for (const r of collections) {
    const d = (r.received_date as string) ?? (r.collected_at as string);
    if (inWeek(toCtDate(d))) data.weekly_collections += Number(r.amount) || 0;
  }

  // $ that hit the bank (payments deposited this week; fallback received_date)
  const deposits = await rowsInWindow(
    env,
    `SELECT deposited_date, received_date, collected_at, amount FROM payments
      WHERE substr(COALESCE(deposited_date, received_date, collected_at),1,10) >= ?
        AND substr(COALESCE(deposited_date, received_date, collected_at),1,10) <= ?`,
    lo,
    hi,
  );
  for (const r of deposits) {
    const d = (r.deposited_date as string) ?? (r.received_date as string) ?? (r.collected_at as string);
    if (d && inWeek(toCtDate(d))) data.bank_deposits += Number(r.amount) || 0;
  }

  // AR snapshot (status-based; not date-windowed)
  const ar = await env.DB.prepare(
    `SELECT SUM(COALESCE(total_due, total, 0) - COALESCE(paid_amount, payments_total, 0)) AS ar
       FROM invoices
      WHERE LOWER(COALESCE(status,'')) IN ('sent','viewed','partial','past_due')`,
  ).first<{ ar: number | null }>();
  data.ar_balance = round2(ar?.ar ?? 0);

  data.new_sales = round2(data.new_sales);
  data.weekly_collections = round2(data.weekly_collections);
  data.bank_deposits = round2(data.bank_deposits);
  return data;
}

export async function computeMonthly(env: Env, now: Date = new Date()): Promise<MonthlyData> {
  const mo = ctMonthBounds(now);
  const inMonth = (ctDate: string) => ctDate >= mo.start && ctDate < mo.endExclusive;
  const lo = pad(mo.start, -1);
  const hi = pad(mo.endExclusive, 1);

  let total_income = 0;
  let stripe_fees = 0;
  const pays = await rowsInWindow(
    env,
    `SELECT received_date, collected_at, amount, COALESCE(stripe_fee,0) AS stripe_fee FROM payments
      WHERE substr(COALESCE(received_date, collected_at),1,10) >= ?
        AND substr(COALESCE(received_date, collected_at),1,10) <= ?`,
    lo,
    hi,
  );
  for (const r of pays) {
    const d = (r.received_date as string) ?? (r.collected_at as string);
    if (d && inMonth(toCtDate(d))) {
      total_income += Number(r.amount) || 0;
      stripe_fees += Number(r.stripe_fee) || 0;
    }
  }

  let expenses = 0;
  const exps = await rowsInWindow(
    env,
    `SELECT COALESCE(incurred_date, incurred_at) AS d, amount FROM expenses
      WHERE substr(COALESCE(incurred_date, incurred_at),1,10) >= ?
        AND substr(COALESCE(incurred_date, incurred_at),1,10) <= ?`,
    lo,
    hi,
  );
  for (const r of exps) {
    if (inMonth(toCtDate(r.d as string))) expenses += Number(r.amount) || 0;
  }

  const total_expenses = round2(expenses + stripe_fees);
  total_income = round2(total_income);
  return { total_income, total_expenses, net_profit: round2(total_income - total_expenses) };
}

// ─── Row discovery ──────────────────────────────────────────────────────────

function colRange(spec: string): { start: string; end: string } {
  const [start, end] = spec.split(":");
  return { start: start || "C", end: end || start || "C" };
}

async function findKpiRow(client: SheetsClient, s: WcSettings, today = ctToday()): Promise<number | null> {
  const last = s.kpiFirstRow + 80;
  const grid = await client.readRange(
    `${q(s.kpiTab)}!${s.kpiWeekStartCol}${s.kpiFirstRow}:${s.kpiWeekEndCol}${last}`,
    "FORMATTED_VALUE",
  );
  for (let i = 0; i < grid.length; i++) {
    const startCell = grid[i]?.[0] ?? null;
    const endCell = grid[i]?.[1] ?? null;
    if (kpiRowMatches(startCell, endCell, today)) return s.kpiFirstRow + i;
  }
  return null;
}

async function findMarketingRow(
  client: SheetsClient,
  s: WcSettings,
  weekStart: string,
  weekEnd: string,
): Promise<{ row: number | null; sample?: (string | number | null)[][]; formatted?: (string | number | null)[][] }> {
  const last = s.marketingFirstRow + 80;
  const endCol = s.marketingWeekEndCol || s.marketingWeekCol;
  const range = `${q(s.marketingTab)}!${s.marketingWeekCol}${s.marketingFirstRow}:${endCol}${last}`;
  const formatted = await client.readRange(range, "FORMATTED_VALUE");
  let grid = await client.readRange(range, "UNFORMATTED_VALUE");
  if (grid.length === 0) grid = formatted;

  const today = ctToday();
  for (let i = 0; i < grid.length; i++) {
    const startCell = grid[i]?.[0] ?? null;
    const endCell = grid[i]?.[1] ?? null;

    if (marketingRowMatchesWeek(startCell, endCell, weekStart, weekEnd, today)) {
      return { row: s.marketingFirstRow + i };
    }

    // Fallback: week-start label in col A (or any cell) resolves to this Sunday.
    for (const cell of [startCell, endCell]) {
      const parsed = parseShortDate(cell);
      if (!parsed) continue;
      for (const baseYear of [today.year - 1, today.year, today.year + 1]) {
        const iso = `${baseYear}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
        if (sundayOf(iso) === weekStart) return { row: s.marketingFirstRow + i };
      }
    }
  }
  return { row: null, sample: grid.slice(0, 8), formatted: formatted.slice(0, 8) };
}

function marketingActiveWeekFallback(s: WcSettings, weekStart: string): number | null {
  if (s.marketingActiveWeekRow == null) return null;
  if (weekStart !== ctWeekBounds().start) return null;
  return s.marketingActiveWeekRow;
}

async function findMonthlyRow(client: SheetsClient, s: WcSettings, monthIndex: number): Promise<number | null> {
  const grid = await client.readRange(
    `${q(s.monthlyTab)}!${s.monthlyMonthCol}${s.monthlyFirstRow}:${s.monthlyMonthCol}${s.monthlyLastRow}`,
    "FORMATTED_VALUE",
  );
  for (let i = 0; i < grid.length; i++) {
    if (monthLabelMatches(grid[i]?.[0] ?? null, monthIndex)) return s.monthlyFirstRow + i;
  }
  return null;
}

// ─── Sync ─────────────────────────────────────────────────────────────────

export async function runWcSpreadsheetSync(env: Env, now: Date = new Date()): Promise<WcSyncResult> {
  const t0 = Date.now();
  const result: WcSyncResult = {
    status: "success",
    tabs_updated: [],
    tabs_failed: [],
    tabs_skipped: [],
    rows_matched: {},
    data_snapshot: {},
    duration_ms: 0,
  };

  const settings = await loadSettings(env);

  // Kill switch — cron still fires; we return immediately without query/write.
  if (!settings.enabled) {
    result.status = "skipped";
    result.reason = "wc_sync_enabled=false";
    result.duration_ms = Date.now() - t0;
    await logSync(env, result);
    return result;
  }

  const sa = env.WC_SHEETS_SERVICE_ACCOUNT ?? env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sa) {
    result.status = "skipped";
    result.reason = "no Sheets service account configured";
    result.duration_ms = Date.now() - t0;
    await logSync(env, result);
    return result;
  }

  const { id: sheetId, reason } = resolveSheetId(settings, env);
  if (!sheetId) {
    result.status = "skipped";
    result.reason = reason;
    result.duration_ms = Date.now() - t0;
    await logSync(env, result, sheetId);
    return result;
  }

  result.data_snapshot.spreadsheet_id = sheetId;
  const client = new SheetsClient(sa, sheetId);
  const sheetTabs = (await client.listSheets()).map((t) => t.title);
  const marketingTab = resolveTabTitle(sheetTabs, settings.marketingTab);
  const marketingSettings = { ...settings, marketingTab };
  if (marketingTab !== settings.marketingTab) {
    result.data_snapshot.marketing_tab_resolved = marketingTab;
  }
  const wk = ctWeekBounds(now);
  const mo = ctMonthBounds(now);

  let weekly: WeeklyData;
  let monthly: MonthlyData;
  try {
    [weekly, monthly] = await Promise.all([computeWeekly(env, now), computeMonthly(env, now)]);
  } catch (err) {
    result.status = "failure";
    result.error_message = `D1 query failed: ${(err as Error).message}`;
    result.duration_ms = Date.now() - t0;
    await onFailure(env, result, "all", result.error_message, sheetId);
    return result;
  }
  result.data_snapshot = { week: wk, month: mo, weekly, monthly };

  const updates: { range: string; values: (string | number | null)[][] }[] = [];

  // KPI tab — columns C..G (configurable): New Sales, Collections, Leads, Appts, Closed
  try {
    const row = await findKpiRow(client, settings, ctToday(now));
    result.rows_matched[settings.kpiTab] = row;
    if (row == null) {
      result.tabs_skipped.push(settings.kpiTab);
      result.rows_matched[settings.kpiTab] = null;
      console.warn(`[wc] ROW_MISSING kpi week=${wk.start} — skipping KPI tab (row not yet added to sheet)`);
    } else {
      const { start, end } = colRange(settings.kpiDataCols);
      updates.push({
        range: `${q(settings.kpiTab)}!${start}${row}:${end}${row}`,
        values: [[weekly.new_sales, weekly.weekly_collections, weekly.leads_total, weekly.appointments, weekly.closed]],
      });
    }
  } catch (err) {
    result.tabs_failed.push(settings.kpiTab);
    console.warn(`[wc] kpi discovery failed: ${(err as Error).message}`);
  }

  // Marketing Tallies — column letters from system_settings (§7; non-contiguous ranges).
  try {
    const { row, sample, formatted } = await findMarketingRow(client, marketingSettings, wk.start, wk.end);
    const resolvedRow = row ?? marketingActiveWeekFallback(marketingSettings, wk.start);
    result.rows_matched[marketingTab] = resolvedRow;
    if (resolvedRow == null) {
      result.tabs_skipped.push(marketingTab);
      result.rows_matched[marketingTab] = null;
      result.data_snapshot.marketing_debug = {
        tab: marketingTab,
        sheet_tabs: sheetTabs,
        read_range: `${marketingSettings.marketingWeekCol}${marketingSettings.marketingFirstRow}:${marketingSettings.marketingWeekEndCol || marketingSettings.marketingWeekCol}${marketingSettings.marketingFirstRow + 80}`,
        sample_unformatted: sample ?? [],
        sample_formatted: formatted ?? [],
        row6_unformatted: await client.readRange(`${q(marketingTab)}!A6:Z6`, "UNFORMATTED_VALUE").catch(() => []),
        row6_formatted: await client.readRange(`${q(marketingTab)}!A6:Z6`, "FORMATTED_VALUE").catch(() => []),
        header_formatted: await client.readRange(`${q(marketingTab)}!A1:R10`, "FORMATTED_VALUE").catch(() => []),
        fin_c6_e6_unformatted: await client
          .readRange(
            `${q(marketingTab)}!${colRange(settings.marketingFinancialCols).start}6:${colRange(settings.marketingFinancialCols).end}6`,
            "UNFORMATTED_VALUE",
          )
          .catch(() => []),
      };
      console.warn(`[wc] ROW_MISSING marketing week=${wk.start} tab=${marketingTab} — skipping Marketing tab (row not yet added to sheet)`);
    } else {
      if (row == null) result.data_snapshot.marketing_row_fallback = resolvedRow;
      const tab = q(marketingTab);
      const fin = colRange(settings.marketingFinancialCols);
      const lc = settings.marketingLeadCols;
      const ls = weekly.lead_by_source;
      updates.push(
        {
          range: `${tab}!${fin.start}${resolvedRow}:${fin.end}${resolvedRow}`,
          values: [[weekly.new_sales, weekly.bank_deposits, weekly.ar_balance]],
        },
        { range: `${tab}!${lc.organic}${resolvedRow}:${lc.adwords}${resolvedRow}`, values: [[ls.organic, ls.adwords]] },
        { range: `${tab}!${lc.lsa}${resolvedRow}`, values: [[ls.lsa]] },
        { range: `${tab}!${lc.facebook}${resolvedRow}`, values: [[ls.facebook]] },
        { range: `${tab}!${lc.referral}${resolvedRow}:${lc.other}${resolvedRow}`, values: [[ls.referral, ls.repeat, ls.other]] },
        { range: `${tab}!${settings.marketingConvertedCol}${resolvedRow}`, values: [[weekly.converted]] },
      );
    }
  } catch (err) {
    result.tabs_failed.push(marketingTab);
    const msg = (err as Error).message;
    result.error_message = (result.error_message ? result.error_message + " | " : "") + `marketing: ${msg}`;
    console.warn(`[wc] marketing discovery failed: ${msg}`);
  }

  // Monthly Net Profits — columns B:C (configurable): Total Income, Net Profits
  try {
    const row = await findMonthlyRow(client, settings, mo.monthIndex);
    result.rows_matched[settings.monthlyTab] = row;
    if (row == null) {
      result.tabs_skipped.push(settings.monthlyTab);
      result.rows_matched[settings.monthlyTab] = null;
      console.warn(`[wc] ROW_MISSING monthly month=${mo.label} — skipping Monthly tab (row not yet added to sheet)`);
    } else {
      const { start, end } = colRange(settings.monthlyDataCols);
      updates.push({
        range: `${q(settings.monthlyTab)}!${start}${row}:${end}${row}`,
        values: [[monthly.total_income, monthly.net_profit]],
      });
    }
  } catch (err) {
    result.tabs_failed.push(settings.monthlyTab);
    console.warn(`[wc] monthly discovery failed: ${(err as Error).message}`);
  }

  // Execute the batch write.
  if (updates.length > 0) {
    try {
      await client.batchUpdate(updates);
      const written = new Set(updates.map((u) => u.range.split("!")[0].replace(/^'|'$/g, "").replace(/''/g, "'")));
      result.tabs_updated = [...written];

      const marketingRow = result.rows_matched[marketingTab];
      if (marketingRow != null && written.has(marketingTab)) {
        const fin = colRange(settings.marketingFinancialCols);
        const verifyRange = `${q(marketingTab)}!${fin.start}${marketingRow}:${fin.end}${marketingRow}`;
        const readback = await client.readRange(verifyRange, "UNFORMATTED_VALUE");
        result.data_snapshot.marketing_row_verify = {
          range: verifyRange,
          values: readback[0] ?? [],
        };
      }
    } catch (err) {
      result.error_message = `batchUpdate failed: ${(err as Error).message}`;
      // Every attempted tab failed to write.
      for (const u of updates) {
        const tab = u.range.split("!")[0].replace(/^'|'$/g, "").replace(/''/g, "'");
        if (!result.tabs_failed.includes(tab)) result.tabs_failed.push(tab);
      }
    }
  }

  result.status = deriveStatus(result);
  result.duration_ms = Date.now() - t0;

  if (result.status === "failure" || result.status === "partial_failure") {
    await onFailure(env, result, result.tabs_failed.join(",") || "all", result.error_message ?? "row(s) missing or write failed", sheetId);
  } else {
    await logSync(env, result, sheetId);
    await resetFailureStreakIfHealthy(env);
  }
  return result;
}

function deriveStatus(r: WcSyncResult): WcSyncStatus {
  // tabs_skipped (ROW_MISSING) are spec-compliant warn+skip — they don't
  // count as failures and don't trigger DLQ or alerts.
  if (r.tabs_updated.length > 0 && r.tabs_failed.length > 0) return "partial_failure";
  if (r.tabs_updated.length === 0 && r.tabs_failed.length > 0) return "failure";
  return "success";
}

// ─── Reliability: sync_log + DLQ + consecutive-failure heartbeat ────────────

async function logSync(env: Env, r: WcSyncResult, spreadsheetId?: string | null): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sync_log (job_name, started_at, finished_at, status, rows_affected, error_message, duration_ms, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      SYNC_TYPE,
      now,
      now,
      r.status,
      r.tabs_updated.length,
      r.error_message ?? null,
      r.duration_ms,
      JSON.stringify({
        spreadsheet_id: spreadsheetId ?? r.data_snapshot.spreadsheet_id ?? null,
        tabs_updated: r.tabs_updated,
        tabs_failed: r.tabs_failed,
        tabs_skipped: r.tabs_skipped,
        rows_matched: r.rows_matched,
        reason: r.reason,
        data_snapshot: r.data_snapshot,
      }),
    )
    .run();
}

async function onFailure(
  env: Env,
  r: WcSyncResult,
  tabRef: string,
  message: string,
  spreadsheetId?: string | null,
): Promise<void> {
  await logSync(env, r, spreadsheetId);
  await recordDeadLetter(env, {
    jobName: SYNC_TYPE,
    entityType: "wc_spreadsheet",
    entityId: tabRef,
    payload: { rows_matched: r.rows_matched, tabs_failed: r.tabs_failed },
    errorMessage: message,
  });
  await maybeAlertConsecutiveFailures(env);
}

/** Derive the consecutive-failure streak from the last sync_log rows (no KV). */
async function maybeAlertConsecutiveFailures(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT status FROM sync_log WHERE job_name = ? ORDER BY id DESC LIMIT ?`,
  )
    .bind(SYNC_TYPE, CONSECUTIVE_FAILURE_ALERT)
    .all<{ status: string }>();
  const rows = results ?? [];
  if (rows.length < CONSECUTIVE_FAILURE_ALERT) return;
  const allFailed = rows.every((r) => r.status === "failure" || r.status === "partial_failure");
  if (!allFailed) return;
  await notify(env, {
    severity: "error",
    subject: `WC Spreadsheet sync failing (${CONSECUTIVE_FAILURE_ALERT} consecutive)`,
    text:
      `The Wealthy Contractor spreadsheet sync has failed ${CONSECUTIVE_FAILURE_ALERT} cycles in a row.\n` +
      `Check the wc_spreadsheet rows in sync_log and the qbo/wc DLQ.\n`,
    dedupeKey: "wc_spreadsheet:consecutive-failures",
    dedupeWindowMs: 6 * 60 * 60 * 1000,
  });
}

async function resetFailureStreakIfHealthy(_env: Env): Promise<void> {
  // No KV counter to reset — the streak is derived from sync_log on each check,
  // so a single 'success' row naturally breaks the consecutive-failure run.
}
export function resolveTabTitle(titles: string[], configured: string): string {
  const want = configured.trim().toLowerCase();
  const matches = titles.filter((t) => t.trim().toLowerCase() === want);
  if (matches.length > 0) {
    const withoutTrailingSpace = matches.find((t) => t === t.trim());
    return withoutTrailingSpace ?? matches[0];
  }
  if (titles.includes(configured)) return configured;
  return configured;
}

function q(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Status (for the admin route) ───────────────────────────────────────────

export interface WcStatus {
  enabled: boolean;
  spreadsheet_id_configured: boolean;
  last_sync_at: string | null;
  last_status: string | null;
  last_details: unknown;
}

export async function getWcStatus(env: Env): Promise<WcStatus> {
  const settings = await loadSettings(env);
  const { id } = resolveSheetId(settings, env);
  const last = await env.DB.prepare(
    `SELECT finished_at, status, details FROM sync_log WHERE job_name = ? ORDER BY id DESC LIMIT 1`,
  )
    .bind(SYNC_TYPE)
    .first<{ finished_at: string; status: string; details: string | null }>();
  let details: unknown = null;
  if (last?.details) {
    try {
      details = JSON.parse(last.details);
    } catch {
      details = null;
    }
  }
  return {
    enabled: settings.enabled,
    spreadsheet_id_configured: !!id,
    last_sync_at: last?.finished_at ?? null,
    last_status: last?.status ?? null,
    last_details: details,
  };
}

export async function listWcSheetTabs(env: Env): Promise<string[]> {
  const settings = await loadSettings(env);
  const { id: sheetId } = resolveSheetId(settings, env);
  if (!sheetId) throw new Error("no sheet id");
  const sa = env.WC_SHEETS_SERVICE_ACCOUNT ?? env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sa) throw new Error("no service account");
  const client = new SheetsClient(sa, sheetId);
  const tabs = await client.listSheets();
  return tabs.map((t) => t.title);
}
