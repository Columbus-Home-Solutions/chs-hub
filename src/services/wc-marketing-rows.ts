/**
 * Marketing Tallies tab — automatic week-row discovery and creation.
 *
 * Production workbook quirk: column A/B week labels are often blank in the
 * Sheets Values API (merged cells never populated by the coaching team).
 * When labels exist we match by date; otherwise we place new weeks on the
 * first empty row after the last row with CHS-written data.
 */

import type { SheetMerge, SheetTab, SheetsClient } from "../lib/google/sheets.js";
import {
  type DateParts,
  formatMarketingWeekLabel,
  marketingRowMatchesWeek,
  parseShortDate,
  sundayOf,
} from "./wc-dates.js";

export interface MarketingRowSettings {
  marketingTab: string;
  marketingWeekCol: string;
  marketingWeekEndCol: string;
  marketingFinancialCols: string;
  marketingLeadCols: Record<string, string>;
  marketingConvertedCol: string;
  marketingFirstRow: number;
  /** Emergency-only override; ignored for routine sync when auto logic works. */
  marketingActiveWeekRow: number | null;
}

export type MarketingRowDiscovery = "matched_label" | "created_row" | "reused_empty_row";

export interface MarketingRowResolution {
  row: number;
  discovery: MarketingRowDiscovery;
  weekLabel: string;
  /** True when a structural insertDimension was applied. */
  insertedRow: boolean;
}

