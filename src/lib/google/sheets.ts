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

  async readRange(range: string): Promise<(string | number | null)[][]> {
    const token = await this.token();
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
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
}
