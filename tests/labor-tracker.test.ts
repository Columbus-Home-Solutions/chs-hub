import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleLaborBatchPay, handleLaborEntryCreate, handleLaborStatements } from "../src/routes/labor.js";
import { handleJobRevenue } from "../src/routes/reports.js";
import { jobFinancialDeleteBlock } from "../src/lib/cascade-delete.js";
import { handleSubcontractorDelete } from "../src/routes/subcontractors.js";
import { buildJobCosting } from "../src/lib/job-costing.js";
import { childActive, SIDEBAR_NAV } from "../frontend/src/lib/sidebar-nav";
import { to } from "../frontend/src/lib/nav";
import {
  centralDate,
  isWeekClosed,
  laborPayrollSignal,
  payDateForWeek,
  weekBounds,
} from "../shared/labor-week";

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

describe("labor week calendar", () => {
  it("puts Sunday in the week that ends that day and Monday in the next week", () => {
    expect(weekBounds("2026-09-27")).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(weekBounds("2026-09-28")).toEqual({ start: "2026-09-28", end: "2026-10-04" });
    expect(payDateForWeek("2026-09-27")).toBe("2026-10-02");
  });

  it("uses Central time at the midnight boundary", () => {
    // 04:59Z is still Oct 4 in Chicago (CDT, UTC-5). 05:00Z is Oct 5.
    expect(centralDate(new Date("2026-10-05T04:59:00Z"))).toBe("2026-10-04");
    expect(centralDate(new Date("2026-10-05T05:00:00Z"))).toBe("2026-10-05");
    expect(weekBounds(centralDate(new Date("2026-10-05T04:59:00Z"))).end).toBe("2026-10-04");
    expect(weekBounds(centralDate(new Date("2026-10-05T05:00:00Z"))).start).toBe("2026-10-05");
  });

  it("refuses to close a week on its Sunday and allows it the next day", () => {
    expect(isWeekClosed("2026-10-04", "2026-10-04")).toBe(false);
    expect(isWeekClosed("2026-10-04", "2026-10-05")).toBe(true);
  });
});

describe("labor payroll action item", () => {
  const entries = [
    { work_date: "2026-09-21", sub_id: "a", days: 1, day_rate: 200 },
    { work_date: "2026-09-22", sub_id: "b", days: 0.5, day_rate: 150 },
  ];

  it("appears for the most recent closed unpaid week and is high on payday", () => {
    const signal = laborPayrollSignal("2026-10-02", entries, []);
    expect(signal?.week_start).toBe("2026-09-21");
    expect(signal?.total).toBe(275);
    expect(signal?.workers).toBe(2);
    expect(signal?.priority).toBe("high");
    expect(signal?.pay_date).toBe("2026-10-02");
  });

  it("stays medium before payday and clears after the batch is paid", () => {
    expect(laborPayrollSignal("2026-09-28", entries, [])?.priority).toBe("medium");
    expect(laborPayrollSignal("2026-10-02", entries, ["2026-09-21"])).toBeNull();
  });
});

