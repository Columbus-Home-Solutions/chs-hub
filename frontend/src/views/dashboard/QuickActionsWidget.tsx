import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { go } from "../../lib/nav";
import { api, ApiError } from "../../api";
import { useMessageCenter } from "../../store/messageCenter";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../store/toast";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClientHit {
  id: string;
  name: string;
  phone: string;
}

interface JobHit {
  id: string;
  job_number: number | null;
  title: string | null;
  client_name: string | null;
}

// ─── Client search hook (shared by both modals) ───────────────────────────────

function useClientSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientHit[]>([]);
  const [selected, setSelected] = useState<ClientHit | null>(null);

  useEffect(() => {
    if (!query.trim() || selected) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const d = await api.get<{ clients: { id: string; first_name: string | null; last_name: string | null; phone: string | null }[] }>(
          `/api/clients?search=${encodeURIComponent(query)}&limit=8`,
        );
        setResults((d.clients ?? []).map((c) => ({
          id: c.id,
          name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Unknown",
          phone: c.phone ?? "",
        })));
      } catch { /* silent */ }
    }, 300);
    return () => clearTimeout(t);
  }, [query, selected]);

  const pick = (c: ClientHit) => { setSelected(c); setQuery(c.name); setResults([]); };
  const clear = () => { setSelected(null); setQuery(""); setResults([]); };

  return { query, setQuery, results, selected, pick, clear };
}

// ─── Client picker sub-component ─────────────────────────────────────────────

