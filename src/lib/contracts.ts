/**
 * Contract text generation (Sprint 5 — Quote Delivery).
 *
 * On send, an estimate's contract text is rendered from the appropriate
 * template — the Service Agreement (fixed-price / trade-by-trade) or the
 * Cost-Plus Billing Agreement (cost-plus billing model) — with the merge
 * fields populated from the estimate, client, property, payment schedule, and
 * company settings. The rendered text is frozen onto the estimate so the public
 * quote page and the captured signature both reference the exact same words the
 * client agreed to.
 *
 * The templates live here as code (not parsed from the .docx files at runtime —
 * Workers can't read .docx) and mirror the wording in:
 *   public/docs/CHS-Service-Agreement-Template.docx
 *   public/docs/CHS-Cost-Plus-Agreement-Template.docx
 *
 * ⚠️ LEGAL: these templates still need Arkansas attorney review before real
 * client use. They are rendered for the workflow now; do not treat as final.
 */

import type { Env } from "../env.js";

export interface ContractContext {
  client_name: string | null;
  property_address: string | null;
  job_title: string | null;
  total: number;
  deposit_amount: number | null;
  billing_model: string | null;
  payment_schedule_lines: string[];
}

const USD = (n: number | null | undefined): string =>
  n == null
    ? "$0.00"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

const PCT = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;

