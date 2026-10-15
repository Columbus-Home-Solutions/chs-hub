import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  buildCompletionPackageData,
  completionFinancialSummary,
  renderCompletionPackageHtml,
} from "../src/lib/completion-package.js";

describe("completion package financial summary", () => {
  it("leaves a job with no change orders unchanged", () => {
    const summary = completionFinancialSummary({
      storedContract: 3300,
      appliedChangeOrders: 0,
      approvedUnappliedChangeOrders: 0,
      totalInvoiced: 3300,
      totalPaid: 1650,
    });
    expect(summary).toEqual({
      contract_total: 3300,
      change_order_total: 0,
      adjusted_total: 3300,
      total_invoiced: 3300,
      total_paid: 1650,
      balance: 1650,
    });
  });

  it("shows a paid-in-full job with one applied change order at a zero balance", () => {
    // Betty Hamilton: original 3300, applied 500, stored 3800, paid 3800.
    const summary = completionFinancialSummary({
      storedContract: 3800,
      appliedChangeOrders: 500,
      approvedUnappliedChangeOrders: 0,
      totalInvoiced: 2150,
      totalPaid: 3800,
    });
    expect(summary.contract_total).toBe(3300);
    expect(summary.change_order_total).toBe(500);
    expect(summary.adjusted_total).toBe(3800);
    expect(summary.total_paid).toBe(3800);
    expect(summary.balance).toBe(0);
  });

  it("includes an approved change order that has not been applied, once", () => {
    const summary = completionFinancialSummary({
      storedContract: 3300,
      appliedChangeOrders: 0,
      approvedUnappliedChangeOrders: 500,
      totalInvoiced: 1650,
      totalPaid: 1650,
    });
    expect(summary.contract_total).toBe(3300);
    expect(summary.change_order_total).toBe(500);
    expect(summary.adjusted_total).toBe(3800);
    expect(summary.balance).toBe(2150);
  });

  it("sums several change orders without adding the applied ones twice", () => {
    const summary = completionFinancialSummary({
      storedContract: 4000,
      appliedChangeOrders: 700,
      approvedUnappliedChangeOrders: 100,
      totalInvoiced: 2000,
      totalPaid: 1000,
    });
    expect(summary.contract_total).toBe(3300);
    expect(summary.change_order_total).toBe(800);
    expect(summary.adjusted_total).toBe(4100);
    expect(summary.balance).toBe(3100);
  });

  it("shows zero when the job is fully paid and the remainder when it is not", () => {
    const paid = completionFinancialSummary({
      storedContract: 3300,
      appliedChangeOrders: 0,
      approvedUnappliedChangeOrders: 0,
      totalInvoiced: 3300,
      totalPaid: 3300,
    });
    expect(paid.balance).toBe(0);
    const partial = completionFinancialSummary({
      storedContract: 3800,
      appliedChangeOrders: 500,
      approvedUnappliedChangeOrders: 0,
      totalInvoiced: 2150,
      totalPaid: 2000,
    });
    expect(partial.adjusted_total).toBe(3800);
    expect(partial.balance).toBe(1800);
  });

  it("does not show a negative balance when payments exceed the adjusted total", () => {
    const summary = completionFinancialSummary({
      storedContract: 3800,
      appliedChangeOrders: 500,
      approvedUnappliedChangeOrders: 0,
      totalInvoiced: 2150,
      totalPaid: 4000,
    });
    expect(summary.balance).toBe(0);
  });
});

describe("completion package data for an applied change order", () => {
  function bettyEnv(): Env {
    const first = async (sql: string) => {
      if (sql.includes("FROM jobs")) {
        return {
          id: "job-betty",
          job_number: 102,
          title: "Hamilton",
          client_id: "c1",
          contract_total: 3800,
          portal_token: "tok",
          property_address: "1 Main",
          property_city: null,
          property_state: null,
          property_zip: null,
          warranty_expiration: null,
          client_name: "Betty Hamilton",
          first_name: "Betty",
          last_name: "Hamilton",
        };
      }
      if (sql.includes("FROM change_orders")) return { applied: 500, unapplied: 0 };
      if (sql.includes("FROM invoices")) return { inv: 2150 };
      if (sql.includes("FROM payments")) return { paid: 3800 };
      if (sql.includes("system_settings")) return { value: "Columbus Home Solutions, LLC" };
      return null;
    };
    return {
      DB: {
        prepare(sql: string) {
          const stmt = {
            first: () => first(sql),
            all: async () => ({ results: [] }),
            bind() {
              return stmt;
            },
          };
          return stmt;
        },
      },
    } as unknown as Env;
  }

  it("renders Betty's package at a zero balance", async () => {
    const data = await buildCompletionPackageData(bettyEnv(), "job-betty");
    expect(data?.financial).toEqual({
      contract_total: 3300,
      change_order_total: 500,
      adjusted_total: 3800,
      total_invoiced: 2150,
      total_paid: 3800,
      balance: 0,
    });
    const html = renderCompletionPackageHtml(data!);
    expect(html).toContain("$3,300.00");
    expect(html).toContain("$500.00");
    expect(html).toContain("$3,800.00");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("$4,300.00");
  });
});
