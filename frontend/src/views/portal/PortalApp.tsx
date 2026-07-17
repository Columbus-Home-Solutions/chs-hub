import { useEffect, useMemo, useState } from "preact/hooks";
import { usePortalUrlTab } from "../../hooks/useUrlTab";
import logoUrl from "../../assets/chs-logo.png";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import { getJson, portalToken, type PortalLanding } from "./portalApi";
import { PhotosTab } from "./PhotosTab";
import { InvoicesTab } from "./InvoicesTab";
import { BudgetTab } from "./BudgetTab";
import { MessagesTab } from "./MessagesTab";
import { ScheduleTab, ChangeOrdersTab, DocumentsTab, CompletionPackageTab } from "./SeamTabs";
import { WarrantyClaimsTab } from "./WarrantyClaimsTab";
import { SelectionsTab } from "./SelectionsTab";

type TabKey =
  | "photos"
  | "schedule"
  | "invoices"
  | "budget"
  | "change_orders"
  | "selections"
  | "documents"
  | "completion"
  | "warranty"
  | "messages";

const TAB_LABELS: Record<TabKey, string> = {
  photos: "Photos",
  schedule: "Schedule",
  invoices: "Invoices & Payments",
  budget: "Budget & Costs",
  change_orders: "Change Orders",
  selections: "Selections",
  documents: "Documents",
  completion: "Completion Package",
  warranty: "Warranty",
  messages: "Messages",
};

const ALL_TABS: TabKey[] = [
  "photos",
  "schedule",
  "invoices",
  "budget",
  "change_orders",
  "selections",
  "documents",
  "completion",
  "warranty",
  "messages",
];

function portalTabsFor(landing: PortalLanding): TabKey[] {
  return [
    "photos",
    "schedule",
    "invoices",
    ...(landing.is_cost_plus ? (["budget"] as TabKey[]) : []),
    "change_orders",
    "selections",
    "documents",
    ...(landing.completion_package_available ? (["completion"] as TabKey[]) : []),
    ...(landing.within_warranty ? (["warranty"] as TabKey[]) : []),
    "messages",
  ];
}

export function PortalApp() {
  const token = useMemo(portalToken, []);
  const [landing, setLanding] = useState<PortalLanding | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = usePortalUrlTab(ALL_TABS, "photos");

  const availableTabs = useMemo(() => (landing ? portalTabsFor(landing) : null), [landing]);

  useEffect(() => {
    if (!availableTabs) return;
    if (!availableTabs.includes(tab)) setTab(availableTabs[0] ?? "photos");
  }, [availableTabs, tab, setTab]);

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

  const tabs = portalTabsFor(landing);
  const activeTab = tabs.includes(tab) ? tab : (tabs[0] ?? "photos");

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

      {landing.billing_party?.notice && (
        <div class="portal-hold" style={{ background: "var(--color-surface-muted)" }}>
          {landing.billing_party.notice}
        </div>
      )}

      {landing.project_manager && (
        <section class="portal-card" style={{ marginBottom: "var(--space-lg)" }}>
          <h2 class="portal-card__title">Your Project Manager</h2>
          <div class="portal-pm">
            <div class="portal-pm__name">{landing.project_manager.assigned_to_name}</div>
            {landing.project_manager.assigned_to_phone && (
              <div>
                <a href={`tel:${landing.project_manager.assigned_to_phone.replace(/\D/g, "")}`}>
                  📞 {landing.project_manager.assigned_to_phone}
                </a>
              </div>
            )}
            {landing.project_manager.assigned_to_email && (
              <div>
                <a href={`mailto:${landing.project_manager.assigned_to_email}`}>
                  📧 {landing.project_manager.assigned_to_email}
                </a>
              </div>
            )}
          </div>
        </section>
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
            class={`portal-tab${activeTab === t ? " portal-tab--active" : ""}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      <main class="portal-content">
        {activeTab === "photos" && <PhotosTab token={token} />}
        {activeTab === "schedule" && <ScheduleTab token={token} />}
        {activeTab === "invoices" && (
          <InvoicesTab token={token} onHold={landing.on_hold} onPaid={reload} />
        )}
        {activeTab === "budget" && <BudgetTab token={token} />}
        {activeTab === "change_orders" && <ChangeOrdersTab token={token} />}
        {activeTab === "selections" && <SelectionsTab />}
        {activeTab === "documents" && <DocumentsTab token={token} />}
        {activeTab === "completion" && <CompletionPackageTab token={token} />}
        {activeTab === "warranty" && <WarrantyClaimsTab />}
        {activeTab === "messages" && <MessagesTab token={token} />}
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
