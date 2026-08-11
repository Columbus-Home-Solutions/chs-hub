import type { RoutableProps } from "preact-router";
import { useState, useRef, useEffect } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { api, ApiError } from "../../api";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { Timeline } from "../../components/Timeline";
import { ClientForm } from "./ClientForm";
import { useToast } from "../../store/toast";
import { formatCurrency, formatDate, formatPhone, formatStatus } from "../../lib/format";
import { go } from "../../lib/nav";
import {
  COMM_CHANNELS,
  type Client,
  type ClientContact,
  type ClientTag,
  type Communication,
  type EstimateRequestLite,
  type JobLite,
  type Property,
  type ReferralSource,
  type TagDefinition,
} from "../../types";

interface GoogleReviewLite {
  id: string;
  star_rating: number;
  comment_text: string | null;
  review_created_at: string;
  reply_text: string | null;
  match_confidence: string | null;
}

interface EstimateLite {
  id: string;
  estimate_number: number | null;
  title: string | null;
  status: string;
  total: number | null;
  subtotal: number | null;
  client_signature: string | null;
  viewed_date: string | null;
  sent_at: string | null;
  created_at: string;
}

interface InvoiceLite {
  id: string;
  invoice_number: number | null;
  title: string | null;
  job_id: string | null;
  amount: number | null;
  total_due: number | null;
  status: string | null;
  due_date: string | null;
  created_at: string;
}

interface PaymentLite {
  id: string;
  invoice_id: string;
  amount: number;
  received_date: string | null;
  created_at: string;
  invoice_number: number | null;
}

interface DetailResponse {
  client: Client;
  properties: Property[];
  jobs: JobLite[];
  contacts: ClientContact[];
  tags: ClientTag[];
  estimate_requests: EstimateRequestLite[];
  quotes: EstimateLite[];
  invoices: InvoiceLite[];
  payments: PaymentLite[];
  google_reviews: GoogleReviewLite[];
}

