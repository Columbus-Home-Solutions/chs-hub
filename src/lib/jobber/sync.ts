/**
 * Jobber → D1 sync orchestrator.
 *
 * Pulls jobs (with nested client, quote, line_items, invoice, payment data)
 * in pages of 25 and upserts each into the appropriate D1 tables atomically.
 *
 * v1 does a full sync on every run. Delta sync (where `updatedAt > cursor`)
 * will come in a later pass once we've validated the upsert logic against
 * real data. At ~500 jobs and 25/page that's ~20 paginated requests — well
 * within Jobber's rate limit headroom and the Worker's subrequest cap.
 */

import type { Env } from "../../env.js";
import { getAccessToken } from "./auth.js";
import { jobberQuery } from "./client.js";
import {
  EXPENSES_PAGE_QUERY,
  INVOICES_PAGE_QUERY,
  JOBS_PAGE_QUERY,
  QUOTES_PAGE_QUERY,
} from "./queries.js";

const JOBS_PAGE_SIZE = 25;
const INVOICES_PAGE_SIZE = 50;
const QUOTES_PAGE_SIZE = 50;
const EXPENSES_PAGE_SIZE = 50;
const MAX_PAGES = 200; // 200 × 25 = 5000 jobs ceiling; safety stop for runaway loops

// ─── GraphQL response shapes ────────────────────────────────────────

interface JobsPageResult {
  jobs: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    totalCount: number;
    nodes: JobberJob[];
  };
}

interface JobberJob {
  id: string;
  jobNumber?: number | null;
  title?: string | null;
  jobStatus?: string | null;
  source?: string | null;
  total?: number | null;
  createdAt?: string | null;
  startAt?: string | null;
  completedAt?: string | null;
  client?: JobberClient | null;
  property?: { address?: JobberAddress | null } | null;
  quote?: JobberQuote | null;
  lineItems?: { nodes: JobberLineItem[] } | null;
  paymentRecords?: { nodes: JobberPayment[] } | null;
  invoices?: { nodes: JobberInvoice[] } | null;
}

interface JobberClient {
  id: string;
  name?: string | null;
  phones?: Array<{ number?: string | null }> | null;
  emails?: Array<{ address?: string | null }> | null;
  customFields?: Array<{
    label?: string | null;
    valueText?: string | null;
    valueDropdown?: string | null;
  }> | null;
}

interface JobberAddress {
  street?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
}

interface JobberQuote {
  id: string;
  quoteNumber?: number | null;
  quoteStatus?: string | null;
  createdAt?: string | null;
  transitionedAt?: string | null;
  amounts?: { subtotal?: number | null } | null;
}

interface JobberLineItem {
  id: string;
  name?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  unitCost?: number | null;
}

interface JobberPayment {
  id: string;
  amount?: number | null;
}

interface JobberInvoice {
  id: string;
  invoiceStatus?: string | null;
  total?: number | null;
  paymentsTotal?: number | null;
  issuedDate?: string | null;
  dueDate?: string | null;
  amounts?: { depositAmount?: number | null } | null;
}

// ─── Standalone expenses pass ──────────────────────────────────────

interface ExpensesPageResult {
  expenses: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: StandaloneExpense[];
  };
}

interface StandaloneExpense {
  id: string;
  title?: string | null;
  description?: string | null;
  total?: number | null;
  date?: string | null;
  linkedJob?: { id: string } | null;
}

// ─── Standalone invoices pass ──────────────────────────────────────

interface InvoicesPageResult {
  invoices: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: StandaloneInvoice[];
  };
}

interface StandaloneInvoice {
  id: string;
  invoiceStatus?: string | null;
  total?: number | null;
  paymentsTotal?: number | null;
  issuedDate?: string | null;
  dueDate?: string | null;
  amounts?: { depositAmount?: number | null } | null;
  jobs?: { nodes: Array<{ id: string }> } | null;
  paymentRecords?: { nodes: JobberPayment[] } | null;
}

