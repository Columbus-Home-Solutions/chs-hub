import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildQboPayment,
  buildQboPurchase,
  expenseSweepSelectSql,
  EXPENSE_SWEEP_LIMIT,
  isExpensePushEligible,
  isJobberExcludedExpense,
  isJobberExcludedInvoice,
  isJobberExcludedPayment,
  JOBBER_PAYMENT_EXCLUSION_SQL,
  isQboExpenseSyncEnabled,
  pickExpenseSweepBatch,
  pushExpenseById,
  runQboSweep,
  SETTING_QBO_EXPENSE_SYNC_ENABLED,
  resolveInvoiceTxnDate,
  resolvePaymentAccountId,
  resolvePaymentTxnDate,
  resolveQboCustomerId,
} from "../src/lib/qbo-sync.js";
import { decryptToken, encryptToken } from "../src/lib/qbo-auth.js";
import { replayDeadLetters } from "../src/lib/ops/dlq.js";
import type { Env } from "../src/env.js";

// Minimal Env stub — only the QBO encryption key is needed for these tests.
const env = { QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;

describe("resolveQboCustomerId", () => {
  it("prefers an explicit per-client mapping over the default", () => {
    expect(resolveQboCustomerId("42", "99")).toBe("42");
  });

  it("falls back to the default when the client has no mapping", () => {
    expect(resolveQboCustomerId(null, "99")).toBe("99");
    expect(resolveQboCustomerId("", "99")).toBe("99");
  });

  it("returns null when neither mapping nor default is set", () => {
    expect(resolveQboCustomerId(null, null)).toBeNull();
    expect(resolveQboCustomerId("", "")).toBeNull();
  });
});

describe("isJobberExcludedPayment", () => {
  it("excludes jobs with data_source=jobber_import regardless of payment id shape", () => {
    expect(
      isJobberExcludedPayment({
        paymentId: "native-uuid-payment",
        jobDataSource: "jobber_import",
      }),
    ).toBe(true);
  });

  it("excludes Jobber GraphQL payment ids even when job data_source is null", () => {
    expect(
      isJobberExcludedPayment({
        paymentId: "Z2lkOi8vSm9iYmVyL1BheW1lbnRSZWNvcmQvMTk4Mzc3MzY0",
        jobDataSource: null,
      }),
    ).toBe(true);
  });

  it("allows native CHS payments on non-Jobber jobs (including null data_source)", () => {
    expect(
      isJobberExcludedPayment({
        paymentId: "a900736b-0efd-44f2-89aa-76fec4155a60",
        jobDataSource: null,
      }),
    ).toBe(false);
    expect(
      isJobberExcludedPayment({
        paymentId: "a900736b-0efd-44f2-89aa-76fec4155a60",
        jobDataSource: "chs",
      }),
    ).toBe(false);
  });

  it("excludes a jobber_import payment even when the job is missing", () => {
    expect(
      isJobberExcludedPayment({
        paymentId: "4f8a1350-0604-4b05-9000-000000009050",
        jobDataSource: null,
        paymentDataSource: "jobber_import",
      }),
    ).toBe(true);
  });

  it("excludes a CHS payment on a Jobber invoice with no job", () => {
    expect(
      isJobberExcludedPayment({
        paymentId: "4f8a1350-0604-4b05-9000-000000009050",
        jobDataSource: null,
        paymentDataSource: null,
        invoiceId: "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTU2MjI0NDgw",
        invoiceDataSource: null,
      }),
    ).toBe(true);
    expect(
      isJobberExcludedPayment({
        paymentId: "native-uuid-payment",
        jobDataSource: null,
        invoiceId: "native-uuid-invoice",
        invoiceDataSource: "jobber_import",
      }),
    ).toBe(true);
  });

  it("keeps the payment sweep SQL on the same exclusion, including orphan invoices", () => {
    expect(JOBBER_PAYMENT_EXCLUSION_SQL).toContain("COALESCE(p.data_source, '') != 'jobber_import'");
    expect(JOBBER_PAYMENT_EXCLUSION_SQL).toContain("COALESCE(i.data_source, '') != 'jobber_import'");
    expect(JOBBER_PAYMENT_EXCLUSION_SQL).toContain("COALESCE(i.id, '') NOT LIKE 'Z2lkOi8vSm9iYmVy%'");
    expect(JOBBER_PAYMENT_EXCLUSION_SQL).toContain("COALESCE(j.data_source, '') != 'jobber_import'");
    const sweep = readFileSync(new URL("../src/lib/qbo-sync.ts", import.meta.url), "utf8");
    const fn = sweep.slice(sweep.indexOf("async function sweepPayments"));
    expect(fn.slice(0, fn.indexOf("async function " , 20))).toContain("JOBBER_PAYMENT_EXCLUSION_SQL");
  });
});

describe("isJobberExcludedInvoice", () => {
  it("excludes jobs with data_source=jobber_import regardless of invoice id shape", () => {
    expect(
      isJobberExcludedInvoice({
        invoiceId: "native-uuid-invoice",
        jobDataSource: "jobber_import",
      }),
    ).toBe(true);
  });

  it("excludes Jobber GraphQL invoice ids even when job_id / data_source is null", () => {
    expect(
      isJobberExcludedInvoice({
        invoiceId: "Z2lkOi8vSm9iYmVyL0ludm9pY2UvMTUwMjM2ODUz",
        jobDataSource: null,
      }),
    ).toBe(true);
  });

  it("excludes invoices.data_source=jobber_import even with a null job", () => {
    expect(
      isJobberExcludedInvoice({
        invoiceId: "native-uuid-invoice",
        jobDataSource: null,
        invoiceDataSource: "jobber_import",
      }),
    ).toBe(true);
  });

  it("allows native CHS invoices on non-Jobber jobs (including null data_source)", () => {
    expect(
      isJobberExcludedInvoice({
        invoiceId: "a900736b-0efd-44f2-89aa-76fec4155a60",
        jobDataSource: null,
      }),
    ).toBe(false);
    expect(
      isJobberExcludedInvoice({
        invoiceId: "a900736b-0efd-44f2-89aa-76fec4155a60",
        jobDataSource: "chs",
      }),
    ).toBe(false);
  });
});

describe("resolvePaymentTxnDate", () => {
  it("prefers received_date over collected_at", () => {
    expect(
      resolvePaymentTxnDate({ received_date: "2025-03-15", collected_at: "2024-01-01" }),
    ).toBe("2025-03-15");
  });

  it("falls back to collected_at date portion when received_date is null", () => {
    expect(resolvePaymentTxnDate({ received_date: null, collected_at: "2024-08-06T12:00:00Z" })).toBe(
      "2024-08-06",
    );
  });
});

describe("resolveInvoiceTxnDate", () => {
  it("prefers sent_date over issued_date and created_at", () => {
    expect(
      resolveInvoiceTxnDate({
        sent_date: "2025-03-15",
        issued_date: "2025-03-01",
        created_at: "2024-01-01",
      }),
    ).toBe("2025-03-15");
  });

  it("falls back to issued_date then created_at", () => {
    expect(
      resolveInvoiceTxnDate({
        sent_date: null,
        issued_date: "2025-04-02T12:00:00Z",
        created_at: "2024-01-01",
      }),
    ).toBe("2025-04-02");
    expect(
      resolveInvoiceTxnDate({
        sent_date: null,
        issued_date: null,
        created_at: "2024-08-06T12:00:00Z",
      }),
    ).toBe("2024-08-06");
  });
});

describe("buildQboPayment", () => {
  it("links the payment to its QBO invoice and carries the gross amount (convenience fee = income)", () => {
    const p = buildQboPayment({
      id: "p1",
      amount: 1035, // 1000 + 35 convenience fee; the full gross is income
      invoice_id: "inv1",
      qbo_customer_id: "QBO-CUST-1",
      qbo_invoice_id: "QBO-INV-9",
      received_date: "2025-06-01",
    });
    expect(p.CustomerRef).toEqual({ value: "QBO-CUST-1" });
    expect(p.TotalAmt).toBe(1035);
    expect(p.TxnDate).toBe("2025-06-01");
    expect(p.PrivateNote).toBe("CHS-PAY:p1");
    expect(p.Line).toEqual([
      { Amount: 1035, LinkedTxn: [{ TxnId: "QBO-INV-9", TxnType: "Invoice" }] },
    ]);
  });

  it("omits LinkedTxn when there is no QBO invoice id", () => {
    const p = buildQboPayment({
      id: "p2",
      amount: 500,
      invoice_id: null,
      qbo_customer_id: "QBO-CUST-2",
      qbo_invoice_id: null,
      collected_at: "2024-02-27",
    });
    expect(p.Line).toBeUndefined();
    expect(p.TotalAmt).toBe(500);
    expect(p.TxnDate).toBe("2024-02-27");
    expect(p.PrivateNote).toBe("CHS-PAY:p2");
  });

  it("sets DepositToAccountRef when a deposit account is provided", () => {
    const p = buildQboPayment(
      {
        id: "p3",
        amount: 100,
        invoice_id: null,
        qbo_customer_id: "QBO-CUST-3",
        qbo_invoice_id: null,
      },
      { depositAccountId: "9" },
    );
    expect(p.DepositToAccountRef).toEqual({ value: "9" });
  });
});

describe("resolvePaymentAccountId", () => {
  it("uses the subcontractor payment account when a QBO Vendor is linked", () => {
    expect(
      resolvePaymentAccountId(
        { sub_id: "s1", qbo_vendor_id: "V1" },
        "EXPENSE-BANK",
        "PAYROLL-BANK",
      ),
    ).toBe("PAYROLL-BANK");
  });

  it("falls back to the default payment account when sub override is blank", () => {
    expect(
      resolvePaymentAccountId({ sub_id: "s1", qbo_vendor_id: "V1" }, "EXPENSE-BANK", ""),
    ).toBe("EXPENSE-BANK");
  });

  it("uses the default when no QBO Vendor is linked, even if override is set", () => {
    expect(
      resolvePaymentAccountId(
        { sub_id: null, qbo_vendor_id: null },
        "EXPENSE-BANK",
        "PAYROLL-BANK",
      ),
    ).toBe("EXPENSE-BANK");
  });
});

describe("buildQboPurchase", () => {
  it("uses the mapped expense account + payment account, and a Vendor EntityRef for sub expenses", () => {
    const purchase = buildQboPurchase(
      { id: "e1", amount: 250, description: "Lumber", expense_type: "materials", sub_id: "s1", qbo_vendor_id: "QBO-VEND-2001" },
      "QBO-ACCT-MAT",
      "QBO-ACCT-BANK",
    );
    expect(purchase.AccountRef).toEqual({ value: "QBO-ACCT-BANK" });
    expect(purchase.EntityRef).toEqual({ value: "QBO-VEND-2001", type: "Vendor" });
    const line = (purchase.Line as Record<string, unknown>[])[0];
    expect(line.Amount).toBe(250);
    expect((line.AccountBasedExpenseLineDetail as Record<string, unknown>).AccountRef).toEqual({ value: "QBO-ACCT-MAT" });
  });

  it("omits EntityRef when the expense has no mapped vendor", () => {
    const purchase = buildQboPurchase(
      { id: "e2", amount: 80, description: "Permit fee", expense_type: "permits", sub_id: null, qbo_vendor_id: null },
      "QBO-ACCT-PERMITS",
      "QBO-ACCT-BANK",
    );
    expect(purchase.EntityRef).toBeUndefined();
  });
});

describe("token encryption at rest — round trip + rotation safety", () => {
  it("encrypts then decrypts back to the original token", async () => {
    const refresh = "AB11906000000VqdfrefreshTokenSample";
    const enc = await encryptToken(env, refresh);
    expect(enc).toBeTruthy();
    expect(enc).not.toBe(refresh);
    expect(enc!.startsWith("v1:")).toBe(true);
    const dec = await decryptToken(env, enc);
    expect(dec).toBe(refresh);
  });

  it("produces distinct ciphertext per call (random IV) but decrypts identically", async () => {
    const a = await encryptToken(env, "same-token");
    const b = await encryptToken(env, "same-token");
    expect(a).not.toBe(b);
    expect(await decryptToken(env, a)).toBe("same-token");
    expect(await decryptToken(env, b)).toBe("same-token");
  });

  it("tolerates legacy plaintext (no v1: prefix) by returning it unchanged", async () => {
    expect(await decryptToken(env, "legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("returns null for null", async () => {
    expect(await encryptToken(env, null)).toBeNull();
    expect(await decryptToken(env, null)).toBeNull();
  });
});

const laborMap = { accountMap: { labor: "71" }, paymentAccountRef: "9", subPaymentAccountRef: "12" };

function expense(partial: Record<string, unknown>) {
  return {
    id: "e1",
    amount: 150,
    description: "day labor",
    expense_type: "labor",
    sub_id: "w1",
    qbo_vendor_id: "V1",
    job_data_source: null,
    incurred_date: "2026-09-21",
    created_at: "2026-09-21T12:00:00Z",
    qbo_transaction_id: null,
    ...partial,
  };
}

describe("isJobberExcludedExpense", () => {
  it("excludes a jobber_import job and a Jobber expense id", () => {
    expect(isJobberExcludedExpense({ expenseId: "native-uuid", jobDataSource: "jobber_import" })).toBe(true);
    expect(
      isJobberExcludedExpense({
        expenseId: "Z2lkOi8vSm9iYmVyL0V4cGVuc2UvMTM0ODg4NzQ=",
        jobDataSource: null,
      }),
    ).toBe(true);
  });

  it("allows a native expense on a non-Jobber job", () => {
    expect(isJobberExcludedExpense({ expenseId: "1e5846d2-a90f-4a57-a309-56478f5eb76e", jobDataSource: null })).toBe(
      false,
    );
  });
});

describe("expense sweep eligibility", () => {
  it("requires a mapped type and a vendor when a worker is attached", () => {
    expect(isExpensePushEligible(expense({}), laborMap)).toBe(true);
    expect(isExpensePushEligible(expense({ qbo_vendor_id: null }), laborMap)).toBe(false);
    expect(isExpensePushEligible(expense({ qbo_vendor_id: "  " }), laborMap)).toBe(false);
    expect(isExpensePushEligible(expense({ expense_type: null, sub_id: null, qbo_vendor_id: null }), laborMap)).toBe(
      false,
    );
    expect(isExpensePushEligible(expense({ expense_type: "office" }), laborMap)).toBe(false);
    expect(isExpensePushEligible(expense({ sub_id: null, qbo_vendor_id: null, expense_type: "labor" }), laborMap)).toBe(
      true,
    );
  });

  it("never treats a Jobber expense as eligible, even when type and vendor are mapped", () => {
    expect(isExpensePushEligible(expense({ job_data_source: "jobber_import" }), laborMap)).toBe(false);
    expect(
      isExpensePushEligible(expense({ id: "Z2lkOi8vSm9iYmVyL0V4cGVuc2UvMTM0ODg4NzQ=", sub_id: null }), laborMap),
    ).toBe(false);
  });

  it("does not let unmapped or historical rows starve an older eligible expense", () => {
    const historical = Array.from({ length: 250 }, (_, i) =>
      expense({
        id: `hist-${String(i).padStart(3, "0")}`,
        expense_type: null,
        sub_id: null,
        qbo_vendor_id: null,
        job_data_source: i < 200 ? "jobber_import" : null,
        incurred_date: null,
        created_at: null,
      }),
    );
    const unmappedWorker = expense({ id: "no-vendor", qbo_vendor_id: null, incurred_date: "2020-01-01" });
    const older = expense({ id: "labor-old", incurred_date: "2026-09-21" });
    const newer = expense({ id: "labor-new", incurred_date: "2026-09-27" });
    const batch = pickExpenseSweepBatch([unmappedWorker, ...historical, newer, older], laborMap);
    expect(batch.map((row) => row.id)).toEqual(["labor-old", "labor-new"]);
    expect(batch.length).toBeLessThanOrEqual(EXPENSE_SWEEP_LIMIT);
  });

  it("selects only eligible rows in the sweep query, oldest first, capped at 200", () => {
    const sql = expenseSweepSelectSql(2);
    expect(sql).toContain("COALESCE(j.data_source, '') != 'jobber_import'");
    expect(sql).toContain("e.id NOT LIKE 'Z2lkOi8vSm9iYmVy%'");
    expect(sql).toContain("e.expense_type IN (?, ?)");
    expect(sql).toContain("e.sub_id IS NULL OR (s.qbo_vendor_id IS NOT NULL AND TRIM(s.qbo_vendor_id) != '')");
    expect(sql).toContain("ORDER BY COALESCE(NULLIF(TRIM(e.incurred_date), ''), substr(e.created_at, 1, 10)) ASC, e.id ASC");
    expect(sql).toContain("LIMIT 200");
    expect(sql).not.toMatch(/LIMIT 200[\s\S]*WHERE/);
  });
});

function qboEnv(settings: Record<string, string | null>, sqlLog: string[] = []) {
  const connection = {
    id: "quickbooks",
    status: "connected",
    access_token: null,
    refresh_token: "refresh-token",
    token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    account_id: "realm",
    configuration: JSON.stringify({
      environment: "sandbox",
      account_map: { labor: "71", material: "70" },
      payment_account_ref: "9",
      subcontractor_payment_account_ref: "12",
    }),
    last_sync: null,
    last_error: null,
  };
  const db = {
    prepare(sql: string) {
      sqlLog.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM integration_connections")) return connection as T;
              if (sql.includes("FROM system_settings") && sql.includes("key = ?")) {
                const key = String(args[0]);
                if (!(key in settings) || settings[key] == null) return null;
                return { value: settings[key] } as T;
              }
              if (sql.includes("FROM expenses")) {
                return {
                  id: "jobber-exp",
                  amount: 20,
                  description: null,
                  expense_type: "labor",
                  sub_id: null,
                  qbo_vendor_id: null,
                  job_data_source: "jobber_import",
                  qbo_transaction_id: null,
                } as T;
              }
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { DB: db, QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;
}

describe("qbo expense go-live gate", () => {
  it("is off unless the setting is exactly true", async () => {
    const missing = qboEnv({});
    expect(await isQboExpenseSyncEnabled(missing)).toBe(false);
    expect(await isQboExpenseSyncEnabled(qboEnv({ [SETTING_QBO_EXPENSE_SYNC_ENABLED]: "false" }))).toBe(false);
    expect(await isQboExpenseSyncEnabled(qboEnv({ [SETTING_QBO_EXPENSE_SYNC_ENABLED]: "true" }))).toBe(true);
  });

  it("skips the expense sweep and writes no dead-letter row when the gate is off", async () => {
    const sqlLog: string[] = [];
    const result = await runQboSweep(
      qboEnv(
        {
          qbo_invoice_sync_enabled: "false",
          qbo_payment_sync_enabled: "false",
          [SETTING_QBO_EXPENSE_SYNC_ENABLED]: "false",
        },
        sqlLog,
      ),
    );
    expect(result.ran).toBe(true);
    expect(result.expenses).toEqual({ pushed: 0, skipped: 0, failed: 0 });
    expect(sqlLog.some((sql) => sql.includes("FROM expenses"))).toBe(false);
    expect(sqlLog.some((sql) => sql.includes("sync_dead_letters"))).toBe(false);
  });

  it("queries only eligible expenses when the gate is on and does not dead-letter an empty batch", async () => {
    const sqlLog: string[] = [];
    const result = await runQboSweep(
      qboEnv(
        {
          qbo_invoice_sync_enabled: "false",
          qbo_payment_sync_enabled: "false",
          [SETTING_QBO_EXPENSE_SYNC_ENABLED]: "true",
        },
        sqlLog,
      ),
    );
    const expenseSql = sqlLog.find((sql) => sql.includes("FROM expenses e"));
    expect(expenseSql).toBeTruthy();
    expect(expenseSql).toContain("jobber_import");
    expect(expenseSql).toContain("e.sub_id IS NULL");
    expect(expenseSql).toContain("ORDER BY");
    expect(expenseSql).toContain("LIMIT 200");
    expect(result.expenses.failed).toBe(0);
    expect(sqlLog.some((sql) => sql.includes("INSERT INTO sync_dead_letters"))).toBe(false);
  });

  it("does not push a Jobber expense when the gate is on", async () => {
    await expect(
      pushExpenseById(qboEnv({ [SETTING_QBO_EXPENSE_SYNC_ENABLED]: "true" }), "jobber-exp"),
    ).rejects.toThrow(/permanently excluded: Jobber-imported/);
  });

  it("resolves an expense DLQ row without inserting another when the gate is off", async () => {
    const sqlLog: string[] = [];
    const envGate = qboEnv({ [SETTING_QBO_EXPENSE_SYNC_ENABLED]: "false" }, sqlLog);
    const db = envGate.DB as unknown as {
      prepare: (sql: string) => {
        bind: (...args: unknown[]) => {
          all: () => Promise<{ results: unknown[] }>;
          first: () => Promise<unknown>;
          run: () => Promise<unknown>;
        };
      };
    };
    const original = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = original(sql);
      return {
        bind(...args: unknown[]) {
          const bound = stmt.bind(...args);
          return {
            all: async () => {
              if (sql.includes("FROM sync_dead_letters") && sql.includes("resolved_at IS NULL")) {
                return {
                  results: [
                    {
                      id: 9,
                      job_name: "qbo_sync",
                      entity_type: "expense",
                      entity_id: "labor-1",
                      payload: "{}",
                      attempts: 1,
                      alerted_at: null,
                    },
                  ],
                };
              }
              return bound.all();
            },
            first: () => bound.first(),
            run: () => bound.run(),
          };
        },
      };
    };
    const replay = await replayDeadLetters(envGate);
    expect(replay.succeeded).toBe(1);
    expect(replay.failed).toBe(0);
    expect(sqlLog.some((sql) => sql.startsWith("INSERT INTO sync_dead_letters"))).toBe(false);
    expect(sqlLog.some((sql) => sql.includes("UPDATE sync_dead_letters") && sql.includes("resolved_at"))).toBe(true);
  });
});