interface CommsResponse {
  communications: Communication[];
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function ClientStatusBadge({ activeJobs }: { activeJobs: number }) {
  if (activeJobs > 0) {
    return <Badge tone="success">Active</Badge>;
  }
  return <Badge tone="neutral">Past</Badge>;
}

// ─── Tags widget ─────────────────────────────────────────────────────────────

function TagsWidget({
  clientId,
  tags,
  onChanged,
}: {
  clientId: string;
  tags: ClientTag[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [suggestions, setSuggestions] = useState<TagDefinition[]>([]);
  const [allTags, setAllTags] = useState<TagDefinition[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!adding) return;
    api.get<{ tags: TagDefinition[] }>("/api/tags").then((res) => {
      setAllTags(res.tags.filter((t) => !t.archived));
    });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [adding]);

  useEffect(() => {
    const q = tagInput.trim().toLowerCase();
    if (!q) {
      setSuggestions(allTags.filter((t) => !tags.some((ct) => ct.id === t.id)));
    } else {
      setSuggestions(
        allTags.filter(
          (t) => t.tag_text.toLowerCase().includes(q) && !tags.some((ct) => ct.id === t.id),
        ),
      );
    }
  }, [tagInput, allTags, tags]);

  const assign = async (tagId?: string, tagText?: string) => {
    try {
      await api.post(`/api/clients/${clientId}/tags`, tagId ? { tag_definition_id: tagId } : { tag_text: tagText });
      setAdding(false);
      setTagInput("");
      onChanged();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const remove = async (tagId: string) => {
    try {
      await api.del(`/api/clients/${clientId}/tags/${tagId}`);
      onChanged();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  return (
    <div>
      <div class="flex items-center gap-xs flex-wrap" style={{ marginBottom: "var(--space-xs)" }}>
        {tags.map((t) => (
          <span
            key={t.id}
            class="badge badge--brand"
            style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
          >
            {t.tag_text}
            <button
              type="button"
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, fontSize: "12px", opacity: 0.7 }}
              onClick={() => void remove(t.id)}
              title="Remove tag"
            >
              ×
            </button>
          </span>
        ))}
        {tags.length === 0 && <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>No tags</span>}
      </div>
      {adding ? (
        <div style={{ position: "relative" }}>
          <input
            ref={inputRef}
            class="form-input"
            style={{ fontSize: "var(--text-sm)" }}
            value={tagInput}
            placeholder="Search or create a tag…"
            onInput={(e) => setTagInput((e.target as HTMLInputElement).value)}
          />
          <div class="typeahead" style={{ position: "static", marginTop: "2px" }}>
            {suggestions.slice(0, 6).map((t) => (
              <button
                key={t.id}
                type="button"
                class="typeahead__item"
                onClick={() => void assign(t.id)}
              >
                {t.tag_text}
              </button>
            ))}
            {tagInput.trim() && !suggestions.some((t) => t.tag_text.toLowerCase() === tagInput.trim().toLowerCase()) && (
              <button
                type="button"
                class="typeahead__item"
                onClick={() => void assign(undefined, tagInput.trim())}
              >
                Create "{tagInput.trim()}"
              </button>
            )}
          </div>
          <Button size="sm" variant="tertiary" onClick={() => { setAdding(false); setTagInput(""); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="tertiary" onClick={() => setAdding(true)}>
          + Add tag
        </Button>
      )}
    </div>
  );
}

// ─── Referral Source widget ───────────────────────────────────────────────────

function ReferralSourceWidget({
  clientId,
  currentSource,
  onChanged,
}: {
  clientId: string;
  currentSource: { id: string; label: string } | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [sources, setSources] = useState<ReferralSource[]>([]);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");

  const load = async () => {
    const res = await api.get<{ referral_sources: ReferralSource[] }>("/api/referral-sources");
    setSources(res.referral_sources.filter((s) => !s.archived));
  };

  const save = async (id: string | null) => {
    try {
      await api.put(`/api/clients/${clientId}`, { referral_source_id: id });
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const createAndSave = async () => {
    if (!newLabel.trim()) return;
    try {
      const res = await api.post<{ referral_source: ReferralSource }>("/api/referral-sources", { label: newLabel.trim() });
      await save(res.referral_source.id);
      setCreating(false);
      setNewLabel("");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  if (!editing) {
    return (
      <div class="flex items-center gap-xs">
        <span style={{ fontSize: "var(--text-sm)" }}>{currentSource?.label ?? <span class="text--muted">Not set</span>}</span>
        <button
          type="button"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-primary)", fontSize: "var(--text-xs)" }}
          onClick={() => { setEditing(true); void load(); }}
        >
          {currentSource ? "Change" : "Set"}
        </button>
      </div>
    );
  }

  return (
    <div>
      {creating ? (
        <div class="flex gap-xs">
          <input
            class="form-input"
            style={{ fontSize: "var(--text-sm)" }}
            value={newLabel}
            placeholder="New source label…"
            onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
          />
          <Button size="sm" variant="primary" onClick={() => void createAndSave()}>Add</Button>
          <Button size="sm" variant="tertiary" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      ) : (
        <div class="stack" style={{ gap: "var(--space-xs)" }}>
          {currentSource && (
            <button type="button" class="typeahead__item" onClick={() => void save(null)}>
              Clear (none)
            </button>
          )}
          {sources.map((s) => (
            <button
              key={s.id}
              type="button"
              class={`typeahead__item${s.id === currentSource?.id ? " typeahead__item--active" : ""}`}
              onClick={() => void save(s.id)}
            >
              {s.label}
            </button>
          ))}
          <button type="button" class="typeahead__item" onClick={() => setCreating(true)}>
            + Add new source
          </button>
          <Button size="sm" variant="tertiary" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}

// ─── Contacts widget ──────────────────────────────────────────────────────────

function ContactsWidget({
  clientId,
  contacts,
  onChanged,
}: {
  clientId: string;
  contacts: ClientContact[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: "", contact_type: "phone" as "phone" | "email", value: "" });

  const save = async () => {
    if (!form.label.trim() || !form.value.trim()) {
      toast.push("error", "Label and value are required");
      return;
    }
    try {
      await api.post(`/api/clients/${clientId}/contacts`, form);
      setAdding(false);
      setForm({ label: "", contact_type: "phone", value: "" });
      onChanged();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.del(`/api/client-contacts/${id}`);
      onChanged();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  return (
    <div>
      {contacts.length > 0 && (
        <div>
          {expanded ? (
            <div class="stack" style={{ gap: "var(--space-xs)", marginBottom: "var(--space-xs)" }}>
              {contacts.map((c) => (
                <div key={c.id} class="flex items-center justify-between gap-sm">
                  <div style={{ fontSize: "var(--text-sm)" }}>
                    <span class="text--muted">{c.label}: </span>
                    {c.contact_type === "phone" ? formatPhone(c.value) : c.value}
                  </div>
                  <button
                    type="button"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)", fontSize: "var(--text-xs)" }}
                    onClick={() => void remove(c.id)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-primary)", fontSize: "var(--text-sm)", padding: 0 }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide" : `+${contacts.length} more contact${contacts.length > 1 ? "s" : ""}`}
          </button>
        </div>
      )}
      {adding ? (
        <div style={{ marginTop: "var(--space-sm)" }}>
          <div class="form-row">
            <FormField label="Label" inputProps={{ value: form.label, placeholder: "e.g. Spouse, Office", onInput: (e) => setForm((p) => ({ ...p, label: (e.target as HTMLInputElement).value })) }} />
            <FormField label="Type">
              <Select
                value={form.contact_type}
                onChange={(v) => setForm((p) => ({ ...p, contact_type: v as "phone" | "email" }))}
                options={[{ value: "phone", label: "Phone" }, { value: "email", label: "Email" }]}
              />
            </FormField>
          </div>
          <FormField label="Value" inputProps={{ value: form.value, placeholder: "Phone number or email", onInput: (e) => setForm((p) => ({ ...p, value: (e.target as HTMLInputElement).value })) }} />
          <div class="flex gap-xs">
            <Button size="sm" variant="primary" onClick={() => void save()}>Save</Button>
            <Button size="sm" variant="tertiary" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-primary)", fontSize: "var(--text-sm)", padding: 0, marginTop: contacts.length ? "var(--space-xs)" : 0 }}
          onClick={() => setAdding(true)}
        >
          + Add another contact
        </button>
      )}
    </div>
  );
}

// ─── Scrollable list helper ───────────────────────────────────────────────────

const LIST_SCROLL_STYLE: preact.JSX.CSSProperties = {
  maxHeight: "280px",
  overflowY: "auto",
};

// ─── Requests card ────────────────────────────────────────────────────────────

function RequestsCard({ requests }: { requests: EstimateRequestLite[] }) {
  return (
    <Card
      title={`Requests${requests.length > 0 ? ` (${requests.length})` : ""}`}
    >
      {requests.length === 0 ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>No open requests.</p>
      ) : (
        <div style={LIST_SCROLL_STYLE}>
          <div class="kv">
            {requests.map((r) => (
              <div
                key={r.id}
                class="kv__row"
                style={{ cursor: "pointer" }}
                onClick={() => go(`/estimating/${r.id}`)}
              >
                <span>
                  <span class="text--muted" style={{ fontSize: "var(--text-xs)", marginRight: "6px" }}>REQ</span>
                  {r.property_address ? `${r.property_address}, ${r.property_city}` : `#${r.request_number ?? "—"}`}
                </span>
                <span class="kv__value" style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
                  <Badge status={r.status}>{formatStatus(r.status)}</Badge>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Quotes card ──────────────────────────────────────────────────────────────

function QuotesCard({ quotes }: { quotes: EstimateLite[] }) {
  const quoteLabel = (q: EstimateLite) => {
    if (q.title) return q.title;
    if (q.estimate_number) return `Quote #${q.estimate_number}`;
    return "Untitled quote";
  };

  const quoteStatus = (q: EstimateLite) => {
    if (q.client_signature) return "signed";
    return q.status;
  };

  return (
    <Card title={`Quotes${quotes.length > 0 ? ` (${quotes.length})` : ""}`}>
      {quotes.length === 0 ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>No quotes yet.</p>
      ) : (
        <div style={LIST_SCROLL_STYLE}>
          <div class="kv">
            {quotes.map((q) => (
              <div
                key={q.id}
                class="kv__row"
                style={{ cursor: "pointer" }}
                onClick={() => go(`/estimates/${q.id}`)}
              >
                <span>
                  <span class="text--muted" style={{ fontSize: "var(--text-xs)", marginRight: "6px" }}>QTE</span>
                  {quoteLabel(q)}
                </span>
                <span class="kv__value" style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
                  {(q.total ?? q.subtotal) != null && (
                    <span>{formatCurrency((q.total ?? q.subtotal)!)}</span>
                  )}
                  <Badge status={quoteStatus(q)}>{formatStatus(quoteStatus(q))}</Badge>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Jobs card ────────────────────────────────────────────────────────────────

function JobsCard({ jobs }: { jobs: JobLite[] }) {
  return (
    <Card title={`Jobs${jobs.length > 0 ? ` (${jobs.length})` : ""}`}>
      {jobs.length === 0 ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>No jobs yet.</p>
      ) : (
        <div style={LIST_SCROLL_STYLE}>
          <div class="kv">
            {jobs.map((j) => (
              <div
                key={j.id}
                class="kv__row"
                style={{ cursor: "pointer" }}
                onClick={() => go(`/jobs/${j.id}`)}
              >
                <span>
                  <span class="text--muted" style={{ fontSize: "var(--text-xs)", marginRight: "6px" }}>JOB</span>
                  {j.title ?? `Job #${j.job_number ?? "—"}`}
                </span>
                <span class="kv__value" style={{ display: "flex", alignItems: "center", gap: "var(--space-xs)" }}>
                  {j.contract_total != null && (
                    <span>{formatCurrency(j.contract_total)}</span>
                  )}
                  <Badge status={j.status ?? undefined}>{formatStatus(j.status ?? "")}</Badge>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Invoices ledger card ─────────────────────────────────────────────────────

function InvoicesCard({
  invoices,
  payments,
  totalRevenue,
}: {
  invoices: InvoiceLite[];
  payments: PaymentLite[];
  totalRevenue: number;
}) {
  const totalPaid = payments.reduce((sum, p) => sum + (p.amount ?? 0), 0);
  const totalInvoiced = invoices.reduce((sum, i) => sum + (i.total_due ?? i.amount ?? 0), 0);
  const balance = totalInvoiced - totalPaid;

  type LedgerRow =
    | { kind: "invoice"; id: string; label: string; date: string; amount: number | null; status: string | null }
    | { kind: "payment"; id: string; label: string; date: string; amount: number; invoiceNum: number | null };

  const rows: LedgerRow[] = [
    ...invoices.map((inv): LedgerRow => ({
      kind: "invoice",
      id: inv.id,
      label: inv.title ?? (inv.invoice_number ? `Invoice #${inv.invoice_number}` : "Invoice"),
      date: inv.created_at,
      amount: inv.total_due ?? inv.amount,
      status: inv.status,
    })),
    ...payments.map((p): LedgerRow => ({
      kind: "payment",
      id: p.id,
      label: `Payment${p.invoice_number ? ` on Invoice #${p.invoice_number}` : ""}`,
      date: p.received_date ?? p.created_at,
      amount: p.amount,
      invoiceNum: p.invoice_number,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <Card title={`Invoices${invoices.length > 0 ? ` (${invoices.length})` : ""}`}>
      {rows.length === 0 ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>No invoices yet.</p>
      ) : (
        <>
          <div style={LIST_SCROLL_STYLE}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px 4px 0", fontWeight: 500, color: "var(--color-text-muted)" }}>Item</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", fontWeight: 500, color: "var(--color-text-muted)" }}>Date</th>
                  <th style={{ textAlign: "right", padding: "4px 0", fontWeight: 500, color: "var(--color-text-muted)" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    style={{ borderBottom: "1px solid var(--color-border-subtle)", cursor: row.kind === "invoice" ? "pointer" : "default" }}
                    onClick={() => row.kind === "invoice" && go(`/jobs/${(invoices.find(i => i.id === row.id))?.job_id}`)}
                  >
                    <td style={{ padding: "6px 8px 6px 0" }}>
                      <span class="text--muted" style={{ fontSize: "var(--text-xs)", marginRight: "6px" }}>
                        {row.kind === "invoice" ? "INV" : "PAY"}
                      </span>
                      {row.label}
                      {row.kind === "invoice" && row.status && (
                        <span style={{ marginLeft: "6px" }}>
                          <Badge status={row.status}>{formatStatus(row.status)}</Badge>
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "6px 8px", color: "var(--color-text-muted)" }}>
                      {formatDate(row.date)}
                    </td>
                    <td style={{ padding: "6px 0", textAlign: "right" }}>
                      <span style={{ color: row.kind === "payment" ? "var(--color-success, #16a34a)" : "inherit" }}>
                        {row.kind === "payment" ? "+" : ""}
                        {formatCurrency(row.amount ?? 0)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Pinned balance — not inside the scroll container */}
          <div style={{ borderTop: "2px solid var(--color-border)", marginTop: "var(--space-sm)", paddingTop: "var(--space-sm)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Current balance</span>
            <span style={{ fontWeight: 700, color: balance > 0 ? "var(--color-error, #dc2626)" : "var(--color-success, #16a34a)" }}>
              {formatCurrency(balance)}
            </span>
          </div>
        </>
      )}
      {rows.length === 0 && totalRevenue > 0 && (
        <p class="text--muted" style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-xs)", margin: 0 }}>
          Lifetime revenue: {formatCurrency(totalRevenue)}
        </p>
      )}
    </Card>
  );
}

// ─── Danger zone ─────────────────────────────────────────────────────────────

function DeleteClientCard({ client }: { client: Client }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/clients/${client.id}`);
      toast.push("success", "Client deleted");
      go("/clients");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Card title="Danger zone">
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-sm)" }}>
          Permanently remove this client, their estimates, and closed job history.
        </p>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete Client
        </Button>
      </Card>
      <Modal
        open={open}
        title="Delete client"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              Yes, delete
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Permanently delete {client.name}? All estimates and closed job history for this client will
          be deleted. This cannot be undone.
        </p>
      </Modal>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ClientDetail({ id }: RoutableProps & { id?: string }) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<DetailResponse>(id ? `/api/clients/${id}` : null);
  const comms = useApi<CommsResponse>(id ? `/api/clients/${id}/communications` : null);

  const [editing, setEditing] = useState(false);
  const [propModal, setPropModal] = useState<{ mode: "create" | "edit"; property?: Property } | null>(null);
  const [commModal, setCommModal] = useState(false);

  if (loading) return <Spinner center />;
  if (error || !data) return <div class="empty-state">Couldn't load client: {error ?? "not found"}</div>;

  const c = data.client;
  const lastComm = comms.data?.communications?.[0] ?? null;

  return (
    <div>
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div class="view-header">
        <div>
          <div class="flex items-center gap-sm flex-wrap">
            <h1 class="view-title" style={{ margin: 0 }}>
              {c.name}
              {c.company_name && <span class="text--muted"> — {c.company_name}</span>}
            </h1>
            <ClientStatusBadge activeJobs={c.active_jobs} />
            {c.is_repeat_client && <Badge tone="brand">Repeat</Badge>}
          </div>
          <p class="view-subtitle">
            {formatPhone(c.phone)} · {c.email ?? "—"}
          </p>
          {/* Primary contact info + extras */}
          <ContactsWidget
            clientId={c.id}
            contacts={data.contacts}
            onChanged={refetch}
          />
        </div>
        <div class="view-header__right flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => go(`/estimating/new?client_id=${c.id}&autostart=1`)}>
            + New Estimate
          </Button>
          <Button variant="tertiary" onClick={() => go("/clients")}>
            ← Back
          </Button>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
      </div>

      <div class="detail-grid">
        {/* ── Left / main column ───────────────────────────────────── */}
        <div class="stack">
          {/* Properties */}
          <Card
            title="Properties"
            actions={
              <Button size="sm" variant="secondary" onClick={() => setPropModal({ mode: "create" })}>
                + Add
              </Button>
            }
          >
            {data.properties.length === 0 ? (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
                No properties on file.
              </p>
            ) : (
              /* Contained horizontal scroll — same pattern as Estimates/Jobs lists.
                 Keeps Address/City/Type columns tabular at phone width without crushing. */
              <div class="table-container" style={{ border: "none", borderRadius: 0 }}>
                <table class="table" style={{ minWidth: "36rem" }}>
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>City</th>
                      <th>Type</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.properties.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <div>{p.address}</div>
                          {p.notes && (
                            <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>{p.notes}</div>
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {p.city}, {p.state} {p.zip}
                        </td>
                        <td>
                          {p.property_type ? <Badge tone="neutral">{p.property_type}</Badge> : <span class="text--muted">—</span>}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <div class="flex items-center gap-xs" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => go(`/estimating/new?client_id=${c.id}&property_id=${p.id}&autostart=1`)}
                            >
                              Estimate
                            </Button>
                            <Button
                              size="sm"
                              variant="tertiary"
                              onClick={() => setPropModal({ mode: "edit", property: p })}
                            >
                              Edit
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Requests */}
          <RequestsCard requests={data.estimate_requests} />

          {/* Quotes */}
          <QuotesCard quotes={data.quotes ?? []} />

          {/* Jobs */}
          <JobsCard jobs={data.jobs} />

          {/* Invoices ledger */}
          <InvoicesCard
            invoices={data.invoices ?? []}
            payments={data.payments ?? []}
            totalRevenue={c.total_revenue}
          />

          {/* Communication timeline */}
          <Card
            title="Communication timeline"
            actions={
              <Button size="sm" variant="secondary" onClick={() => setCommModal(true)}>
                + Log
              </Button>
            }
          >
            {comms.loading ? (
              <Spinner />
            ) : (
              <div style={{ maxHeight: "360px", overflowY: "auto" }}>
                <Timeline entries={comms.data?.communications ?? []} />
              </div>
            )}
          </Card>

          {c.can_delete && <DeleteClientCard client={c} />}
        </div>

        {/* ── Right / sidebar ──────────────────────────────────────── */}
        <div class="stack">
          {/* Overview card */}
          <Card title="Overview">
            <div class="kv">
              <div class="kv__row">
                <span class="kv__label">Lifetime value</span>
                <span class="kv__value metric metric--positive" style={{ fontSize: "var(--text-lg)" }}>
                  {formatCurrency(c.total_revenue)}
                </span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Total jobs</span>
                <span class="kv__value">{c.total_jobs}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Created</span>
                <span class="kv__value">{formatDate(c.created_at)}</span>
              </div>
            </div>
          </Card>

          {/* Tags */}
          <Card title="Tags">
            <TagsWidget clientId={c.id} tags={data.tags} onChanged={refetch} />
          </Card>

          {/* Referral source */}
          <Card title="Referral source">
            <ReferralSourceWidget
              clientId={c.id}
              currentSource={c.referral_source ?? null}
              onChanged={refetch}
            />
          </Card>

          {/* Last communication */}
          <Card title="Last communication">
            {lastComm ? (
              <div style={{ fontSize: "var(--text-sm)" }}>
                <div class="text--muted" style={{ marginBottom: "2px" }}>
                  {formatDate(lastComm.created_at)} · {lastComm.channel.replace(/_/g, " ")}
                </div>
                <div>{lastComm.summary}</div>
                {comms.data && comms.data.communications.length > 1 && (
                  <button
                    type="button"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-primary)", fontSize: "var(--text-sm)", padding: 0, marginTop: "4px" }}
                    onClick={() => document.querySelector(".detail-grid .stack .card:nth-child(2)")?.scrollIntoView({ behavior: "smooth" })}
                  >
                    See full timeline ↓
                  </button>
                )}
              </div>
            ) : (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
                No communications logged yet.
              </p>
            )}
          </Card>

          {/* Notes */}
          <Card title="Notes">
            {c.notes ? (
              <p style={{ margin: 0, fontSize: "var(--text-sm)", whiteSpace: "pre-wrap" }}>{c.notes}</p>
            ) : (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>No notes.</p>
            )}
            <Button size="sm" variant="tertiary" onClick={() => setEditing(true)} style={{ marginTop: "var(--space-xs)" }}>
              Edit
            </Button>
          </Card>

          {/* Details */}
          <Card title="Details">
            <div class="kv">
              <div class="kv__row">
                <span class="kv__label">Lead source</span>
                <span class="kv__value">{c.lead_source ?? "—"}</span>
              </div>
              {c.phone_secondary && (
                <div class="kv__row">
                  <span class="kv__label">Secondary phone</span>
                  <span class="kv__value">{formatPhone(c.phone_secondary)}</span>
                </div>
              )}
              <div class="kv__row">
                <span class="kv__label">Last interaction</span>
                <span class="kv__value">{formatDate(c.last_interaction_date)}</span>
              </div>
            </div>
          </Card>

          {/* Google Reviews — confirmed matches only, read-only (Sprint 36) */}
          {data.google_reviews?.length > 0 && (
            <Card title="Google Reviews">
              <div>
                {data.google_reviews.map((r) => (
                  <div key={r.id} style={{ paddingBottom: "var(--space-sm)", marginBottom: "var(--space-sm)", borderBottom: "1px solid var(--color-border)" }}>
                    <div class="flex items-center gap-xs flex-wrap" style={{ marginBottom: "2px" }}>
                      <span style={{ color: "#f59e0b", fontSize: "var(--text-sm)" }}>{"★".repeat(r.star_rating)}<span style={{ opacity: 0.25 }}>{"★".repeat(5 - r.star_rating)}</span></span>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>{formatDate(r.review_created_at)}</span>
                    </div>
                    {r.comment_text && (
                      <p style={{ margin: 0, fontSize: "var(--text-xs)", lineHeight: 1.5, color: "var(--color-text-secondary)" }}>
                        {r.comment_text.length > 120 ? `${r.comment_text.slice(0, 120)}…` : r.comment_text}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <Button size="sm" variant="tertiary" onClick={() => go("/social/reviews")} style={{ marginTop: "var(--space-xs)" }}>
                Manage in Reviews →
              </Button>
            </Card>
          )}
        </div>
      </div>

      {editing && (
        <ClientForm
          open={editing}
          mode="edit"
          initial={c}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refetch();
          }}
        />
      )}

      {propModal && id && (
        <PropertyModal
          clientId={id}
          mode={propModal.mode}
          property={propModal.property}
          onClose={() => setPropModal(null)}
          onSaved={() => {
            setPropModal(null);
            refetch();
            toast.push("success", "Property saved");
          }}
        />
      )}

      {commModal && id && (
        <CommunicationModal
          clientId={id}
          onClose={() => setCommModal(false)}
          onSaved={() => {
            setCommModal(false);
            comms.refetch();
            refetch();
            toast.push("success", "Communication logged");
          }}
        />
      )}
    </div>
  );
}

// ─── Property add/edit modal ──────────────────────────────────────────────────

function PropertyModal({
  clientId,
  mode,
  property,
  onClose,
  onSaved,
}: {
  clientId: string;
  mode: "create" | "edit";
  property?: Property;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [address, setAddress] = useState(property?.address ?? "");
  const [city, setCity] = useState(property?.city ?? "");
  const [state, setState] = useState(property?.state ?? "Arkansas");
  const [zip, setZip] = useState(property?.zip ?? "");
  const [propertyType, setPropertyType] = useState(property?.property_type ?? "");
  const [notes, setNotes] = useState(property?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!address.trim() || !city.trim() || !zip.trim()) {
      toast.push("error", "Address, city and ZIP are required");
      return;
    }
    setBusy(true);
    try {
      const body = { address, city, state, zip, property_type: propertyType, notes };
      if (mode === "create") await api.post(`/api/clients/${clientId}/properties`, body);
      else await api.put(`/api/properties/${property!.id}`, body);
      onSaved();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={mode === "create" ? "Add Property" : "Edit Property"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <FormField
        label="Address"
        required
        inputProps={{ value: address, onInput: (e) => setAddress((e.target as HTMLInputElement).value) }}
      />
      <div class="form-row">
        <FormField
          label="City"
          required
          inputProps={{ value: city, onInput: (e) => setCity((e.target as HTMLInputElement).value) }}
        />
        <FormField
          label="State"
          inputProps={{ value: state, onInput: (e) => setState((e.target as HTMLInputElement).value) }}
        />
        <FormField
          label="ZIP"
          required
          inputProps={{ value: zip, onInput: (e) => setZip((e.target as HTMLInputElement).value) }}
        />
      </div>
      <FormField label="Property type">
        <Select
          value={propertyType}
          placeholder="—"
          onChange={setPropertyType}
          options={["residential", "commercial", "rental"].map((v) => ({ value: v, label: v }))}
        />
      </FormField>
      <FormField label="Notes" hint="Gate codes, dog warnings, access instructions…">
        <textarea
          class="form-textarea"
          value={notes}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
    </Modal>
  );
}

// ─── Communication log modal ──────────────────────────────────────────────────

export function CommunicationModal({
  clientId,
  jobId,
  onClose,
  onSaved,
}: {
  clientId: string;
  jobId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [channel, setChannel] = useState("phone_call");
  const [direction, setDirection] = useState("outbound");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!summary.trim()) {
      toast.push("error", "Summary is required");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/communications", {
        client_id: clientId,
        job_id: jobId,
        channel,
        direction,
        summary,
        body,
      });
      onSaved();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Log Communication"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Log"}
          </Button>
        </>
      }
    >
      <div class="form-row">
        <FormField label="Channel">
          <Select
            value={channel}
            onChange={setChannel}
            options={COMM_CHANNELS.map((v) => ({ value: v, label: v.replace(/_/g, " ") }))}
          />
        </FormField>
        <FormField label="Direction">
          <Select
            value={direction}
            onChange={setDirection}
            options={[
              { value: "outbound", label: "outbound" },
              { value: "inbound", label: "inbound" },
            ]}
          />
        </FormField>
      </div>
      <FormField
        label="Summary"
        required
        inputProps={{ value: summary, onInput: (e) => setSummary((e.target as HTMLInputElement).value) }}
      />
      <FormField label="Notes">
        <textarea
          class="form-textarea"
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
    </Modal>
  );
}
