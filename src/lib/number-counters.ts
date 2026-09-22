/**
 * Monotonic entity-number allocators backed by system_settings counters.
 * Never use MAX(column)+1 — deletes must not free numbers for reuse.
 *
 * Counter value = next number to allocate. Atomic UPDATE … RETURNING claims
 * it and bumps the stored value in one statement.
 */

import type { Env } from "../env.js";

export const NEXT_REQUEST_NUMBER_KEY = "next_request_number";
export const NEXT_JOB_NUMBER_KEY = "next_job_number";
export const NEXT_INVOICE_NUMBER_KEY = "next_invoice_number";

/**
 * Native CHS invoices start here. Jobber's client-visible numbers stay below
 * this and are written onto invoices.invoice_number directly — they must not
 * call allocateNextInvoiceNumber.
 */
export const CHS_INVOICE_SERIES_START = 10_000;

type CounterMeta = {
  key: string;
  category: string;
  label: string;
  description: string;
  /** SQL that returns { n: number } = current MAX of the numbered column. */
  maxSql: string;
  /** Never seed the counter below this. */
  floor?: number;
};

async function claimNext(env: Env, key: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `UPDATE system_settings
        SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
            updated_at = datetime('now')
      WHERE key = ?
        AND CAST(value AS INTEGER) >= 1
      RETURNING CAST(CAST(value AS INTEGER) - 1 AS INTEGER) AS n`,
  )
    .bind(key)
    .first<{ n: number }>();

  if (!row || !Number.isFinite(row.n) || row.n < 1) return null;
  return row.n;
}

async function ensureSeeded(env: Env, meta: CounterMeta): Promise<void> {
  const maxRow = await env.DB.prepare(meta.maxSql).first<{ n: number | null }>();
  const seedNext = Math.max(meta.floor ?? 1, Math.max(0, Number(maxRow?.n ?? 0)) + 1);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO system_settings
       (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'number', ?, ?, ?, ?)`,
  )
    .bind(meta.key, String(seedNext), meta.category, meta.label, meta.description, now)
    .run();
}

async function allocateNext(env: Env, meta: CounterMeta): Promise<number> {
  const first = await claimNext(env, meta.key);
  if (first != null) return first;

  await ensureSeeded(env, meta);

  const second = await claimNext(env, meta.key);
  if (second == null) {
    throw new Error(`Failed to allocate number for ${meta.key}`);
  }
  return second;
}

const REQUEST_META: CounterMeta = {
  key: NEXT_REQUEST_NUMBER_KEY,
  category: "estimating",
  label: "Next request number",
  description: "Durable counter for estimate_requests.request_number (never reuse after delete).",
  maxSql: "SELECT COALESCE(MAX(request_number), 0) AS n FROM estimate_requests",
};

const JOB_META: CounterMeta = {
  key: NEXT_JOB_NUMBER_KEY,
  category: "jobs",
  label: "Next job number",
  description: "Durable counter for jobs.job_number (never reuse after delete).",
  maxSql: "SELECT COALESCE(MAX(job_number), 0) AS n FROM jobs",
};

const INVOICE_META: CounterMeta = {
  key: NEXT_INVOICE_NUMBER_KEY,
  category: "billing",
  label: "Next invoice number",
  description: "CHS invoice series. Starts at 10000. Jobber imports write their own visible numbers below that and do not bump this counter.",
  maxSql: "SELECT COALESCE(MAX(invoice_number), 0) AS n FROM invoices",
  floor: CHS_INVOICE_SERIES_START,
};

/**
 * Jobber's client-visible invoice number (what the client saw, and what QBO
 * DocNumber should match). Does not read or update next_invoice_number.
 */
export function jobberVisibleInvoiceNumber(raw: unknown): number {
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim().replace(/^#/, "");
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n >= CHS_INVOICE_SERIES_START) {
    throw new Error(
      `Jobber invoice number ${text || "(blank)"} must be an integer below ${CHS_INVOICE_SERIES_START}`,
    );
  }
  return n;
}

export function allocateNextRequestNumber(env: Env): Promise<number> {
  return allocateNext(env, REQUEST_META);
}

export function allocateNextJobNumber(env: Env): Promise<number> {
  return allocateNext(env, JOB_META);
}

export function allocateNextInvoiceNumber(env: Env): Promise<number> {
  return allocateNext(env, INVOICE_META);
}
