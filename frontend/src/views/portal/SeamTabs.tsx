import { useEffect, useState } from "preact/hooks";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import { getJson, postJson, type PortalScheduleEntry, type PortalChangeOrder } from "./portalApi";

function Empty({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div class="portal-empty">
      <div class="portal-empty__icon">{icon}</div>
      <div class="portal-empty__title">{title}</div>
      <div class="quote-muted">{body}</div>
    </div>
  );
}

// ─── Schedule — read-only client view (Sprint 13) ──────────────────────────────
export function ScheduleTab({ token }: { token: string }) {
  const [rows, setRows] = useState<PortalScheduleEntry[] | null>(null);
  useEffect(() => {
    getJson<{ entries: PortalScheduleEntry[] }>(`/api/portal/${token}/schedule`)
      .then((r) => setRows(r.entries))
      .catch(() => setRows([]));
  }, [token]);

  if (!rows) return <div class="quote-muted">Loading schedule…</div>;
  if (rows.length === 0) {
    return <Empty icon="📅" title="No scheduled work yet" body="Your project schedule will appear here as work is planned." />;
  }
  return (
    <div class="portal-card">
      <h3 class="portal-card__title">Upcoming &amp; scheduled work</h3>
      {rows.map((e) => (
        <div class="portal-invoice__history-row" key={e.id}>
          <span>
            {formatDate(e.scheduled_date)} · {e.trade_or_work}
            {e.start_time ? ` · ${e.start_time}${e.end_time ? `–${e.end_time}` : ""}` : ""}
          </span>
          <span>{formatStatus(e.status)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Change Orders — list + in-portal signature (Sprint 13) ────────────────────
export function ChangeOrdersTab({ token }: { token: string }) {
  const [rows, setRows] = useState<PortalChangeOrder[] | null>(null);
  const [signing, setSigning] = useState<PortalChangeOrder | null>(null);

  const load = () => {
    getJson<{ change_orders: PortalChangeOrder[] }>(`/api/portal/${token}/change-orders`)
      .then((r) => setRows(r.change_orders))
      .catch(() => setRows([]));
  };
  useEffect(load, [token]);

  if (!rows) return <div class="quote-muted">Loading change orders…</div>;
  if (rows.length === 0) {
    return (
      <Empty
        icon="🧾"
        title="No change orders"
        body="Any changes to your project's scope or budget will appear here for your review and signature."
      />
    );
  }

  return (
    <div class="portal-card">
      <h3 class="portal-card__title">Change Orders</h3>
      {rows.map((c) => (
        <div class="portal-co" key={c.id}>
          <div class="portal-co__head">
            <div>
              <strong>{c.display}</strong> · {c.title}
            </div>
            <span class={`portal-status portal-status--${c.status ?? "sent"}`}>{formatStatus(c.status)}</span>
          </div>
          {c.description && <div class="quote-muted portal-co__desc">{c.description}</div>}
          <div class="portal-co__meta">
            <span>{c.is_credit ? "Credit: " : "Amount: "}{formatCurrency(c.amount)}</span>
            {c.end_date_extension_days > 0 && <span> · Adds {c.end_date_extension_days} day(s) to the timeline</span>}
            {c.status === "approved" && c.signed_name && (
              <span> · Signed by {c.signed_name}{c.approved_date ? ` on ${formatDate(c.approved_date)}` : ""}</span>
            )}
          </div>
          {c.can_sign && (
            <button class="quote-btn quote-btn--primary portal-co__sign" onClick={() => setSigning(c)}>
              Review &amp; sign
            </button>
          )}
        </div>
      ))}

      {signing && (
        <SignModal
          token={token}
          co={signing}
          onClose={() => setSigning(null)}
          onSigned={() => {
            setSigning(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function SignModal({
  token,
  co,
  onClose,
  onSigned,
}: {
  token: string;
  co: PortalChangeOrder;
  onClose: () => void;
  onSigned: () => void;
}) {
  const [name, setName] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !agree) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/portal/${token}/change-orders/${co.id}/sign`, {
        signature: name.trim(),
        signed_name: name.trim(),
      });
      onSigned();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="portal-sign-backdrop" onClick={onClose}>
      <div class="portal-sign-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{co.display}: {co.title}</h3>
        {co.description && <p class="quote-muted">{co.description}</p>}
        <div class="portal-co__meta" style={{ marginBottom: "var(--space-md)" }}>
          <div>{co.is_credit ? "Credit" : "Additional cost"}: <strong>{formatCurrency(co.amount)}</strong></div>
          {co.end_date_extension_days > 0 && (
            <div>Timeline impact: +{co.end_date_extension_days} day(s)</div>
          )}
        </div>
        <p class="quote-muted" style={{ fontSize: "var(--text-sm)" }}>
          By typing your full name below and approving, you authorize this change to your project's
          scope{co.is_credit ? "" : " and contract total"}.
        </p>
        <input
          class="quote-input"
          placeholder="Type your full name to sign"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <label class="quote-check" style={{ marginTop: "var(--space-sm)" }}>
          <input type="checkbox" checked={agree} onChange={(e) => setAgree((e.target as HTMLInputElement).checked)} />
          <span>I approve this change order.</span>
        </label>
        {error && <div class="quote-error" style={{ marginTop: "var(--space-sm)" }}>{error}</div>}
        <div class="flex gap-sm" style={{ marginTop: "var(--space-lg)", justifyContent: "flex-end" }}>
          <button class="quote-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button class="quote-btn quote-btn--primary" onClick={submit} disabled={!name.trim() || !agree || busy}>
            {busy ? "Submitting…" : "Sign & approve"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Documents — read-only, grouped by category (Sprint 15) ───────────────────
interface PortalDoc {
  id: string;
  title: string | null;
  file_type: string | null;
  document_category: string;
  is_signed: number | null;
  created_at: string | null;
}

const DOC_CATEGORY_LABELS: Record<string, string> = {
  contract: "Contracts",
  working_agreement: "Working Agreements",
  selection_approval: "Selection Approvals",
  change_order: "Change Orders",
  permit: "Permits",
  plan_drawing: "Plans & Drawings",
  invoice: "Invoices",
  lien_waiver: "Lien Waivers",
  photo_report: "Photo Reports",
  other: "Other",
};

export function DocumentsTab({ token }: { token: string }) {
  const [groups, setGroups] = useState<Record<string, PortalDoc[]> | null>(null);
  useEffect(() => {
    getJson<{ groups: Record<string, PortalDoc[]> }>(`/api/portal/${token}/documents`)
      .then((r) => setGroups(r.groups ?? {}))
      .catch(() => setGroups({}));
  }, [token]);

  if (!groups) return <div class="quote-muted">Loading documents…</div>;
  const cats = Object.keys(groups);
  if (cats.length === 0) {
    return <Empty icon="📄" title="No documents yet" body="Your signed contract and shared documents will appear here." />;
  }
  return (
    <div class="portal-card">
      <h3 class="portal-card__title">Documents</h3>
      {cats.map((cat) => (
        <div key={cat} class="portal-doc-group">
          <div class="portal-doc-group__label">{DOC_CATEGORY_LABELS[cat] ?? formatStatus(cat)}</div>
          {groups[cat].map((d) => {
            const fileUrl = `/api/portal/${token}/documents/${d.id}/file`;
            const isReferenceDoc = d.document_category === "working_agreement";
            const canView = !!d.is_signed || isReferenceDoc;
            return (
              <div class="portal-invoice__history-row" key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  {canView ? (
                    <a href={fileUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
                      {d.title ?? "Document"}
                    </a>
                  ) : (
                    d.title ?? "Document"
                  )}
                  {d.is_signed ? (
                    <span class="portal-status portal-status--paid" style={{ marginLeft: "8px", fontSize: "0.75rem" }}>✓ Signed</span>
                  ) : isReferenceDoc ? (
                    <span class="portal-status portal-status--reference" style={{ marginLeft: "8px", fontSize: "0.75rem" }}>Reference</span>
                  ) : null}
                </span>
                <span class="flex gap-sm" style={{ alignItems: "center" }}>
                  <span class="quote-muted" style={{ fontSize: "0.8rem" }}>{d.created_at ? formatDate(d.created_at) : ""}</span>
                  {canView ? (
                    <a
                      href={fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="quote-btn"
                      style={{ fontSize: "0.75rem", padding: "2px 10px" }}
                    >
                      View
                    </a>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Completion Package — sent HTML artifact, printable (Sprint 15) ────────────
// Only mounted when landing.completion_package_available (owner has sent it).
export function CompletionPackageTab({ token }: { token: string }) {
  const src = `/api/portal/${token}/completion-package`;
  return (
    <div class="portal-card">
      <div class="flex gap-sm" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 class="portal-card__title" style={{ margin: 0 }}>Project Completion Package</h3>
        <button class="quote-btn" onClick={() => window.open(src, "_blank")}>Open &amp; print</button>
      </div>
      <p class="quote-muted" style={{ marginTop: "var(--space-sm)" }}>
        Your finished-project summary — documents, photos, and financials. Use your browser's
        “Save as PDF” to keep a copy.
      </p>
      <iframe
        title="Completion package"
        src={src}
        style={{ width: "100%", height: "70vh", border: "1px solid var(--line, #e3e8ee)", borderRadius: "8px", background: "#fff" }}
      />
    </div>
  );
}
