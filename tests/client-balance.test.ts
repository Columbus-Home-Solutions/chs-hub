import { describe, expect, it } from "vitest";
import { clientInvoiceBalance } from "../frontend/src/views/clients/client-balance.ts";

describe("client page balance", () => {
  it("does not count a void invoice, so Ian Hawk's $600 void is not owed", () => {
    const { balance, collected } = clientInvoiceBalance(
      [
        { id: "paid-work", total: 52706.47, total_due: null, amount: null, status: "paid" },
        { id: "job-75", total: 600, total_due: null, amount: null, status: "void" },
      ],
      [{ invoice_id: "paid-work", amount: 52706.47 }],
    );
    expect(balance).toBe(0);
    expect(collected).toBe(52706.47);
  });

  it("still counts an open invoice and keeps a bad-debt remainder as a write-off", () => {
    const { balance, writtenOff, collected } = clientInvoiceBalance(
      [
        { id: "open", total: 850, total_due: null, amount: null, status: "past_due" },
        { id: "debt", total: 1300, total_due: null, amount: null, status: "bad_debt" },
        { id: "voided", total: 600, total_due: null, amount: null, status: "VOID" },
      ],
      [{ invoice_id: "open", amount: 0 }],
    );
    expect(balance).toBe(850);
    expect(writtenOff).toBe(1300);
    expect(collected).toBe(0);
  });
});
