import type { Estimate, PaymentMilestone } from "../types";

export type MilestoneDraft = {
  sort_order: number;
  description: string;
  percentage: number | null;
  fixed_amount: number | null;
  is_deposit: boolean;
  trigger: string | null;
};

export function depositFromSchedule(estimate: Estimate): number {
  const dep = estimate.payment_schedule.find((p) => p.is_deposit);
  if (!dep) return 0;
  if (dep.fixed_amount != null) return dep.fixed_amount;
  if (dep.percentage != null) return Math.round(((dep.percentage / 100) * estimate.total) * 100) / 100;
  return dep.amount ?? 0;
}

export function defaultDepositAmount(total: number, billingModel?: string | null): number {
  const pct = billingModel === "fifty_fifty" ? 0.5 : 0.33;
  return Math.round(total * pct * 100) / 100;
}

/** Deposit due at signing — from schedule milestones or standalone `deposit_amount` for per_line_item. */
export function effectiveDeposit(estimate: Estimate): number {
  if (isPerLineItemBilling(estimate.billing_model)) {
    return estimate.deposit_amount ?? 0;
  }
  return depositFromSchedule(estimate);
}

export function isCostPlusSchedule(estimate: Estimate): boolean {
  const contract = estimate.contract_template_id ?? "standard_service_agreement";
  return contract === "cost_plus_billing_agreement" || estimate.billing_model === "cost_plus";
}

export function isPerLineItemBilling(billingModel: string | null | undefined): boolean {
  return billingModel === "per_line_item";
}

/** Standard default written when "Require deposit" is checked on Pay-As-Completed. */
export const PER_LINE_ITEM_DEFAULT_DEPOSIT_PERCENT = 33;

export type DepositFlagFields = {
  deposit_amount: number | null;
  deposit_type: string | null;
  deposit_percentage: number | null;
};

function percentageIsSet(percentage: number | null | undefined): boolean {
  return percentage != null && Number.isFinite(percentage);
}

/**
 * Pay-As-Completed "Require deposit".
 * Checked when a percentage is stored or the dollar amount is above $0.
 * A $0 amount with a stored percentage stays checked.
 */
export function requireDepositChecked(row: {
  deposit_amount?: number | null;
  deposit_percentage?: number | null;
}): boolean {
  return percentageIsSet(row.deposit_percentage) || (row.deposit_amount ?? 0) > 0;
}

export function enableDepositPatch(total: number): DepositFlagFields {
  return {
    deposit_amount: defaultDepositAmount(total, "per_line_item"),
    deposit_type: "percentage",
    deposit_percentage: PER_LINE_ITEM_DEFAULT_DEPOSIT_PERCENT,
  };
}

export function clearDepositPatch(): DepositFlagFields {
  return {
    deposit_amount: 0,
    deposit_type: "fixed",
    deposit_percentage: null,
  };
}

/**
 * A typed amount becomes a fixed dollar deposit and leaves `deposit_percentage`
 * as it was. Typing $0 does not uncheck the box when a percentage is still set.
 * Recalculation on later price changes only runs while `deposit_type` is
 * "percentage", so a typed $0 stops tracking the percentage.
 */
export function applyTypedDeposit<T extends DepositFlagFields>(row: T, amount: number): T {
  return { ...row, deposit_amount: amount, deposit_type: "fixed" };
}

export function depositEnabledToast(total: number): string {
  if (defaultDepositAmount(total, "per_line_item") > 0) return "Deposit enabled";
  return `Deposit enabled. It will be ${PER_LINE_ITEM_DEFAULT_DEPOSIT_PERCENT}% once line items are priced.`;
}

/**
 * Shown under a checked $0 amount.
 * Percentage deposits explain that the dollars fill in when lines are priced.
 * A fixed $0 does not. Unchecked (no percentage, amount $0) shows nothing.
 */
export function depositZeroNote(row: {
  deposit_amount?: number | null;
  deposit_type?: string | null;
  deposit_percentage?: number | null;
}): string | null {
  if ((row.deposit_amount ?? 0) > 0) return null;
  if (!requireDepositChecked(row)) return null;
  if (row.deposit_type === "percentage" && percentageIsSet(row.deposit_percentage)) {
    const pct = row.deposit_percentage as number;
    const label = String(Math.round(pct * 100) / 100);
    return `Deposit will be ${label}% once line items are priced`;
  }
  if (row.deposit_type === "fixed") return "Deposit set to $0";
  return null;
}

