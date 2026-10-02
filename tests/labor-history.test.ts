import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  OVERLAP_EXPENSE_SQL,
  handleLaborEntryDelete,
  handleLaborEntryUpdate,
  handleLaborLedger,
  handleLaborPay,
  handleLaborPayable,
  handleLaborRangeStatements,
  handleLaborWeeks,
} from "../src/routes/labor.js";
import { centralDate, laborUnpaidAggregate, weekBounds } from "../shared/labor-week";

const USER = {
  id: "user-1",
  email: "tony@example.com",
  first_name: "Tony",
  last_name: "Columbus",
  role: "owner",
  is_active: 1,
};

function authed(url: string, body?: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "Cf-Access-Authenticated-User-Email": USER.email,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

interface Entry {
  id: string;
  sub_id: string;
  job_id: string;
  work_date: string;
  days: number;
  day_rate: number;
  batch_id: string | null;
  expense_id: string | null;
  deleted_at: string | null;
  company_name: string;
  company: null;
  contact_name: null;
  primary_contact: null;
  job_number: number;
  title: string;
  property_address: string;
  notes?: string | null;
  entered_via?: string;
  created_at?: string;
  created_by?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
  deleted_by?: string | null;
  delete_reason?: string | null;
  pay_date?: string | null;
  method?: string | null;
}

function entry(partial: Partial<Entry> & Pick<Entry, "id" | "sub_id" | "job_id" | "work_date" | "days" | "day_rate">): Entry {
  return {
    batch_id: null,
    expense_id: null,
    deleted_at: null,
    company_name: partial.sub_id === "w2" ? "ZZ B" : "ZZ A",
    company: null,
    contact_name: null,
    primary_contact: null,
    job_number: partial.job_id === "j2" ? 102 : 101,
    title: partial.job_id === "j2" ? "Kitchen" : "Pergola",
    property_address: "2511 Lilac",
    notes: null,
    entered_via: "web",
    created_at: "2026-09-21T12:00:00Z",
    created_by: "tony@example.com",
    updated_at: null,
    updated_by: null,
    deleted_by: null,
    delete_reason: null,
    pay_date: null,
    method: null,
    ...partial,
  };
}

function payDb(
  entries: Entry[],
  expenses: Record<string, unknown>[] = [],
  batchAudits: { entity_id: string; details: string }[] = [],
) {
  const updates: { id: string; batch_id: string; expense_id: string | null }[] = [];
  const inserts: { sql: string; args: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          _sql: sql,
          _args: [] as unknown[],
          bind(...args: unknown[]) {
            this._args = args;
            return this;
          },
          async first() {
            if (sql.includes("FROM users")) return USER;
            if (sql.includes("FROM subcontractors")) {
              return {
                id: this._args[0],
                company_name: "ZZ A",
                company: null,
                contact_name: null,
                primary_contact: null,
                day_rate: 200,
                is_active: 1,
                worker_type: "day_rate_labor",
              };
            }
            if (sql.includes("FROM labor_entries")) {
              return entries.find((row) => row.id === this._args[0]) ?? null;
            }
            if (sql.includes("FROM expenses")) {
              return expenses.find((row) => row.id === this._args[0]) ?? null;
            }
            return null;
          },
          async all() {
            if (sql.includes("FROM audit_logs")) {
              if (sql.includes("labor_pay_batch")) return { results: batchAudits };
              return {
                results: [
                  {
                    id: "aud-1",
                    entity_id: "day-edit",
                    action: "labor_entry_updated",
                    user_email: USER.email,
                    details: JSON.stringify({ before: { days: 1 }, after: { days: 0.5 } }),
                    created_at: "2026-09-22T12:00:00Z",
                  },
                ],
              };
            }
            if (sql.includes("FROM expenses")) return { results: expenses };
            if (sql.includes("FROM labor_entries")) {
              let rows = entries;
              if (sql.includes("deleted_at IS NULL")) rows = rows.filter((row) => !row.deleted_at);
              if (sql.includes("le.id IN")) {
                const ids = new Set(this._args.map(String));
                rows = rows.filter((row) => ids.has(row.id));
              }
              return { results: rows };
            }
            return { results: [] };
          },
          async run() {
            inserts.push({ sql, args: this._args });
            return { success: true };
          },
        };
        return stmt;
      },
      async batch(statements: { _sql: string; _args: unknown[] }[]) {
        for (const statement of statements) {
          inserts.push({ sql: statement._sql, args: statement._args });
          if (statement._sql.startsWith("UPDATE labor_entries SET batch_id")) {
            const id = String(statement._args[2]);
            const row = entries.find((item) => item.id === id);
            if (row) {
              row.batch_id = String(statement._args[0]);
              row.expense_id = (statement._args[1] as string | null) ?? null;
            }
            updates.push({
              id,
              batch_id: String(statement._args[0]),
              expense_id: (statement._args[1] as string | null) ?? null,
            });
          }
        }
        return [];
      },
    },
  } as unknown as Env;
  return { env, entries, updates, inserts };
}

