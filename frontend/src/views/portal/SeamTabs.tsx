import { useEffect, useState } from "preact/hooks";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import { getJson } from "./portalApi";

function Empty({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div class="portal-empty">
      <div class="portal-empty__icon">{icon}</div>
      <div class="portal-empty__title">{title}</div>
      <div class="quote-muted">{body}</div>
    </div>
  );
}

// ─── Schedule — Sprint 13 seam (read-only; data lands in S13) ──────────────────
export function ScheduleTab({ token }: { token: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    getJson<{ entries: any[] }>(`/api/portal/${token}/schedule`)
      .then((r) => setRows(r.entries))
      .catch(() => setRows([]));
  }, [token]);

  if (rows && rows.length > 0) {
    return (
      <div class="portal-card">
        <h3 class="portal-card__title">Schedule</h3>
        {rows.map((e, i) => (
          <div class="portal-invoice__history-row" key={i}>
            <span>{formatDate(e.scheduled_date)} · {e.trade_or_work}</span>
            <span>{formatStatus(e.status)}</span>
          </div>
        ))}
      </div>
    );
  }
  return <Empty icon="📅" title="Schedule coming soon" body="Your project schedule will appear here soon." />;
}

// ─── Change Orders — Sprint 13 seam (read-only; signing lands in S13) ──────────
export function ChangeOrdersTab({ token }: { token: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    getJson<{ change_orders: any[] }>(`/api/portal/${token}/change-orders`)
      .then((r) => setRows(r.change_orders))
      .catch(() => setRows([]));
  }, [token]);

  if (rows && rows.length > 0) {
    return (
      <div class="portal-card">
        <h3 class="portal-card__title">Change Orders</h3>
        {rows.map((c, i) => (
          <div class="portal-invoice__history-row" key={i}>
            <span>CO-{c.change_order_number} · {c.title}</span>
            <span>{formatCurrency(c.amount)} · {formatStatus(c.status)}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <Empty
      icon="🧾"
      title="No change orders"
      body="Any changes to your project's scope or budget will appear here for your review."
    />
  );
}

// ─── Documents — read-only (full Document Management is Sprint 15) ─────────────
export function DocumentsTab({ token }: { token: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    getJson<{ documents: any[] }>(`/api/portal/${token}/documents`)
      .then((r) => setRows(r.documents))
      .catch(() => setRows([]));
  }, [token]);

  if (!rows) return <div class="quote-muted">Loading documents…</div>;
  if (rows.length === 0) {
    return <Empty icon="📄" title="No documents yet" body="Your signed contract and shared documents will appear here." />;
  }
  return (
    <div class="portal-card">
      <h3 class="portal-card__title">Documents</h3>
      {rows.map((d, i) => (
        <div class="portal-invoice__history-row" key={i}>
          <span>
            {d.title ?? "Document"}
            {d.is_signed ? " · Signed" : ""}
          </span>
          <span class="quote-muted">{formatStatus(d.document_category) || formatStatus(d.file_type)}</span>
        </div>
      ))}
    </div>
  );
}
