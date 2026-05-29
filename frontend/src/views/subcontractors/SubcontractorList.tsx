import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { api, ApiError } from "../../api";
import { Table, type Column } from "../../components/ui/Table";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { formatPhone } from "../../lib/format";
import { TRADES, type Subcontractor } from "../../types";

interface SubListResponse {
  total: number;
  trades: string[];
  subcontractors: Subcontractor[];
}

export function SubcontractorList(_props: RoutableProps) {
  const [trade, setTrade] = useState("");
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [modal, setModal] = useState<{ mode: "create" | "edit"; sub?: Subcontractor } | null>(null);

  const url = `/api/subcontractors${activeOnly ? "?active=1" : ""}`;
  const { data, loading, error, refetch } = useApi<SubListResponse>(url);

  const rows = useMemo(() => {
    let subs = data?.subcontractors ?? [];
    if (trade) subs = subs.filter((s) => (s.trade ?? "").toLowerCase() === trade.toLowerCase());
    const q = search.trim().toLowerCase();
    if (q) {
      subs = subs.filter((s) =>
        [s.company_name, s.contact_name, s.trade, s.phone, s.email]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    return subs;
  }, [data, trade, search]);

  const columns: Column<Subcontractor>[] = [
    {
      key: "company_name",
      header: "Company",
      sortValue: (s) => (s.company_name ?? "").toLowerCase(),
      render: (s) => <strong>{s.company_name ?? "—"}</strong>,
    },
    { key: "contact_name", header: "Contact", render: (s) => s.contact_name ?? "—" },
    {
      key: "trade",
      header: "Trade",
      sortValue: (s) => s.trade ?? "",
      render: (s) => (s.trade ? <Badge tone="info">{s.trade}</Badge> : "—"),
    },
    { key: "phone", header: "Phone", render: (s) => formatPhone(s.phone) },
    {
      key: "insurance_on_file",
      header: "Insurance",
      render: (s) => (s.insurance_on_file ? <Badge tone="success">Yes</Badge> : <Badge>No</Badge>),
    },
    {
      key: "w9_on_file",
      header: "W-9",
      render: (s) => (s.w9_on_file ? <Badge tone="success">Yes</Badge> : <Badge>No</Badge>),
    },
    {
      key: "is_active",
      header: "Active",
      render: (s) => (s.is_active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>),
    },
  ];

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Subcontractors</h1>
          <p class="view-subtitle">{data ? `${data.total} subs` : "Subcontractor directory"}</p>
        </div>
        <div class="view-header__right">
          <Button variant="primary" onClick={() => setModal({ mode: "create" })}>
            + New Sub
          </Button>
        </div>
      </div>

      <div class="toolbar">
        <input
          class="form-input toolbar__search"
          type="search"
          placeholder="Search company, contact, phone…"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        <Select
          value={trade}
          placeholder="All trades"
          onChange={setTrade}
          options={TRADES.map((t) => ({ value: t, label: t }))}
        />
        <button
          class={`filter-pill${activeOnly ? " filter-pill--active" : ""}`}
          onClick={() => setActiveOnly((v) => !v)}
        >
          {activeOnly ? "Active only" : "All statuses"}
        </button>
      </div>

      {loading && <Spinner center />}
      {error && <div class="empty-state">Couldn't load subcontractors: {error}</div>}
      {!loading && !error && rows.length === 0 && (
        <div class="empty-state">
          <div class="empty-state__icon">🔧</div>
          <div class="empty-state__title">No subcontractors</div>
          <div>Add your first sub to build the directory.</div>
        </div>
      )}
      {!loading && !error && rows.length > 0 && (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          onRowClick={(s) => setModal({ mode: "edit", sub: s })}
          initialSort="company_name"
        />
      )}

      {modal && (
        <SubForm
          mode={modal.mode}
          sub={modal.sub}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}

// ─── Create / edit modal ──────────────────────────────────────────────────────

function SubForm({
  mode,
  sub,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  sub?: Subcontractor;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [companyName, setCompanyName] = useState(sub?.company_name ?? "");
  const [contactName, setContactName] = useState(sub?.contact_name ?? "");
  const [tradeVal, setTradeVal] = useState(sub?.trade ?? "general");
  const [phone, setPhone] = useState(sub?.phone ?? "");
  const [email, setEmail] = useState(sub?.email ?? "");
  const [license, setLicense] = useState(sub?.license_number ?? "");
  const [insurance, setInsurance] = useState(sub?.insurance_on_file ?? false);
  const [w9, setW9] = useState(sub?.w9_on_file ?? false);
  const [active, setActive] = useState(sub?.is_active ?? true);
  const [notes, setNotes] = useState(sub?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!companyName.trim() || !tradeVal) {
      toast.push("error", "Company name and trade are required");
      return;
    }
    setBusy(true);
    try {
      const body = {
        company_name: companyName,
        contact_name: contactName,
        trade: tradeVal,
        phone,
        email,
        license_number: license,
        insurance_on_file: insurance,
        w9_on_file: w9,
        is_active: active,
        notes,
      };
      if (mode === "create") await api.post("/api/subcontractors", body);
      else await api.put(`/api/subcontractors/${sub!.id}`, body);
      toast.push("success", mode === "create" ? "Subcontractor created" : "Subcontractor updated");
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
      title={mode === "create" ? "New Subcontractor" : "Edit Subcontractor"}
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
      <div class="form-row">
        <FormField
          label="Company name"
          required
          inputProps={{
            value: companyName,
            onInput: (e) => setCompanyName((e.target as HTMLInputElement).value),
          }}
        />
        <FormField label="Trade" required>
          <Select
            value={tradeVal}
            onChange={setTradeVal}
            options={TRADES.map((t) => ({ value: t, label: t }))}
          />
        </FormField>
      </div>
      <FormField
        label="Contact name"
        inputProps={{
          value: contactName,
          onInput: (e) => setContactName((e.target as HTMLInputElement).value),
        }}
      />
      <div class="form-row">
        <FormField
          label="Phone"
          inputProps={{ value: phone, onInput: (e) => setPhone((e.target as HTMLInputElement).value) }}
        />
        <FormField
          label="Email"
          inputProps={{
            type: "email",
            value: email,
            onInput: (e) => setEmail((e.target as HTMLInputElement).value),
          }}
        />
      </div>
      <FormField
        label="License number"
        inputProps={{ value: license, onInput: (e) => setLicense((e.target as HTMLInputElement).value) }}
      />
      <div class="flex gap-lg flex-wrap mb-lg">
        <label class="flex items-center gap-sm" style={{ fontSize: "var(--text-sm)" }}>
          <input type="checkbox" checked={insurance} onChange={(e) => setInsurance((e.target as HTMLInputElement).checked)} />
          Insurance on file
        </label>
        <label class="flex items-center gap-sm" style={{ fontSize: "var(--text-sm)" }}>
          <input type="checkbox" checked={w9} onChange={(e) => setW9((e.target as HTMLInputElement).checked)} />
          W-9 on file
        </label>
        <label class="flex items-center gap-sm" style={{ fontSize: "var(--text-sm)" }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive((e.target as HTMLInputElement).checked)} />
          Active
        </label>
      </div>
      <FormField label="Notes">
        <textarea
          class="form-textarea"
          value={notes}
          onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
        />
      </FormField>
    </Modal>
  );
}
