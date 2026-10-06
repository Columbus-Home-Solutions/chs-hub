import { describe, expect, it } from "vitest";
import { buildClientLedgerRows, clientInvoiceBalance, clientInvoiceJobPath } from "../frontend/src/views/clients/client-balance.ts";

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

  it("renders an imported invoice with a null invoice number and null optional fields", () => {
    const rows = buildClientLedgerRows(
      [
        {
          id: "imported",
          invoice_number: null,
          title: null,
          total: 1200,
          total_due: null,
          amount: null,
          status: "past_due",
          due_date: null,
          created_at: null,
        },
        {
          id: "written-off",
          invoice_number: null,
          title: null,
          total: 400,
          total_due: null,
          amount: null,
          status: "bad_debt",
          due_date: null,
          created_at: null,
        },
      ],
      [
        {
          id: "pay",
          invoice_id: "imported",
          amount: null,
          received_date: null,
          created_at: null,
          invoice_number: null,
        },
      ],
    );
    expect(rows.map((row) => row.kind)).toEqual(["invoice", "invoice", "writeoff", "payment"]);
    expect(rows[0]).toMatchObject({ label: "Invoice", date: null, amount: 1200, status: "past_due" });
    expect(rows.find((row) => row.kind === "writeoff")).toMatchObject({ date: null, amount: 400 });
    expect(rows.find((row) => row.kind === "payment")).toMatchObject({ label: "Payment", date: null, amount: 0 });
  });

  it("does not build a job link when an invoice has no job", () => {
    expect(clientInvoiceJobPath(null)).toBeNull();
    expect(clientInvoiceJobPath(undefined)).toBeNull();
    expect(clientInvoiceJobPath("")).toBeNull();
    expect(clientInvoiceJobPath("  ")).toBeNull();
    expect(clientInvoiceJobPath("Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=")).toBe(
      "/jobs/Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=",
    );
  });
});
