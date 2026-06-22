import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Table, type Column } from "../../components/ui/Table";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatPhone } from "../../lib/format";
import type { Payer } from "../../types";

interface PayerListResponse {
  total: number;
  payers: Payer[];
}

export function PayerList(_props: RoutableProps) {
  const toast = useToast();
  const { data, loading, error, refetch } = useApi<PayerListResponse>("/api/payers");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    company_name: "",
    contact_name: "",
    email: "",
    phone: "",
  });
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => {
    const all = data?.payers ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((p) =>
      [p.company_name, p.contact_name, p.email, p.phone].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [data, search]);

  const columns: Column<Payer>[] = [
    {
      key: "company_name",
      header: "Company",
      sortValue: (p) => (p.company_name ?? p.contact_name).toLowerCase(),
      render: (p) => (
        <span>
          <strong>{p.company_name ?? "—"}</strong>
          {p.company_name && (
            <span class="text--muted" style={{ display: "block", fontSize: "var(--text-xs)" }}>
              {p.contact_name}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "contact_name",
      header: "Contact",
      sortValue: (p) => p.contact_name.toLowerCase(),
      render: (p) => p.contact_name,
    },
    { key: "email", header: "Email", render: (p) => p.email },
    { key: "phone", header: "Phone", render: (p) => formatPhone(p.phone) },
    { key: "job_count", header: "Jobs", sortValue: (p) => p.job_count, render: (p) => p.job_count },
    {
      key: "has_card_on_file",
      header: "Card on File",
      render: (p) =>
        p.has_card_on_file ? (
          <Badge tone="success">{p.card_brand ?? "Card"} ····{p.card_last4}</Badge>
        ) : (
          <Badge tone="neutral">No</Badge>
        ),
    },
  ];

  const createPayer = async () => {
    if (!form.contact_name.trim() || !form.email.trim()) {
      toast.push("error", "Contact name and email are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ payer: Payer }>("/api/payers", form);
      toast.push("success", "Payer created");
      setShowCreate(false);
      setForm({ company_name: "", contact_name: "", email: "", phone: "" });
      if (res.payer?.id) go(`/payers/${res.payer.id}`);
      else refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner center />;
  if (error) return <div class="empty-state">Couldn't load payers: {error}</div>;

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Payers</h1>
          <p class="view-subtitle">{data ? `${data.total} billing parties` : "Third-party payers"}</p>
        </div>
        <div class="view-header__right">
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            + New Payer
          </Button>
        </div>
      </div>

      <div class="toolbar" style={{ marginBottom: "var(--space-md)" }}>
        <input
          class="form-input"
          placeholder="Search payers…"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
      </div>

      <Table columns={columns} rows={rows} onRowClick={(p) => go(`/payers/${p.id}`)} />

      <Modal
        open={showCreate}
        title="New Payer"
        onClose={() => setShowCreate(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void createPayer()}>
              {saving ? "Saving…" : "Create Payer"}
            </Button>
          </>
        }
      >
        <FormField label="Company name">
          <input
            class="form-input"
            value={form.company_name}
            onInput={(e) => setForm((f) => ({ ...f, company_name: (e.target as HTMLInputElement).value }))}
          />
        </FormField>
        <FormField label="Contact name" required>
          <input
            class="form-input"
            value={form.contact_name}
            onInput={(e) => setForm((f) => ({ ...f, contact_name: (e.target as HTMLInputElement).value }))}
          />
        </FormField>
        <FormField label="Email" required>
          <input
            class="form-input"
            type="email"
            value={form.email}
            onInput={(e) => setForm((f) => ({ ...f, email: (e.target as HTMLInputElement).value }))}
          />
        </FormField>
        <FormField label="Phone">
          <input
            class="form-input"
            value={form.phone}
            onInput={(e) => setForm((f) => ({ ...f, phone: (e.target as HTMLInputElement).value }))}
          />
        </FormField>
      </Modal>
    </div>
  );
}
