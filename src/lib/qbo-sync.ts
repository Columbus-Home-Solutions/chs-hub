/**
 * QuickBooks Online reference pull + idempotent push — Sprint 14.
 *
 * Direction B (decided): transactions flow one way CHS → QBO; reference data
 * (Customers / Vendors / Accounts) is READ from QBO so each push maps to the
 * right *existing* entity instead of spawning a duplicate.
 *
 * Idempotency contract (the Opus piece): the push is exactly-once, keyed on the
 * QBO-id column. A record already carrying qbo_invoice_id / qbo_payment_id /
 * qbo_transaction_id is NEVER re-pushed; on success we stamp the id + synced_at
 * in a single write. "Unsynced" = qbo_*_id IS NULL (the dirty flag). The partial
 * UNIQUE index on each id column is the hard dedup anchor.
 *
 * Mapping gate (business rule): a push NEVER fires for a record whose required
 * QBO ref isn't mapped — it surfaces "needs mapping" and is skipped, so QBO is
 * never asked to auto-create a Customer/Vendor/Account.
 */

import type { Env } from "../env.js";
import { recordDeadLetter } from "./ops/dlq.js";
import {
  getValidAccessToken,
  loadConnection,
  markSynced,
  resolveQboApiContext,
  saveConfiguration,
  tokenShape,
  QboNotConnectedError,
  QboReconnectError,
  type QboConfiguration,
  type QboConnection,
} from "./qbo-auth.js";

const QBO_DLQ_JOB = "qbo_sync";
const MAX_429_RETRIES = 3;

/** Fallback QBO Customer for clients with no per-client `qbo_customer_id`. */
export const SETTING_QBO_DEFAULT_CUSTOMER_ID = "qbo_default_customer_id";
export const SETTING_QBO_DEFAULT_CUSTOMER_NAME = "qbo_default_customer_name";
/** Go-live gate: payment push (sweep + DLQ replay) stays off until Tony flips this. */
export const SETTING_QBO_PAYMENT_SYNC_ENABLED = "qbo_payment_sync_enabled";
/** Go-live gate: invoice push (sweep + DLQ replay) stays off until Tony flips this. */
export const SETTING_QBO_INVOICE_SYNC_ENABLED = "qbo_invoice_sync_enabled";

/** True only when system_settings explicitly stores "true". Missing/false → off. */
export async function isQboPaymentSyncEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT value FROM system_settings WHERE key = ?`)
    .bind(SETTING_QBO_PAYMENT_SYNC_ENABLED)
    .first<{ value: string | null }>();
  return (row?.value ?? "").trim().toLowerCase() === "true";
}

/** True only when system_settings explicitly stores "true". Missing/false → off. */
export async function isQboInvoiceSyncEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT value FROM system_settings WHERE key = ?`)
    .bind(SETTING_QBO_INVOICE_SYNC_ENABLED)
    .first<{ value: string | null }>();
  return (row?.value ?? "").trim().toLowerCase() === "true";
}

/**
 * Permanent structural exclusion — Jobber history must never push to QBO,
 * regardless of `qbo_payment_sync_enabled`. Not a toggle.
 *
 * Signals: jobs.data_source = 'jobber_import', or a Jobber GraphQL payment id
 * (covers orphan payments with no job_id).
 */
export function isJobberExcludedPayment(opts: {
  paymentId: string;
  jobDataSource?: string | null;
}): boolean {
  if ((opts.jobDataSource ?? "").trim() === "jobber_import") return true;
  // Jobber GraphQL global ids are base64 of "gid://Jobber/..."
  if (opts.paymentId.startsWith("Z2lkOi8vSm9iYmVy")) return true;
  return false;
}

/**
 * Permanent structural exclusion — Jobber history must never push to QBO,
 * regardless of `qbo_invoice_sync_enabled`. Not a toggle.
 *
 * Signals: jobs.data_source = 'jobber_import', or a Jobber GraphQL invoice id
 * (covers orphan invoices with job_id NULL).
 */
export function isJobberExcludedInvoice(opts: {
  invoiceId: string;
  jobDataSource?: string | null;
}): boolean {
  if ((opts.jobDataSource ?? "").trim() === "jobber_import") return true;
  if (opts.invoiceId.startsWith("Z2lkOi8vSm9iYmVy")) return true;
  return false;
}

/** Explicit per-client mapping wins; otherwise the system default (if set). */
export function resolveQboCustomerId(
  clientQboCustomerId: string | null | undefined,
  defaultQboCustomerId: string | null | undefined,
): string | null {
  const explicit = (clientQboCustomerId ?? "").trim();
  if (explicit) return explicit;
  const fallback = (defaultQboCustomerId ?? "").trim();
  return fallback || null;
}