function q(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function colLetterToIndex(col: string): number {
  let n = 0;
  for (const c of col.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function rowHasValue(cells: (string | number | null)[] | undefined): boolean {
  if (!cells) return false;
  return cells.some((c) => c != null && c !== "");
}

/** CHS auto-populated columns used to detect occupied week rows. */
export function marketingDataColumnLetters(settings: MarketingRowSettings): string[] {
  const fin = settings.marketingFinancialCols.split(":");
  const finStart = fin[0] ?? "C";
  const finEnd = fin[1] ?? finStart;
  const cols = new Set<string>([finStart, finEnd]);
  for (const col of Object.values(settings.marketingLeadCols)) cols.add(col);
  cols.add(settings.marketingConvertedCol);
  return [...cols].sort((a, b) => colLetterToIndex(a) - colLetterToIndex(b));
}

export function findMarketingRowInGrids(
  weekGrid: (string | number | null)[][],
  formattedGrid: (string | number | null)[][],
  settings: MarketingRowSettings,
  weekStart: string,
  weekEnd: string,
  today: DateParts,
): number | null {
  const len = Math.max(weekGrid.length, formattedGrid.length);
  for (let i = 0; i < len; i++) {
    const raw = weekGrid[i] ?? [];
    const fmt = formattedGrid[i] ?? [];
    const startCell = raw[0] ?? fmt[0] ?? null;
    const endCell = raw[1] ?? fmt[1] ?? null;

    if (marketingRowMatchesWeek(startCell, endCell, weekStart, weekEnd, today)) {
      return settings.marketingFirstRow + i;
    }

    for (const cell of [startCell, endCell, fmt[0], fmt[1]]) {
      const parsed = parseShortDate(cell);
      if (!parsed) continue;
      for (const baseYear of [today.year - 1, today.year, today.year + 1]) {
        const iso = `${baseYear}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
        if (sundayOf(iso) === weekStart) return settings.marketingFirstRow + i;
      }
    }
  }
  return null;
}

export function findLastMarketingDataRow(
  dataGrid: (string | number | null)[][],
  settings: MarketingRowSettings,
): number | null {
  let last: number | null = null;
  for (let i = 0; i < dataGrid.length; i++) {
    if (rowHasValue(dataGrid[i])) last = settings.marketingFirstRow + i;
  }
  return last;
}

export function nextMarketingWeekRow(lastDataRow: number | null, firstRow: number): number {
  if (lastDataRow == null || lastDataRow < firstRow) return firstRow;
  return lastDataRow + 1;
}

function weekLabelMergeOnRow(
  merges: SheetMerge[],
  sheetId: number,
  row1Based: number,
  weekCol0: number,
  weekEndCol0: number,
): SheetMerge | null {
  const row0 = row1Based - 1;
  for (const m of merges) {
    if (m.sheetId !== sheetId) continue;
    if (m.startRowIndex !== row0 || m.endRowIndex !== row0 + 1) continue;
    if (m.startColumnIndex <= weekCol0 && m.endColumnIndex >= weekEndCol0 + 1) return m;
  }
  return null;
}

async function ensureWeekLabelMerge(
  client: SheetsClient,
  sheetId: number,
  templateRow: number,
  targetRow: number,
  weekCol0: number,
  weekEndCol0: number,
  merges: SheetMerge[],
): Promise<void> {
  const templateMerge = weekLabelMergeOnRow(merges, sheetId, templateRow, weekCol0, weekEndCol0);
  if (!templateMerge) return;
  const width = templateMerge.endColumnIndex - templateMerge.startColumnIndex;
  await client.mergeCells(sheetId, targetRow, targetRow, weekCol0, weekCol0 + width);
}

export async function resolveMarketingWeekRow(
  client: SheetsClient,
  sheetTabs: SheetTab[],
  settings: MarketingRowSettings,
  weekStart: string,
  weekEnd: string,
  today: DateParts,
): Promise<MarketingRowResolution> {
  const tab = q(settings.marketingTab);
  const last = settings.marketingFirstRow + 80;
  const endCol = settings.marketingWeekEndCol || settings.marketingWeekCol;
  const weekRange = `${tab}!${settings.marketingWeekCol}${settings.marketingFirstRow}:${endCol}${last}`;

  const dataCols = marketingDataColumnLetters(settings);
  const dataStart = dataCols[0];
  const dataEnd = dataCols[dataCols.length - 1];
  const dataRange = `${tab}!${dataStart}${settings.marketingFirstRow}:${dataEnd}${last}`;

  const [formattedWeekGrid, weekGrid, dataGrid] = await Promise.all([
    client.readRange(weekRange, "FORMATTED_VALUE"),
    client.readRange(weekRange, "UNFORMATTED_VALUE"),
    client.readRange(dataRange, "UNFORMATTED_VALUE"),
  ]);
  const effectiveWeekGrid = weekGrid.length > 0 ? weekGrid : formattedWeekGrid;

  const weekLabel = formatMarketingWeekLabel(weekStart, weekEnd);

  const matched = findMarketingRowInGrids(effectiveWeekGrid, formattedWeekGrid, settings, weekStart, weekEnd, today);
  if (matched != null) {
    return { row: matched, discovery: "matched_label", weekLabel, insertedRow: false };
  }

  const lastDataRow = findLastMarketingDataRow(dataGrid, settings);
  let targetRow = nextMarketingWeekRow(lastDataRow, settings.marketingFirstRow);
  let insertedRow = false;

  const sheetMeta = sheetTabs.find((t) => t.title === settings.marketingTab);
  if (!sheetMeta) throw new Error(`marketing tab not found: ${settings.marketingTab}`);

  const targetDataRow = await client.readRange(`${tab}!${dataStart}${targetRow}:${dataEnd}${targetRow}`, "UNFORMATTED_VALUE");
  if (rowHasValue(targetDataRow[0])) {
    await client.insertRowBefore(sheetMeta.sheetId, targetRow, true);
    insertedRow = true;
  }

  const weekCol0 = colLetterToIndex(settings.marketingWeekCol);
  const weekEndCol0 = colLetterToIndex(settings.marketingWeekEndCol || settings.marketingWeekCol);
  const templateRow = lastDataRow ?? settings.marketingFirstRow;
  const merges = await client.listMerges();
  await ensureWeekLabelMerge(client, sheetMeta.sheetId, templateRow, targetRow, weekCol0, weekEndCol0, merges);

  const labelRange = `${tab}!${settings.marketingWeekCol}${targetRow}:${endCol}${targetRow}`;
  const short = (iso: string) => {
    const [, month, day] = iso.split("-").map(Number);
    return `${month}/${day}`;
  };
  const labelValues = endCol !== settings.marketingWeekCol ? [[short(weekStart), short(weekEnd)]] : [[weekLabel]];

  await client.batchUpdate([{ range: labelRange, values: labelValues }]);

  return {
    row: targetRow,
    discovery: insertedRow ? "created_row" : "reused_empty_row",
    weekLabel,
    insertedRow,
  };
}
