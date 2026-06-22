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
