import { addDays, centralDate } from "./labor-week.js";

export const DEFAULT_DUE_DAYS = 7;

export const SHORT_DUE_WARNING =
  "Your agreement says invoices are due 7 days after they are sent";

/** Due date when the invoice is sent with the field left blank. Central send date + 7. */
export function defaultInvoiceDueDate(sentAt: Date = new Date()): string {
  return addDays(centralDate(sentAt), DEFAULT_DUE_DAYS);
}

/**
 * Warning when an owner-chosen due date is sooner than 7 days after send.
 * A blank date is not a warning: send fills it in.
 */
export function shortDueDateWarning(
  dueDate: string | null | undefined,
  sentAt: Date = new Date(),
): string | null {
  const due = (dueDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  return due < defaultInvoiceDueDate(sentAt) ? SHORT_DUE_WARNING : null;
}
