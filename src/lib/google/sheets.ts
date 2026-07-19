/**
 * Thin wrapper around the Google Sheets v4 REST API for Cloudflare Workers.
 * Handles the most common operations we need for the WC workbook sync:
 *   - listSheets(): inventory of tab names + grid dimensions
 *   - readRange(): read a range as a 2D array of strings/numbers
 *   - writeRange(): write a 2D array into a range (overwrites)
 *   - batchUpdate(): apply multiple writes atomically
 */

import { getGoogleAccessToken } from "./auth.js";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface SheetTab {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

export interface SheetMerge {
  sheetId: number;
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
}

export class SheetsClient {
  constructor(
    private readonly serviceAccountJson: string,
    private readonly spreadsheetId: string,
  ) {}

  private async token(): Promise<string> {
    return getGoogleAccessToken(this.serviceAccountJson, [SHEETS_SCOPE]);
  }

  async listSheets(): Promise<SheetTab[]> {
    const token = await this.token();
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}?fields=sheets(properties(sheetId,title,gridProperties))`;
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`listSheets failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as {
      sheets: {
        properties: {
          sheetId: number;
          title: string;
          gridProperties: { rowCount: number; columnCount: number };
        };
      }[];
    };
    return data.sheets.map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      rowCount: s.properties.gridProperties.rowCount,
      columnCount: s.properties.gridProperties.columnCount,
    }));
  }

  async readRange(
    range: string,
    renderOption: "UNFORMATTED_VALUE" | "FORMATTED_VALUE" = "UNFORMATTED_VALUE",
  ): Promise<(string | number | null)[][]> {
    const token = await this.token();
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=${renderOption}`;
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`readRange ${range} failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as { values?: (string | number | null)[][] };
    return data.values ?? [];
  }

  async writeRange(
    range: string,
    values: (string | number | null)[][],
  ): Promise<void> {
    const token = await this.token();
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ range, values }),
    });
    if (!resp.ok) throw new Error(`writeRange ${range} failed (${resp.status}): ${await resp.text()}`);
  }

  async batchUpdate(
    updates: { range: string; values: (string | number | null)[][] }[],
  ): Promise<void> {
    const token = await this.token();
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}/values:batchUpdate`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: updates.map((u) => ({ range: u.range, values: u.values })),
      }),
    });
    if (!resp.ok) throw new Error(`batchUpdate failed (${resp.status}): ${await resp.text()}`);
  }

  /** Structural updates (insert rows, merge cells) — not value writes. */
  async batchSpreadsheetUpdate(requests: object[]): Promise<void> {
    if (requests.length === 0) return;
    const token = await this.token();
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}:batchUpdate`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requests }),
    });
    if (!resp.ok) throw new Error(`batchSpreadsheetUpdate failed (${resp.status}): ${await resp.text()}`);
  }

  async listMerges(): Promise<SheetMerge[]> {
    const token = await this.token();
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}?fields=sheets(properties(sheetId),merges)`;
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`listMerges failed (${resp.status}): ${await resp.text()}`);
    const data = (await resp.json()) as {
      sheets?: {
        properties: { sheetId: number };
        merges?: {
          startRowIndex: number;
          endRowIndex: number;
          startColumnIndex: number;
          endColumnIndex: number;
        }[];
      }[];
    };
    const out: SheetMerge[] = [];
    for (const sheet of data.sheets ?? []) {
      for (const merge of sheet.merges ?? []) {
        out.push({ sheetId: sheet.properties.sheetId, ...merge });
      }
    }
    return out;
  }

  /** Insert one blank row before the 1-based row number (shifts that row down). */
  async insertRowBefore(sheetId: number, row1Based: number, inheritFromBefore = true): Promise<void> {
    const startIndex = row1Based - 1;
    await this.batchSpreadsheetUpdate([
      {
        insertDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex,
            endIndex: startIndex + 1,
          },
          inheritFromBefore,
        },
      },
    ]);
  }

  async mergeCells(
    sheetId: number,
    startRow1Based: number,
    endRow1Based: number,
    startCol0Based: number,
    endCol0Based: number,
  ): Promise<void> {
    await this.batchSpreadsheetUpdate([
      {
        mergeCells: {
          mergeType: "MERGE_ALL",
          range: {
            sheetId,
            startRowIndex: startRow1Based - 1,
            endRowIndex: endRow1Based,
            startColumnIndex: startCol0Based,
            endColumnIndex: endCol0Based,
          },
        },
      },
    ]);
  }
}