describe("labor entry create", () => {
  it("rejects a worker with no day rate and no override", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("FROM users")) return USER;
              if (sql.includes("FROM subcontractors")) {
                return {
                  id: "w1",
                  company_name: "ZZ No Rate",
                  company: null,
                  contact_name: null,
                  primary_contact: null,
                  day_rate: null,
                  is_active: 1,
                  worker_type: "day_rate_labor",
                };
              }
              return null;
            },
          };
        },
      },
    } as unknown as Env;

    const res = await handleLaborEntryCreate(
      authed("https://app.example/api/labor/entries", {
        sub_id: "w1",
        entries: [{ job_id: "j1", work_date: "2026-09-21", days: 1 }],
      }),
      env,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("Set a day rate for this worker or enter one");
  });

  it("saves more than one day and returns a warning", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("FROM users")) return USER;
              if (sql.includes("FROM subcontractors")) {
                return {
                  id: "w1",
                  company_name: "ZZ A",
                  company: null,
                  contact_name: null,
                  primary_contact: null,
                  day_rate: 200,
                  is_active: 1,
                  worker_type: "day_rate_labor",
                };
              }
              if (sql.includes("FROM jobs")) return { id: "j1" };
              if (sql.includes("SUM(days)")) return { days: 1.5 };
              return null;
            },
            async run() {
              return { success: true };
            },
          };
        },
      },
    } as unknown as Env;

    const res = await handleLaborEntryCreate(
      authed("https://app.example/api/labor/entries", {
        sub_id: "w1",
        day_rate: 180,
        entries: [{ job_id: "j1", work_date: "2026-09-21", days: 1 }],
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warnings: string[]; ids: string[] };
    expect(body.ids).toHaveLength(1);
    expect(body.warnings[0]).toContain("more than 1 day");
    expect(body.warnings[0]).toContain("2026-09-21");
  });
});