function ClientPicker({
  query,
  setQuery,
  results,
  selected,
  onPick,
  onClear,
  placeholder = "Search client by name or phone…",
}: {
  query: string;
  setQuery: (v: string) => void;
  results: ClientHit[];
  selected: ClientHit | null;
  onPick: (c: ClientHit) => void;
  onClear: () => void;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  if (selected) {
    return (
      <div class="quick-action-modal__selected-client">
        <span>{selected.name}</span>
        <button type="button" class="mc-new-compose__clear" onClick={onClear}>✕</button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <input
        ref={inputRef}
        class="form-input"
        placeholder={placeholder}
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        autoComplete="off"
      />
      {results.length > 0 && (
        <div class="mc-client-results">
          {results.map((r) => (
            <button key={r.id} type="button" class="mc-client-result" onClick={() => onPick(r)}>
              <span class="mc-client-result__name">{r.name}</span>
              <span class="mc-client-result__phone">{r.phone}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Job picker for "Invoice existing job" ────────────────────────────────────

function JobPicker({ onPick }: { onPick: (j: JobHit) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JobHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const d = await api.get<{ jobs: JobHit[] }>(
          `/api/jobs?q=${encodeURIComponent(query)}`,
        );
        setResults((d.jobs ?? []).slice(0, 10));
      } catch { /* silent */ }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    // Load recent jobs on mount
    api.get<{ jobs: JobHit[] }>("/api/jobs")
      .then((d) => setResults((d.jobs ?? []).slice(0, 10)))
      .catch(() => {});
  }, []);

  return (
    <div>
      <input
        ref={inputRef}
        class="form-input"
        placeholder="Search by job # or client name…"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        style={{ marginBottom: "var(--space-sm)" }}
        autoComplete="off"
      />
      <div class="quick-action-modal__job-list">
        {results.length === 0 && (
          <div class="text--muted" style={{ padding: "var(--space-sm)" }}>No jobs found.</div>
        )}
        {results.map((j) => (
          <button key={j.id} type="button" class="mc-client-result" onClick={() => onPick(j)}>
            <span class="mc-client-result__name">
              {j.job_number ? `JOB-${j.job_number}` : j.id.slice(0, 8)}
              {j.title ? ` — ${j.title}` : ""}
            </span>
            {j.client_name && <span class="mc-client-result__phone">{j.client_name}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── New Estimate modal ───────────────────────────────────────────────────────

function NewEstimateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { query, setQuery, results, selected, pick, clear } = useClientSearch();
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => { clear(); }, [clear]);
  useEffect(() => { if (!open) reset(); }, [open, reset]);

  const submit = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      const data = await api.post<{ estimate: { id: string } }>("/api/estimates", {
        client_id: selected.id,
      });
      onClose();
      go(`/estimates/${data.estimate.id}`);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Failed to create estimate");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="New Estimate"
      onClose={onClose}
      footer={
        <button
          type="button"
          class="btn btn--primary"
          disabled={!selected || submitting}
          onClick={() => void submit()}
        >
          {submitting ? "Creating…" : "Create & Open →"}
        </button>
      }
    >
      <p class="text--muted" style={{ marginBottom: "var(--space-sm)" }}>
        Select a client to start a blank estimate for them.
      </p>
      <ClientPicker
        query={query}
        setQuery={setQuery}
        results={results}
        selected={selected}
        onPick={pick}
        onClear={clear}
      />
    </Modal>
  );
}

// ─── Quick Job form (inside invoice chooser) ──────────────────────────────────

const BILLING_MODELS = [
  { value: "fixed_price", label: "Fixed Price" },
  { value: "trade_by_trade", label: "Trade-by-Trade" },
  { value: "cost_plus", label: "Cost-Plus" },
  { value: "per_line_item", label: "Per Line Item" },
];

function QuickJobForm({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { query, setQuery, results, selected, pick, clear } = useClientSearch();
  const [title, setTitle] = useState("");
  const [jobType, setJobType] = useState("Hourly / Simple Service");
  const [billingModel, setBillingModel] = useState("fixed_price");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    try {
      const data = await api.post<{ job: { id: string; job_number: number | null } }>(
        "/api/jobs/quick",
        {
          client_id: selected.id,
          title: title.trim() || undefined,
          job_type: jobType.trim() || undefined,
          billing_model: billingModel,
          property_address: address.trim() || undefined,
          property_city: city.trim() || undefined,
        },
      );
      onClose();
      go(`/jobs/${data.job.id}?tab=financial`);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Failed to create job");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="quick-action-modal__quick-job">
      <div class="form-field">
        <label class="form-label">Client *</label>
        <ClientPicker
          query={query}
          setQuery={setQuery}
          results={results}
          selected={selected}
          onPick={pick}
          onClear={clear}
        />
      </div>

      <div class="form-field">
        <label class="form-label">Job Title (optional)</label>
        <input
          class="form-input"
          placeholder="e.g. Monthly lawn care"
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="form-field">
        <label class="form-label">Job Type</label>
        <input
          class="form-input"
          value={jobType}
          onInput={(e) => setJobType((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="form-field">
        <label class="form-label">Billing Model</label>
        <select
          class="form-select"
          value={billingModel}
          onChange={(e) => setBillingModel((e.target as HTMLSelectElement).value)}
        >
          {BILLING_MODELS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-sm)" }}>
        <div class="form-field">
          <label class="form-label">Street Address (optional)</label>
          <input
            class="form-input"
            placeholder="123 Main St"
            value={address}
            onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="form-field">
          <label class="form-label">City (optional)</label>
          <input
            class="form-input"
            placeholder="Little Rock"
            value={city}
            onInput={(e) => setCity((e.target as HTMLInputElement).value)}
          />
        </div>
      </div>

      <div style={{ marginTop: "var(--space-md)", display: "flex", gap: "var(--space-sm)", justifyContent: "flex-end" }}>
        <button type="button" class="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button
          type="button"
          class="btn btn--primary"
          disabled={!selected || submitting}
          onClick={() => void submit()}
        >
          {submitting ? "Creating…" : "Create Job →"}
        </button>
      </div>
    </div>
  );
}

// ─── New Invoice chooser modal ────────────────────────────────────────────────

type InvoiceView = "choose" | "existing_job" | "quick_job";

function NewInvoiceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<InvoiceView>("choose");
  useEffect(() => { if (!open) setView("choose"); }, [open]);

  return (
    <Modal
      open={open}
      title={view === "quick_job" ? "Quick Job" : view === "existing_job" ? "Invoice Existing Job" : "New Invoice"}
      onClose={onClose}
    >
      {view === "choose" && (
        <div class="quick-action-modal__chooser">
          <button
            type="button"
            class="quick-action-modal__choice"
            onClick={() => setView("existing_job")}
          >
            <span class="quick-action-modal__choice-icon">📋</span>
            <div>
              <div class="quick-action-modal__choice-title">Invoice an existing job</div>
              <div class="quick-action-modal__choice-desc">Pick a job and go to its Financial tab</div>
            </div>
            <span class="quick-action-modal__choice-arrow">→</span>
          </button>
          <button
            type="button"
            class="quick-action-modal__choice"
            onClick={() => setView("quick_job")}
          >
            <span class="quick-action-modal__choice-icon">⚡</span>
            <div>
              <div class="quick-action-modal__choice-title">Quick Job</div>
              <div class="quick-action-modal__choice-desc">Hourly or ongoing billing — no estimate needed</div>
            </div>
            <span class="quick-action-modal__choice-arrow">→</span>
          </button>
        </div>
      )}

      {view === "existing_job" && (
        <JobPicker
          onPick={(j) => {
            onClose();
            go(`/jobs/${j.id}?tab=financial`);
          }}
        />
      )}

      {view === "quick_job" && (
        <QuickJobForm onClose={onClose} />
      )}
    </Modal>
  );
}

// ─── Main widget ──────────────────────────────────────────────────────────────

export function QuickActionsWidget() {
  const { openCompose } = useMessageCenter();
  const [showNewEstimate, setShowNewEstimate] = useState(false);
  const [showNewInvoice, setShowNewInvoice] = useState(false);

  return (
    <>
      <div class="quick-actions">
        <div class="quick-actions__header">Quick Actions</div>
        <div class="quick-actions__grid">
          {/* Original order preserved */}
          <button type="button" class="quick-actions__btn" onClick={() => go("/estimating/new")}>
            <span class="quick-actions__btn-icon">📋</span>
            <span class="quick-actions__btn-label">New Lead</span>
          </button>
          <button type="button" class="quick-actions__btn" onClick={() => setShowNewEstimate(true)}>
            <span class="quick-actions__btn-icon">📝</span>
            <span class="quick-actions__btn-label">New Estimate</span>
          </button>
          <button type="button" class="quick-actions__btn" onClick={() => go("/financial?tab=expenses&action=new")}>
            <span class="quick-actions__btn-icon">💰</span>
            <span class="quick-actions__btn-label">Log Expense</span>
          </button>
          <button type="button" class="quick-actions__btn" onClick={() => go("/photos?action=upload")}>
            <span class="quick-actions__btn-icon">📷</span>
            <span class="quick-actions__btn-label">Add Photo</span>
          </button>
          <button type="button" class="quick-actions__btn" onClick={() => setShowNewInvoice(true)}>
            <span class="quick-actions__btn-icon">🧾</span>
            <span class="quick-actions__btn-label">New Invoice</span>
          </button>
          <button type="button" class="quick-actions__btn" onClick={openCompose}>
            <span class="quick-actions__btn-icon">💬</span>
            <span class="quick-actions__btn-label">Send Message</span>
          </button>
        </div>
      </div>

      <NewEstimateModal open={showNewEstimate} onClose={() => setShowNewEstimate(false)} />
      <NewInvoiceModal open={showNewInvoice} onClose={() => setShowNewInvoice(false)} />
    </>
  );
}