export async function getQboDefaultCustomer(
  env: Env,
): Promise<{ qbo_customer_id: string | null; qbo_customer_name: string | null }> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM system_settings WHERE key IN (?, ?)`,
  )
    .bind(SETTING_QBO_DEFAULT_CUSTOMER_ID, SETTING_QBO_DEFAULT_CUSTOMER_NAME)
    .all<{ key: string; value: string }>();
  const map = new Map((results ?? []).map((r) => [r.key, r.value]));
  const id = (map.get(SETTING_QBO_DEFAULT_CUSTOMER_ID) ?? "").trim() || null;
  const name = (map.get(SETTING_QBO_DEFAULT_CUSTOMER_NAME) ?? "").trim() || null;
  return { qbo_customer_id: id, qbo_customer_name: name };
}

export async function setQboDefaultCustomer(
  env: Env,
  qboCustomerId: string | null,
  qboCustomerName?: string | null,
): Promise<void> {
  const id = (qboCustomerId ?? "").trim();
  if (!id) {
    await env.DB.prepare(`DELETE FROM system_settings WHERE key IN (?, ?)`)
      .bind(SETTING_QBO_DEFAULT_CUSTOMER_ID, SETTING_QBO_DEFAULT_CUSTOMER_NAME)
      .run();
    return;
  }
  const name = (qboCustomerName ?? "").trim() || null;
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'integrations', 'QBO default customer',
             'Fallback QBO Customer for CHS clients without an individual mapping.', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(SETTING_QBO_DEFAULT_CUSTOMER_ID, id)
    .run();
  if (name) {
    await env.DB.prepare(
      `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
       VALUES (?, ?, 'string', 'integrations', 'QBO default customer name',
               'Display name for qbo_default_customer_id.', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
      .bind(SETTING_QBO_DEFAULT_CUSTOMER_NAME, name)
      .run();
  }
}

// ─── QBO API request (auth + 429 backoff + Retry-After) ────────────────────

