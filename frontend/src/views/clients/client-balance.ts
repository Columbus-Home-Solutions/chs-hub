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

export type ClientLedgerRow =
  | { kind: "invoice"; id: string; label: string; date: string | null; amount: number | null; status: string | null }
  | { kind: "payment"; id: string; label: string; date: string | null; amount: number; invoiceNum: number | null }
  | { kind: "writeoff"; id: string; label: string; date: string | null; amount: number };

/**
 * Invoice, payment, and write-off rows for the client page.
 * Imported invoices often have a null invoice number and null dates.
 */
export function buildClientLedgerRows(
  invoices: Array<{
    id: string;
    invoice_number: number | null;
    title: string | null;
    total: number | null;
    total_due: number | null;
    amount: number | null;
    status: string | null;
    due_date?: string | null;
    created_at: string | null;
  }>,
  payments: Array<{
    id: string;
    invoice_id: string;
    amount: number | null;
    received_date: string | null;
    created_at: string | null;
    invoice_number: number | null;
  }>,
): ClientLedgerRow[] {
  const paidOn = (invoiceId: string) =>
    payments.filter((p) => p.invoice_id === invoiceId).reduce((sum, p) => sum + (p.amount ?? 0), 0);
  return [
    ...invoices.map((inv): ClientLedgerRow => ({
      kind: "invoice",
      id: inv.id,
      label: inv.title ?? (inv.invoice_number ? `Invoice #${inv.invoice_number}` : "Invoice"),
      date: inv.created_at,
      amount: invoiceFace(inv),
      status: inv.status,
    })),
    ...invoices.filter((inv) => isStatus(inv.status, "bad_debt")).flatMap((inv): ClientLedgerRow[] => {
      const off = Math.max(0, invoiceFace(inv) - paidOn(inv.id));
      if (off <= 0) return [];
      return [{
        kind: "writeoff",
        id: `${inv.id}-writeoff`,
        label: "Bad-debt write-off",
        date: inv.created_at,
        amount: off,
      }];
    }),
    ...payments.map((p): ClientLedgerRow => ({
      kind: "payment",
      id: p.id,
      label: `Payment${p.invoice_number ? ` on Invoice #${p.invoice_number}` : ""}`,
      date: p.received_date ?? p.created_at,
      amount: p.amount ?? 0,
      invoiceNum: p.invoice_number,
    })),
  ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}
