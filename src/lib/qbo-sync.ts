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
  qboApiBase,
  saveConfiguration,
  QboNotConnectedError,
  QboReconnectError,
  type QboConfiguration,
  type QboConnection,
} from "./qbo-auth.js";

const QBO_DLQ_JOB = "qbo_sync";
const MAX_429_RETRIES = 3;

// ─── QBO API request (auth + 429 backoff + Retry-After) ────────────────────

async function qboFetch(
  env: Env,
  conn: QboConnection,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  if (!conn.account_id) throw new QboNotConnectedError("No QBO realmId on the connection");
  const base = qboApiBase(conn.configuration.environment, conn.account_id);
  const url = path.startsWith("http") ? path : `${base}${path}`;

  let attempt = 0;
  for (;;) {
    const token = await getValidAccessToken(env);
    const resp = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (resp.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await sleep(waitMs);
      attempt++;
      continue;
    }

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`QBO ${init.method ?? "GET"} ${path} failed (${resp.status}): ${text.slice(0, 400)}`);
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
}

export function buildQboPayment(p: PaymentRow): Record<string, unknown> {
  // TotalAmt is the gross collected amount, which INCLUDES the convenience fee
  // (income). The Stripe processing fee is a cost and is represented on the
  // expense/Purchase side, not netted out of the payment here.
  const payment: Record<string, unknown> = {
    CustomerRef: { value: p.qbo_customer_id },
    TotalAmt: round2(p.amount ?? 0),
  };
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
  if (!conn || conn.status !== "connected") {
    result.reason = conn ? `connection status=${conn.status}` : "not_connected";
    result.duration_ms = Date.now() - t0;
    return result;
  }
  result.ran = true;

  try {
    await sweepInvoices(env, conn, result);
    await sweepPayments(env, conn, result);
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

async function sweepInvoices(env: Env, conn: QboConnection, result: SweepResult): Promise<void> {
  // Invoices link to a client through their job (jobs.client_id); the direct
  // invoices.client_id column is only sparsely populated, so resolve via the job
  // and fall back to a direct client_id when one is present.
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.job_id, i.invoice_number, i.total, c.qbo_customer_id
       FROM invoices i
       LEFT JOIN jobs j ON j.id = i.job_id
       LEFT JOIN clients c ON c.id = COALESCE(i.client_id, j.client_id)
      WHERE i.qbo_invoice_id IS NULL
      LIMIT 200`,
  ).all<InvoiceRow>();

  for (const inv of results ?? []) {
    if (!inv.qbo_customer_id) {
      result.invoices.skipped++;
      result.needs_mapping.push(`invoice ${inv.id}: client not mapped to a QBO Customer`);
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
      const body = await buildQboInvoice(env, inv);
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

async function sweepPayments(env: Env, conn: QboConnection, result: SweepResult): Promise<void> {
  // Same as invoices: resolve the client through the linked invoice's job,
  // preferring a direct payments.client_id when present.
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.amount, p.invoice_id, c.qbo_customer_id, i.qbo_invoice_id
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN jobs j ON j.id = i.job_id
       LEFT JOIN clients c ON c.id = COALESCE(p.client_id, j.client_id)
      WHERE p.qbo_payment_id IS NULL
      LIMIT 200`,
  ).all<PaymentRow>();

  for (const p of results ?? []) {
    if (!p.qbo_customer_id) {
      result.payments.skipped++;
      result.needs_mapping.push(`payment ${p.id}: client not mapped to a QBO Customer`);
      continue;
    }
    try {
      const body = buildQboPayment(p);
      const created = (await qboFetch(env, conn, `/payment?minorversion=70`, {
        method: "POST",
        body: JSON.stringify(body),
      })) as { Payment?: { Id?: string } };
      const qboId = created.Payment?.Id;
      if (!qboId) throw new Error("QBO returned no Payment.Id");
      await env.DB.prepare(
        `UPDATE payments SET qbo_payment_id = ?, qbo_synced_at = ? WHERE id = ? AND qbo_payment_id IS NULL`,
      )
        .bind(qboId, new Date().toISOString(), p.id)
        .run();
      result.payments.pushed++;
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
  const paymentAccountId = (conn.configuration.payment_account_ref as string) ?? "";
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.amount, e.description, e.expense_type, e.sub_id, s.qbo_vendor_id
       FROM expenses e
       LEFT JOIN subcontractors s ON s.id = e.sub_id
      WHERE e.pushed_to_qbo IS NOT 1 AND e.qbo_transaction_id IS NULL
      LIMIT 200`,
  ).all<ExpenseRow>();

  for (const e of results ?? []) {
    const accountId = e.expense_type ? accountMap[e.expense_type] : undefined;
    if (!accountId || !paymentAccountId) {
      result.expenses.skipped++;
      result.needs_mapping.push(
        `expense ${e.id}: ${!accountId ? `expense_type '${e.expense_type}' not mapped to a QBO Account` : "no payment_account_ref configured"}`,
      );
      continue;
    }
    if (e.sub_id && !e.qbo_vendor_id) {
      result.expenses.skipped++;
      result.needs_mapping.push(`expense ${e.id}: subcontractor not mapped to a QBO Vendor`);
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