describe("mark labor batch paid", () => {
  function payEnv(opts: { closedToday?: boolean; existing?: boolean; handExpense?: boolean }) {
    const entries = [
      { id: "e1", sub_id: "w1", job_id: "j1", days: 1, day_rate: 200, company_name: "ZZ A", company: null, contact_name: null, primary_contact: null, job_number: 101, title: "Pergola" },
      { id: "e2", sub_id: "w1", job_id: "j1", days: 1, day_rate: 200, company_name: "ZZ A", company: null, contact_name: null, primary_contact: null, job_number: 101, title: "Pergola" },
      { id: "e3", sub_id: "w2", job_id: "j2", days: 0.5, day_rate: 150, company_name: "ZZ B", company: null, contact_name: null, primary_contact: null, job_number: 102, title: "Kitchen" },
    ];
    const expenses: Record<string, unknown>[] = opts.handExpense
      ? [{ id: "hand-1", sub_id: "w1", job_id: "j1", amount: 400, expense_type: "labor" }]
      : [];
    const batches: Record<string, unknown>[] = opts.existing
      ? [{ id: "batch-old", week_start: "2026-09-21", total: 1, paid_at: "2026-10-02" }]
      : [];
    const updates: { id: string; batch_id: string; expense_id: string | null }[] = [];

    const env = {
      DB: {
        prepare(sql: string) {
          return {
            _args: [] as unknown[],
            bind(...args: unknown[]) {
              this._args = args;
              return this;
            },
            async first() {
              if (sql.includes("FROM users")) return USER;
              if (sql.includes("FROM labor_pay_batches")) {
                return batches.find((b) => b.week_start === this._args[0]) ?? null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM labor_entries")) return { results: entries };
              if (sql.includes("FROM expenses")) return { results: expenses };
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
        async batch(statements: { _args: unknown[]; _sql?: string }[]) {
          // The route's prepared statements close over SQL via prepare(); re-read by calling
          // batch with the same objects. We inspect binds from a parallel recorder below.
          void statements;
        },
      },
    } as unknown as Env & { __state?: unknown };

    const recorded: { sql: string; args: unknown[] }[] = [];
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      const stmt = realPrepare(sql) as {
        _args: unknown[];
        bind: (...args: unknown[]) => unknown;
      };
      const origBind = stmt.bind.bind(stmt);
      stmt.bind = (...args: unknown[]) => {
        origBind(...args);
        return stmt;
      };
      const wrapped = stmt as unknown as { run: () => Promise<unknown>; _args: unknown[] };
      const origRun = wrapped.run?.bind(wrapped);
      if (origRun) {
        wrapped.run = async () => {
          recorded.push({ sql, args: wrapped._args });
          return origRun();
        };
      }
      return stmt as ReturnType<Env["DB"]["prepare"]>;
    };
    env.DB.batch = async (statements) => {
      for (const statement of statements as unknown as { _args: unknown[] }[]) {
        const sql = (statement as { _sql?: string })._sql ?? "";
        void sql;
      }
      // Re-execute by walking recorded binds is unreliable because prepare's SQL
      // is not stored on the statement. Capture SQL in prepare instead.
      return [];
    };

    // Store SQL on each statement from prepare.
    env.DB.prepare = (sql: string) => {
      const stmt = {
        _sql: sql,
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async first() {
          if (sql.includes("FROM users")) return USER;
          if (sql.includes("FROM labor_pay_batches")) {
            return batches.find((b) => b.week_start === this._args[0]) ?? null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM labor_entries")) return { results: entries };
          if (sql.includes("FROM expenses")) return { results: expenses };
          return { results: [] };
        },
        async run() {
          recorded.push({ sql, args: this._args });
          return { success: true };
        },
      };
      return stmt as unknown as ReturnType<Env["DB"]["prepare"]>;
    };
    env.DB.batch = async (statements) => {
      for (const statement of statements as unknown as {
        _sql: string;
        _args: unknown[];
        run: () => Promise<unknown>;
      }[]) {
        recorded.push({ sql: statement._sql, args: statement._args });
        if (statement._sql.startsWith("INSERT INTO expenses")) {
          expenses.push({
            id: statement._args[0],
            job_id: statement._args[1],
            amount: statement._args[2],
            description: statement._args[3],
            incurred_date: statement._args[5],
            vendor: statement._args[7],
            expense_type: "labor",
            tax_category: "labor",
            is_1099_reportable: 1,
            sub_id: statement._args[8],
            entered_via: "auto",
            pushed_to_qbo: 0,
          });
        }
        if (statement._sql.startsWith("INSERT INTO labor_pay_batches")) {
          batches.push({
            id: statement._args[0],
            week_start: statement._args[1],
            total: statement._args[4],
            pay_date: statement._args[3],
            paid_at: "2026-10-02",
          });
        }
        if (statement._sql.startsWith("UPDATE labor_entries")) {
          updates.push({
            batch_id: String(statement._args[0]),
            expense_id: (statement._args[1] as string | null) ?? null,
            id: String(statement._args[2]),
          });
        }
      }
      return [];
    };

    return { env, expenses, batches, updates, recorded, entries };
  }

  it("rejects an open week", async () => {
    const { env } = payEnv({});
    const real = centralDate;
    void real;
    // Force an open week by paying the current week starting this Monday.
    const { start } = weekBounds(centralDate());
    const res = await handleLaborBatchPay(
      authed(`https://app.example/api/labor/batches/${start}/pay`, {}),
      env,
      start,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("week_open");
  });

  it("creates one labor expense per worker per job and does nothing the second time", async () => {
    const state = payEnv({});
    const first = await handleLaborBatchPay(
      authed("https://app.example/api/labor/batches/2026-09-21/pay", { pay_date: "2026-10-02" }),
      state.env,
      "2026-09-21",
    );
    expect(first.status).toBe(200);
    const created = (await first.json()) as {
      created: boolean;
      batch: { total: number; pay_date: string };
      expenses: { amount: number; sub_id: string; job_id: string }[];
    };
    expect(created.created).toBe(true);
    expect(created.batch.total).toBe(475);
    expect(created.batch.pay_date).toBe("2026-10-02");
    expect(created.expenses).toHaveLength(2);
    const pergola = created.expenses.find((row) => row.job_id === "j1");
    const kitchen = created.expenses.find((row) => row.job_id === "j2");
    expect(pergola?.amount).toBe(400);
    expect(kitchen?.amount).toBe(75);
    const inserted = state.expenses.filter((row) => row.entered_via === "auto");
    expect(inserted).toHaveLength(2);
    for (const row of inserted) {
      expect(row.expense_type).toBe("labor");
      expect(row.is_1099_reportable).toBe(1);
      expect(row.pushed_to_qbo).toBe(0);
      expect(row.tax_category).toBe("labor");
      expect(row.incurred_date).toBe("2026-10-02");
      expect(row.sub_id).toBeTruthy();
    }
    expect(state.updates).toHaveLength(3);
    expect(state.updates.every((row) => row.batch_id && row.expense_id)).toBe(true);

    const second = await handleLaborBatchPay(
      authed("https://app.example/api/labor/batches/2026-09-21/pay", {}),
      state.env,
      "2026-09-21",
    );
    const again = (await second.json()) as { created: boolean };
    expect(again.created).toBe(false);
    expect(state.expenses.filter((row) => row.entered_via === "auto")).toHaveLength(2);
  });

  it("skips a duplicate group instead of creating a second expense, and creates one when not skipped", async () => {
    const skipped = payEnv({ handExpense: true });
    const res = await handleLaborBatchPay(
      authed("https://app.example/api/labor/batches/2026-09-21/pay", {
        pay_date: "2026-10-02",
        skip: [{ sub_id: "w1", job_id: "j1" }],
      }),
      skipped.env,
      "2026-09-21",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { expenses: { job_id: string; amount: number }[]; batch: { total: number } };
    expect(body.expenses.map((row) => row.job_id)).toEqual(["j2"]);
    expect(body.batch.total).toBe(75);
    expect(skipped.expenses.filter((row) => row.entered_via === "auto")).toHaveLength(1);
    const linked = skipped.updates.filter((row) => row.id === "e1" || row.id === "e2");
    expect(linked.every((row) => row.expense_id === "hand-1")).toBe(true);

    const fresh = payEnv({ handExpense: true });
    const unskipped = await handleLaborBatchPay(
      authed("https://app.example/api/labor/batches/2026-09-21/pay", { pay_date: "2026-10-02", skip: [] }),
      fresh.env,
      "2026-09-21",
    );
    const created = (await unskipped.json()) as { expenses: { job_id: string }[] };
    expect(created.expenses.map((row) => row.job_id).sort()).toEqual(["j1", "j2"]);
  });
});

describe("accrued labor in job costing", () => {
  function costingEnv(accrued: number, expenseAmount: number) {
    return {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("estimate_id FROM jobs")) return { estimate_id: null };
              if (sql.includes("FROM labor_entries")) return { v: accrued };
              return null;
            },
            async all() {
              if (sql.includes("FROM expenses")) {
                return expenseAmount
                  ? { results: [{ amount: expenseAmount, expense_type: "labor", align: null }] }
                  : { results: [] };
              }
              if (sql.includes("FROM time_entries")) return { results: [] };
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;
  }

  it("counts unpaid days immediately and replaces them with the expense after pay, same total", async () => {
    const before = await buildJobCosting(costingEnv(400, 0), "job-1");
    expect(before.accrued_labor).toBe(400);
    expect(before.totals.actual).toBe(400);

    const after = await buildJobCosting(costingEnv(0, 400), "job-1");
    expect(after.accrued_labor).toBe(0);
    expect(after.totals.actual).toBe(400);
    expect(after.unallocated).toBe(400);
  });
});

describe("statements, no-costs flag, and job delete guard", () => {
  it("returns statement totals and never includes an SSN field", async () => {
    const row = {
      id: "e1",
      sub_id: "w1",
      job_id: "j1",
      work_date: "2026-09-21",
      days: 1,
      day_rate: 200,
      notes: null,
      batch_id: null,
      expense_id: null,
      company_name: "ZZ A",
      company: null,
      contact_name: null,
      primary_contact: null,
      worker_day_rate: 200,
      job_number: 101,
      title: "Pergola",
      property_address: "2511 Lilac",
    };
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("FROM users")) return USER;
              return null;
            },
            async all() {
              if (sql.includes("FROM labor_entries")) return { results: [row, { ...row, id: "e2", days: 0.5, work_date: "2026-09-22" }] };
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;
    const res = await handleLaborStatements(
      authed("https://app.example/api/labor/week/2026-09-21/statements", undefined, "GET"),
      env,
      "2026-09-21",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      statements: { name: string; days: number; total: number; lines: { amount: number }[] }[];
    };
    const text = JSON.stringify(body).toLowerCase();
    expect(text).not.toContain("ssn");
    expect(text).not.toContain("tax_id");
    expect(body.statements).toHaveLength(1);
    expect(body.statements[0].name).toBe("ZZ A");
    expect(body.statements[0].days).toBe(1.5);
    expect(body.statements[0].total).toBe(300);
    expect(body.statements[0].lines.reduce((sum, line) => sum + line.amount, 0)).toBe(300);
  });

  it("treats accrued labor as costs logged when no expenses exist", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("FROM users")) return USER;
              return null;
            },
            async all() {
              if (sql.includes("accrued_labor")) {
                return {
                  results: [
                    {
                      id: "job-1",
                      job_number: 101,
                      title: "Pergola",
                      client_name: "ZZ Client",
                      contract_total: 1000,
                      status: "in_progress",
                      completed_date: null,
                      total_collected: 0,
                      total_expenses: 0,
                      time_entry_labor: 0,
                      accrued_labor: 400,
                    },
                  ],
                };
              }
              return { results: [] };
            },
          };
        },
      },
    } as unknown as Env;
    const res = await handleJobRevenue(
      authed("https://app.example/api/reports/job-revenue?year=2026", undefined, "GET"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: { costs_logged: string; total_expenses: number }[] };
    expect(body.jobs[0].costs_logged).toBe("yes");
    expect(body.jobs[0].total_expenses).toBe(0);
  });

  it("blocks deleting a real job that has labor entries", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("FROM clients")) return { is_test: 0 };
              if (sql.includes("open_invoices")) return { open_invoices: 0, payments: 0 };
              if (sql.includes("FROM labor_entries")) return { n: 3 };
              return null;
            },
          };
        },
      },
    } as unknown as Env;
    const message = await jobFinancialDeleteBlock(env, "job-1", "client-1");
    expect(message).toContain("labor days");
  });
});

