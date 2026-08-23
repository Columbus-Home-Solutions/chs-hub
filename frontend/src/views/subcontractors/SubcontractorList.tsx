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
import { go } from "../../lib/nav";
import { TRADES, type Subcontractor } from "../../types";

/** Returns days until the given ISO date (negative = already expired). */
export function daysUntilExpiration(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(`${isoDate}T00:00:00`);
  return Math.round((exp.getTime() - today.getTime()) / 86_400_000);
}

/** Badge that shows expiration status for COI/license dates. */
export function ExpirationBadge({ date }: { date: string | null }) {
  if (!date) return <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>—</span>;
  const days = daysUntilExpiration(date);
  if (days === null) return <span class="text--muted">—</span>;
  if (days < 0) return <Badge tone="danger">Expired</Badge>;
  if (days <= 15) return <Badge tone="danger">{days}d left</Badge>;
  if (days <= 30) return <Badge tone="warning">{days}d left</Badge>;
  return <span style={{ fontSize: "var(--text-sm)" }}>{date}</span>;
}

interface SubListResponse {
  total: number;
  trades: string[];
  subcontractors: Subcontractor[];
}

export function SubcontractorList(_props: RoutableProps) {
  return <PeopleDirectory workerType="subcontractor" />;
}

export function LaborDirectory(_props: RoutableProps) {
  return <PeopleDirectory workerType="day_rate_labor" />;
}

