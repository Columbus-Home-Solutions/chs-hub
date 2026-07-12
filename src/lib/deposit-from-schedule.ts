/**
 * Deposit amount for quotes, Stripe, and send-gates — sourced from the first
 * is_deposit milestone in payment_schedules (not estimates.deposit_amount).
 */

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ScheduleDepositRow {
  is_deposit?: number | boolean | null;
  fixed_amount?: number | null;
  percentage?: number | null;
  amount?: number | null;
}

export function depositFromSchedule(rows: ScheduleDepositRow[], total: number): number {
  const dep = rows.find((p) => p.is_deposit === true || p.is_deposit === 1);
  if (!dep) return 0;
  if (dep.fixed_amount != null) return round2(dep.fixed_amount);
  if (dep.percentage != null) return round2((dep.percentage / 100) * total);
  return round2(dep.amount ?? 0);
}

export function isPerLineItemBilling(billingModel: string | null | undefined): boolean {
  return billingModel === "per_line_item";
}