describe("partial labor pay", () => {
  const oscar = (id: string, date: string, job = "j1") =>
    entry({ id, sub_id: "w1", job_id: job, work_date: date, days: 1, day_rate: 200 });
  const izaias = (id: string, date: string) =>
    entry({ id, sub_id: "w2", job_id: "j2", work_date: date, days: 1, day_rate: 150 });

  it("pays one worker and leaves the other unpaid", async () => {
    const state = payDb([oscar("o1", "2026-09-21"), izaias("i1", "2026-09-21")]);
    const res = await handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", {
        pay_date: "2026-10-02",
        method: "check",
        entry_ids: ["o1"],
      }),
      state.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean; expenses: { sub_id: string; amount: number }[]; batch: { total: number } };
    expect(body.created).toBe(true);
    expect(body.batch.total).toBe(200);
    expect(body.expenses.map((row) => row.sub_id)).toEqual(["w1"]);
    expect(state.updates.map((row) => row.id)).toEqual(["o1"]);
    expect(state.entries.find((row) => row.id === "i1")?.batch_id).toBeNull();
  });

  it("pays days from two weeks as one expense with a date range", async () => {
    const state = payDb([oscar("o1", "2026-09-07"), oscar("o2", "2026-09-21")]);
    const res = await handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", {
        pay_date: "2026-10-02",
        entry_ids: ["o1", "o2"],
      }),
      state.env,
    );
    const body = (await res.json()) as { expenses: { amount: number }[] };
    expect(body.expenses).toHaveLength(1);
    expect(body.expenses[0].amount).toBe(400);
    const inserted = state.inserts.find((row) => row.sql.startsWith("INSERT INTO expenses"));
    expect(String(inserted?.args[3])).toContain("9/7");
    expect(String(inserted?.args[3])).toContain("9/21");
    const batch = state.inserts.find((row) => row.sql.startsWith("INSERT INTO labor_pay_batches"));
    expect(batch?.args[1]).toBe("2026-09-07");
    expect(batch?.args[2]).toBe("2026-09-27");
  });

  it("pays specific days and leaves the rest for the next payment", async () => {
    const state = payDb([oscar("o1", "2026-09-21"), oscar("o2", "2026-09-22")]);
    const first = await handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", { pay_date: "2026-10-02", entry_ids: ["o1"] }),
      state.env,
    );
    expect(first.status).toBe(200);
    expect(state.entries.find((row) => row.id === "o2")?.expense_id).toBeNull();

    const second = await handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", { pay_date: "2026-10-09", entry_ids: ["o2"] }),
      state.env,
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as { created: boolean; expenses: { amount: number }[] };
    expect(body.created).toBe(true);
    expect(body.expenses[0].amount).toBe(200);
    expect(state.entries.find((row) => row.id === "o2")?.batch_id).toBeTruthy();
  });

  it("creates nothing when the same days are submitted again", async () => {
    const state = payDb([oscar("o1", "2026-09-21")]);
    await handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", { pay_date: "2026-10-02", entry_ids: ["o1"] }),
      state.env,
    );
    const again = await handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", { pay_date: "2026-10-02", entry_ids: ["o1"] }),
      state.env,
    );
    const body = (await again.json()) as { created: boolean; expenses: unknown[] };
    expect(body.created).toBe(false);
    expect(body.expenses).toEqual([]);
    expect(state.inserts.filter((row) => row.sql.startsWith("INSERT INTO expenses"))).toHaveLength(1);
  });

  it("refuses days in a week that is still open", async () => {
    const { start } = weekBounds(centralDate());
    const state = payDb([oscar("o1", start)]);
    const res = await handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", { entry_ids: ["o1"] }),
      state.env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("week_open");
  });

  it("links a skipped group to a subcontractor-typed expense instead of creating another", async () => {
    const state = payDb(
      [oscar("o1", "2026-09-21"), izaias("i1", "2026-09-22")],
      [
        {
          id: "hand-sub",
          sub_id: "w2",
          job_id: "j2",
          amount: 150,
          expense_type: "subcontractor",
          incurred_date: "2026-09-22",
        },
      ],
    );
    const res = await handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", {
        pay_date: "2026-10-02",
        entry_ids: ["o1", "i1"],
        skip: [{ sub_id: "w2", job_id: "j2" }],
      }),
      state.env,
    );
    const body = (await res.json()) as { expenses: { job_id: string }[]; batch: { total: number } };
    expect(body.expenses.map((row) => row.job_id)).toEqual(["j1"]);
    expect(body.batch.total).toBe(200);
    expect(state.updates.find((row) => row.id === "i1")?.expense_id).toBe("hand-sub");
  });
});