export function buildDefaultMilestones(estimate: Estimate): MilestoneDraft[] {
  if (isPerLineItemBilling(estimate.billing_model)) {
    return [];
  }

  if (isCostPlusSchedule(estimate)) {
    return [
      {
        sort_order: 0,
        description: "Deposit (due before work begins)",
        percentage: null,
        fixed_amount: 0,
        is_deposit: true,
        trigger: "contract_signing",
      },
    ];
  }

  if (estimate.billing_model === "fifty_fifty") {
    return [
      {
        sort_order: 0,
        description: "Deposit (due before work begins)",
        percentage: 50,
        fixed_amount: null,
        is_deposit: true,
        trigger: "contract_signing",
      },
      {
        sort_order: 1,
        description: "Final Payment (due upon completion)",
        percentage: 50,
        fixed_amount: null,
        is_deposit: false,
        trigger: "milestone",
      },
    ];
  }

  const contract = estimate.contract_template_id ?? "standard_service_agreement";
  const isStandard =
    contract === "standard_service_agreement" || estimate.billing_model === "fixed_price";
  if (isStandard) {
    return [
      {
        sort_order: 0,
        description: "Deposit (due before work begins)",
        percentage: 33,
        fixed_amount: null,
        is_deposit: true,
        trigger: "contract_signing",
      },
      {
        sort_order: 1,
        description: "Progress Payment",
        percentage: 33,
        fixed_amount: null,
        is_deposit: false,
        trigger: "milestone",
      },
      {
        sort_order: 2,
        description: "Final Payment (due upon completion)",
        percentage: 34,
        fixed_amount: null,
        is_deposit: false,
        trigger: "milestone",
      },
    ];
  }

  // Lump sum / no contract (and trade-by-trade fallback).
  return [
    {
      sort_order: 0,
      description: "Deposit (due before work begins)",
      percentage: 50,
      fixed_amount: null,
      is_deposit: true,
      trigger: "contract_signing",
    },
    {
      sort_order: 1,
      description: "Final Payment (due upon completion)",
      percentage: 50,
      fixed_amount: null,
      is_deposit: false,
      trigger: "milestone",
    },
  ];
}

export function scheduleTriggersAutoPopulate(body: Record<string, unknown>): boolean {
  return (
    "billing_model" in body ||
    "contract_template_id" in body ||
    "estimate_mode" in body ||
    "include_contract" in body
  );
}

/** A milestone has real values the user (or auto-populate) configured. */
export function isMilestoneConfigured(p: PaymentMilestone): boolean {
  if (p.percentage != null && p.fixed_amount == null) return true;
  if (p.fixed_amount != null && p.fixed_amount > 0) return true;
  if ((p.amount ?? 0) > 0) return true;
  return false;
}

/**
 * True when the schedule has no configured milestones — includes empty rows left
 * by "+ Add Milestone" (which blocks the old length === 0 check).
 */
export function isScheduleUnconfigured(schedule: PaymentMilestone[]): boolean {
  if (schedule.length === 0) return true;
  return schedule.every((p) => !isMilestoneConfigured(p));
}

/** @deprecated use isScheduleUnconfigured */
export function isPaymentScheduleEmpty(schedule: PaymentMilestone[]): boolean {
  return isScheduleUnconfigured(schedule);
}

type ScheduleAutoPopulateEstimate = Pick<
  Estimate,
  "payment_schedule" | "billing_model" | "contract_template_id" | "status"
>;

/** True when a billing/contract change should replace milestones with model defaults. */
export function billingOrContractChanged(
  body: Record<string, unknown>,
  estimate: ScheduleAutoPopulateEstimate,
): boolean {
  const billingChanged =
    "billing_model" in body &&
    body.billing_model != null &&
    String(body.billing_model) !== String(estimate.billing_model ?? "");

  const contractChanged =
    "contract_template_id" in body &&
    body.contract_template_id != null &&
    String(body.contract_template_id) !==
      String(estimate.contract_template_id ?? "standard_service_agreement");

  return billingChanged || contractChanged;
}

export function shouldAutoPopulateSchedule(
  body: Record<string, unknown>,
  estimate: ScheduleAutoPopulateEstimate,
): boolean {
  if (estimate.status === "sent" || estimate.status === "approved") return false;

  const nextBilling =
    body.billing_model != null ? String(body.billing_model) : estimate.billing_model;
  if (isPerLineItemBilling(nextBilling)) return false;

  // Billing model or contract type always refreshes milestones (draft estimates only).
  if (billingOrContractChanged(body, estimate)) return true;

  return scheduleTriggersAutoPopulate(body) && isScheduleUnconfigured(estimate.payment_schedule);
}

/** Display/calc amount for a milestone (percentage × total when amount not stored). */
export function milestoneAmount(
  p: Pick<PaymentMilestone, "percentage" | "fixed_amount" | "amount">,
  total: number,
): number {
  if (p.fixed_amount != null) return p.fixed_amount;
  if (p.percentage != null) return Math.round(((p.percentage / 100) * total) * 100) / 100;
  return p.amount ?? 0;
}

/** Implied percentage when a milestone uses a fixed dollar amount. */
export function milestonePercentage(fixedAmount: number, total: number): number | null {
  if (total <= 0 || fixedAmount <= 0) return null;
  return Math.round((fixedAmount / total) * 10000) / 100;
}
