import { useEffect, useMemo, useState } from "preact/hooks";
import { formatCurrency, formatDate } from "../../lib/format";
import logoUrl from "../../assets/chs-logo.png";

/**
 * Standalone, no-auth client quote page (Sprint 5), served at /quote/:token.
 * No app shell, no sidebar, no nav — a branded page the client uses to review
 * the quote, sign the service agreement, and pay the deposit (Stripe or check).
 * The portal_token in the URL is the only credential. Sub-items never appear in
 * the payload, so they cannot render here.
 */

interface PublicLineItem {
  id: string;
  product_service: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  total: number;
  includes_note: string | null;
}
interface PublicMilestone {
  id: string;
  description: string;
  percentage: number | null;
  amount: number;
  is_deposit: boolean;
  trigger: string | null;
}
interface PublicReview {
  id: string;
  reviewer_name: string;
  rating: number;
  review_text: string;
  review_date: string | null;
  source: string | null;
}
interface PublicQuote {
  token: string;
  estimate_number: number | null;
  status: string;
  expired: boolean;
  title: string | null;
  billing_model: string | null;
  company_name: string;
  client_name: string | null;
  client_phone: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  subtotal: number;
  tax_amount: number;
  total: number;
  deposit_amount: number | null;
  valid_days: number;
  sent_date: string | null;
  viewed_date: string | null;
  expiration_date: string | null;
  signed: boolean;
  client_signature: string | null;
  signed_date: string | null;
  approved_date: string | null;
  include_contract: boolean;
  contract_text: string | null;
  signature_required: boolean;
  signature_complete: boolean;
  contract_signature_mode: "none" | "typed" | "boldsign";
  signature_status: string;
  contract_document_id: string | null;
  convenience_fee_rate: number;
  stripe_enabled: boolean;
  stripe_publishable_key: string | null;
  line_items: PublicLineItem[];
  payment_schedule: PublicMilestone[];
  reviews: PublicReview[];
}

declare global {
  interface Window {
    Stripe?: (key: string) => any;
  }
}

