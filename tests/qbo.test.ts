import { describe, expect, it } from "vitest";
import { buildQboPayment, buildQboPurchase } from "../src/lib/qbo-sync.js";
import { decryptToken, encryptToken } from "../src/lib/qbo-auth.js";
import type { Env } from "../src/env.js";

// Minimal Env stub — only the QBO encryption key is needed for these tests.
const env = { QBO_TOKEN_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;

describe("buildQboPayment", () => {
  it("links the payment to its QBO invoice and carries the gross amount (convenience fee = income)", () => {
    const p = buildQboPayment({
      id: "p1",
      amount: 1035, // 1000 + 35 convenience fee; the full gross is income
      invoice_id: "inv1",
      qbo_customer_id: "QBO-CUST-1",
      qbo_invoice_id: "QBO-INV-9",
    });
    expect(p.CustomerRef).toEqual({ value: "QBO-CUST-1" });
    expect(p.TotalAmt).toBe(1035);
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
    });
    expect(p.Line).toBeUndefined();
    expect(p.TotalAmt).toBe(500);
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