describe("labor delete guard and nav", () => {
  it("blocks deleting a worker who has labor entries", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("FROM users")) return USER;
              if (sql.includes("FROM subcontractors WHERE")) {
                return {
                  id: "w1",
                  company_name: "ZZ A",
                  company: null,
                  contact_name: null,
                  primary_contact: null,
                  worker_type: "day_rate_labor",
                };
              }
              if (sql.includes("labor_entries")) return { labor_entries: 2, expenses: 0 };
              return null;
            },
            async run() {
              throw new Error("should not delete");
            },
          };
        },
      },
    } as unknown as Env;
    const res = await handleSubcontractorDelete(
      authed("https://app.example/api/subcontractors/w1", undefined, "DELETE"),
      env,
      "w1",
    );
    expect(res.status).toBe(409);
  });

  it("highlights Financial → Labor Tracker only on that tab and the statement", () => {
    const financial = SIDEBAR_NAV.find((section) => section.id === "financial")!;
    const labor = financial.children!.find((child) => child.label === "Labor Tracker")!;
    const pricing = financial.children!.find((child) => child.label === "Pricing Intelligence")!;
    const people = SIDEBAR_NAV.find((section) => section.id === "people")!;
    const roster = people.children!.find((child) => child.label === "Labor")!;
    const subs = people.children!.find((child) => child.label === "Subs")!;

    expect(childActive(labor, to("/financial"), "tab=labor")).toBe(true);
    expect(childActive(pricing, to("/financial"), "tab=labor")).toBe(false);
    expect(childActive(labor, to("/financial/labor/statement"), "week=2026-09-21")).toBe(true);
    expect(childActive(roster, to("/financial"), "tab=labor")).toBe(false);
    expect(childActive(roster, to("/labor"), "")).toBe(true);
    expect(childActive(subs, to("/labor"), "")).toBe(false);
    expect(childActive(labor, to("/labor"), "")).toBe(false);
  });
});