/** Load the company + fee settings the templates merge in (best-effort defaults). */
async function loadSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM system_settings WHERE key IN (
       'company_name','company_phone','company_email','company_address',
       'labor_rate_general','labor_rate_pm_skilled','pm_fee_rate','contractor_fee_rate'
     )`,
  ).all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const r of results ?? []) map[r.key] = r.value;
  return map;
}

function todayLong(): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Is this estimate billed cost-plus (→ Cost-Plus Agreement, else Service Agreement)? */
export function contractKindFor(billingModel: string | null): "cost_plus" | "service" {
  return billingModel === "cost_plus" ? "cost_plus" : "service";
}

/**
 * Render the contract text for an estimate. Returns the populated agreement as
 * plain text (markdown-ish, matching the template documents).
 */
export async function renderContract(env: Env, ctx: ContractContext): Promise<string> {
  const s = await loadSettings(env);
  const company = s.company_name ?? "Columbus Home Solutions, LLC";
  const phone = s.company_phone ?? "";
  const email = s.company_email ?? "";
  const scheduleBlock =
    ctx.payment_schedule_lines.length > 0
      ? ctx.payment_schedule_lines.map((l) => `  • ${l}`).join("\n")
      : "  • Per the payment schedule in the attached estimate.";

  const client = ctx.client_name ?? "Client";
  const address = ctx.property_address ?? "";
  const title = ctx.job_title ?? "Construction & Remodeling Project";
  const kind = contractKindFor(ctx.billing_model);

  if (kind === "cost_plus") {
    const laborGeneral = USD(Number(s.labor_rate_general ?? 90));
    const laborPm = USD(Number(s.labor_rate_pm_skilled ?? 105));
    const pmFee = PCT(Number(s.pm_fee_rate ?? 0.1));
    const contractorFee = PCT(Number(s.contractor_fee_rate ?? 0.2));
    return [
      `${company}`,
      `COST-PLUS BILLING AGREEMENT`,
      `Pay-As-You-Progress Construction Billing`,
      ``,
      `Client: ${client}`,
      `Property Address: ${address}`,
      `Project: ${title}`,
      `Estimated Total: ${USD(ctx.total)} (estimate only — actual costs billed at cost)`,
      `Date: ${todayLong()}`,
      ``,
      `This Cost-Plus Billing Agreement is entered into between ${company} ("Contractor") and the Client named above for the project described above, billed using a cost-plus model with bi-weekly billing cycles.`,
      ``,
      `1. HOW COST-PLUS PRICING WORKS`,
      `You pay the actual cost of materials, labor, and subcontractors — plus a contractor fee. There is no markup on materials or subcontractor costs. You pay what it costs us, with complete transparency into every dollar spent.`,
      ``,
      `2. FEE STRUCTURE`,
      `Materials: actual cost, no markup. Receipts provided for every purchase.`,
      `Subcontractors: actual cost, no markup (electrical, plumbing, HVAC, concrete, tile, etc.).`,
      `Labor: ${laborGeneral}/hour for general construction; ${laborPm}/hour for project management and skilled carpentry.`,
      `Project Management & Scheduling Fee: ${pmFee} of total project costs.`,
      `Contractor Fee: ${contractorFee} of total project costs.`,
      ``,
      `3. BI-WEEKLY BILLING CYCLE`,
      `The project is billed in two-week cycles. Before each cycle, Contractor provides a Mini-Budget of anticipated costs; the cycle is invoiced and due within twenty-four (24) hours. Actual expenses are tracked in real time through the Client Project Portal, and each cycle ends with a Reconciliation Report. Surpluses credit the next cycle; overages add to it.`,
      ``,
      `4. DEPOSIT & FINAL PAYMENT`,
      `A deposit of ${USD(ctx.deposit_amount)} is required to schedule the project and is applied toward total project costs. For the final billing cycle, fifty percent (50%) of projected final costs are due upfront with the balance due upon completion and final reconciliation.`,
      ``,
      `5. PAYMENT METHODS`,
      `Payments may be made by check (no additional fee) or by credit card or ACH bank transfer (a 3.5% convenience fee applies to all electronic payments to cover processing costs, disclosed before each payment).`,
      ``,
      `6. EXPENSE DOCUMENTATION`,
      `Contractor provides receipts and documentation for all materials, subcontractor invoices, and labor hours, accessible through the Client Portal and included in each reconciliation report.`,
      ``,
      `7. CHANGES & UNEXPECTED CONDITIONS`,
      `If unforeseen conditions require additional work or cost, Contractor will notify Client in writing with a cost estimate before proceeding. Approved changes are documented in a Change Order and billed through the bi-weekly cycle.`,
      ``,
      `8. NON-REFUNDABLE ITEMS`,
      `All deposits, material purchases, installed products, and special-order products are final and non-refundable.`,
      ``,
      `This Cost-Plus Billing Agreement is supplemental to the Service Agreement and is governed by its terms for warranty, insurance, termination, dispute resolution, and all other provisions not specifically addressed here. This Agreement shall be governed by the laws of the State of Arkansas.`,
      ``,
      `Primary point of contact: Tony Columbus${phone ? `, ${phone}` : ""}${email ? `, ${email}` : ""}`,
      ``,
      `By signing below (in person or electronically), both parties acknowledge that they have read, understand, and agree to all terms stated in this document. Electronic signatures are legally binding and carry the same weight as handwritten signatures under federal and Arkansas law.`,
    ].join("\n");
  }

  // Service Agreement (fixed-price / trade-by-trade)
  return [
    `${company}`,
    `SERVICE AGREEMENT`,
    `Residential Construction & Remodeling`,
    ``,
    `Client: ${client}`,
    `Property Address: ${address}`,
    `Project: ${title}`,
    `Contract Total: ${USD(ctx.total)}`,
    `Date: ${todayLong()}`,
    ``,
    `This Service Agreement ("Agreement") is entered into between ${company} ("Contractor") and the Client named above for the construction and/or remodeling work described in the attached Estimate and Scope of Work.`,
    ``,
    `1. SCOPE OF WORK`,
    `Contractor will perform the work described in the project estimate and scope of work attached to this Agreement, incorporated by reference. Any work not explicitly described is not included in the contract price.`,
    ``,
    `2. COMMUNICATION`,
    `Contractor will keep Client informed of progress via phone, text, email, or the Client Project Portal, where Client can view project photos, schedule, invoices, documents, and communicate directly with Contractor.`,
    `Primary point of contact: Tony Columbus${phone ? `, ${phone}` : ""}${email ? `, ${email}` : ""}`,
    ``,
    `3. PROJECT TIMELINE`,
    `Work will begin on a mutually scheduled start date with an estimated completion communicated before work begins. Timeline may be affected by weather, material availability, permitting, inspections, change orders, or other factors outside Contractor's reasonable control.`,
    ``,
    `4. PAYMENT TERMS`,
    `The total contract price is ${USD(ctx.total)}, payable according to the following schedule:`,
    scheduleBlock,
    `All invoices are due within seven (7) days of receipt. Payments may be made by check (no additional fee) or by credit card or ACH bank transfer (a 3.5% convenience fee applies to all electronic payments, clearly disclosed before payment).`,
    ``,
    `5. LATE PAYMENT FEE`,
    `A late fee of $50.00 per day applies to any invoice not paid within seven (7) days of receipt. Contractor may suspend work if payment is more than fourteen (14) days past due; work resumes once all balances and accrued late fees are paid.`,
    ``,
    `6. PRICE ESCALATION`,
    `The contract price reflects current material prices. If specified material costs increase after execution, Contractor will notify Client in writing with documentation and Client agrees to pay the verified increase. Increases exceeding ten percent (10%) of the total require written notice and Client approval before purchase.`,
    ``,
    `7. CHANGE ORDERS`,
    `Any change to the agreed scope must be documented in a written Change Order describing the modified work, cost impact, and timeline effect, and requires Client signature before work proceeds.`,
    ``,
    `8. WARRANTY`,
    `Contractor provides a one-year workmanship warranty on completed work beginning at project completion, covering defects in workmanship (excluding normal wear, Client/third-party damage, improper maintenance, and manufacturer-covered material defects).`,
    ``,
    `9. INSURANCE & LICENSING`,
    `${company} is licensed and insured in the State of Arkansas, maintaining general liability and workers compensation coverage. Certificates of insurance are available upon request.`,
    ``,
    `10. SITE ACCESS & WORKING HOURS`,
    `Client will provide reasonable access during regular business hours (Mon–Fri, 7:00 AM–7:00 PM) and is responsible for keeping the work area accessible and securing pets during working hours.`,
    ``,
    `11. PERMITS & INSPECTIONS`,
    `Contractor will obtain necessary permits and schedule required inspections for work in scope. Permit fees are included in the contract price unless otherwise noted.`,
    ``,
    `12. SUBCONTRACTORS`,
    `Some work may be performed by trade subcontractors selected by Contractor, who manages those relationships and is responsible for the quality of their work under this Agreement.`,
    ``,
    `13. TERMINATION`,
    `Either party may terminate in writing. If Client terminates, Client pays for all completed work, materials purchased/ordered, subcontractor commitments, and a termination fee of ten percent (10%) of the remaining balance. If Contractor terminates for non-payment or breach, all completed work, materials, and balances are due immediately.`,
    ``,
    `14. DISPUTE RESOLUTION`,
    `The parties will resolve disputes first by good-faith negotiation, then mediation before legal action. This Agreement is governed by the laws of the State of Arkansas.`,
    ``,
    `15. ENTIRE AGREEMENT`,
    `This Agreement, with the attached Estimate, Scope of Work, and executed Change Orders, is the entire agreement. No verbal agreements are binding unless incorporated in writing.`,
    ``,
    `By signing below (in person or electronically), both parties acknowledge that they have read, understand, and agree to all terms stated in this document. Electronic signatures are legally binding and carry the same weight as handwritten signatures under federal and Arkansas law.`,
  ].join("\n");
}
