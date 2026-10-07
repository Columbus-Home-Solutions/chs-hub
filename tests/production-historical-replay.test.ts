/**
 * Historical-payment writes against a replay of the Oct 7, 2026 production
 * rows. Amounts are the remote totals ($7,005 / $9,050 / $3,750), not the
 * invented $1,500 fixture in record-historical-payment.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleInvoiceCreate, handleInvoiceHistoricalPayment } from "../src/routes/invoices.js";
import { handleJobPipeline } from "../src/routes/jobs-api.js";
import { lienWaiverJobStatusAllowsGeneration } from "../src/lib/completion-triggers.js";
import { isJobberExcludedInvoice, isJobberExcludedPayment } from "../src/lib/qbo-sync.js";
import {
  INV_133,
  INV_135,
  JOB_91,
  JOB_99,
  JOB_105,
  JOB_106,
  JOB_112,
  OWNER,
  UNLINKED_105,
  UNLINKED_106,
  openProductionReplay,
} from "./production-replay-db.js";

let env: Env;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const replay = await openProductionReplay();
  env = replay.env;
  dispose = replay.dispose;
});

afterAll(async () => {
  await dispose();
});

function post(path: string, body: unknown): Request {
  return new Request(`http://replay.local${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Cf-Access-Authenticated-User-Email": OWNER,
    },
    body: JSON.stringify(body),
  });
}

type InvoiceSnap = {
  status: string;
  paid_amount: number | null;
  payments_total: number | null;
  total_due: number | null;
  paid_date: string | null;
  payment_method: string | null;
  data_source: string | null;
  job_id: string | null;
  jobber_invoice_number: number | null;
};

type PaymentSnap = {
  id: string;
  amount: number;
  payment_method: string | null;
  received_date: string | null;
  job_id: string | null;
  invoice_id: string | null;
};

async function invoiceSnap(id: string): Promise<InvoiceSnap> {
  const row = await env.DB.prepare(
    `SELECT status, paid_amount, payments_total, total_due, paid_date, payment_method,
            data_source, job_id, jobber_invoice_number
       FROM invoices WHERE id = ?`,
  )
    .bind(id)
    .first<InvoiceSnap>();
  if (!row) throw new Error(`invoice missing: ${id}`);
  return row;
}

async function paymentsFor(invoiceId: string): Promise<PaymentSnap[]> {
  return (
    (
      await env.DB.prepare(
        `SELECT id, amount, payment_method, received_date, job_id, invoice_id
           FROM payments WHERE invoice_id = ?
          ORDER BY amount DESC, id`,
      )
        .bind(invoiceId)
        .all<PaymentSnap>()
    ).results ?? []
  );
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("production replay — historical payments", () => {
  it("lists the live board and leaves job 91 off it", async () => {
    const res = await handleJobPipeline(env);
    const body = (await res.json()) as {
      pipeline: Record<string, Array<{ job_number: number; client_name: string | null }>>;
    };
    const cards = Object.values(body.pipeline).flat();
    const numbers = cards.map((c) => c.job_number).sort((a, b) => a - b);
    expect(numbers).toEqual([78, 96, 99, 101, 102, 103, 104, 105, 107, 109, 110, 111]);
    expect(cards.find((c) => c.job_number === 109)?.client_name).toBe("Abdul Razaque");
    expect(cards.find((c) => c.job_number === 110)?.client_name).toBe("Alicia Johnson");
    expect(cards.find((c) => c.job_number === 99)?.client_name).toBe("Charlie  Turner");
  });

  it("finds unlinked payments only on jobs 105 and 106", async () => {
    const rows = (
      await env.DB.prepare(
        `SELECT j.job_number, j.status, p.id, p.amount, p.payment_method, p.received_date
           FROM payments p
           JOIN jobs j ON j.id = p.job_id
          WHERE p.invoice_id IS NULL
            AND j.data_source = 'jobber_import'
          ORDER BY j.job_number`,
      ).all<{
        job_number: number;
        status: string;
        id: string;
        amount: number;
        payment_method: string;
        received_date: string;
      }>()
    ).results ?? [];

    expect(rows).toEqual([
      {
        job_number: 105,
        status: "action_required",
        id: UNLINKED_105,
        amount: 1150,
        payment_method: "check",
        received_date: "2026-06-17",
      },
      {
        job_number: 106,
        status: "cancelled",
        id: UNLINKED_106,
        amount: 400,
        payment_method: "jobber",
        received_date: "2026-06-17",
      },
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE job_id = ? AND invoice_id IS NULL", JOB_91)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE job_id = ? AND invoice_id IS NULL", JOB_99)).toBe(0);
  });

  it("records #133 at $7,005 and #135 at $9,050", async () => {
    const before133 = await invoiceSnap(INV_133);
    const before135 = await invoiceSnap(INV_135);
    expect(before133).toMatchObject({
      status: "past_due",
      paid_amount: null,
      payments_total: 0,
      total_due: 7005,
      paid_date: null,
      payment_method: null,
      data_source: "jobber_import",
      job_id: JOB_91,
      jobber_invoice_number: 133,
    });
    expect(before135).toMatchObject({
      status: "past_due",
      paid_amount: null,
      payments_total: 0,
      total_due: 9050,
      paid_date: null,
      payment_method: null,
      data_source: "jobber_import",
      job_id: null,
      jobber_invoice_number: 135,
    });
    expect(await paymentsFor(INV_133)).toEqual([]);
    expect(await paymentsFor(INV_135)).toEqual([]);

    const pay133 = await handleInvoiceHistoricalPayment(
      post(`/api/invoices/${INV_133}/record-historical-payment`, {
        amount: 7005,
        payment_method: "other",
        received_date: "2026-04-28",
      }),
      env,
      INV_133,
    );
    expect(pay133.status).toBe(201);
    const body133 = (await pay133.json()) as {
      amount_recorded: number;
      applied_unlinked_payment_ids: string[];
      payment_id: string;
    };
    expect(body133.amount_recorded).toBe(7005);
    expect(body133.applied_unlinked_payment_ids).toEqual([]);

    const pay135 = await handleInvoiceHistoricalPayment(
      post(`/api/invoices/${INV_135}/record-historical-payment`, {
        amount: 9050,
        payment_method: "jobber",
        received_date: "2026-06-04",
      }),
      env,
      INV_135,
    );
    expect(pay135.status).toBe(201);
    const body135 = (await pay135.json()) as {
      amount_recorded: number;
      applied_unlinked_payment_ids: string[];
      payment_id: string;
    };
    expect(body135.amount_recorded).toBe(9050);
    expect(body135.applied_unlinked_payment_ids).toEqual([]);

    const after133 = await invoiceSnap(INV_133);
    const after135 = await invoiceSnap(INV_135);
    expect(after133).toMatchObject({
      status: "paid",
      paid_amount: 7005,
      payments_total: 7005,
      total_due: 7005,
      payment_method: "other",
      data_source: "jobber_import",
    });
    expect(after133.paid_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after135).toMatchObject({
      status: "paid",
      paid_amount: 9050,
      payments_total: 9050,
      total_due: 9050,
      payment_method: "jobber",
      data_source: "jobber_import",
      job_id: null,
    });
    expect(after135.paid_date).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const rows133 = await paymentsFor(INV_133);
    const rows135 = await paymentsFor(INV_135);
    expect(rows133).toEqual([
      {
        id: body133.payment_id,
        amount: 7005,
        payment_method: "other",
        received_date: "2026-04-28",
        job_id: JOB_91,
        invoice_id: INV_133,
      },
    ]);
    expect(rows135).toEqual([
      {
        id: body135.payment_id,
        amount: 9050,
        payment_method: "jobber",
        received_date: "2026-06-04",
        job_id: null,
        invoice_id: INV_135,
      },
    ]);

    expect(
      isJobberExcludedInvoice({
        invoiceId: INV_133,
        jobDataSource: "jobber_import",
        invoiceDataSource: after133.data_source,
      }),
    ).toBe(true);
    expect(
      isJobberExcludedPayment({
        paymentId: body133.payment_id,
        jobDataSource: "jobber_import",
        paymentDataSource: null,
        invoiceId: INV_133,
        invoiceDataSource: after133.data_source,
      }),
    ).toBe(true);
    expect(
      isJobberExcludedInvoice({
        invoiceId: INV_135,
        jobDataSource: null,
        invoiceDataSource: after135.data_source,
      }),
    ).toBe(true);
    expect(
      isJobberExcludedPayment({
        paymentId: body135.payment_id,
        jobDataSource: null,
        paymentDataSource: null,
        invoiceId: INV_135,
        invoiceDataSource: after135.data_source,
      }),
    ).toBe(true);
  });

  it("creates Charlie's Final invoice for $3,750 and records the historical payment", async () => {
    const created = await handleInvoiceCreate(
      post("/api/invoices", {
        job_id: JOB_99,
        invoice_type: "final",
        amount: 3750,
        title: "Final Invoice",
      }),
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { invoice: { id: string; invoice_number: number; status: string; total_due: number } };
    const invoiceId = createdBody.invoice.id;
    expect(createdBody.invoice.invoice_number).toBe(10000);
    expect(createdBody.invoice.status).toBe("draft");
    expect(createdBody.invoice.total_due).toBe(3750);

    const before = await invoiceSnap(invoiceId);
    expect(before).toMatchObject({
      status: "draft",
      paid_amount: null,
      payments_total: null,
      total_due: 3750,
      paid_date: null,
      job_id: JOB_99,
    });

    const paid = await handleInvoiceHistoricalPayment(
      post(`/api/invoices/${invoiceId}/record-historical-payment`, {
        amount: 3750,
        payment_method: "jobber",
        received_date: "2026-10-07",
      }),
      env,
      invoiceId,
    );
    expect(paid.status).toBe(201);
    const paidBody = (await paid.json()) as {
      amount_recorded: number;
      applied_unlinked_payment_ids: string[];
      payment_id: string;
    };
    expect(paidBody.amount_recorded).toBe(3750);
    expect(paidBody.applied_unlinked_payment_ids).toEqual([]);

    const after = await invoiceSnap(invoiceId);
    expect(after).toMatchObject({
      status: "paid",
      paid_amount: 3750,
      payments_total: 3750,
      total_due: 3750,
      payment_method: "jobber",
      job_id: JOB_99,
    });
    expect(await paymentsFor(invoiceId)).toEqual([
      {
        id: paidBody.payment_id,
        amount: 3750,
        payment_method: "jobber",
        received_date: "2026-10-07",
        job_id: JOB_99,
        invoice_id: invoiceId,
      },
    ]);
    expect(
      isJobberExcludedInvoice({
        invoiceId,
        jobDataSource: "jobber_import",
        invoiceDataSource: after.data_source,
      }),
    ).toBe(true);
  });

  it("applies job 105's $1,150 deposit once and does not insert it again", async () => {
    const created = await handleInvoiceCreate(
      post("/api/invoices", {
        job_id: JOB_105,
        invoice_type: "final",
        amount: 3500,
      }),
      env,
    );
    expect(created.status).toBe(201);
    const invoiceId = ((await created.json()) as { invoice: { id: string } }).invoice.id;

    const paid = await handleInvoiceHistoricalPayment(
      post(`/api/invoices/${invoiceId}/record-historical-payment`, {
        amount: 3500,
        payment_method: "check",
        received_date: "2026-10-07",
      }),
      env,
      invoiceId,
    );
    expect(paid.status).toBe(201);
    const body = (await paid.json()) as {
      amount_recorded: number;
      applied_unlinked_payment_ids: string[];
    };
    expect(body.applied_unlinked_payment_ids).toEqual([UNLINKED_105]);
    expect(body.amount_recorded).toBe(2350);

    const after = await invoiceSnap(invoiceId);
    expect(after).toMatchObject({
      status: "paid",
      paid_amount: 3500,
      payments_total: 3500,
      total_due: 3500,
    });
    const rows = await paymentsFor(invoiceId);
    expect(rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([1150, 2350]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(3500);
    const deposit = rows.find((r) => r.id === UNLINKED_105);
    expect(deposit).toMatchObject({
      amount: 1150,
      payment_method: "check",
      received_date: "2026-06-17",
      job_id: JOB_105,
      invoice_id: invoiceId,
    });
    expect(await count("SELECT COUNT(*) AS n FROM payments WHERE job_id = ? AND invoice_id IS NULL", JOB_105)).toBe(0);
  });

  it("links job 106's $400 deposit and inserts no second payment", async () => {
    const created = await handleInvoiceCreate(
      post("/api/invoices", {
        job_id: JOB_106,
        invoice_type: "final",
        amount: 400,
      }),
      env,
    );
    const invoiceId = ((await created.json()) as { invoice: { id: string } }).invoice.id;
    const paid = await handleInvoiceHistoricalPayment(
      post(`/api/invoices/${invoiceId}/record-historical-payment`, {
        amount: 400,
        payment_method: "jobber",
        received_date: "2026-06-17",
      }),
      env,
      invoiceId,
    );
    const body = (await paid.json()) as { amount_recorded: number; applied_unlinked_payment_ids: string[] };
    expect(paid.status).toBe(201);
    expect(body.amount_recorded).toBe(0);
    expect(body.applied_unlinked_payment_ids).toEqual([UNLINKED_106]);
    expect(await invoiceSnap(invoiceId)).toMatchObject({
      status: "paid",
      paid_amount: 400,
      payments_total: 400,
      total_due: 400,
    });
    expect(await paymentsFor(invoiceId)).toEqual([
      {
        id: UNLINKED_106,
        amount: 400,
        payment_method: "jobber",
        received_date: "2026-06-17",
        job_id: JOB_106,
        invoice_id: invoiceId,
      },
    ]);
  });

  it("does not generate a lien waiver or notification for late, action_required, or archived jobs", async () => {
    expect(lienWaiverJobStatusAllowsGeneration("late")).toBe(false);
    expect(lienWaiverJobStatusAllowsGeneration("action_required")).toBe(false);
    expect(lienWaiverJobStatusAllowsGeneration("archived")).toBe(false);
    expect(lienWaiverJobStatusAllowsGeneration("complete")).toBe(true);
    expect(lienWaiverJobStatusAllowsGeneration("closed")).toBe(true);

    const created = await handleInvoiceCreate(
      post("/api/invoices", {
        job_id: JOB_112,
        invoice_type: "final",
        amount: 3000,
      }),
      env,
    );
    const invoiceId = ((await created.json()) as { invoice: { id: string } }).invoice.id;
    const paid = await handleInvoiceHistoricalPayment(
      post(`/api/invoices/${invoiceId}/record-historical-payment`, {
        amount: 3000,
        payment_method: "check",
        received_date: "2026-10-07",
      }),
      env,
      invoiceId,
    );
    expect(paid.status).toBe(201);
    expect((await invoiceSnap(invoiceId)).status).toBe("paid");

    const job112 = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(JOB_112).first<{ status: string }>();
    const job91 = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(JOB_91).first<{ status: string }>();
    const job99 = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(JOB_99).first<{ status: string }>();
    expect(job91?.status).toBe("late");
    expect(job99?.status).toBe("action_required");
    expect(job112?.status).toBe("archived");

    expect(await count("SELECT COUNT(*) AS n FROM job_documents")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM notification_logs")).toBe(0);
  });
});