function PeopleDirectory({ workerType }: { workerType: "subcontractor" | "day_rate_labor" }) {
  const isLabor = workerType === "day_rate_labor";
  const [trade, setTrade] = useState("");
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [modal, setModal] = useState<{ mode: "create" | "edit"; sub?: Subcontractor } | null>(null);

  const url = `/api/subcontractors?worker_type=${workerType}${activeOnly ? "&active=1" : ""}`;
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
      header: isLabor ? "Name" : "Company",
      sortValue: (s) => (s.company_name ?? "").toLowerCase(),
      render: (s) => <strong>{s.company_name ?? "—"}</strong>,
    },
    { key: "contact_name", header: "Contact", render: (s) => s.contact_name ?? "—" },
    ...(isLabor
      ? [
          {
            key: "day_rate",
            header: "Day Rate",
            sortValue: (s: Subcontractor) => s.day_rate ?? 0,
            render: (s: Subcontractor) =>
              s.day_rate != null ? `$${Number(s.day_rate).toFixed(2)}` : "—",
          } as Column<Subcontractor>,
        ]
      : [
          {
            key: "trade",
            header: "Trade",
            sortValue: (s: Subcontractor) => s.trade ?? "",
            render: (s: Subcontractor) => (s.trade ? <Badge tone="info">{s.trade}</Badge> : "—"),
          } as Column<Subcontractor>,
        ]),
    { key: "phone", header: "Phone", render: (s) => formatPhone(s.phone) },
    ...(isLabor
      ? [
          {
            key: "w9_on_file",
            header: "W-9",
            render: (s: Subcontractor) =>
              s.w9_on_file ? <Badge tone="success">Yes</Badge> : <Badge>No</Badge>,
          } as Column<Subcontractor>,
        ]
      : [
          {
            key: "insurance_on_file",
            header: "Insurance",
            render: (s: Subcontractor) =>
              s.insurance_on_file ? <Badge tone="success">Yes</Badge> : <Badge>No</Badge>,
          } as Column<Subcontractor>,
          {
            key: "w9_on_file",
            header: "W-9",
            render: (s: Subcontractor) =>
              s.w9_on_file ? <Badge tone="success">Yes</Badge> : <Badge>No</Badge>,
          } as Column<Subcontractor>,
          {
            key: "coi_expiration_date",
            header: "COI Exp.",
            render: (s: Subcontractor) => <ExpirationBadge date={s.coi_expiration_date} />,
          } as Column<Subcontractor>,
          {
            key: "license_expiration_date",
            header: "License Exp.",
            render: (s: Subcontractor) => <ExpirationBadge date={s.license_expiration_date} />,
          } as Column<Subcontractor>,
        ]),
    {
      key: "is_active",
      header: "Active",
      render: (s) => (s.is_active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>),
    },
    {
      key: "actions",
      header: "",
      render: (s) => (
        <span
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <DeleteSubButton
            sub={s}
            size="sm"
            listBase={isLabor ? "/labor" : "/subcontractors"}
            onDeleted={() => refetch()}
          />
        </span>
      ),
    },
  ];

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">{isLabor ? "Day-Rate Labor" : "Subcontractors"}</h1>
          <p class="view-subtitle">
            {data
              ? `${data.total} ${isLabor ? "workers" : "subs"}`
              : isLabor
                ? "Day-rate labor directory"
                : "Subcontractor directory"}
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="primary" onClick={() => setModal({ mode: "create" })}>
            {isLabor ? "+ New Worker" : "+ New Sub"}
          </Button>
        </div>
      </div>

      <div class="toolbar">
        <input
          class="form-input toolbar__search"
          type="search"
          placeholder={isLabor ? "Search name, phone…" : "Search company, contact, phone…"}
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        {!isLabor && (
          <Select
            value={trade}
            placeholder="All trades"
            onChange={setTrade}
            options={TRADES.map((t) => ({ value: t, label: t }))}
          />
        )}
        <button
          class={`filter-pill${activeOnly ? " filter-pill--active" : ""}`}
          onClick={() => setActiveOnly((v) => !v)}
        >
          {activeOnly ? "Active only" : "All statuses"}
        </button>
      </div>

      {loading && <Spinner center />}
      {error && (
        <div class="empty-state">
          Couldn't load {isLabor ? "labor" : "subcontractors"}: {error}
        </div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div class="empty-state">
          <div class="empty-state__icon">{isLabor ? "👷" : "🔧"}</div>
          <div class="empty-state__title">{isLabor ? "No day-rate workers" : "No subcontractors"}</div>
          <div>{isLabor ? "Add your first day-rate worker." : "Add your first sub to build the directory."}</div>
        </div>
      )}
      {!loading && !error && rows.length > 0 && (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          onRowClick={(s) => go(isLabor ? `/labor/${s.id}` : `/subcontractors/${s.id}`)}
          initialSort="company_name"
        />
      )}

      {modal && (
        <SubForm
          mode={modal.mode}
          sub={modal.sub}
          defaultWorkerType={workerType}
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

export function SubForm({
  mode,
  sub,
  onClose,
  onSaved,
  defaultWorkerType = "subcontractor",
}: {
  mode: "create" | "edit";
  sub?: Subcontractor;
  onClose: () => void;
  onSaved: () => void;
  defaultWorkerType?: "subcontractor" | "day_rate_labor";
}) {
  const toast = useToast();
  const workerType = sub?.worker_type ?? defaultWorkerType;
  const isLabor = workerType === "day_rate_labor";
  const [companyName, setCompanyName] = useState(sub?.company_name ?? "");
  const [contactName, setContactName] = useState(sub?.contact_name ?? "");
  const [tradeVal, setTradeVal] = useState(sub?.trade ?? "general");
  const [dayRate, setDayRate] = useState(
    sub?.day_rate != null ? String(sub.day_rate) : "",
  );
  const [phone, setPhone] = useState(sub?.phone ?? "");
  const [email, setEmail] = useState(sub?.email ?? "");
  const [taxId, setTaxId] = useState(sub?.tax_id ?? "");
  const [license, setLicense] = useState(sub?.license_number ?? "");
  const [insurance, setInsurance] = useState(sub?.insurance_on_file ?? false);
  const [w9, setW9] = useState(sub?.w9_on_file ?? false);
  const [active, setActive] = useState(sub?.is_active ?? true);
  const [notes, setNotes] = useState(sub?.notes ?? "");
  const [coiExp, setCoiExp] = useState(sub?.coi_expiration_date ?? "");
  const [licenseExp, setLicenseExp] = useState(sub?.license_expiration_date ?? "");
  const [rating, setRating] = useState<string>(sub?.rating != null ? String(sub.rating) : "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!companyName.trim() || !tradeVal) {
      toast.push("error", isLabor ? "Name and trade are required" : "Company name and trade are required");
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
        tax_id: taxId,
        w9_on_file: w9,
        is_active: active,
        notes,
        rating: rating ? parseInt(rating, 10) : null,
        worker_type: workerType,
        day_rate: dayRate.trim() === "" ? null : Number(dayRate),
        ...(isLabor
          ? {}
          : {
              license_number: license,
              insurance_on_file: insurance,
              coi_expiration_date: coiExp || null,
              license_expiration_date: licenseExp || null,
            }),
      };
      if (mode === "create") await api.post("/api/subcontractors", body);
      else await api.put(`/api/subcontractors/${sub!.id}`, body);
      toast.push(
        "success",
        mode === "create"
          ? isLabor
            ? "Worker created"
            : "Subcontractor created"
          : isLabor
            ? "Worker updated"
            : "Subcontractor updated",
      );
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
      title={
        mode === "create"
          ? isLabor
            ? "New Day-Rate Worker"
            : "New Subcontractor"
          : isLabor
            ? "Edit Day-Rate Worker"
            : "Edit Subcontractor"
      }
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
          label={isLabor ? "Name" : "Company name"}
          required
          inputProps={{
            value: companyName,
            onInput: (e) => setCompanyName((e.target as HTMLInputElement).value),
          }}
        />
        {isLabor ? (
          <FormField
            label="Day Rate ($)"
            inputProps={{
              type: "number",
              step: "any",
              value: dayRate,
              onInput: (e) => setDayRate((e.target as HTMLInputElement).value),
            }}
          />
        ) : (
          <FormField label="Trade" required>
            <Select
              value={tradeVal}
              onChange={setTradeVal}
              options={TRADES.map((t) => ({ value: t, label: t }))}
            />
          </FormField>
        )}
      </div>
      {isLabor && (
        <FormField label="Trade">
          <Select
            value={tradeVal}
            onChange={setTradeVal}
            options={TRADES.map((t) => ({ value: t, label: t }))}
          />
        </FormField>
      )}
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
        label={isLabor ? "Social Security Number" : "Tax ID / EIN"}
        inputProps={{
          value: taxId,
          placeholder: isLabor ? "XXX-XX-XXXX" : "XX-XXXXXXX",
          onInput: (e) => setTaxId((e.target as HTMLInputElement).value),
        }}
      />
      {!isLabor && (
        <>
          <FormField
            label="License number"
            inputProps={{
              value: license,
              onInput: (e) => setLicense((e.target as HTMLInputElement).value),
            }}
          />
          <div class="form-row">
            <FormField label="COI Expiration Date" hint="Leave blank if not on file">
              <input
                class="form-input"
                type="date"
                value={coiExp}
                onInput={(e) => setCoiExp((e.target as HTMLInputElement).value)}
              />
            </FormField>
            <FormField label="License Expiration Date" hint="Leave blank if not applicable">
              <input
                class="form-input"
                type="date"
                value={licenseExp}
                onInput={(e) => setLicenseExp((e.target as HTMLInputElement).value)}
              />
            </FormField>
          </div>
        </>
      )}
      <div class="flex gap-lg flex-wrap mb-lg">
        {!isLabor && (
          <label class="flex items-center gap-sm" style={{ fontSize: "var(--text-sm)" }}>
            <input
              type="checkbox"
              checked={insurance}
              onChange={(e) => setInsurance((e.target as HTMLInputElement).checked)}
            />
            Insurance on file
          </label>
        )}
        <label class="flex items-center gap-sm" style={{ fontSize: "var(--text-sm)" }}>
          <input type="checkbox" checked={w9} onChange={(e) => setW9((e.target as HTMLInputElement).checked)} />
          W-9 on file
        </label>
        <label class="flex items-center gap-sm" style={{ fontSize: "var(--text-sm)" }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive((e.target as HTMLInputElement).checked)} />
          Active
        </label>
      </div>
      <FormField label="Internal rating" hint="1–5 — internal reference only, not shown to clients">
        <Select
          value={rating}
          onChange={setRating}
          options={[
            { value: "", label: "— unset —" },
            { value: "5", label: "★★★★★  5 — Excellent" },
            { value: "4", label: "★★★★☆  4 — Good" },
            { value: "3", label: "★★★☆☆  3 — Average" },
            { value: "2", label: "★★☆☆☆  2 — Below average" },
            { value: "1", label: "★☆☆☆☆  1 — Poor" },
          ]}
        />
      </FormField>
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

/** Hard-delete a sub/labor person with no history — same modal pattern as estimates/clients. */
export function DeleteSubButton({
  sub,
  size = "default",
  listBase,
  onDeleted,
}: {
  sub: Subcontractor;
  size?: "default" | "sm";
  /** Where to navigate after delete from detail; list passes onDeleted instead. */
  listBase?: "/labor" | "/subcontractors";
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isLabor = (sub.worker_type ?? "subcontractor") === "day_rate_labor";
  const label = sub.company_name || sub.contact_name || "this person";

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/subcontractors/${sub.id}`);
      toast.push("success", isLabor ? "Worker deleted" : "Subcontractor deleted");
      setOpen(false);
      if (onDeleted) onDeleted();
      else go(listBase ?? (isLabor ? "/labor" : "/subcontractors"));
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size={size === "sm" ? "sm" : undefined} variant="danger" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <Modal
        open={open}
        title={isLabor ? "Delete day-rate worker" : "Delete subcontractor"}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Yes, delete"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Delete <strong>{label}</strong>? This cannot be undone. If they have job or payment
          history, deactivate them instead.
        </p>
      </Modal>
    </>
  );
}