describe("labor weeks, ledger, and settlement", () => {
  it("lists paid, partly paid, and unpaid weeks and summarizes every unpaid closed week", async () => {
    const rows = [
      entry({ id: "a", sub_id: "w1", job_id: "j1", work_date: "2026-09-07", days: 1, day_rate: 200, expense_id: "paid-1", batch_id: "b1" }),
      entry({ id: "b", sub_id: "w1", job_id: "j1", work_date: "2026-09-14", days: 1, day_rate: 200, expense_id: "paid-2", batch_id: "b2" }),
      entry({ id: "c", sub_id: "w2", job_id: "j2", work_date: "2026-09-15", days: 1, day_rate: 150 }),
      entry({ id: "d", sub_id: "w1", job_id: "j1", work_date: "2026-09-21", days: 1, day_rate: 200 }),
      entry({ id: "gone", sub_id: "w1", job_id: "j1", work_date: "2026-09-08", days: 1, day_rate: 200, deleted_at: "2026-09-08" }),
    ].map((row) => ({ ...row, paid: row.expense_id ? 1 : 0 }));
    const { env } = payDb(rows);
    const res = await handleLaborWeeks(authed("https://app.example/api/labor/weeks", undefined, "GET"), env);
    const body = (await res.json()) as {
      weeks: { week_start: string; state: string; unpaid: number }[];
      unpaid_summary: { weeks: number; total: number; oldest: string };
    };
    expect(body.weeks.map((week) => week.state)).toEqual(["closed_unpaid", "partly_paid", "paid"]);
    expect(body.unpaid_summary).toEqual({ weeks: 2, total: 350, oldest: "2026-09-14" });
    expect(body.weeks.find((week) => week.week_start === "2026-09-07")?.unpaid).toBe(0);

    const paidOnly = await handleLaborWeeks(
      authed("https://app.example/api/labor/weeks?status=paid", undefined, "GET"),
      env,
    );
    const filtered = (await paidOnly.json()) as { weeks: { state: string }[]; unpaid_summary: { weeks: number } };
    expect(filtered.weeks.map((week) => week.state)).toEqual(["paid"]);
    expect(filtered.unpaid_summary.weeks).toBe(2);
  });

  it("keeps earned equal to paid plus owed, and shows removed days only when asked", async () => {
    const rows = [
      entry({ id: "paid", sub_id: "w1", job_id: "j1", work_date: "2026-09-07", days: 1, day_rate: 200, expense_id: "ex", batch_id: "b", pay_date: "2026-09-18", method: "check" }),
      entry({ id: "day-edit", sub_id: "w1", job_id: "j1", work_date: "2026-09-21", days: 0.5, day_rate: 200 }),
      entry({ id: "removed", sub_id: "w1", job_id: "j1", work_date: "2026-09-08", days: 1, day_rate: 200, deleted_at: "2026-09-08", delete_reason: "logged on the wrong job" }),
    ];
    const { env } = payDb(rows);
    const hidden = await handleLaborLedger(
      authed("https://app.example/api/labor/workers/w1/ledger", undefined, "GET"),
      env,
      "w1",
    );
    const without = (await hidden.json()) as {
      totals: { earned: number; paid: number; unpaid: number };
      entries: { id: string; status: string; history: { action: string }[] }[];
    };
    expect(without.entries.map((row) => row.id)).toEqual(["paid", "day-edit"]);
    expect(without.totals.earned).toBe(without.totals.paid + without.totals.unpaid);
    expect(without.totals).toEqual({ earned: 300, paid: 200, unpaid: 100 });
    expect(without.entries.find((row) => row.id === "day-edit")?.history[0].action).toBe("labor_entry_updated");

    const shown = await handleLaborLedger(
      authed("https://app.example/api/labor/workers/w1/ledger?include_removed=1", undefined, "GET"),
      env,
      "w1",
    );
    const withRemoved = (await shown.json()) as { totals: { earned: number }; entries: { status: string }[] };
    expect(withRemoved.entries.some((row) => row.status === "removed")).toBe(true);
    expect(withRemoved.totals.earned).toBe(300);
  });

  it("prints a multi-week settlement with paid and owed, and no SSN", async () => {
    const rows = [
      entry({ id: "a", sub_id: "w1", job_id: "j1", work_date: "2026-09-07", days: 1, day_rate: 200, expense_id: "ex", batch_id: "b", pay_date: "2026-09-18", method: "check" }),
      entry({ id: "b", sub_id: "w1", job_id: "j2", work_date: "2026-09-21", days: 0.5, day_rate: 200 }),
    ];
    const { env } = payDb(rows);
    const res = await handleLaborRangeStatements(
      authed("https://app.example/api/labor/statements?sub_id=w1&from=2026-09-01&to=2026-09-30", undefined, "GET"),
      env,
    );
    const body = (await res.json()) as {
      statements: { days: number; earned: number; paid: number; owed: number; lines: { status: string }[] }[];
    };
    const text = JSON.stringify(body).toLowerCase();
    expect(text).not.toContain("ssn");
    expect(text).not.toContain("tax_id");
    expect(body.statements[0].days).toBe(1.5);
    expect(body.statements[0].earned).toBe(300);
    expect(body.statements[0].paid).toBe(200);
    expect(body.statements[0].owed).toBe(100);
    expect(body.statements[0].lines.map((line) => line.status).sort()).toEqual(["paid", "unpaid"]);
  });
});

