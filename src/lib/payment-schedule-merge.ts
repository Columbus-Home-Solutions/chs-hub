/**
 * Payment schedule merge-field helpers for contract DOCX generation.
 * Amounts use the same rules as shapePayment() / public-quote payment_schedule.
 */

import { formatCurrency } from "./document-generator.js";

export interface PaymentScheduleRow {
  description: string | null;
  percentage: number | null;
  fixed_amount: number | null;
  amount: number | null;
  trigger: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Dollar amount for one milestone (percentage × total when amount not stored). */
export function milestoneAmount(row: PaymentScheduleRow, total: number): number {
  if (row.fixed_amount != null) return round2(row.fixed_amount);
  if (row.percentage != null) return round2((row.percentage / 100) * total);
  return round2(row.amount ?? 0);
}

/** Human-readable due date for the contract payment schedule table. */
export function formatMilestoneDueDate(
  trigger: string | null,
  description: string | null,
): string {
  if (trigger === "contract_signing") return "At contract signing";
  if (trigger === "completion") return "Upon completion";
  if (trigger === "trade_completion") return "Upon trade completion";
  if (trigger === "bi_weekly_cycle") return "Per billing cycle";
  if (trigger === "milestone") {
    const d = (description ?? "").toLowerCase();
    if (d.includes("completion") || d.includes("final")) return "Upon completion";
    return "At project milestone";
  }
  const paren = description?.match(/\(\s*due\s+([^)]+)\)/i);
  if (paren) {
    const phrase = paren[1].trim();
    return phrase.charAt(0).toUpperCase() + phrase.slice(1);
  }
  return "";
}

/** Merge fields payment_1_amount … payment_5_due for the service agreement table. */
export function paymentScheduleMergeFields(
  schedule: PaymentScheduleRow[],
  total: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < 5; i++) {
    const n = i + 1;
    const row = schedule[i];
    out[`payment_${n}_amount`] = row ? formatCurrency(milestoneAmount(row, total)) : "";
    out[`payment_${n}_due`] = row ? formatMilestoneDueDate(row.trigger, row.description) : "";
  }
  return out;
}