// ─── Sync result type ──────────────────────────────────────────────

export interface SyncStats {
  pages: number;
  jobs_seen: number;
  jobs_written: number;
  clients_written: number;
  quotes_written: number;
  quote_pages: number;
  quotes_seen: number;
  line_items_written: number;
  invoices_written: number;
  invoice_pages: number;
  invoices_seen: number;
  payments_written: number;
  expenses_written: number;
  expense_pages: number;
  expenses_seen: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  errors: string[];
}

// ─── Main sync entry point ─────────────────────────────────────────

export async function syncJobberToD1(env: Env): Promise<SyncStats> {
  const startedAt = new Date();
  const stats: SyncStats = {
    pages: 0,
    jobs_seen: 0,
    jobs_written: 0,
    clients_written: 0,
    quotes_written: 0,
    quote_pages: 0,
    quotes_seen: 0,
    line_items_written: 0,
    invoices_written: 0,
    invoice_pages: 0,
    invoices_seen: 0,
    payments_written: 0,
    expenses_written: 0,
    expense_pages: 0,
    expenses_seen: 0,
    started_at: startedAt.toISOString(),
    finished_at: "",
    duration_ms: 0,
    errors: [],
  };

  await logSyncStart(env, "jobber_full", startedAt);

  try {
    const accessToken = await getAccessToken(env);
    let cursor: string | null = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const result: JobsPageResult = await jobberQuery<JobsPageResult>(
        accessToken,
        JOBS_PAGE_QUERY,
        { variables: { first: JOBS_PAGE_SIZE, after: cursor } },
      );

      const nodes: JobberJob[] = result.jobs?.nodes ?? [];
      stats.pages = page;
      stats.jobs_seen += nodes.length;

      for (const job of nodes) {
        try {
          await upsertJob(env, job, stats);
        } catch (err) {
          const msg = (err as Error).message;
          stats.errors.push(`Job ${job.id}: ${msg}`);
        }
      }

      const pageInfo: JobsPageResult["jobs"]["pageInfo"] | undefined = result.jobs?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }

    // Standalone quotes pass — captures pipeline quotes (awaiting_response,
    // changes_requested, approved-not-yet-job) that the per-job pass never
    // sees because they haven't converted to jobs.
    await syncAllQuotes(env, accessToken, stats);

    // Standalone invoices pass — captures invoices the per-job loop missed
    // (change orders, re-issues, invoices whose parent job ordering buried
    // them behind the `first: 1` limit on jobs.invoices).
    await syncAllInvoices(env, accessToken, stats);

    // Standalone expenses pass — captures ALL expenses (not just those linked
    // to jobs), including Overhead / Vehicle / Office / Apparel / Tools
    // categories which are typically entered without a job link.
    await syncAllExpenses(env, accessToken, stats);

    const finishedAt = new Date();
    stats.finished_at = finishedAt.toISOString();
    stats.duration_ms = finishedAt.getTime() - startedAt.getTime();

    await logSyncFinish(env, "jobber_full", startedAt, finishedAt, stats, null);
    return stats;
  } catch (err) {
    const finishedAt = new Date();
    stats.finished_at = finishedAt.toISOString();
    stats.duration_ms = finishedAt.getTime() - startedAt.getTime();
    const msg = (err as Error).message;
    stats.errors.push(msg);
    await logSyncFinish(env, "jobber_full", startedAt, finishedAt, stats, msg);
    throw err;
  }
}

// ─── Per-job upsert ────────────────────────────────────────────────