describe("overlap link and amount reconciliation", () => {
  const hand = {
    id: "hand-sub",
    sub_id: "w2",
    job_id: "j2",
    amount: 150,
    expense_type: "subcontractor",
    incurred_date: "2026-09-22",
    vendor: "ZZ B",
    description: "paid outside",
    is_active: 1,
  };

  function kitchenDays() {
    return [
      entry({ id: "i1", sub_id: "w2", job_id: "j2", work_date: "2026-09-22", days: 1, day_rate: 150 }),
      entry({ id: "i2", sub_id: "w2", job_id: "j2", work_date: "2026-09-23", days: 1, day_rate: 150 }),
      entry({ id: "i3", sub_id: "w2", job_id: "j2", work_date: "2026-09-24", days: 1, day_rate: 150 }),
    ];
  }

  function pay(state: ReturnType<typeof payDb>, groups: unknown[], ids = ["i1", "i2", "i3"]) {
    return handleLaborPay(
      authed("https://app.example/api/labor/batches/pay", {
        pay_date: "2026-10-02",
        method: "check",
        entry_ids: ids,
        groups,
      }),
      state.env,
    );
  }

  function auditDetails(state: ReturnType<typeof payDb>) {
    const audit = state.inserts.find((row) => row.sql.includes("labor_batch_paid"));
    return JSON.parse(String(audit?.args[3])) as {
      total: number;
      settlements: { decision: string; expense_id: string; earned: number; linked: number; difference: number }[];
    };
  }

  it("rejects a shortfall link until Tony chooses how to handle the difference", async () => {
    const state = payDb(kitchenDays(), [hand]);
    const res = await pay(state, [{ sub_id: "w2", job_id: "j2", action: "link", expense_id: "hand-sub" }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("difference_required");
    expect(body.message).toContain("300.00");
    expect(state.inserts.some((row) => row.sql.startsWith("INSERT INTO expenses"))).toBe(false);
    expect(state.inserts.some((row) => row.sql.startsWith("INSERT INTO labor_pay_batches"))).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("adds one labor expense for the shortfall and links the days to the logged expense", async () => {
    const state = payDb(kitchenDays(), [hand]);
    const res = await pay(state, [
      { sub_id: "w2", job_id: "j2", action: "link", expense_id: "hand-sub", difference_decision: "add_difference" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batch: { total: number }; expenses: { amount: number }[] };
    expect(body.batch.total).toBe(300);
    expect(body.expenses).toEqual([{ sub_id: "w2", job_id: "j2", expense_id: expect.any(String), amount: 300 }]);
    const inserted = state.inserts.filter((row) => row.sql.startsWith("INSERT INTO expenses"));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].args[2]).toBe(300);
    expect(String(inserted[0].args[3])).toBe("Day labor — ZZ B — difference for 3 days, 9/22–9/24");
    expect(inserted[0].sql).toContain("'labor', NULL, 'labor', 1");
    expect(inserted[0].sql).toContain("'auto', 1, 0");
    expect(state.updates.map((row) => row.expense_id)).toEqual(["hand-sub", "hand-sub", "hand-sub"]);
    const details = auditDetails(state);
    expect(details.settlements[0]).toMatchObject({
      decision: "add_difference",
      expense_id: "hand-sub",
      earned: 450,
      linked: 150,
      difference: 300,
    });
    expect(details.total).toBe(300);
    expect(state.inserts.find((row) => row.sql.includes("audit_logs"))?.args[1]).toBe(USER.email);
  });

  it("accepts a shortfall as full payment without another expense", async () => {
    const state = payDb(kitchenDays(), [hand]);
    const res = await pay(state, [
      { sub_id: "w2", job_id: "j2", action: "link", expense_id: "hand-sub", difference_decision: "accept_as_paid" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batch: { total: number }; expenses: unknown[] };
    expect(body.batch.total).toBe(0);
    expect(body.expenses).toEqual([]);
    expect(state.inserts.some((row) => row.sql.startsWith("INSERT INTO expenses"))).toBe(false);
    expect(state.updates.every((row) => row.expense_id === "hand-sub")).toBe(true);
    expect(auditDetails(state).settlements[0].decision).toBe("accept_as_paid");
  });

  it("links an exact expense and a larger logged expense without creating one", async () => {
    const exact = { ...hand, id: "exact", amount: 150 };
    const state = payDb(
      [entry({ id: "i1", sub_id: "w2", job_id: "j2", work_date: "2026-09-22", days: 1, day_rate: 150 })],
      [exact, { ...hand, id: "bigger", amount: 400 }],
    );
    const exactRes = await pay(state, [{ sub_id: "w2", job_id: "j2", action: "link", expense_id: "exact" }], ["i1"]);
    expect(exactRes.status).toBe(200);
    expect(state.inserts.some((row) => row.sql.startsWith("INSERT INTO expenses"))).toBe(false);
    expect(auditDetails(state).settlements[0].decision).toBe("exact");

    const overState = payDb(
      [entry({ id: "i1", sub_id: "w2", job_id: "j2", work_date: "2026-09-22", days: 1, day_rate: 150 })],
      [{ ...hand, id: "bigger", amount: 400 }],
    );
    const overRes = await pay(overState, [{ sub_id: "w2", job_id: "j2", action: "link", expense_id: "bigger" }], ["i1"]);
    expect(overRes.status).toBe(200);
    const overBody = (await overRes.json()) as { expenses: unknown[]; batch: { total: number } };
    expect(overBody.expenses).toEqual([]);
    expect(overBody.batch.total).toBe(0);
    expect(auditDetails(overState).settlements[0].decision).toBe("over");
    expect(auditDetails(overState).settlements[0].difference).toBe(-250);
  });

  it("rejects a link to another worker or job", async () => {
    const state = payDb(kitchenDays(), [{ ...hand, sub_id: "w1", job_id: "j1" }]);
    const res = await pay(state, [
      { sub_id: "w2", job_id: "j2", action: "link", expense_id: "hand-sub", difference_decision: "add_difference" },
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("expense_mismatch");
  });

  it("creates a new expense when asked and ignores the matches", async () => {
    const state = payDb(kitchenDays(), [hand]);
    const res = await pay(state, [{ sub_id: "w2", job_id: "j2", action: "create" }]);
    expect(res.status).toBe(200);
    const inserted = state.inserts.filter((row) => row.sql.startsWith("INSERT INTO expenses"));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].args[2]).toBe(450);
    expect(String(inserted[0].args[3])).toContain("Day labor — ZZ B — 3 days");
    expect(state.updates.every((row) => row.expense_id !== "hand-sub")).toBe(true);
  });

  it("does nothing when the same days are submitted again", async () => {
    const state = payDb(kitchenDays(), [hand]);
    const body = {
      pay_date: "2026-10-02",
      entry_ids: ["i1", "i2", "i3"],
      groups: [{ sub_id: "w2", job_id: "j2", action: "link", expense_id: "hand-sub", difference_decision: "accept_as_paid" }],
    };
    const first = await handleLaborPay(authed("https://app.example/api/labor/batches/pay", body), state.env);
    expect(first.status).toBe(200);
    const expenseInserts = state.inserts.filter((row) => row.sql.startsWith("INSERT INTO expenses")).length;
    const second = await handleLaborPay(authed("https://app.example/api/labor/batches/pay", body), state.env);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);
    expect(state.inserts.filter((row) => row.sql.startsWith("INSERT INTO expenses")).length).toBe(expenseInserts);
  });

  it("shows a linked settlement on the ledger and the statement", async () => {
    const details = JSON.stringify({
      expenses: [],
      settlements: [
        {
          sub_id: "w2",
          job_id: "j2",
          action: "link",
          expense_id: "hand-sub",
          expense_amount: 150,
          expense_date: "2026-09-22",
          expense_type: "subcontractor",
          earned: 450,
          linked: 150,
          difference: 300,
          decision: "add_difference",
        },
      ],
    });
    const rows = [
      entry({
        id: "i1",
        sub_id: "w2",
        job_id: "j2",
        work_date: "2026-09-22",
        days: 1,
        day_rate: 150,
        expense_id: "hand-sub",
        batch_id: "batch-1",
        pay_date: "2026-10-02",
        method: "check",
      }),
    ];
    const { env } = payDb(rows, [hand], [{ entity_id: "batch-1", details }]);
    const ledger = await handleLaborLedger(
      authed("https://app.example/api/labor/workers/w2/ledger", undefined, "GET"),
      env,
      "w2",
    );
    const ledgerBody = (await ledger.json()) as {
      entries: { settlement: { decision: string; difference: number; expense_amount: number } | null }[];
    };
    expect(ledgerBody.entries[0].settlement).toMatchObject({
      decision: "add_difference",
      difference: 300,
      expense_amount: 150,
      expense_type: "subcontractor",
    });
    const statement = await handleLaborRangeStatements(
      authed("https://app.example/api/labor/statements?sub_id=w2&from=2026-09-01&to=2026-09-30", undefined, "GET"),
      env,
    );
    const statementBody = (await statement.json()) as {
      statements: { lines: { settlement: { decision: string } | null }[] }[];
    };
    expect(statementBody.statements[0].lines[0].settlement?.decision).toBe("add_difference");
  });
});

describe("overlap warnings and removed days", () => {
  it("flags labor and subcontractor expenses and ignores a payment from before the unpaid days", async () => {
    expect(OVERLAP_EXPENSE_SQL).not.toMatch(/expense_type\s*=/);
    expect(OVERLAP_EXPENSE_SQL).toContain("amount");
    expect(OVERLAP_EXPENSE_SQL).toContain("expense_type");
    expect(OVERLAP_EXPENSE_SQL).toContain("incurred_date");
    expect(OVERLAP_EXPENSE_SQL).toContain("vendor");
    expect(OVERLAP_EXPENSE_SQL).toContain("description");

    const rows = [
      entry({ id: "o1", sub_id: "w1", job_id: "j1", work_date: "2026-09-21", days: 1, day_rate: 200 }),
      entry({ id: "i1", sub_id: "w2", job_id: "j2", work_date: "2026-09-22", days: 1, day_rate: 150 }),
    ];
    const { env } = payDb(rows, [
      { id: "hand-labor", sub_id: "w1", job_id: "j1", amount: 600, expense_type: "labor", incurred_date: "2026-09-25", vendor: "ZZ A", description: "newer labor" },
      { id: "hand-older", sub_id: "w1", job_id: "j1", amount: 250, expense_type: "materials", incurred_date: "2026-09-24", vendor: "ZZ A", description: "older materials" },
      { id: "old", sub_id: "w1", job_id: "j1", amount: 200, expense_type: "labor", incurred_date: "2026-09-18" },
      { id: "hand-sub", sub_id: "w2", job_id: "j2", amount: 150, expense_type: "subcontractor", incurred_date: "2026-09-22", vendor: "ZZ B", description: "paid outside" },
    ]);
    const res = await handleLaborPayable(
      authed("https://app.example/api/labor/payable?pay_date=2026-10-02", undefined, "GET"),
      env,
    );
    const body = (await res.json()) as {
      overlaps: {
        sub_id: string;
        earned: number;
        matches: { expense_id: string; expense_type: string; amount: number; difference: number; vendor: string | null }[];
        match: { expense_id: string; expense_type: string } | null;
      }[];
    };
    const oscar = body.overlaps.find((row) => row.sub_id === "w1");
    const izaias = body.overlaps.find((row) => row.sub_id === "w2");
    expect(oscar?.match?.expense_id).toBe("hand-labor");
    expect(oscar?.matches.map((match) => match.expense_id)).toEqual(["hand-labor"]);
    expect(oscar?.matches.map((match) => match.expense_type)).toEqual(["labor"]);
    expect(oscar?.matches.some((match) => match.expense_id === "hand-older")).toBe(false);
    expect(oscar?.earned).toBe(200);
    expect(oscar?.matches[0].difference).toBe(-400);
    expect(izaias?.match?.expense_id).toBe("hand-sub");
    expect(izaias?.matches).toHaveLength(1);
    expect(izaias?.matches[0].difference).toBe(0);
  });

  it("leaves a materials expense off the match list and preselects the newest labor match", async () => {
    const rows = [entry({ id: "o1", sub_id: "w1", job_id: "j1", work_date: "2026-09-21", days: 1, day_rate: 200 })];
    const { env } = payDb(rows, [
      { id: "lumber", sub_id: "w1", job_id: "j1", amount: 500, expense_type: "material", incurred_date: "2026-09-25", vendor: "Lowe's", description: "deck boards" },
      { id: "labor-new", sub_id: "w1", job_id: "j1", amount: 200, expense_type: "labor", incurred_date: "2026-09-24", vendor: "ZZ A", description: "day labor" },
      { id: "sub-old", sub_id: "w1", job_id: "j1", amount: 150, expense_type: "subcontractor", incurred_date: "2026-09-22", vendor: "ZZ A", description: "paid outside" },
    ]);
    const res = await handleLaborPayable(
      authed("https://app.example/api/labor/payable?pay_date=2026-10-02", undefined, "GET"),
      env,
    );
    const body = (await res.json()) as {
      overlaps: { match: { expense_id: string; expense_type: string } | null; matches: { expense_id: string; expense_type: string }[] }[];
    };
    const group = body.overlaps[0];
    expect(group.matches.map((match) => match.expense_id)).toEqual(["labor-new", "sub-old"]);
    expect(group.matches.some((match) => match.expense_type === "material")).toBe(false);
    expect(group.match?.expense_id).toBe("labor-new");
    expect(group.match?.expense_type).toBe("labor");
  });

  it("soft-deletes an unpaid day and records the reason", async () => {
    const state = payDb([entry({ id: "o1", sub_id: "w1", job_id: "j1", work_date: "2026-09-21", days: 1, day_rate: 200 })]);
    const res = await handleLaborEntryDelete(
      authed("https://app.example/api/labor/entries/o1", { delete_reason: "logged on the wrong job" }, "DELETE"),
      state.env,
      "o1",
    );
    expect(res.status).toBe(200);
    const update = state.inserts.find((row) => row.sql.startsWith("UPDATE labor_entries"));
    expect(update?.sql).toContain("deleted_at");
    expect(update?.sql).not.toContain("DELETE FROM");
    expect(update?.args).toContain("logged on the wrong job");
    const audit = state.inserts.find((row) => row.sql.includes("audit_logs"));
    expect(audit?.args).toContain("labor_entry_removed");
  });

  it("writes before and after when a day is edited", async () => {
    const state = payDb([entry({ id: "o1", sub_id: "w1", job_id: "j1", work_date: "2026-09-21", days: 1, day_rate: 200 })]);
    const res = await handleLaborEntryUpdate(
      authed("https://app.example/api/labor/entries/o1", { days: 0.5 }, "PUT"),
      state.env,
      "o1",
    );
    expect(res.status).toBe(200);
    const audit = state.inserts.find((row) => row.sql.includes("audit_logs"));
    const details = JSON.parse(String(audit?.args[4]));
    expect(details.before.days).toBe(1);
    expect(details.after.days).toBe(0.5);
    expect(state.inserts.some((row) => row.sql.includes("updated_by"))).toBe(true);
  });

  it("leaves removed days out of week, accrued, dashboard, pay, and statement queries", () => {
    const labor = readFileSync("src/routes/labor.ts", "utf8");
    const costing = readFileSync("src/lib/job-costing.ts", "utf8");
    const reports = readFileSync("src/routes/reports.ts", "utf8");
    const dashboard = readFileSync("src/routes/dashboard.ts", "utf8");
    expect(labor).toContain("const ACTIVE_ENTRY = \"le.deleted_at IS NULL\"");
    expect(costing.match(/deleted_at IS NULL/g)?.length).toBeGreaterThanOrEqual(2);
    expect(reports).toContain("le.deleted_at IS NULL");
    expect(dashboard).toContain("le.deleted_at IS NULL");
    expect(dashboard).toContain("laborUnpaidAggregate");
    expect(dashboard).toContain('id: "labor_payroll_due"');
  });
});

describe("unpaid labor aggregate", () => {
  const weeks = [
    { week_start: "2026-09-14", week_end: "2026-09-20", unpaid: 150 },
    { week_start: "2026-09-21", week_end: "2026-09-27", unpaid: 200 },
  ];

  it("is medium before the oldest payday and high once any week reaches its Friday", () => {
    const early = laborUnpaidAggregate("2026-09-21", [weeks[0]]);
    expect(early?.priority).toBe("medium");
    expect(early?.weeks).toBe(1);
    expect(early?.oldest).toBe("2026-09-14");

    const payday = laborUnpaidAggregate("2026-09-25", [weeks[0]]);
    expect(payday?.priority).toBe("high");
    const later = laborUnpaidAggregate("2026-10-02", weeks);
    expect(later?.priority).toBe("high");
    expect(later?.weeks).toBe(2);
    expect(later?.total).toBe(350);
    expect(later?.oldest).toBe("2026-09-14");
  });
});
