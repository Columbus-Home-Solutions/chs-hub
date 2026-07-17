import { describe, expect, it } from "vitest";
import {
  buildCostPlusFinalCycleCheck,
  buildFixedPriceFinalInvoiceCheck,
} from "../src/lib/close-eligibility.js";
import { invoiceLabel, warrantyExpirationDate } from "../src/lib/invoicing.js";

describe("close job helpers", () => {
  it("formats invoice labels from invoice_number (not a DB column)", () => {
    expect(invoiceLabel(3)).toBe("INV-003");
    expect(invoiceLabel(null)).toBe("INV-000");
  });

  it("computes five-year warranty expiration from completion date", () => {
    const exp = warrantyExpirationDate("2026-01-01");
    const start = new Date("2026-01-01T12:00:00Z");
    const end = new Date(`${exp}T12:00:00Z`);
    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    expect(days).toBe(1825);
  });
});

describe("buildFixedPriceFinalInvoiceCheck", () => {
  it("requires a paid final invoice", () => {
    expect(buildFixedPriceFinalInvoiceCheck(null).passed).toBe(false);
    expect(buildFixedPriceFinalInvoiceCheck(null).detail).toBe("No final invoice found");

    expect(buildFixedPriceFinalInvoiceCheck({ invoice_number: 9, status: "sent" }).passed).toBe(
      false,
    );
    expect(buildFixedPriceFinalInvoiceCheck({ invoice_number: 9, status: "paid" }).passed).toBe(
      true,
    );
  });
});

describe("buildCostPlusFinalCycleCheck", () => {
  const cycle = {
    id: "c1",
    status: "closed",
    invoice_id: "inv-upfront",
    reconciliation_invoice_id: "inv-final",
    reconciliation_date: "2026-07-15",
    cycle_number: 2,
  };

  it("fails when no final cycle exists", () => {
    const check = buildCostPlusFinalCycleCheck(null, []);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("No final billing cycle created yet");
  });

  it("fails when final cycle is not reconciled", () => {
    const check = buildCostPlusFinalCycleCheck(
      { ...cycle, status: "active", reconciliation_date: null },
      [],
    );
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("must be reconciled");
  });

  it("passes when both cycle invoices are paid", () => {
    const check = buildCostPlusFinalCycleCheck(cycle, [
      { id: "inv-upfront", invoice_number: 3, status: "paid" },
      { id: "inv-final", invoice_number: 4, status: "paid" },
    ]);
    expect(check.passed).toBe(true);
  });

  it("fails when remaining 50% invoice is missing", () => {
    const check = buildCostPlusFinalCycleCheck(
      { ...cycle, reconciliation_invoice_id: null },
      [{ id: "inv-upfront", invoice_number: 3, status: "paid" }],
    );
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("remaining 50%");
  });
});
