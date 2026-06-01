import { useEffect, useState } from "preact/hooks";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import {
  getJson,
  postJson,
  type PortalInvoice,
  type PortalPayment,
  type PortalScheduleRow,
} from "./portalApi";

declare global {
  interface Window {
    Stripe?: (key: string) => any;
  }
}

interface InvoicesPayload {
  on_hold: boolean;
  invoices: PortalInvoice[];
  payments: PortalPayment[];
  payment_schedule: PortalScheduleRow[];
}

export function InvoicesTab({
  token,
  onHold,
  onPaid,
}: {
  token: string;
  onHold: boolean;
  onPaid: () => void;
}) {
  const [data, setData] = useState<InvoicesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);

  const reload = async () => {
    const r = await getJson<InvoicesPayload>(`/api/portal/${token}/invoices`);
    setData(r);
    return r;
  };

  useEffect(() => {
    reload().catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (error) return <div class="quote-error">{error}</div>;
  if (!data) return <div class="quote-muted">Loading invoices…</div>;

  const paymentsByInvoice = (id: string) => data.payments.filter((p) => p.invoice_id === id);

  return (
    <div class="portal-invoices">
      {data.payment_schedule.length > 0 && (
        <div class="portal-card">
          <h3 class="portal-card__title">Payment Schedule</h3>
          <div class="portal-schedule">
            {data.payment_schedule.map((s, i) => (
              <div class="portal-schedule__row" key={i}>
                <div>
                  <div class="portal-schedule__label">{s.label}</div>
                  <div class="quote-muted">
                    {formatStatus(s.trigger_type)}
                    {s.percentage != null ? ` · ${s.percentage}%` : ""}
                  </div>
                </div>
                <div class="portal-schedule__amount">
                  {s.amount != null ? formatCurrency(s.amount) : "—"}
                  <span class={`portal-pill portal-pill--${s.status}`}>{formatStatus(s.status)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.invoices.length === 0 ? (
        <div class="portal-empty">
          <div class="portal-empty__icon">🧾</div>
          <div class="portal-empty__title">No invoices yet</div>
          <div class="quote-muted">Invoices will appear here when they're issued.</div>
        </div>
      ) : (
        data.invoices.map((inv) => (
          <div class="portal-card" key={inv.id}>
            <div class="portal-invoice__head">
              <div>
                <div class="portal-invoice__title">
                  {inv.invoice_display}
                  {inv.title ? ` · ${inv.title}` : ""}
                </div>
                <div class="quote-muted">
                  {inv.due_date ? `Due ${formatDate(inv.due_date)}` : "No due date"}
                </div>
              </div>
              <StatusBadge status={inv.status} />
            </div>

            <div class="portal-invoice__rows">
              <Row label="Amount" value={formatCurrency(inv.amount)} />
              {inv.tax_amount > 0 && <Row label="Tax" value={formatCurrency(inv.tax_amount)} />}
              {inv.late_fee_amount > 0 && <Row label="Late fee" value={formatCurrency(inv.late_fee_amount)} />}
              {inv.credits_applied > 0 && <Row label="Credits" value={`−${formatCurrency(inv.credits_applied)}`} />}
              <Row label="Total due" value={formatCurrency(inv.total_due)} strong />
              {inv.collected > 0 && <Row label="Paid" value={`−${formatCurrency(inv.collected)}`} />}
              <Row label="Balance" value={formatCurrency(inv.balance)} strong />
            </div>

            {paymentsByInvoice(inv.id).length > 0 && (
              <div class="portal-invoice__history">
                <div class="portal-invoice__history-label">Payment history</div>
                {paymentsByInvoice(inv.id).map((p) => (
                  <div class="portal-invoice__history-row" key={p.id}>
                    <span>
                      {formatDate(p.paid_at)} · {formatStatus(p.payment_method) || "Payment"}
                    </span>
                    <span>{formatCurrency(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}

            {inv.status === "paid" ? (
              <div class="portal-receipt">✓ Paid in full — thank you!</div>
            ) : inv.payable && !onHold ? (
              payingId === inv.id ? (
                <PayPanel
                  token={token}
                  invoice={inv}
                  onCancel={() => setPayingId(null)}
                  onPaid={() => {
                    setPayingId(null);
                    reload().catch(() => {});
                    onPaid();
                  }}
                />
              ) : (
                <button class="quote-btn quote-btn--primary" onClick={() => setPayingId(inv.id)}>
                  Pay Now
                  <span class="quote-btn__sub">{formatCurrency(inv.balance)}</span>
                </button>
              )
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div class={`portal-invoice__row${strong ? " portal-invoice__row--strong" : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, string> = {
    paid: "Paid",
    past_due: "Past Due",
    partial: "Partially Paid",
    sent: "Sent",
    viewed: "Sent",
    void: "Void",
  };
  return <span class={`portal-pill portal-pill--${status ?? "sent"}`}>{map[status ?? ""] ?? formatStatus(status)}</span>;
}

// ─── Pay panel: check (no fee) vs. electronic (+3.5%, reused Sprint 9 path) ─────

function loadStripeJs(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Stripe) return resolve();
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the payment form."));
    document.head.appendChild(s);
  });
}

function PayPanel({
  token,
  invoice,
  onCancel,
  onPaid,
}: {
  token: string;
  invoice: PortalInvoice;
  onCancel: () => void;
  onPaid: () => void;
}) {
  const [method, setMethod] = useState<"electronic" | "check" | null>(null);

  return (
    <div class="portal-pay">
      <div class="portal-pay__label">How would you like to pay {formatCurrency(invoice.balance)}?</div>
      <div class="portal-pay__choices">
        <button
          class={`portal-pay__choice${method === "check" ? " portal-pay__choice--active" : ""}`}
          onClick={() => setMethod("check")}
        >
          <strong>Check or Cash</strong>
          <span class="quote-muted">No convenience fee</span>
        </button>
        <button
          class={`portal-pay__choice${method === "electronic" ? " portal-pay__choice--active" : ""}`}
          onClick={() => setMethod("electronic")}
        >
          <strong>Card or Bank</strong>
          <span class="quote-muted">+3.5% convenience fee</span>
        </button>
      </div>

      {method === "check" && (
        <div class="quote-check-box">
          Please contact us to arrange payment by check or cash — there's no convenience fee for these.
          We'll mark your invoice paid once it's received.
        </div>
      )}

      {method === "electronic" && <ElectronicPay token={token} invoice={invoice} onPaid={onPaid} />}

      <button class="quote-link-btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function ElectronicPay({
  token,
  invoice,
  onPaid,
}: {
  token: string;
  invoice: PortalInvoice;
  onPaid: () => void;
}) {
  const [intent, setIntent] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState(false);
  const [stripeRefs, setStripeRefs] = useState<{ stripe: any; elements: any } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // REUSES the Sprint 9 intent path via the portal pay route (which sets
        // metadata.invoice_id so the single Stripe webhook records the payment).
        const res = await postJson<any>(`/api/portal/${token}/pay/${invoice.id}`);
        if (cancelled) return;
        setIntent(res);
        if (res.publishable_key && res.client_secret) {
          await loadStripeJs();
          if (cancelled) return;
          const stripe = window.Stripe!(res.publishable_key);
          const elements = stripe.elements({ clientSecret: res.client_secret });
          const paymentEl = elements.create("payment");
          requestAnimationFrame(() => {
            const node = document.getElementById(`portal-stripe-${invoice.id}`);
            if (node) paymentEl.mount(node);
          });
          setStripeRefs({ stripe, elements });
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async () => {
    if (!stripeRefs) return;
    setPaying(true);
    setErr(null);
    const { error } = await stripeRefs.stripe.confirmPayment({
      elements: stripeRefs.elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });
    if (error) {
      setErr(error.message ?? "Payment could not be completed.");
      setPaying(false);
      return;
    }
    // The webhook records the payment authoritatively; poll until it lands.
    setDone(true);
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = await getJson<{ invoices: PortalInvoice[] }>(`/api/portal/${token}/invoices`).catch(() => null);
      const me = fresh?.invoices.find((x) => x.id === invoice.id);
      if (me && (me.status === "paid" || me.balance <= 0)) {
        onPaid();
        return;
      }
    }
    onPaid();
  };

  if (busy) return <div class="quote-muted">Setting up secure payment…</div>;
  if (err && !intent) {
    return (
      <div class="quote-error">
        {err} — please contact us to arrange payment by check.
      </div>
    );
  }
  if (done) {
    return <div class="quote-muted">Payment submitted — finalizing your receipt…</div>;
  }

  return (
    <div class="portal-pay__card">
      <div class="quote-fee-disclosure">{intent?.disclosure}</div>
      {stripeRefs ? (
        <>
          <div id={`portal-stripe-${invoice.id}`} class="quote-stripe-element" />
          {err && <div class="quote-error">{err}</div>}
          <button class="quote-btn quote-btn--primary" disabled={paying} onClick={confirm}>
            {paying ? "Processing…" : `Pay ${formatCurrency(intent?.total_charge)}`}
          </button>
        </>
      ) : (
        <div class="quote-muted">
          Card payments aren't available right now. Please contact us to arrange payment by check.
        </div>
      )}
    </div>
  );
}
