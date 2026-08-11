import { describe, expect, it } from "vitest";
import {
  buildQboPayment,
  buildQboPurchase,
  isJobberExcludedInvoice,
  isJobberExcludedPayment,
  resolveInvoiceTxnDate,
  resolvePaymentAccountId,
  resolvePaymentTxnDate,
  resolveQboCustomerId,
} from "../src/lib/qbo-sync.js";
import { decryptToken, encryptToken } from "../src/lib/qbo-auth.js";
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