async function upsertJob(env: Env, job: JobberJob, stats: SyncStats): Promise<void> {
  const syncedAt = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];

  // Client
  const clientId = job.client?.id ?? null;
  if (job.client) {
    const c = job.client;
    const phone = c.phones?.[0]?.number ?? null;
    const email = c.emails?.[0]?.address ?? null;
    const customFieldsJson = c.customFields ? JSON.stringify(c.customFields) : null;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO clients (id, name, phone, email, address_street, address_city, address_state, address_postal, custom_fields, synced_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           phone = excluded.phone,
           email = excluded.email,
           custom_fields = excluded.custom_fields,
           synced_at = excluded.synced_at`,
      ).bind(c.id, c.name ?? null, phone, email, customFieldsJson, syncedAt),
    );
    stats.clients_written++;
  }

  // Update address fields on client if property.address was returned (some jobs
  // have property-level address which is the closest we get to a client
  // address; overwrite with whatever the latest job tells us)
  const addr = job.property?.address;
  if (clientId && addr) {
    stmts.push(
      env.DB.prepare(
        `UPDATE clients SET address_street = ?, address_city = ?, address_state = ?, address_postal = ?, synced_at = ?
         WHERE id = ?`,
      ).bind(
        addr.street ?? null,
        addr.city ?? null,
        addr.province ?? null,
        addr.postalCode ?? null,
        syncedAt,
        clientId,
      ),
    );
  }

  // Job
  stmts.push(
    env.DB.prepare(
      `INSERT INTO jobs (id, job_number, title, status, client_id, source, total, created_at, start_at, completed_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         job_number = excluded.job_number,
         title = excluded.title,
         status = excluded.status,
         client_id = excluded.client_id,
         source = excluded.source,
         total = excluded.total,
         created_at = excluded.created_at,
         start_at = excluded.start_at,
         completed_at = excluded.completed_at,
         synced_at = excluded.synced_at`,
    ).bind(
      job.id,
      job.jobNumber ?? null,
      job.title ?? null,
      job.jobStatus ?? null,
      clientId,
      job.source ?? null,
      job.total ?? null,
      job.createdAt ?? null,
      job.startAt ?? null,
      job.completedAt ?? null,
      syncedAt,
    ),
  );
  stats.jobs_written++;

  // Quote
  if (job.quote) {
    const q = job.quote;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO quotes (id, job_id, quote_number, status, subtotal, created_at, transitioned_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           job_id = excluded.job_id,
           quote_number = excluded.quote_number,
           status = excluded.status,
           subtotal = excluded.subtotal,
           created_at = excluded.created_at,
           transitioned_at = excluded.transitioned_at,
           synced_at = excluded.synced_at`,
      ).bind(
        q.id,
        job.id,
        q.quoteNumber ?? null,
        q.quoteStatus ?? null,
        q.amounts?.subtotal ?? null,
        q.createdAt ?? null,
        q.transitionedAt ?? null,
        syncedAt,
      ),
    );
    stats.quotes_written++;
  }

  // Line items — wipe + re-insert is simpler than per-item upsert
  // when Jobber is authoritative
  stmts.push(env.DB.prepare("DELETE FROM line_items WHERE job_id = ?").bind(job.id));
  const lineItems = job.lineItems?.nodes ?? [];
  for (const li of lineItems) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO line_items (id, job_id, name, quantity, unit_price, unit_cost, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        li.id,
        job.id,
        li.name ?? null,
        li.quantity ?? null,
        li.unitPrice ?? null,
        li.unitCost ?? null,
        syncedAt,
      ),
    );
    stats.line_items_written++;
  }

  // Invoice (we only fetch first: 1 per job in the list query; that's
  // the primary invoice. More-complete invoice sync will come later.)
  const invoice = job.invoices?.nodes?.[0];
  let invoiceId: string | null = null;
  if (invoice) {
    invoiceId = invoice.id;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO invoices (id, job_id, status, total, payments_total, issued_date, due_date, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           job_id = excluded.job_id,
           status = excluded.status,
           total = excluded.total,
           payments_total = excluded.payments_total,
           issued_date = excluded.issued_date,
           due_date = excluded.due_date,
           synced_at = excluded.synced_at`,
      ).bind(
        invoice.id,
        job.id,
        invoice.invoiceStatus ?? null,
        invoice.total ?? null,
        invoice.paymentsTotal ?? null,
        invoice.issuedDate ?? null,
        invoice.dueDate ?? null,
        syncedAt,
      ),
    );
    stats.invoices_written++;
  }

  // Payments — Jobber's paymentRecord has no date field, so we use the
  // invoice's issuedDate as the collected_at proxy (matching Python behavior)
  stmts.push(env.DB.prepare("DELETE FROM payments WHERE job_id = ?").bind(job.id));
  const payments = job.paymentRecords?.nodes ?? [];
  const collectedAt = invoice?.issuedDate ?? null;
  for (const p of payments) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO payments (id, job_id, invoice_id, amount, collected_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(p.id, job.id, invoiceId, p.amount ?? null, collectedAt, syncedAt),
    );
    stats.payments_written++;
  }

  await env.DB.batch(stmts);
}

// ─── Standalone quotes sync ────────────────────────────────────────

interface QuotesPageResult {
  quotes: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: StandaloneQuote[];
  };
}

interface StandaloneQuote {
  id: string;
  quoteNumber?: number | null;
  quoteStatus?: string | null;
  amounts?: { subtotal?: number | null } | null;
  createdAt?: string | null;
  transitionedAt?: string | null;
  jobs?: { nodes: Array<{ id: string }> } | null;
  client?: {
    id: string;
    name?: string | null;
    phones?: Array<{ number?: string | null }> | null;
    emails?: Array<{ address?: string | null }> | null;
  } | null;
}

async function syncAllQuotes(
  env: Env,
  accessToken: string,
  stats: SyncStats,
): Promise<void> {
  let cursor: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result: QuotesPageResult = await jobberQuery<QuotesPageResult>(
      accessToken,
      QUOTES_PAGE_QUERY,
      { variables: { first: QUOTES_PAGE_SIZE, after: cursor } },
    );

    const nodes: StandaloneQuote[] = result.quotes?.nodes ?? [];
    stats.quote_pages = page;
    stats.quotes_seen += nodes.length;

    const syncedAt = new Date().toISOString();

    for (const q of nodes) {
      const linkedJobId = q.jobs?.nodes?.[0]?.id ?? null;
      const clientId = q.client?.id ?? null;

      // Upsert the client first so the FK is satisfied for the quote.
      // Open quotes (not yet jobs) are the only path that surfaces these
      // clients, so without this block the pipeline drill has no name to
      // show. Sparse fields — we only update name/phone/email if present.
      if (clientId) {
        const phone = q.client?.phones?.[0]?.number ?? null;
        const email = q.client?.emails?.[0]?.address ?? null;
        try {
          await env.DB.prepare(
            `INSERT INTO clients (id, name, phone, email, synced_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = COALESCE(excluded.name, clients.name),
               phone = COALESCE(excluded.phone, clients.phone),
               email = COALESCE(excluded.email, clients.email),
               synced_at = excluded.synced_at`,
          )
            .bind(clientId, q.client?.name ?? null, phone, email, syncedAt)
            .run();
        } catch (err) {
          stats.errors.push(
            `Client upsert (quote ${q.id}): ${(err as Error).message}`,
          );
        }
      }

      try {
        // Upsert: if the quote already exists (e.g. from the jobs pass),
        // keep its job_id unless we have a newer one from this standalone
        // query. Otherwise insert with whatever job + client links we have.
        await env.DB.prepare(
          `INSERT INTO quotes (id, job_id, client_id, quote_number, status, subtotal, created_at, transitioned_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             job_id = COALESCE(excluded.job_id, quotes.job_id),
             client_id = COALESCE(excluded.client_id, quotes.client_id),
             quote_number = excluded.quote_number,
             status = excluded.status,
             subtotal = excluded.subtotal,
             created_at = excluded.created_at,
             transitioned_at = excluded.transitioned_at,
             synced_at = excluded.synced_at`,
        )
          .bind(
            q.id,
            linkedJobId,
            clientId,
            q.quoteNumber ?? null,
            q.quoteStatus ?? null,
            q.amounts?.subtotal ?? null,
            q.createdAt ?? null,
            q.transitionedAt ?? null,
            syncedAt,
          )
          .run();
        stats.quotes_written++;
      } catch (err) {
        // FK failure if linkedJobId points to a job we don't have — retry
        // with NULL so the quote still lands in our pipeline count.
        try {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO quotes (id, job_id, client_id, quote_number, status, subtotal, created_at, transitioned_at, synced_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              q.id,
              clientId,
              q.quoteNumber ?? null,
              q.quoteStatus ?? null,
              q.amounts?.subtotal ?? null,
              q.createdAt ?? null,
              q.transitionedAt ?? null,
              syncedAt,
            )
            .run();
          stats.quotes_written++;
        } catch (err2) {
          stats.errors.push(`Quote ${q.id}: ${(err2 as Error).message}`);
        }
      }
    }

    const pageInfo = result.quotes?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
}

// ─── Standalone invoices sync ──────────────────────────────────────

async function syncAllInvoices(
  env: Env,
  accessToken: string,
  stats: SyncStats,
): Promise<void> {
  let cursor: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result: InvoicesPageResult = await jobberQuery<InvoicesPageResult>(
      accessToken,
      INVOICES_PAGE_QUERY,
      { variables: { first: INVOICES_PAGE_SIZE, after: cursor } },
    );

    const nodes: StandaloneInvoice[] = result.invoices?.nodes ?? [];
    stats.invoice_pages = page;
    stats.invoices_seen += nodes.length;

    for (const inv of nodes) {
      try {
        await upsertStandaloneInvoice(env, inv, stats);
      } catch (err) {
        stats.errors.push(`Invoice ${inv.id}: ${(err as Error).message}`);
      }
    }

    const pageInfo = result.invoices?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
}

async function upsertStandaloneInvoice(
  env: Env,
  invoice: StandaloneInvoice,
  stats: SyncStats,
): Promise<void> {
  const syncedAt = new Date().toISOString();
  const jobId = invoice.jobs?.nodes?.[0]?.id ?? null;
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    env.DB.prepare(
      `INSERT INTO invoices (id, job_id, status, total, payments_total, issued_date, due_date, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         job_id = excluded.job_id,
         status = excluded.status,
         total = excluded.total,
         payments_total = excluded.payments_total,
         issued_date = excluded.issued_date,
         due_date = excluded.due_date,
         synced_at = excluded.synced_at`,
    ).bind(
      invoice.id,
      jobId,
      invoice.invoiceStatus ?? null,
      invoice.total ?? null,
      invoice.paymentsTotal ?? null,
      invoice.issuedDate ?? null,
      invoice.dueDate ?? null,
      syncedAt,
    ),
  );
  stats.invoices_written++;

  // Re-sync payments for this invoice. We wipe by invoice_id (not job_id)
  // because the jobs-pass already handled job-bound payments; here we cover
  // payments whose invoice lives under a different job than what we keyed
  // off, or has no job at all.
  const payments = invoice.paymentRecords?.nodes ?? [];
  if (payments.length > 0) {
    stmts.push(
      env.DB.prepare("DELETE FROM payments WHERE invoice_id = ?").bind(invoice.id),
    );
    const collectedAt = invoice.issuedDate ?? null;
    for (const p of payments) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO payments (id, job_id, invoice_id, amount, collected_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             job_id = excluded.job_id,
             invoice_id = excluded.invoice_id,
             amount = excluded.amount,
             collected_at = excluded.collected_at,
             synced_at = excluded.synced_at`,
        ).bind(p.id, jobId, invoice.id, p.amount ?? null, collectedAt, syncedAt),
      );
      stats.payments_written++;
    }
  }

  await env.DB.batch(stmts);
}

