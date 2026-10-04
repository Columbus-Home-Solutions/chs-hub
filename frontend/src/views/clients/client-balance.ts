/** Face value used on the client page. Same order as the job Financial tab. */
export function invoiceFace(inv: {
  total: number | null;
  total_due: number | null;
  amount: number | null;
}): number {
  return inv.total ?? inv.total_due ?? inv.amount ?? 0;
}

function isStatus(status: string | null, name: string): boolean {
  return (status ?? "").toLowerCase() === name;
}

/**
 * Current balance on the client page. Void invoices are not money owed,
 * matching the job Financial tab. Bad-debt remainders are a write-off.
 */
export function clientInvoiceBalance(
  invoices: Array<{
    id: string;
    total: number | null;
    total_due: number | null;
    amount: number | null;
    status: string | null;
  }>,
  payments: Array<{ invoice_id: string; amount: number }>,
): { collected: number; writtenOff: number; balance: number } {
  const paidOn = (invoiceId: string) =>
    payments.filter((p) => p.invoice_id === invoiceId).reduce((sum, p) => sum + (p.amount ?? 0), 0);
  const writtenOff = invoices
    .filter((inv) => isStatus(inv.status, "bad_debt"))
    .reduce((sum, inv) => sum + Math.max(0, invoiceFace(inv) - paidOn(inv.id)), 0);
  const balance = invoices
    .filter((inv) => !isStatus(inv.status, "bad_debt") && !isStatus(inv.status, "void"))
    .reduce((sum, inv) => sum + Math.max(0, invoiceFace(inv) - paidOn(inv.id)), 0);
  const collected = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0);
  return { collected, writtenOff, balance };
}
