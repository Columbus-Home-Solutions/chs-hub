/**
 * Close-job eligibility helpers — billing-model-specific completion checks.
 */

import { invoiceLabel } from "./invoicing.js";

export interface EligibilityCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string | null;
}

export interface CostPlusFinalCycleRow {
  id: string;
  status: string;
  invoice_id: string | null;
  reconciliation_invoice_id: string | null;
  reconciliation_date: string | null;
  cycle_number: number;
}

export interface InvoiceStatusRow {
  id: string;
  invoice_number: number | null;
  status: string;
}

export interface FinalInvoiceRow {
  invoice_number: number | null;
  status: string;
}

/** Fixed Price / Trade-by-trade / per_line_item — paid invoice_type = 'final'. */
export function buildFixedPriceFinalInvoiceCheck(finalRow: FinalInvoiceRow | null): EligibilityCheck {
  const finalPassed = finalRow?.status === "paid";
  return {
    id: "final_invoice_paid",
    label: "Final invoice paid",
    passed: finalPassed,
    detail: !finalRow
      ? "No final invoice found"
      : !finalPassed
        ? `Final invoice ${invoiceLabel(finalRow.invoice_number)} is ${finalRow.status} (not paid)`
        : null,
  };
}

/** Cost-plus — final billing cycle reconciled with both cycle invoices paid. */
export function buildCostPlusFinalCycleCheck(
  finalCycle: CostPlusFinalCycleRow | null,
  invoices: InvoiceStatusRow[],
): EligibilityCheck {
  const base = {
    id: "final_invoice_paid",
    label: "Final billing cycle complete",
  } as const;

  if (!finalCycle) {
    return {
      ...base,
      passed: false,
      detail:
        "No final billing cycle created yet — mark your last cycle as final before closing this job",
    };
  }

  if (finalCycle.status !== "closed" || !finalCycle.reconciliation_date) {
    return {
      ...base,
      passed: false,
      detail: `Final cycle ${finalCycle.cycle_number} must be reconciled before closing this job`,
    };
  }

  if (!finalCycle.invoice_id) {
    return {
      ...base,
      passed: false,
      detail: "Final cycle has not been invoiced yet — generate the upfront invoice first",
    };
  }

  if (!finalCycle.reconciliation_invoice_id) {
    return {
      ...base,
      passed: false,
      detail:
        "Final cycle is reconciled but the remaining 50% has not been invoiced — use Bill Final on the cycle",
    };
  }

  const byId = new Map(invoices.map((i) => [i.id, i]));
  const upfront = byId.get(finalCycle.invoice_id);
  const remaining = byId.get(finalCycle.reconciliation_invoice_id);
  const unpaid: string[] = [];

  if (!upfront || upfront.status !== "paid") {
    unpaid.push(upfront ? invoiceLabel(upfront.invoice_number) : "upfront invoice");
  }
  if (!remaining || remaining.status !== "paid") {
    unpaid.push(remaining ? invoiceLabel(remaining.invoice_number) : "final 50% invoice");
  }

  if (unpaid.length > 0) {
    return {
      ...base,
      passed: false,
      detail: `Final cycle invoice(s) unpaid: ${unpaid.join(", ")}`,
    };
  }

  return { ...base, passed: true, detail: null };
}