// ─── Standalone expenses sync ──────────────────────────────────────

async function syncAllExpenses(
  env: Env,
  accessToken: string,
  stats: SyncStats,
): Promise<void> {
  // Full refresh: wipe expenses and re-insert from Jobber's top-level
  // expenses connection. This captures both job-linked and business-wide
  // expenses (Overhead, Vehicle, Office, Apparel, Tools). Expense count
  // is small (~100s), so full-refresh is cheap and handles deletions.
  await env.DB.prepare("DELETE FROM expenses").run();

  let cursor: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result: ExpensesPageResult = await jobberQuery<ExpensesPageResult>(
      accessToken,
      EXPENSES_PAGE_QUERY,
      { variables: { first: EXPENSES_PAGE_SIZE, after: cursor } },
    );

    const nodes: StandaloneExpense[] = result.expenses?.nodes ?? [];
    stats.expense_pages = page;
    stats.expenses_seen += nodes.length;

    const syncedAt = new Date().toISOString();
    const stmts: D1PreparedStatement[] = [];

    for (const exp of nodes) {
      const description =
        [exp.title, exp.description].filter(Boolean).join(" — ") || null;
      // linkedJob may point to a job we don't have in D1 (e.g. from a
      // previous year). Only set job_id if the job exists locally,
      // otherwise FK would fail. Cheapest check: bind NULL and let KPI
      // math reconcile — expense totals don't require the FK.
      stmts.push(
        env.DB.prepare(
          `INSERT INTO expenses (id, job_id, amount, description, incurred_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          exp.id,
          exp.linkedJob?.id ?? null,
          exp.total ?? null,
          description,
          exp.date ?? null,
          syncedAt,
        ),
      );
      stats.expenses_written++;
    }

    if (stmts.length > 0) {
      try {
        await env.DB.batch(stmts);
      } catch (err) {
        // If FK fails for a linked job not in D1, retry individually and
        // null the job_id on failure so we still capture the expense.
        stats.errors.push(
          `Expenses page ${page} batch failed, retrying individually: ${(err as Error).message}`,
        );
        for (const exp of nodes) {
          const description =
            [exp.title, exp.description].filter(Boolean).join(" — ") || null;
          try {
            await env.DB.prepare(
              `INSERT INTO expenses (id, job_id, amount, description, incurred_at, synced_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
              .bind(
                exp.id,
                exp.linkedJob?.id ?? null,
                exp.total ?? null,
                description,
                exp.date ?? null,
                syncedAt,
              )
              .run();
          } catch {
            // FK failure — retry with job_id = NULL
            await env.DB.prepare(
              `INSERT OR REPLACE INTO expenses (id, job_id, amount, description, incurred_at, synced_at)
               VALUES (?, NULL, ?, ?, ?, ?)`,
            )
              .bind(
                exp.id,
                exp.total ?? null,
                description,
                exp.date ?? null,
                syncedAt,
              )
              .run();
          }
        }
      }
    }

    const pageInfo = result.expenses?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
}

// ─── sync_log bookkeeping ──────────────────────────────────────────

async function logSyncStart(
  env: Env,
  jobName: string,
  startedAt: Date,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_log (job_name, started_at, status) VALUES (?, ?, 'running')`,
  )
    .bind(jobName, startedAt.toISOString())
    .run();
}

async function logSyncFinish(
  env: Env,
  jobName: string,
  startedAt: Date,
  finishedAt: Date,
  stats: SyncStats,
  errorMessage: string | null,
): Promise<void> {
  const rowsAffected =
    stats.jobs_written +
    stats.clients_written +
    stats.quotes_written +
    stats.line_items_written +
    stats.invoices_written +
    stats.payments_written +
    stats.expenses_written;

  await env.DB.prepare(
    `UPDATE sync_log
     SET finished_at = ?, status = ?, rows_affected = ?, error_message = ?, duration_ms = ?
     WHERE job_name = ? AND started_at = ?`,
  )
    .bind(
      finishedAt.toISOString(),
      errorMessage ? "error" : "success",
      rowsAffected,
      errorMessage,
      finishedAt.getTime() - startedAt.getTime(),
      jobName,
      startedAt.toISOString(),
    )
    .run();
}
