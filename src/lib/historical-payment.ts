/**
 * External / historical invoice payments (Jobber-migrated, Venmo, Zelle, etc.).
 *
 * Mirrors Mark-as-Won deposit methods on the invoice side: record money that
 * was collected outside CHS without sending the client a payment link, firing
 * a receipt, or attempting Stripe.
 */

export const HISTORICAL_NOTE_MARKER = "[historical]";
export const HISTORICAL_INVOICE_BADGE = "Paid externally — not collected in CHS";

export const HISTORICAL_PAYMENT_METHODS = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "venmo", label: "Venmo" },
  { value: "zelle", label: "Zelle" },
  { value: "other", label: "Other" },
  { value: "jobber", label: "Migrated from Jobber" },
] as const;

export type HistoricalPaymentMethod = (typeof HISTORICAL_PAYMENT_METHODS)[number]["value"];

const HISTORICAL_METHOD_SET = new Set<string>(HISTORICAL_PAYMENT_METHODS.map((m) => m.value));

export function isHistoricalPaymentMethod(method: string | null | undefined): boolean {
  return !!method && HISTORICAL_METHOD_SET.has(method);
}

export function isHistoricalInvoice(notes: string | null | undefined): boolean {
  return (notes ?? "").includes(HISTORICAL_NOTE_MARKER);
}

export function appendHistoricalNote(
  existing: string | null | undefined,
  extra: string | null | undefined,
): string {
  const extras = (extra ?? "").trim();
  const have = (existing ?? "").trim();
  const bits: string[] = [];
  if (have) bits.push(have);
  if (!have.includes(HISTORICAL_NOTE_MARKER)) bits.push(HISTORICAL_NOTE_MARKER);
  if (extras && !extras.includes(HISTORICAL_NOTE_MARKER) && !have.includes(extras)) bits.push(extras);
  return bits.join(" ");
}

/**
 * Cap the additional historical payment so applying unlinked job payments plus
 * this amount cannot overpay the invoice.
 */
export function additionalHistoricalAmount(
  totalDue: number,
  alreadyLinkedPaid: number,
  unlinkedToApply: number,
  requested: number,
): number {
  const remainingAfterUnlinked = Math.round((totalDue - alreadyLinkedPaid - unlinkedToApply) * 100) / 100;
  if (remainingAfterUnlinked <= 0) return 0;
  const req = Math.round(requested * 100) / 100;
  if (!Number.isFinite(req) || req <= 0) return remainingAfterUnlinked;
  return Math.min(req, remainingAfterUnlinked);
}
