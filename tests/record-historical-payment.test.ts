/**
 * Executes POST /api/invoices/:id/record-historical-payment
 * (handleInvoiceHistoricalPayment → recordPayment when additional > 0).
 * In-memory D1, foreign keys on.
 *
 * Amounts here are invented fixtures (invoice 133 is $1,500) so the method
 * matrix stays small. Production totals are in production-historical-replay.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { Env } from "../src/env.js";
import { handleInvoiceHistoricalPayment } from "../src/routes/invoices.js";
import { isJobberExcludedInvoice, isJobberExcludedPayment } from "../src/lib/qbo-sync.js";

const OWNER = "tony@homesolutionsar.com";

const CLIENT_JOBBER = "client-jobber";
const CLIENT_NATIVE = "client-native";
const JOB_91 = "job-91";
const JOB_NATIVE = "job-native";
const JOB_CASH = "job-cash";

const INV_133 = "inv-133";
const INV_135 = "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTU2MjI0NDgw";
const INV_NATIVE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const INV_CASH = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

let mf: Miniflare;
let env: Env;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: { DB: "record-historical-payment" },
    d1Persist: false,
  });
  const bindings = await mf.getBindings<{ DB: Env["DB"] }>();
  env = { DB: bindings.DB } as Env;
  await env.DB.prepare("PRAGMA foreign_keys = ON").run();
  const schema = `
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL
    );
    CREATE TABLE clients (
      id TEXT PRIMARY KEY,
      name TEXT,
      first_name TEXT,
      last_name TEXT
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      job_number INTEGER,
      status TEXT,
      client_id TEXT REFERENCES clients(id),
      data_source TEXT,
      contract_total REAL
    );
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY,
      invoice_number INTEGER,
      job_id TEXT REFERENCES jobs(id),
      client_id TEXT REFERENCES clients(id),
      billing_model TEXT,
      invoice_type TEXT,
      title TEXT,
      description TEXT,
      amount REAL,
      total REAL,
      tax_amount REAL,
      late_fee_amount REAL,
      credits_applied REAL,
      total_due REAL,
      status TEXT,
      sent_date TEXT,
      viewed_date TEXT,
      due_date TEXT,
      paid_date TEXT,
      paid_amount REAL,
      payment_method TEXT,
      stripe_payment_id TEXT,
      portal_link TEXT,
      payment_token TEXT,
      cost_plus_cycle_id TEXT,
      milestone_number INTEGER,
      trade_line_item_id TEXT,
      line_item_ids TEXT,
      payer_id TEXT,
      notes TEXT,
      created_at TEXT,
      created_by TEXT,
      payments_total REAL,
      data_source TEXT
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      job_id TEXT REFERENCES jobs(id),
      invoice_id TEXT REFERENCES invoices(id),
      client_id TEXT REFERENCES clients(id),
      amount REAL NOT NULL,
      convenience_fee REAL,
      stripe_fee REAL,
      net_amount REAL,
      payment_method TEXT,
      stripe_payment_id TEXT,
      received_date TEXT,
      collected_at TEXT,
      notes TEXT,
      synced_at TEXT,
      created_at TEXT,
      data_source TEXT
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      user_email TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      created_at TEXT
    );
    CREATE TABLE notification_logs (
      id TEXT PRIMARY KEY,
      template_id TEXT,
      trigger_event TEXT,
      recipient_type TEXT,
      recipient_name TEXT,
      recipient_contact TEXT,
      recipient_user_id TEXT,
      channel TEXT,
      subject TEXT,
      body TEXT,
      status TEXT,
      retry_count INTEGER,
      is_read INTEGER,
      job_id TEXT,
      client_id TEXT,
      created_at TEXT
    );
  `;
  for (const statement of schema.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active)
     VALUES ('user-owner', ?, 'Tony', 'Columbus', 'owner', 1)`,
  )
    .bind(OWNER)
    .run();
  await env.DB.prepare(
    `INSERT INTO clients (id, name, first_name, last_name) VALUES (?, NULL, 'Jobber', 'Client')`,
  )
    .bind(CLIENT_JOBBER)
    .run();
  await env.DB.prepare(
    `INSERT INTO clients (id, name, first_name, last_name) VALUES (?, 'Native Client', 'Native', 'Client')`,
  )
    .bind(CLIENT_NATIVE)
    .run();
  await env.DB.prepare(
    `INSERT INTO jobs (id, job_number, status, client_id, data_source, contract_total)
     VALUES (?, 91, 'in_progress', ?, 'jobber_import', 1500)`,
  )
    .bind(JOB_91, CLIENT_JOBBER)
    .run();
  await env.DB.prepare(
    `INSERT INTO jobs (id, job_number, status, client_id, data_source, contract_total)
     VALUES (?, 50, 'in_progress', ?, 'estimate', 400)`,
  )
    .bind(JOB_NATIVE, CLIENT_NATIVE)
    .run();
  await env.DB.prepare(
    `INSERT INTO jobs (id, job_number, status, client_id, data_source, contract_total)
     VALUES (?, 51, 'scheduled', ?, 'estimate', 80)`,
  )
    .bind(JOB_CASH, CLIENT_NATIVE)
    .run();

  await insertInvoice({
    id: INV_133,
    number: 133,
    jobId: JOB_91,
    clientId: CLIENT_JOBBER,
    status: "late",
    total: 1500,
    dataSource: "jobber_import",
  });
  await insertInvoice({
    id: INV_135,
    number: 135,
    jobId: null,
    clientId: CLIENT_JOBBER,
    status: "late",
    total: 250,
    dataSource: "jobber_import",
  });
  await insertInvoice({
    id: INV_NATIVE,
    number: 40,
    jobId: JOB_NATIVE,
    clientId: CLIENT_NATIVE,
    status: "sent",
    total: 400,
    dataSource: null,
  });
  await insertInvoice({
    id: INV_CASH,
    number: 41,
    jobId: JOB_CASH,
    clientId: CLIENT_NATIVE,
    status: "sent",
    total: 80,
    dataSource: null,
  });
});

afterAll(async () => {
  await mf.dispose();
});

async function insertInvoice(row: {
  id: string;
  number: number;
  jobId: string | null;
  clientId: string;
  status: string;
  total: number;
  dataSource: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO invoices (
       id, invoice_number, job_id, client_id, billing_model, invoice_type, title,
       amount, total, tax_amount, late_fee_amount, credits_applied, total_due,
       status, sent_date, paid_amount, payments_total, data_source, created_at
     ) VALUES (?, ?, ?, ?, 'fixed', 'progress', ?, ?, ?, 0, 0, 0, ?, ?, '2026-09-01', 0, 0, ?, '2026-09-01T00:00:00Z')`,
  )
    .bind(
      row.id,
      row.number,
      row.jobId,
      row.clientId,
      `Invoice ${row.number}`,
      row.total,
      row.total,
      row.total,
      row.status,
      row.dataSource,
    )
    .run();
}

type Flags = { invoice: boolean; paymentWouldBe: boolean };

async function eligibility(invoiceId: string): Promise<{
  invoiceDataSource: string | null;
  jobDataSource: string | null;
  flags: Flags;
}> {
  const row = await env.DB.prepare(
    `SELECT i.id AS invoice_id, i.data_source AS invoice_data_source, j.data_source AS job_data_source
       FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id WHERE i.id = ?`,
  )
    .bind(invoiceId)
    .first<{
      invoice_id: string;
      invoice_data_source: string | null;
      job_data_source: string | null;
    }>();
  if (!row) throw new Error(`missing invoice ${invoiceId}`);
  const invoice = isJobberExcludedInvoice({
    invoiceId: row.invoice_id,
    invoiceDataSource: row.invoice_data_source,
    jobDataSource: row.job_data_source,
  });
  const paymentWouldBe = isJobberExcludedPayment({
    paymentId: "pending-native-id",
    invoiceId: row.invoice_id,
    invoiceDataSource: row.invoice_data_source,
    jobDataSource: row.job_data_source,
    paymentDataSource: null,
  });
  return {
    invoiceDataSource: row.invoice_data_source,
    jobDataSource: row.job_data_source,
    flags: { invoice, paymentWouldBe },
  };
}

function post(id: string, body: Record<string, unknown>): Request {
  return new Request(`https://app.homesolutionsar.com/api/invoices/${id}/record-historical-payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Cf-Access-Authenticated-User-Email": OWNER,
    },
    body: JSON.stringify(body),
  });
}

describe("record historical payment writes through recordPayment", () => {
  it("rejects a payment whose invoice row does not exist", async () => {
    const res = await handleInvoiceHistoricalPayment(
      post("missing-invoice", { payment_method: "check", amount: 10 }),
      env,
      "missing-invoice",
    );
    expect(res.status).toBe(404);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM payments").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("records Other, check, cash, and Migrated from Jobber and leaves QBO exclusion unchanged", async () => {
    const fk = await env.DB.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>();
    expect(fk?.foreign_keys).toBe(1);
    await expect(
      env.DB.prepare(
        `INSERT INTO payments (
           id, job_id, invoice_id, client_id, amount, payment_method, created_at
         ) VALUES ('orphan', NULL, 'no-such-invoice', NULL, 1, 'check', '2026-10-07')`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);

    const cases = [
      { id: INV_133, method: "other", amount: 1500, jobId: JOB_91 },
      { id: INV_135, method: "jobber", amount: 250, jobId: null },
      { id: INV_NATIVE, method: "check", amount: 400, jobId: JOB_NATIVE },
      { id: INV_CASH, method: "cash", amount: 80, jobId: JOB_CASH },
    ];
    const before = new Map<string, Awaited<ReturnType<typeof eligibility>>>();
    for (const c of cases) before.set(c.id, await eligibility(c.id));
    expect(before.get(INV_133)?.flags.invoice).toBe(true);
    expect(before.get(INV_135)?.flags.invoice).toBe(true);
    expect(before.get(INV_NATIVE)?.flags.invoice).toBe(false);
    expect(before.get(INV_CASH)?.flags.invoice).toBe(false);

    for (const c of cases) {
      const res = await handleInvoiceHistoricalPayment(
        post(c.id, { payment_method: c.method, amount: c.amount, received_date: "2026-10-01" }),
        env,
        c.id,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { payment_id: string; amount_recorded: number };
      expect(body.amount_recorded).toBe(c.amount);
      expect(body.payment_id).toBeTruthy();

      const pay = await env.DB.prepare(
        `SELECT id, invoice_id, job_id, amount, payment_method, data_source, notes
           FROM payments WHERE id = ?`,
      )
        .bind(body.payment_id)
        .first<{
          id: string;
          invoice_id: string;
          job_id: string | null;
          amount: number;
          payment_method: string;
          data_source: string | null;
          notes: string | null;
        }>();
      expect(pay?.invoice_id).toBe(c.id);
      expect(pay?.job_id).toBe(c.jobId);
      expect(pay?.amount).toBe(c.amount);
      expect(pay?.payment_method).toBe(c.method);
      expect(pay?.notes ?? "").toContain("[historical]");

      const inv = await env.DB.prepare(
        `SELECT status, paid_amount, payments_total, payment_method, paid_date, data_source
           FROM invoices WHERE id = ?`,
      )
        .bind(c.id)
        .first<{
          status: string;
          paid_amount: number;
          payments_total: number;
          payment_method: string;
          paid_date: string | null;
          data_source: string | null;
        }>();
      expect(inv?.status).toBe("paid");
      expect(inv?.paid_amount).toBe(c.amount);
      expect(inv?.payments_total).toBe(c.amount);
      expect(inv?.payment_method).toBe(c.method);
      expect(inv?.paid_date).toBeTruthy();

      const after = await eligibility(c.id);
      expect(after.flags).toEqual(before.get(c.id)?.flags);
      expect(after.invoiceDataSource).toBe(before.get(c.id)?.invoiceDataSource);
      expect(after.jobDataSource).toBe(before.get(c.id)?.jobDataSource);
      expect(
        isJobberExcludedPayment({
          paymentId: pay!.id,
          invoiceId: c.id,
          invoiceDataSource: inv?.data_source,
          jobDataSource: after.jobDataSource,
          paymentDataSource: pay?.data_source,
        }),
      ).toBe(before.get(c.id)?.flags.paymentWouldBe);
    }

    const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_logs").first<{ n: number }>();
    expect(notes?.n).toBe(0);
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'invoice_historical_payment_recorded'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(4);
  });
});