async function qboFetch(
  env: Env,
  _conn: QboConnection,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  // Always re-resolve host/realm from D1 — never trust a possibly-stale conn.environment.
  const ctx = await resolveQboApiContext(env);
  const url = path.startsWith("http") ? path : `${ctx.apiBase}${path}`;
  const pathOnly = path.split("?")[0] ?? path;

  let attempt = 0;
  let forcedRefresh = false;
  for (;;) {
    const token = await getValidAccessToken(env, { forceRefresh: forcedRefresh });
    forcedRefresh = false;
    const shape = tokenShape(token);
    console.log(
      `[qbo] ${init.method ?? "GET"} ${url.split("?")[0]} env=${ctx.environment} realm=${ctx.realmId} ` +
        `token_len=${shape.length} prefix=${shape.prefix} forceRefreshAttempt=${attempt > 0}`,
    );

    const resp = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const intuitTid = resp.headers.get("intuit_tid");

    if (resp.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await sleep(waitMs);
      attempt++;
      continue;
    }

    // Expired / revoked access token → one forced refresh + retry (classic 003200).
    if (resp.status === 401 && attempt < 1) {
      console.warn(
        `[qbo] 401 from ${ctx.apiHost}${pathOnly} tid=${intuitTid ?? "none"} — forcing token refresh and retrying once`,
      );
      // Drain body before retry.
      await resp.text().catch(() => "");
      forcedRefresh = true;
      attempt++;
      continue;
    }

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(
        `QBO ${init.method ?? "GET"} ${url} failed (${resp.status}) tid=${intuitTid ?? "none"}: ${text.slice(0, 400)}`,
      );
    }
    return text ? JSON.parse(text) : {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function qboQuery<T>(env: Env, conn: QboConnection, query: string): Promise<T[]> {
  const data = (await qboFetch(
    env,
    conn,
    `/query?query=${encodeURIComponent(query)}&minorversion=70`,
  )) as { QueryResponse?: Record<string, T[]> };
  const qr = data.QueryResponse ?? {};
  // The result array is keyed by the entity name (Customer/Vendor/Account).
  for (const k of Object.keys(qr)) {
    if (Array.isArray(qr[k])) return qr[k] as T[];
  }
  return [];
}

// ─── Reference pull ─────────────────────────────────────────────────────────

export interface QboRef {
  id: string;
  name: string;
  type?: string;
}

export async function fetchCustomers(env: Env, conn: QboConnection): Promise<QboRef[]> {
  const rows = await qboQuery<{ Id: string; DisplayName?: string; CompanyName?: string }>(
    env,
    conn,
    "SELECT Id, DisplayName, CompanyName FROM Customer MAXRESULTS 1000",
  );
  return rows.map((r) => ({ id: r.Id, name: r.DisplayName ?? r.CompanyName ?? r.Id }));
}

export async function fetchVendors(env: Env, conn: QboConnection): Promise<QboRef[]> {
  const rows = await qboQuery<{ Id: string; DisplayName?: string; CompanyName?: string }>(
    env,
    conn,
    "SELECT Id, DisplayName, CompanyName FROM Vendor MAXRESULTS 1000",
  );
  return rows.map((r) => ({ id: r.Id, name: r.DisplayName ?? r.CompanyName ?? r.Id }));
}

export async function fetchAccounts(env: Env, conn: QboConnection): Promise<QboRef[]> {
  const rows = await qboQuery<{ Id: string; Name?: string; AccountType?: string }>(
    env,
    conn,
    "SELECT Id, Name, AccountType FROM Account MAXRESULTS 1000",
  );
  return rows.map((r) => ({ id: r.Id, name: r.Name ?? r.Id, type: r.AccountType }));
}

// ─── Auto-match + persist reference mapping ─────────────────────────────────

function normalizeName(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface MatchSuggestion {
  chs_id: string;
  chs_name: string;
  qbo_id: string | null;
  qbo_name: string | null;
  matched: boolean;
}

/** Auto-match CHS clients → QBO Customers by name (owner confirms/overrides). */
export async function suggestClientMatches(env: Env, conn: QboConnection): Promise<MatchSuggestion[]> {
  const customers = await fetchCustomers(env, conn);
  const byName = new Map(customers.map((c) => [normalizeName(c.name), c]));
  const { results } = await env.DB.prepare(
    `SELECT id, name, qbo_customer_id FROM clients`,
  ).all<{ id: string; name: string; qbo_customer_id: string | null }>();
  return (results ?? []).map((c) => {
    if (c.qbo_customer_id) {
      const existing = customers.find((x) => x.id === c.qbo_customer_id);
      return { chs_id: c.id, chs_name: c.name, qbo_id: c.qbo_customer_id, qbo_name: existing?.name ?? null, matched: true };
    }
    const hit = byName.get(normalizeName(c.name));
    return { chs_id: c.id, chs_name: c.name, qbo_id: hit?.id ?? null, qbo_name: hit?.name ?? null, matched: false };
  });
}

export async function suggestVendorMatches(env: Env, conn: QboConnection): Promise<MatchSuggestion[]> {
  const vendors = await fetchVendors(env, conn);
  const byName = new Map(vendors.map((v) => [normalizeName(v.name), v]));
  const { results } = await env.DB.prepare(
    `SELECT id, COALESCE(company_name, company) AS name, qbo_vendor_id FROM subcontractors`,
  ).all<{ id: string; name: string; qbo_vendor_id: string | null }>();
  return (results ?? []).map((v) => {
    if (v.qbo_vendor_id) {
      const existing = vendors.find((x) => x.id === v.qbo_vendor_id);
      return { chs_id: v.id, chs_name: v.name, qbo_id: v.qbo_vendor_id, qbo_name: existing?.name ?? null, matched: true };
    }
    const hit = byName.get(normalizeName(v.name));
    return { chs_id: v.id, chs_name: v.name, qbo_id: hit?.id ?? null, qbo_name: hit?.name ?? null, matched: false };
  });
}

export async function setClientMapping(env: Env, clientId: string, qboCustomerId: string | null): Promise<void> {
  await env.DB.prepare(`UPDATE clients SET qbo_customer_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(qboCustomerId, clientId)
    .run();
}

export async function setVendorMapping(env: Env, subId: string, qboVendorId: string | null): Promise<void> {
  await env.DB.prepare(`UPDATE subcontractors SET qbo_vendor_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(qboVendorId, subId)
    .run();
}

/** Persist the expense_type → QBO Account map into configuration JSON. */
export async function setAccountMap(
  env: Env,
  conn: QboConnection,
  accountMap: Record<string, string>,
): Promise<void> {
  const next: QboConfiguration = { ...conn.configuration, account_map: accountMap };
  await saveConfiguration(env, next);
}

// ─── Entity builders (CHS → QBO; always the full object) ────────────────────

interface InvoiceRow {
  id: string;
  job_id: string | null;
  invoice_number: number | null;
  total: number | null;
  qbo_customer_id: string | null;
}

export async function buildQboInvoice(env: Env, inv: InvoiceRow): Promise<Record<string, unknown>> {
  const defaultItemRef =
    ((await loadConnection(env))?.configuration.default_item_ref as string) ?? "1";
  let lines: { id: string; name: string; quantity: number; unit_price: number }[] = [];
  if (inv.job_id) {
    const r = await env.DB.prepare(
      `SELECT id, name, COALESCE(quantity,1) AS quantity, COALESCE(unit_price,0) AS unit_price
         FROM line_items WHERE job_id = ?`,
    )
      .bind(inv.job_id)
      .all<{ id: string; name: string; quantity: number; unit_price: number }>();
    lines = r.results ?? [];
  }

  const Line =
    lines.length > 0
      ? lines.map((li) => ({
          DetailType: "SalesItemLineDetail",
          Amount: round2(li.quantity * li.unit_price),
          Description: li.name,
          SalesItemLineDetail: {
            ItemRef: { value: defaultItemRef },
            Qty: li.quantity,
            UnitPrice: li.unit_price,
          },
        }))
      : [
          {
            DetailType: "SalesItemLineDetail",
            Amount: round2(inv.total ?? 0),
            Description: `CHS Invoice #${inv.invoice_number ?? ""}`,
            SalesItemLineDetail: { ItemRef: { value: defaultItemRef } },
          },
        ];

  return {
    CustomerRef: { value: inv.qbo_customer_id },
    DocNumber: inv.invoice_number != null ? String(inv.invoice_number) : undefined,
    PrivateNote: `CHS-INV:${inv.id}`,
    Line,
  };
}

interface PaymentRow {
  id: string;
  amount: number | null;
  invoice_id: string | null;
  qbo_customer_id: string | null;
  qbo_invoice_id: string | null;
  qbo_payment_id?: string | null;
  received_date?: string | null;
  collected_at?: string | null;
}

/** YYYY-MM-DD for QBO TxnDate. Prefer received_date; fall back to collected_at. */
export function resolvePaymentTxnDate(
  p: Pick<PaymentRow, "received_date" | "collected_at">,
): string | null {
  for (const raw of [p.received_date, p.collected_at]) {
    if (!raw) continue;
    const s = String(raw).trim();
    if (!s) continue;
    // Already a date or ISO datetime — take the date portion.
    const day = s.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  }
  return null;
}

export function buildQboPayment(
  p: PaymentRow,
  opts?: { depositAccountId?: string | null },
): Record<string, unknown> {
  // TotalAmt is the gross collected amount, which INCLUDES the convenience fee
  // (income). The Stripe processing fee is a cost and is represented on the
  // expense/Purchase side, not netted out of the payment here.
  const payment: Record<string, unknown> = {
    CustomerRef: { value: p.qbo_customer_id },
    TotalAmt: round2(p.amount ?? 0),
    // Idempotency key — same pattern as invoices (CHS-INV:) / expenses (CHS-EXP:).
    PrivateNote: `CHS-PAY:${p.id}`,
  };
  // Always set TxnDate from the real payment date — QBO defaults omitted TxnDate
  // to "today", which mis-buckets historical Jobber imports into the current period.
  const txnDate = resolvePaymentTxnDate(p);
  if (txnDate) payment.TxnDate = txnDate;
  const deposit = (opts?.depositAccountId ?? "").trim();
  if (deposit) {
    payment.DepositToAccountRef = { value: deposit };
  }
  if (p.qbo_invoice_id) {
    payment.Line = [
      {
        Amount: round2(p.amount ?? 0),
        LinkedTxn: [{ TxnId: p.qbo_invoice_id, TxnType: "Invoice" }],
      },
    ];
  }
  return payment;
}

interface ExpenseRow {
  id: string;
  amount: number | null;
  description: string | null;
  expense_type: string | null;
  sub_id: string | null;
  qbo_vendor_id: string | null;
}

/**
 * Payment *source* account (bank/credit the money left from) — not the expense
 * category AccountRef on the line. Any expense with a mapped QBO Vendor
 * (subcontractor or day-rate labor via sub_id) may use the subcontractor
 * payment account; otherwise fall back to payment_account_ref.
 * Keys off vendor linkage, not expense_type.
 */
export function resolvePaymentAccountId(
  e: Pick<ExpenseRow, "sub_id" | "qbo_vendor_id">,
  paymentAccountRef: string | null | undefined,
  subcontractorPaymentAccountRef: string | null | undefined,
): string {
  const defaultAcct = (paymentAccountRef ?? "").trim();
  if (e.qbo_vendor_id) {
    const subAcct = (subcontractorPaymentAccountRef ?? "").trim();
    if (subAcct) return subAcct;
  }
  return defaultAcct;
}

export function buildQboPurchase(
  e: ExpenseRow,
  accountId: string,
  paymentAccountId: string,
): Record<string, unknown> {
  const purchase: Record<string, unknown> = {
    AccountRef: { value: paymentAccountId },
    PaymentType: "Cash",
    Line: [
      {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: round2(e.amount ?? 0),
        Description: e.description ?? undefined,
        AccountBasedExpenseLineDetail: { AccountRef: { value: accountId } },
      },
    ],
  };
  if (e.qbo_vendor_id) {
    purchase.EntityRef = { value: e.qbo_vendor_id, type: "Vendor" };
  }
  purchase.PrivateNote = `CHS-EXP:${e.id}`;
  return purchase;
}

// ─── Push (idempotent dirty-flag sweep) ─────────────────────────────────────

export interface SweepResult {
  ran: boolean;
  reason?: string;
  invoices: { pushed: number; skipped: number; failed: number };
  payments: { pushed: number; skipped: number; failed: number };
  expenses: { pushed: number; skipped: number; failed: number };
  needs_mapping: string[];
  duration_ms: number;
}

export async function runQboSweep(env: Env): Promise<SweepResult> {
  const t0 = Date.now();
  const result: SweepResult = {
    ran: false,
    invoices: { pushed: 0, skipped: 0, failed: 0 },
    payments: { pushed: 0, skipped: 0, failed: 0 },
    expenses: { pushed: 0, skipped: 0, failed: 0 },
    needs_mapping: [],
    duration_ms: 0,
  };

  const conn = await loadConnection(env);
  // Allow status=error through — getValidAccessToken self-heals via refresh.
  // Only disconnected / missing connections are hard no-ops.
  if (!conn || conn.status === "disconnected" || !conn.refresh_token) {
    result.reason = conn ? `connection status=${conn.status}` : "not_connected";
    result.duration_ms = Date.now() - t0;
    return result;
  }
  result.ran = true;

  // One settings read per sweep — not per invoice/payment.
  const { qbo_customer_id: defaultCustomerId } = await getQboDefaultCustomer(env);

  try {
    await sweepInvoices(env, conn, result, defaultCustomerId);
    await sweepPayments(env, conn, result, defaultCustomerId);
    await sweepExpenses(env, conn, result);
    await markSynced(env);
  } catch (err) {
    if (err instanceof QboReconnectError || err instanceof QboNotConnectedError) {
      result.reason = err.message;
    } else {
      throw err;
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

function qboEscapeLiteral(value: string): string {
  return value.replace(/'/g, "\\'");
}

async function findExistingQboInvoice(
  env: Env,
  conn: QboConnection,
  invoiceId: string,
): Promise<string | null> {
  const note = `CHS-INV:${invoiceId}`;
  const rows = await qboQuery<{ Id: string }>(
    env,
    conn,
    `SELECT Id FROM Invoice WHERE PrivateNote = '${qboEscapeLiteral(note)}' MAXRESULTS 1`,
  );
  return rows[0]?.Id ?? null;
}

/**
 * Push a single payment to QBO (exactly-once via qbo_payment_id). Used by the
 * nightly sweep and by DLQ replay — same code path so replay surfaces the real
 * QBO error instead of a stub "not yet implemented" message.
 *
 * Note: Payment.PrivateNote is NOT queryable in QBO (unlike Invoice), so we
 * cannot look up prior creates by note. Idempotency relies on the local
 * qbo_payment_id stamp (partial UNIQUE index).
 */
export async function pushPaymentById(
  env: Env,
  paymentId: string,
): Promise<{ qboId: string; alreadySynced: boolean }> {
  if (!(await isQboPaymentSyncEnabled(env))) {
    console.log("[qbo] QBO payment sync disabled — pending go-live; skip pushPaymentById");
    throw new Error("QBO payment sync disabled — pending go-live");
  }

  const conn = await loadConnection(env);
  if (!conn || (conn.status !== "connected" && conn.status !== "error")) {
    throw new QboNotConnectedError();
  }
  // status=error is allowed through — getValidAccessToken self-heals via refresh.

  const { qbo_customer_id: defaultCustomerId } = await getQboDefaultCustomer(env);
  const p = await env.DB.prepare(
    `SELECT p.id, p.amount, p.invoice_id, p.qbo_payment_id, p.received_date, p.collected_at,
            c.qbo_customer_id, i.qbo_invoice_id, j.data_source AS job_data_source
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN jobs j ON j.id = COALESCE(p.job_id, i.job_id)
       LEFT JOIN clients c ON c.id = COALESCE(p.client_id, j.client_id)
      WHERE p.id = ?`,
  )
    .bind(paymentId)
    .first<PaymentRow & { job_data_source?: string | null }>();

  if (!p) throw new Error(`payment not found: ${paymentId}`);
  if (
    isJobberExcludedPayment({
      paymentId: p.id,
      jobDataSource: p.job_data_source,
    })
  ) {
    console.log(
      `[qbo] permanently excluding Jobber-imported payment ${paymentId} from QBO push`,
    );
    throw new Error("QBO payment push permanently excluded: Jobber-imported record");
  }
  if (p.qbo_payment_id) {
    return { qboId: p.qbo_payment_id, alreadySynced: true };
  }
  // QBO rejects TotalAmt=0 ("Enter a transaction amount to continue").
  // Treat as nothing-to-push so DLQ replay can clear these without looping.
  if ((p.amount ?? 0) <= 0) {
    return { qboId: "", alreadySynced: true };
  }

  const customerRef = resolveQboCustomerId(p.qbo_customer_id, defaultCustomerId);
  if (!customerRef) {
    throw new Error(
      `payment ${paymentId}: client not mapped to a QBO Customer (and no default customer set)`,
    );
  }

  const depositAccountId = ((conn.configuration.payment_account_ref as string) ?? "").trim() || null;
  const body = buildQboPayment(
    { ...p, qbo_customer_id: customerRef },
    { depositAccountId },
  );
  const created = (await qboFetch(env, conn, `/payment?minorversion=70`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as { Payment?: { Id?: string } };
  const qboId = created.Payment?.Id;
  if (!qboId) throw new Error("QBO returned no Payment.Id");
  try {
    await env.DB.prepare(
      `UPDATE payments SET qbo_payment_id = ?, qbo_synced_at = ? WHERE id = ? AND qbo_payment_id IS NULL`,
    )
      .bind(qboId, new Date().toISOString(), paymentId)
      .run();
  } catch (err) {
    // Race / retry: another write stamped this (or the same) QBO id. If OUR row
    // now has a qbo_payment_id, treat as success; otherwise surface the error.
    const again = await env.DB.prepare(`SELECT qbo_payment_id FROM payments WHERE id = ?`)
      .bind(paymentId)
      .first<{ qbo_payment_id: string | null }>();
    if (again?.qbo_payment_id) {
      return { qboId: again.qbo_payment_id, alreadySynced: true };
    }
    throw err;
  }
  return { qboId, alreadySynced: false };
}

async function findExistingQboPurchase(
  env: Env,
  conn: QboConnection,
  expenseId: string,
): Promise<string | null> {
  const note = `CHS-EXP:${expenseId}`;
  const rows = await qboQuery<{ Id: string }>(
    env,
    conn,
    `SELECT Id FROM Purchase WHERE PrivateNote = '${qboEscapeLiteral(note)}' MAXRESULTS 1`,
  );
  return rows[0]?.Id ?? null;
}

async function sweepInvoices(
  env: Env,
  conn: QboConnection,
  result: SweepResult,
  defaultCustomerId: string | null,
): Promise<void> {
  if (!(await isQboInvoiceSyncEnabled(env))) {
    console.log("[qbo] QBO invoice sync disabled — pending go-live; skip invoice sweep");
    return;
  }

  // Invoices link to a client through their job (jobs.client_id); the direct
  // invoices.client_id column is only sparsely populated, so resolve via the job
  // and fall back to a direct client_id when one is present.
  // Permanent Jobber exclusion is structural (not the go-live gate): never pick
  // jobs.data_source='jobber_import' or Jobber GraphQL invoice ids (orphans).
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.job_id, i.invoice_number, i.total, c.qbo_customer_id,
            j.data_source AS job_data_source
       FROM invoices i
       LEFT JOIN jobs j ON j.id = i.job_id
       LEFT JOIN clients c ON c.id = COALESCE(i.client_id, j.client_id)
      WHERE i.qbo_invoice_id IS NULL
        AND COALESCE(j.data_source, '') != 'jobber_import'
        AND i.id NOT LIKE 'Z2lkOi8vSm9iYmVy%'
      LIMIT 200`,
  ).all<InvoiceRow & { job_data_source?: string | null }>();

  for (const inv of results ?? []) {
    if (
      isJobberExcludedInvoice({
        invoiceId: inv.id,
        jobDataSource: inv.job_data_source,
      })
    ) {
      result.invoices.skipped++;
      continue;
    }
    const customerRef = resolveQboCustomerId(inv.qbo_customer_id, defaultCustomerId);
    if (!customerRef) {
      result.invoices.skipped++;
      result.needs_mapping.push(
        `invoice ${inv.id}: client not mapped to a QBO Customer (and no default customer set)`,
      );
      continue;
    }
    try {
      const existingId = await findExistingQboInvoice(env, conn, inv.id);
      if (existingId) {
        await env.DB.prepare(
          `UPDATE invoices SET qbo_invoice_id = ?, qbo_synced_at = ? WHERE id = ? AND qbo_invoice_id IS NULL`,
        )
          .bind(existingId, new Date().toISOString(), inv.id)
          .run();
        result.invoices.pushed++;
        continue;
      }
      const body = await buildQboInvoice(env, { ...inv, qbo_customer_id: customerRef });
      const created = (await qboFetch(env, conn, `/invoice?minorversion=70`, {
        method: "POST",
        body: JSON.stringify(body),
      })) as { Invoice?: { Id?: string } };
      const qboId = created.Invoice?.Id;
      if (!qboId) throw new Error("QBO returned no Invoice.Id");
      await env.DB.prepare(
        `UPDATE invoices SET qbo_invoice_id = ?, qbo_synced_at = ? WHERE id = ? AND qbo_invoice_id IS NULL`,
      )
        .bind(qboId, new Date().toISOString(), inv.id)
        .run();
      result.invoices.pushed++;
    } catch (err) {
      result.invoices.failed++;
      await recordDeadLetter(env, {
        jobName: QBO_DLQ_JOB,
        entityType: "invoice",
        entityId: inv.id,
        payload: { kind: "invoice", id: inv.id },
        errorMessage: (err as Error).message,
      });
    }
  }
}

async function sweepPayments(
  env: Env,
  _conn: QboConnection,
  result: SweepResult,
  defaultCustomerId: string | null,
): Promise<void> {
  if (!(await isQboPaymentSyncEnabled(env))) {
    console.log("[qbo] QBO payment sync disabled — pending go-live; skip payment sweep");
    return;
  }

  // Permanent Jobber exclusion is structural (not the go-live gate): never pick
  // jobs.data_source='jobber_import' or Jobber GraphQL payment ids.
  // Job join prefers payments.job_id, falls back to the invoice's job.
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.amount, p.invoice_id, p.received_date, p.collected_at,
            c.qbo_customer_id, i.qbo_invoice_id
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN jobs j ON j.id = COALESCE(p.job_id, i.job_id)
       LEFT JOIN clients c ON c.id = COALESCE(p.client_id, j.client_id)
      WHERE p.qbo_payment_id IS NULL
        AND COALESCE(j.data_source, '') != 'jobber_import'
        AND p.id NOT LIKE 'Z2lkOi8vSm9iYmVy%'
      LIMIT 200`,
  ).all<PaymentRow>();

  for (const p of results ?? []) {
    if ((p.amount ?? 0) <= 0) {
      result.payments.skipped++;
      continue;
    }
    const customerRef = resolveQboCustomerId(p.qbo_customer_id, defaultCustomerId);
    if (!customerRef) {
      result.payments.skipped++;
      result.needs_mapping.push(
        `payment ${p.id}: client not mapped to a QBO Customer (and no default customer set)`,
      );
      continue;
    }
    try {
      const r = await pushPaymentById(env, p.id);
      if (r.qboId) result.payments.pushed++;
      else result.payments.skipped++;
    } catch (err) {
      result.payments.failed++;
      await recordDeadLetter(env, {
        jobName: QBO_DLQ_JOB,
        entityType: "payment",
        entityId: p.id,
        payload: { kind: "payment", id: p.id },
        errorMessage: (err as Error).message,
      });
    }
  }
}

async function sweepExpenses(env: Env, conn: QboConnection, result: SweepResult): Promise<void> {
  const accountMap = conn.configuration.account_map ?? {};
  const paymentAccountRef = (conn.configuration.payment_account_ref as string) ?? "";
  const subPaymentAccountRef =
    (conn.configuration.subcontractor_payment_account_ref as string | undefined) ?? "";
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.amount, e.description, e.expense_type, e.sub_id, s.qbo_vendor_id
       FROM expenses e
       LEFT JOIN subcontractors s ON s.id = e.sub_id
      WHERE e.pushed_to_qbo IS NOT 1 AND e.qbo_transaction_id IS NULL
      LIMIT 200`,
  ).all<ExpenseRow>();

  for (const e of results ?? []) {
    const accountId = e.expense_type ? accountMap[e.expense_type] : undefined;
    if (e.sub_id && !e.qbo_vendor_id) {
      result.expenses.skipped++;
      result.needs_mapping.push(`expense ${e.id}: subcontractor not mapped to a QBO Vendor`);
      continue;
    }
    const paymentAccountId = resolvePaymentAccountId(e, paymentAccountRef, subPaymentAccountRef);
    if (!accountId || !paymentAccountId) {
      result.expenses.skipped++;
      result.needs_mapping.push(
        `expense ${e.id}: ${!accountId ? `expense_type '${e.expense_type}' not mapped to a QBO Account` : "no payment_account_ref configured"}`,
      );
      continue;
    }
    try {
      const existingId = await findExistingQboPurchase(env, conn, e.id);
      if (existingId) {
        await env.DB.prepare(
          `UPDATE expenses SET pushed_to_qbo = 1, qbo_transaction_id = ? WHERE id = ? AND qbo_transaction_id IS NULL`,
        )
          .bind(existingId, e.id)
          .run();
        result.expenses.pushed++;
        continue;
      }
      const body = buildQboPurchase(e, accountId, paymentAccountId);
      const created = (await qboFetch(env, conn, `/purchase?minorversion=70`, {
        method: "POST",
        body: JSON.stringify(body),
      })) as { Purchase?: { Id?: string } };
      const qboId = created.Purchase?.Id;
      if (!qboId) throw new Error("QBO returned no Purchase.Id");
      await env.DB.prepare(
        `UPDATE expenses SET pushed_to_qbo = 1, qbo_transaction_id = ? WHERE id = ? AND qbo_transaction_id IS NULL`,
      )
        .bind(qboId, e.id)
        .run();
      result.expenses.pushed++;
    } catch (err) {
      result.expenses.failed++;
      await recordDeadLetter(env, {
        jobName: QBO_DLQ_JOB,
        entityType: "expense",
        entityId: e.id,
        payload: { kind: "expense", id: e.id },
        errorMessage: (err as Error).message,
      });
    }
  }
}

// ─── Erroneous payment void (Aug 6 2026 Jobber-history push cleanup) ─────────

export interface VoidErroneousPaymentResult {
  payment_id: string;
  qbo_payment_id: string;
  amount: number | null;
  ok: boolean;
  error?: string;
}

export interface VoidErroneousPaymentsBatchResult {
  scanned: number;
  voided: number;
  failed: number;
  results: VoidErroneousPaymentResult[];
  duration_ms: number;
}

/**
 * Void QBO Payment objects for D1 rows that carry a qbo_payment_id, then clear
 * the local sync stamp. Batched for visibility/resume. Voids only — never deletes.
 */
export async function voidErroneousQboPayments(
  env: Env,
  opts?: { limit?: number; offset?: number },
): Promise<VoidErroneousPaymentsBatchResult> {
  const t0 = Date.now();
  // Keep batches small — each void is read+void (+ optional fallback), and Workers
  // hit the subrequest cap around ~12 payments per invocation.
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 15);
  const offset = Math.max(opts?.offset ?? 0, 0);

  const conn = await loadConnection(env);
  if (!conn || (conn.status !== "connected" && conn.status !== "error")) {
    throw new QboNotConnectedError();
  }

  const { results: rows } = await env.DB.prepare(
    `SELECT id, amount, qbo_payment_id FROM payments
      WHERE qbo_payment_id IS NOT NULL
      ORDER BY qbo_synced_at ASC, id ASC
      LIMIT ? OFFSET ?`,
  )
    .bind(limit, offset)
    .all<{ id: string; amount: number | null; qbo_payment_id: string }>();

  const out: VoidErroneousPaymentsBatchResult = {
    scanned: rows?.length ?? 0,
    voided: 0,
    failed: 0,
    results: [],
    duration_ms: 0,
  };

  for (const row of rows ?? []) {
    const qboId = row.qbo_payment_id;
    try {
      // Read current SyncToken (required for void).
      const read = (await qboFetch(env, conn, `/payment/${qboId}?minorversion=70`)) as {
        Payment?: { Id?: string; SyncToken?: string };
      };
      const syncToken = read.Payment?.SyncToken;
      if (syncToken == null || syncToken === "") {
        throw new Error(`QBO Payment ${qboId}: missing SyncToken`);
      }

      // Prefer operation=void; fall back to sparse update+include=void.
      try {
        await qboFetch(env, conn, `/payment?operation=void&minorversion=70`, {
          method: "POST",
          body: JSON.stringify({ Id: qboId, SyncToken: syncToken }),
        });
      } catch {
        const again = (await qboFetch(env, conn, `/payment/${qboId}?minorversion=70`)) as {
          Payment?: { SyncToken?: string };
        };
        const token2 = again.Payment?.SyncToken ?? syncToken;
        await qboFetch(env, conn, `/payment?operation=update&include=void&minorversion=70`, {
          method: "POST",
          body: JSON.stringify({ Id: qboId, SyncToken: token2, sparse: true }),
        });
      }

      await env.DB.prepare(
        `UPDATE payments SET qbo_payment_id = NULL, qbo_synced_at = NULL WHERE id = ?`,
      )
        .bind(row.id)
        .run();

      // One-line audit trail per voided row.
      await env.DB.prepare(
        `INSERT INTO sync_log (job_name, started_at, finished_at, status, rows_affected, error_message, duration_ms, details)
         VALUES (?, datetime('now'), datetime('now'), 'success', 1, NULL, NULL, ?)`,
      )
        .bind(
          "qbo_payment_void_aug6",
          JSON.stringify({
            note: "Automated reversal of Aug 6 erroneous QBO payment push",
            payment_id: row.id,
            qbo_payment_id: qboId,
            amount: row.amount,
          }),
        )
        .run();

      console.log(`[qbo-void] ok payment=${row.id} qbo=${qboId} amount=${row.amount}`);
      out.voided++;
      out.results.push({
        payment_id: row.id,
        qbo_payment_id: qboId,
        amount: row.amount,
        ok: true,
      });
    } catch (err) {
      const error = (err as Error).message;
      console.error(`[qbo-void] FAIL payment=${row.id} qbo=${qboId}: ${error}`);
      out.failed++;
      out.results.push({
        payment_id: row.id,
        qbo_payment_id: qboId,
        amount: row.amount,
        ok: false,
        error,
      });
      await env.DB.prepare(
        `INSERT INTO sync_log (job_name, started_at, finished_at, status, rows_affected, error_message, duration_ms, details)
         VALUES (?, datetime('now'), datetime('now'), 'error', 0, ?, NULL, ?)`,
      )
        .bind(
          "qbo_payment_void_aug6",
          error.slice(0, 500),
          JSON.stringify({
            note: "Automated reversal of Aug 6 erroneous QBO payment push — FAILED",
            payment_id: row.id,
            qbo_payment_id: qboId,
            amount: row.amount,
          }),
        )
        .run();
    }

    // Gentle pacing to avoid QBO 429s across ~156 voids.
    await sleep(200);
  }

  out.duration_ms = Date.now() - t0;
  return out;
}

// ─── Status ─────────────────────────────────────────────────────────────────

export interface QboStatus {
  connected: boolean;
  status: string;
  environment: string | null;
  realm_id: string | null;
  company_name: string | null;
  last_sync: string | null;
  last_error: string | null;
  counts: {
    invoices: { synced: number; pending: number };
    payments: { synced: number; pending: number };
    expenses: { synced: number; pending: number };
    dlq_open: number;
  };
}

export async function getQboStatus(env: Env): Promise<QboStatus> {
  const conn = await loadConnection(env);
  const counts = {
    invoices: await pendSynced(env, "invoices", "qbo_invoice_id"),
    payments: await pendSynced(env, "payments", "qbo_payment_id"),
    expenses: await pendSynced(env, "expenses", "qbo_transaction_id"),
    dlq_open: await dlqOpen(env),
  };
  return {
    connected: conn?.status === "connected",
    status: conn?.status ?? "not_connected",
    environment: conn?.configuration.environment ?? null,
    realm_id: conn?.account_id ?? null,
    company_name: (conn?.configuration.company_name as string) ?? null,
    last_sync: conn?.last_sync ?? null,
    last_error: conn?.last_error ?? null,
    counts,
  };
}

async function pendSynced(env: Env, table: string, idCol: string): Promise<{ synced: number; pending: number }> {
  const row = await env.DB.prepare(
    `SELECT SUM(CASE WHEN ${idCol} IS NOT NULL THEN 1 ELSE 0 END) AS synced,
            SUM(CASE WHEN ${idCol} IS NULL THEN 1 ELSE 0 END) AS pending
       FROM ${table}`,
  ).first<{ synced: number | null; pending: number | null }>();
  return { synced: row?.synced ?? 0, pending: row?.pending ?? 0 };
}

async function dlqOpen(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sync_dead_letters WHERE job_name = ? AND resolved_at IS NULL`,
  )
    .bind(QBO_DLQ_JOB)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
