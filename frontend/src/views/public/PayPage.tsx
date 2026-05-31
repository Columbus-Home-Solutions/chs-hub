import { useEffect, useMemo, useState } from "preact/hooks";
import { formatCurrency, formatDate } from "../../lib/format";
import logoUrl from "../../assets/chs-logo.png";

/**
 * Standalone, no-auth client invoice payment page (Sprint 9), served at
 * /pay/:token — the invoice analogue of QuotePage. No app shell, no nav. The
 * invoice's per-row payment_token in the URL is the only credential. The page
 * shows the invoice summary and balance, then pays via Stripe (card/bank, 3.5%
 * convenience fee). The authoritative payment recording happens in the webhook.
 */

interface PublicInvoice {
  invoice_number: number | null;
  invoice_display: string;
  title: string | null;
  description: string | null;
  invoice_type: string | null;
  amount: number;
  tax_amount: number;
  late_fee_amount: number;
  credits_applied: number;
  total_due: number;
  collected: number;
  balance: number;
  due_date: string | null;
  status: string;
  paid: boolean;
}
interface PublicPayPayload {
  ok: boolean;
  company_name: string;
  invoice: PublicInvoice;
  convenience_fee_preview: number;
  total_charge_preview: number;
  disclosure: string;
}

declare global {
  interface Window {
    Stripe?: (key: string) => any;
  }
}

function tokenFromPath(): string {
  const m = window.location.pathname.match(/\/pay\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
  return data as T;
}
async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
  return data as T;
}

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

export function PayPage() {
  const token = useMemo(tokenFromPath, []);
  const [payload, setPayload] = useState<PublicPayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const res = await getJson<PublicPayPayload>(`/api/public/pay/${token}`);
    setPayload(res);
    return res;
  };

  useEffect(() => {
    if (!token) {
      setError("Missing payment link.");
      setLoading(false);
      return;
    }
    reload()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div class="quote-shell">
        <div class="quote-loading">Loading your invoice…</div>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div class="quote-shell">
        <div class="quote-card quote-empty">
          <div class="quote-empty__icon">🔍</div>
          <h1>Invoice unavailable</h1>
          <p>{error ?? "This payment link is invalid or no longer available."}</p>
          <p class="quote-muted">If you think this is a mistake, please contact us.</p>
        </div>
      </div>
    );
  }

  const inv = payload.invoice;
  return (
    <div class="quote-shell">
      <header class="quote-header">
        <div class="quote-header__brand">
          <img class="quote-header__logo" src={logoUrl} alt={payload.company_name} />
          <div>
            <div class="quote-header__company">{payload.company_name}</div>
            <div class="quote-header__est">
              {inv.invoice_display}
              {inv.due_date ? ` · Due ${formatDate(inv.due_date)}` : ""}
            </div>
          </div>
        </div>
        <span class={`quote-status quote-status--${inv.paid ? "approved" : inv.status}`}>
          {inv.paid ? "Paid" : inv.status === "past_due" ? "Past Due" : "Balance Due"}
        </span>
      </header>

      <div class="quote-body">
        <div class="quote-card quote-main-col">
          <div class="preview theme-light" style={{ boxShadow: "none", border: "none", padding: 0 }}>
            {inv.title && <div class="preview__title">{inv.title}</div>}
            {inv.description && <div class="preview__line-desc">{inv.description}</div>}

            <div class="preview__totals" style={{ marginTop: "16px" }}>
              <div class="preview__total-row">
                <span>Amount</span>
                <span>{formatCurrency(inv.amount)}</span>
              </div>
              {inv.tax_amount > 0 && (
                <div class="preview__total-row">
                  <span>Tax</span>
                  <span>{formatCurrency(inv.tax_amount)}</span>
                </div>
              )}
              {inv.late_fee_amount > 0 && (
                <div class="preview__total-row">
                  <span>Late fee</span>
                  <span>{formatCurrency(inv.late_fee_amount)}</span>
                </div>
              )}
              {inv.credits_applied > 0 && (
                <div class="preview__total-row">
                  <span>Credits</span>
                  <span>−{formatCurrency(inv.credits_applied)}</span>
                </div>
              )}
              <div class="preview__total-row preview__total-row--grand">
                <span>Total due</span>
                <span>{formatCurrency(inv.total_due)}</span>
              </div>
              {inv.collected > 0 && (
                <div class="preview__total-row">
                  <span>Already paid</span>
                  <span>−{formatCurrency(inv.collected)}</span>
                </div>
              )}
              <div class="preview__total-row preview__total-row--grand">
                <span>Balance</span>
                <span>{formatCurrency(inv.balance)}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="quote-side">
          {inv.paid || inv.balance <= 0 ? (
            <div class="quote-card quote-approved">
              <div class="quote-approved__check">✓</div>
              <h2 class="quote-card__title">Paid in full</h2>
              <p>Thank you — this invoice has been paid. No further action is needed.</p>
            </div>
          ) : (
            <div class="quote-card quote-action">
              <h2 class="quote-card__title">Pay your balance</h2>
              <div class="quote-deposit-callout">
                <span>Balance due</span>
                <strong>{formatCurrency(inv.balance)}</strong>
              </div>
              <CardPay token={token} preview={payload} reload={reload} />
            </div>
          )}
        </div>
      </div>

      <footer class="quote-footer">
        <div>{payload.company_name}</div>
        <div class="quote-muted">Licensed &amp; insured in the State of Arkansas</div>
      </footer>
    </div>
  );
}

function CardPay({
  token,
  preview,
  reload,
}: {
  token: string;
  preview: PublicPayPayload;
  reload: () => Promise<PublicPayPayload>;
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
        const res = await postJson<any>(`/api/public/pay/${token}/intent`);
        if (cancelled) return;
        setIntent(res);
        if (res.publishable_key && res.client_secret && window) {
          await loadStripeJs();
          if (cancelled) return;
          const stripe = window.Stripe!(res.publishable_key);
          const elements = stripe.elements({ clientSecret: res.client_secret });
          const paymentEl = elements.create("payment");
          requestAnimationFrame(() => {
            const node = document.getElementById("stripe-payment-element");
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
    // Success: the webhook records the payment authoritatively. Poll for paid.
    setDone(true);
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const p = await reload().catch(() => null);
      if (p && (p.invoice.paid || p.invoice.balance <= 0)) return;
    }
  };

  if (busy) return <div class="quote-muted">Setting up secure payment…</div>;

  if (err && !intent) {
    return (
      <div>
        <div class="quote-error">{err}</div>
        <p class="quote-muted">
          Card payments aren't available right now. Please contact us to arrange payment by check.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div class="quote-muted">
        Payment submitted — finalizing your receipt. You can refresh this page in a moment.
      </div>
    );
  }

  return (
    <div class="quote-card-pay">
      <div class="quote-fee-disclosure">{intent?.disclosure ?? preview.disclosure}</div>
      {stripeRefs ? (
        <>
          <div id="stripe-payment-element" class="quote-stripe-element" />
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
