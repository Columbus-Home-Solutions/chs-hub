import { useEffect, useMemo, useState } from "preact/hooks";
import logoUrl from "../../assets/chs-logo.png";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import { getJson, portalToken, type PortalLanding } from "./portalApi";
import { PhotosTab } from "./PhotosTab";
import { InvoicesTab } from "./InvoicesTab";
import { BudgetTab } from "./BudgetTab";
import { MessagesTab } from "./MessagesTab";
import { ScheduleTab, ChangeOrdersTab, DocumentsTab } from "./SeamTabs";

type TabKey =
  | "photos"
  | "schedule"
  | "invoices"
  | "budget"
  | "change_orders"
  | "documents"
  | "messages";

const TAB_LABELS: Record<TabKey, string> = {
  photos: "Photos",
  schedule: "Schedule",
  invoices: "Invoices & Payments",
  budget: "Budget & Costs",
  change_orders: "Change Orders",
  documents: "Documents",
  messages: "Messages",
};

export function PortalApp() {
  const token = useMemo(portalToken, []);
  const [landing, setLanding] = useState<PortalLanding | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("photos");

  const reload = async () => {
    const res = await getJson<PortalLanding>(`/api/portal/${token}`);
    setLanding(res);
    return res;
  };

  useEffect(() => {
    if (!token) {
      setError("Missing project link.");
      setLoading(false);
      return;
    }
    reload()
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div class="quote-shell">
        <div class="quote-loading">Loading your project…</div>
      </div>
    );
  }

  if (error || !landing) {
    return (
      <div class="quote-shell">
        <div class="quote-card quote-empty">
          <div class="quote-empty__icon">🔍</div>
          <h1>Project unavailable</h1>
          <p>{error ?? "This project link is invalid or no longer available."}</p>
          <p class="quote-muted">If you think this is a mistake, please contact us.</p>
        </div>
      </div>
    );
  }

  const tabs: TabKey[] = [
    "photos",
    "schedule",
    "invoices",
    ...(landing.is_cost_plus ? (["budget"] as TabKey[]) : []),
    "change_orders",
    "documents",
    "messages",
  ];

  const h = landing.header;
  const qs = landing.quick_stats;

  return (
    <div class="portal">
      <header class="portal-header">
        <div class="portal-header__bar">
          <div class="portal-header__brand">
            <img class="portal-header__logo" src={logoUrl} alt={landing.company_name} />
            <div>
              <div class="portal-header__company">{landing.company_name}</div>
              <div class="portal-header__job">
                {h.job_display ? `${h.job_display} · ` : ""}
                {h.job_title ?? "Your Project"}
              </div>
            </div>
          </div>
          <span class={`portal-status portal-status--${h.status ?? "active"}`}>
            {formatStatus(h.status)}
          </span>
        </div>
        <div class="portal-header__client">
          {h.client_name && <span>{h.client_name}</span>}
          {h.property_address && <span class="portal-header__addr">{h.property_address}</span>}
        </div>
      </header>

      {landing.on_hold && (
        <div class="portal-hold">
          This project is currently on hold. Please contact us and we'll be glad to help.
        </div>
      )}

      <section class="portal-stats">
        <Stat label="Contract Total" value={fmtOrDash(qs.contract_total)} />
        <Stat label="Paid to Date" value={formatCurrency(qs.total_paid)} />
        <Stat label="Remaining" value={fmtOrDash(qs.remaining_balance)} />
        <Stat
          label="Next Payment"
          value={qs.next_payment ? formatCurrency(qs.next_payment.amount) : "—"}
          sub={qs.next_payment?.due_date ? `Due ${formatDate(qs.next_payment.due_date)}` : undefined}
        />
      </section>

      <nav class="portal-tabs" aria-label="Project sections">
        {tabs.map((t) => (
          <button
            key={t}
            class={`portal-tab${tab === t ? " portal-tab--active" : ""}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      <main class="portal-content">
        {tab === "photos" && <PhotosTab token={token} />}
        {tab === "schedule" && <ScheduleTab token={token} />}
        {tab === "invoices" && (
          <InvoicesTab token={token} onHold={landing.on_hold} onPaid={reload} />
        )}
        {tab === "budget" && <BudgetTab token={token} />}
        {tab === "change_orders" && <ChangeOrdersTab token={token} />}
        {tab === "documents" && <DocumentsTab token={token} />}
        {tab === "messages" && <MessagesTab token={token} />}
      </main>

      <footer class="quote-footer">
        <div>{landing.company_name}</div>
        <div class="quote-muted">Licensed &amp; insured in the State of Arkansas</div>
      </footer>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div class="portal-stat">
      <div class="portal-stat__label">{label}</div>
      <div class="portal-stat__value">{value}</div>
      {sub && <div class="portal-stat__sub">{sub}</div>}
    </div>
  );
}

function fmtOrDash(n: number | null): string {
  return n == null ? "—" : formatCurrency(n);
}