function tokenFromPath(): string {
  const m = window.location.pathname.match(/\/quote\/([^/?#]+)/);
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

const WISETACK_URL = "https://wisetack.us/#/g1wjjq5/prequalify";
const WISETACK_MIN_TOTAL = 500;

const statusLabel: Record<string, string> = {
  sent: "Awaiting Response",
  viewed: "Viewed",
  approved: "Approved",
  expired: "Expired",
  revised: "Revised",
};

function billingScheduleCopy(model: string | null): string {
  switch (model) {
    case "cost_plus":
      return "Billed in bi-weekly cycles at actual cost plus the agreed fees.";
    case "fifty_fifty":
      return "50% deposit due before work begins; balance due upon completion.";
    case "trade_by_trade":
      return "Paid trade-by-trade as each portion of work is completed.";
    default:
      return "Paid at the milestones below as the project progresses.";
  }
}

export function QuotePage() {
  const token = useMemo(tokenFromPath, []);
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const res = await getJson<{ quote: PublicQuote }>(`/api/public/quote/${token}`);
    setQuote(res.quote);
    return res.quote;
  };

  useEffect(() => {
    if (!token) {
      setError("Missing quote link.");
      setLoading(false);
      return;
    }
    reload()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    if (new URLSearchParams(window.location.search).get("signed") === "1") {
      const t = window.setTimeout(() => void reload().catch(() => undefined), 1500);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div class="quote-shell">
        <div class="quote-loading">Loading your quote…</div>
      </div>
    );
  }

  if (error || !quote) {
    return (
      <div class="quote-shell">
        <div class="quote-card quote-empty">
          <div class="quote-empty__icon">🔍</div>
          <h1>Quote unavailable</h1>
          <p>{error ?? "This quote link is invalid or no longer available."}</p>
          <p class="quote-muted">If you think this is a mistake, please contact Columbus Home Solutions.</p>
        </div>
      </div>
    );
  }

  return (
    <div class="quote-shell">
      <Header quote={quote} />
      <div class="quote-body">
        <ScopeCard quote={quote} />
        <div class="quote-side">
          {quote.expired ? (
            <ExpiredCard quote={quote} />
          ) : quote.status === "approved" ? (
            <ApprovedCard quote={quote} />
          ) : (
            <ApprovalFlow quote={quote} reload={reload} />
          )}
          {quote.reviews.length > 0 && <ReviewsCard reviews={quote.reviews} />}
        </div>
      </div>
      <footer class="quote-footer">
        <div>{quote.company_name}</div>
        <div class="quote-muted">Licensed &amp; insured in the State of Arkansas</div>
      </footer>
    </div>
  );
}

function Header({ quote }: { quote: PublicQuote }) {
  const label = quote.expired ? "Expired" : statusLabel[quote.status] ?? quote.status;
  return (
    <header class="quote-header">
      <div class="quote-header__brand">
        <img class="quote-header__logo" src={logoUrl} alt={quote.company_name} />
        <div>
          <div class="quote-header__company">{quote.company_name}</div>
          <div class="quote-header__est">
            EST-{String(quote.estimate_number ?? 0).padStart(3, "0")}
            {quote.sent_date ? ` · Sent ${formatDate(quote.sent_date)}` : ""}
          </div>
        </div>
      </div>
      <span class={`quote-status quote-status--${quote.expired ? "expired" : quote.status}`}>{label}</span>
    </header>
  );
}

function ScopeCard({ quote }: { quote: PublicQuote }) {
  const address = [quote.property_address, quote.property_city, quote.property_state, quote.property_zip]
    .filter(Boolean)
    .join(", ");
  return (
    <div class="quote-card quote-main-col">
      <div class="preview theme-light" style={{ boxShadow: "none", border: "none", padding: 0 }}>
        <div class="preview__meta">
          <div>
            <div class="preview__meta-label">Prepared for</div>
            <div>{quote.client_name ?? "—"}</div>
            {address && <div class="preview__meta-sub">{address}</div>}
            {quote.client_phone && <div class="preview__meta-sub">{quote.client_phone}</div>}
          </div>
          {(quote.deposit_amount ?? 0) > 0 && (
            <div class="preview__deposit">
              <div class="preview__meta-label">Deposit to begin</div>
              <div class="preview__deposit-amount">{formatCurrency(quote.deposit_amount)}</div>
            </div>
          )}
        </div>

        {quote.title && <div class="preview__title">{quote.title}</div>}

        <div class="preview__lines">
          {quote.line_items.length === 0 ? (
            <div class="preview__empty">No line items.</div>
          ) : (
            quote.line_items.map((li) => (
              <div class="preview__line" key={li.id}>
                <div class="preview__line-main">
                  <span class="preview__line-name">{li.product_service}</span>
                  <span class="preview__line-total">{formatCurrency(li.total)}</span>
                </div>
                {li.description && <div class="preview__line-desc">{li.description}</div>}
                <div class="preview__line-qty">
                  {li.quantity ?? 1}
                  {li.unit ? ` ${li.unit}` : ""} × {formatCurrency(li.unit_price)}
                  {li.includes_note ? ` · ${li.includes_note}` : ""}
                </div>
              </div>
            ))
          )}
        </div>

        <div class="preview__totals">
          <div class="preview__total-row">
            <span>Subtotal</span>
            <span>{formatCurrency(quote.subtotal)}</span>
          </div>
          {quote.tax_amount > 0 && (
            <div class="preview__total-row">
              <span>Tax</span>
              <span>{formatCurrency(quote.tax_amount)}</span>
            </div>
          )}
          <div class="preview__total-row preview__total-row--grand">
            <span>Total</span>
            <span>{formatCurrency(quote.total)}</span>
          </div>
        </div>

        {!quote.expired && quote.status !== "approved" && quote.total >= WISETACK_MIN_TOTAL && (
          <WisetackFinancing />
        )}

        {quote.payment_schedule.length > 0 && (
          <div class="preview__section">
            <div class="preview__section-title">Payment Schedule</div>
            <div class="quote-muted" style={{ marginBottom: "8px", fontSize: "13px" }}>
              {billingScheduleCopy(quote.billing_model)}
            </div>
            {quote.payment_schedule.map((p) => (
              <div class="preview__pay" key={p.id}>
                <span>
                  {p.description}
                  {p.is_deposit ? " (deposit)" : ""}
                  {p.percentage != null ? ` · ${p.percentage}%` : ""}
                </span>
                <span>{formatCurrency(p.amount)}</span>
              </div>
            ))}
          </div>
        )}

        <div class="preview__validity">
          {quote.expiration_date
            ? `This quote is valid through ${formatDate(quote.expiration_date)}.`
            : `This quote is valid for ${quote.valid_days} days.`}
        </div>
      </div>
    </div>
  );
}

function WisetackFinancing() {
  return (
    <div class="quote-wisetack">
      <div class="quote-wisetack__title">💳 Flexible Financing Available</div>
      <p class="quote-wisetack__body">
        Finance your project with 0% APR for up to 6 months through Wisetack. Get pre-qualified in
        seconds — no hard credit pull, no impact to your credit score.
      </p>
      <a class="quote-wisetack__cta" href={WISETACK_URL} target="_blank" rel="noopener noreferrer">
        Check Financing Options →
      </a>
      <p class="quote-wisetack__fine">Offered through Wisetack. Subject to credit approval.</p>
    </div>
  );
}

function ReviewsCard({ reviews }: { reviews: PublicReview[] }) {
  return (
    <div class="quote-card">
      <h2 class="quote-card__title">What our clients say</h2>
      {reviews.map((r) => (
        <div class="quote-review" key={r.id}>
          <div class="quote-review__stars">
            {"★".repeat(Math.max(0, Math.min(5, r.rating)))}
            {"☆".repeat(Math.max(0, 5 - r.rating))}
          </div>
          <div class="quote-review__text">{r.review_text}</div>
          <div class="quote-review__by">— {r.reviewer_name}</div>
        </div>
      ))}
    </div>
  );
}

function ExpiredCard({ quote }: { quote: PublicQuote }) {
  return (
    <div class="quote-card quote-expired">
      <h2 class="quote-card__title">This quote has expired</h2>
      <p>
        This quote was valid through {formatDate(quote.expiration_date)} and can no longer be
        accepted online.
      </p>
      <p class="quote-muted">
        Please contact Columbus Home Solutions{quote.client_phone ? "" : ""} for an updated quote —
        we'd be glad to refresh the pricing for you.
      </p>
    </div>
  );
}

function ApprovedCard({ quote }: { quote: PublicQuote }) {
  return (
    <div class="quote-card quote-approved">
      <div class="quote-approved__check">✓</div>
      <h2 class="quote-card__title">You're all set!</h2>
      <p>
        Your deposit has been received and your project is approved
        {quote.approved_date ? ` (${formatDate(quote.approved_date)})` : ""}. Thank you for choosing{" "}
        {quote.company_name}.
      </p>
      <p class="quote-muted">We'll be in touch shortly to schedule your project.</p>
    </div>
  );
}

// ─── Approval flow: sign → pay ────────────────────────────────────────────────

function ApprovalFlow({ quote, reload }: { quote: PublicQuote; reload: () => Promise<PublicQuote> }) {
  const [changesOpen, setChangesOpen] = useState(false);
  const needsSign = quote.signature_required && !quote.signature_complete;
  const stepTotal = quote.signature_required ? 2 : 1;

  return (
    <div class="quote-card quote-action">
      <h2 class="quote-card__title">Approve &amp; Pay Deposit</h2>
      <div class="quote-deposit-callout">
        <span>Deposit to begin</span>
        <strong>{formatCurrency(quote.deposit_amount)}</strong>
      </div>

      {needsSign ? (
        <SignSection quote={quote} reload={reload} stepTotal={stepTotal} />
      ) : (
        <PaySection quote={quote} reload={reload} stepTotal={stepTotal} showSignNote={quote.signature_required} />
      )}

      <button class="quote-link-btn" onClick={() => setChangesOpen((v) => !v)}>
        {changesOpen ? "Never mind" : "Request changes instead"}
      </button>
      {changesOpen && <RequestChanges quote={quote} onDone={() => setChangesOpen(false)} />}
    </div>
  );
}

function SignSection({
  quote,
  reload,
  stepTotal,
}: {
  quote: PublicQuote;
  reload: () => Promise<PublicQuote>;
  stepTotal: number;
}) {
  const [contractOpen, setContractOpen] = useState(false);
  const [name, setName] = useState(quote.client_name ?? "");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signLink, setSignLink] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const boldsign = quote.contract_signature_mode === "boldsign";

  useEffect(() => {
    if (!boldsign) return;
    const poll = window.setInterval(() => {
      void reload().catch(() => undefined);
    }, 12_000);
    return () => window.clearInterval(poll);
  }, [boldsign, quote.token]);

  const sign = async () => {
    setBusy(true);
    setErr(null);
    try {
      await postJson(`/api/public/quote/${quote.token}/sign`, { signature: name.trim(), date: today });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const openBoldSign = async () => {
    setLinkBusy(true);
    setErr(null);
    try {
      const res = await getJson<{ sign_link: string }>(`/api/public/quote/${quote.token}/sign-link`);
      setSignLink(res.sign_link);
      window.open(res.sign_link, "_blank", "noopener,noreferrer");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLinkBusy(false);
    }
  };

  return (
    <div class="quote-step">
      <div class="quote-step__label">
        Step 1 of {stepTotal} — Sign the service agreement
      </div>
      {quote.include_contract && quote.contract_text && (
        <>
          <button class="quote-link-btn" onClick={() => setContractOpen((v) => !v)}>
            {contractOpen ? "Hide agreement" : "Read the full agreement"}
          </button>
          {contractOpen && <pre class="quote-contract">{quote.contract_text}</pre>}
        </>
      )}
      {boldsign ? (
        <>
          <p class="quote-muted">
            Review and sign electronically. Deposit payment unlocks once your signature is complete.
          </p>
          {quote.signature_status && quote.signature_status !== "none" && (
            <div class="quote-signed-note">
              Signature status: <strong>{quote.signature_status}</strong>
            </div>
          )}
          {err && <div class="quote-error">{err}</div>}
          <button class="quote-btn quote-btn--primary" disabled={linkBusy} onClick={openBoldSign}>
            {linkBusy ? "Opening…" : signLink ? "Re-open signature" : "Sign agreement"}
          </button>
          <button class="quote-link-btn" onClick={() => void reload()}>
            I finished signing — refresh status
          </button>
        </>
      ) : (
        <>
          <label class="quote-field">
            <span>Type your full legal name to sign</span>
            <input
              class="quote-input"
              value={name}
              placeholder="e.g. Marcus Aurelius"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="quote-check">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree((e.target as HTMLInputElement).checked)} />
            <span>
              I agree to the service agreement and understand my electronic signature is legally binding.
            </span>
          </label>
          {err && <div class="quote-error">{err}</div>}
          <button class="quote-btn quote-btn--primary" disabled={!name.trim() || !agree || busy} onClick={sign}>
            {busy ? "Signing…" : "Adopt & Sign"}
          </button>
        </>
      )}
    </div>
  );
}

function PaySection({
  quote,
  reload,
  stepTotal,
  showSignNote,
}: {
  quote: PublicQuote;
  reload: () => Promise<PublicQuote>;
  stepTotal: number;
  showSignNote?: boolean;
}) {
  const [mode, setMode] = useState<"choose" | "card" | "check">("choose");
  const payStep = quote.signature_required ? 2 : 1;

  return (
    <div class="quote-step">
      <div class="quote-step__label">
        {stepTotal > 1 ? `Step ${payStep} of ${stepTotal} — ` : ""}Pay your deposit
      </div>
      {showSignNote && quote.client_signature && (
        <div class="quote-signed-note">
          Signed by <strong>{quote.client_signature}</strong>
          {quote.signed_date ? ` on ${formatDate(quote.signed_date)}` : ""}.
        </div>
      )}

      {mode === "choose" && (
        <div class="quote-pay-choices">
          <button class="quote-btn quote-btn--primary" onClick={() => setMode("card")}>
            Pay by Card or Bank
            <span class="quote-btn__sub">3.5% convenience fee applies</span>
          </button>
          <button class="quote-btn quote-btn--secondary" onClick={() => setMode("check")}>
            Pay by Check
            <span class="quote-btn__sub">No fee</span>
          </button>
        </div>
      )}

      {mode === "card" && <CardPay quote={quote} reload={reload} onBack={() => setMode("choose")} />}
      {mode === "check" && <CheckPay quote={quote} onBack={() => setMode("choose")} />}
    </div>
  );
}

function CheckPay({ quote, onBack }: { quote: PublicQuote; onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const arrange = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await postJson<any>(`/api/public/quote/${quote.token}/pay/check`);
      setData(res);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    arrange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err) return <div class="quote-error">{err}</div>;
  if (busy || !data) return <div class="quote-muted">Preparing instructions…</div>;

  const ins = data.instructions ?? {};
  return (
    <div class="quote-check-instructions">
      <p>Please mail a check for {formatCurrency(data.deposit_amount)} (no fee):</p>
      <div class="quote-check-box">
        <div>
          <strong>Pay to:</strong> {ins.payable_to}
        </div>
        {ins.mailing_address && (
          <div>
            <strong>Mail to:</strong> {ins.mailing_address}
          </div>
        )}
        <div>
          <strong>Memo:</strong> {ins.memo}
        </div>
      </div>
      <p class="quote-muted">{ins.note}</p>
      <button class="quote-link-btn" onClick={onBack}>
        ← Choose a different method
      </button>
    </div>
  );
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

function CardPay({
  quote,
  reload,
  onBack,
}: {
  quote: PublicQuote;
  reload: () => Promise<PublicQuote>;
  onBack: () => void;
}) {
  const [intent, setIntent] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState(false);
  const [stripeRefs, setStripeRefs] = useState<{ stripe: any; elements: any } | null>(null);

  // Create the PaymentIntent, then (if Stripe is configured) mount Elements.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await postJson<any>(`/api/public/quote/${quote.token}/pay/intent`);
        if (cancelled) return;
        setIntent(res);
        if (res.publishable_key && res.client_secret && window) {
          await loadStripeJs();
          if (cancelled) return;
          const stripe = window.Stripe!(res.publishable_key);
          const elements = stripe.elements({ clientSecret: res.client_secret });
          const paymentEl = elements.create("payment");
          // defer mount until the node exists in the DOM
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
    // Success: the webhook does the authoritative conversion. Poll for approval.
    setDone(true);
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const q = await reload().catch(() => null);
      if (q && q.status === "approved") return;
    }
  };

  if (busy) return <div class="quote-muted">Setting up secure payment…</div>;

  // Stripe not configured locally (or unreachable): graceful fallback.
  if (err && !intent) {
    return (
      <div>
        <div class="quote-error">{err}</div>
        <p class="quote-muted">You can pay by check instead — it carries no convenience fee.</p>
        <button class="quote-link-btn" onClick={onBack}>
          ← Choose a different method
        </button>
      </div>
    );
  }

  if (done) {
    return (
      <div class="quote-muted">
        Payment submitted — finalizing your approval. You can refresh this page in a moment.
      </div>
    );
  }

  return (
    <div class="quote-card-pay">
      {intent?.disclosure && <div class="quote-fee-disclosure">{intent.disclosure}</div>}
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
          Card payments aren't available right now. Please choose “Pay by Check,” which carries no fee.
        </div>
      )}
      <button class="quote-link-btn" onClick={onBack}>
        ← Choose a different method
      </button>
    </div>
  );
}

function RequestChanges({ quote, onDone }: { quote: PublicQuote; onDone: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await postJson<{ message: string }>(
        `/api/public/quote/${quote.token}/request-changes`,
        { message: msg.trim() || null },
      );
      setSent(res.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div class="quote-changes">
        <div class="quote-signed-note">{sent}</div>
        <button class="quote-link-btn" onClick={onDone}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div class="quote-changes">
      <label class="quote-field">
        <span>What would you like to change?</span>
        <textarea
          class="quote-textarea"
          value={msg}
          placeholder="Tell us what you'd like adjusted and we'll follow up."
          onInput={(e) => setMsg((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      {err && <div class="quote-error">{err}</div>}
      <button class="quote-btn quote-btn--secondary" disabled={busy} onClick={submit}>
        {busy ? "Sending…" : "Send request"}
      </button>
    </div>
  );
}
