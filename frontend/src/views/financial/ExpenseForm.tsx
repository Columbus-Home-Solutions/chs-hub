import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { Spinner } from "../../components/ui/Spinner";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import {
  EXPENSE_TYPE_OPTIONS,
  expenseTypeAllowsVendorLink,
} from "@chs/shared/expense-types";

/**
 * Shared expense field set + form (Sprint 10).
 *
 * Used by the Financial tab "+ Add Expense" modal AND the receipt-confirm seam
 * so a receipt-sourced expense lands in the SAME full form (estimate-line-item
 * alignment, tax category, sub picker) rather than a minimal stub.
 */

export { EXPENSE_TYPE_OPTIONS };

export interface CostingSubLineLite {
  id: string;
  description: string | null;
  category: string;
}
export interface CostingLineLite {
  line_item_id: string;
  name: string;
  sub_items: CostingSubLineLite[];
}

/** Flat alignment options: parent line items + sub-items (same as ExpenseFields). */
export function buildAlignOptions(lines: CostingLineLite[]): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [{ value: "", label: "— Unallocated —" }];
  for (const l of lines) {
    opts.push({ value: l.line_item_id, label: l.name });
    for (const s of l.sub_items) {
      opts.push({ value: s.id, label: `   ↳ ${s.description ?? s.category} (${s.category})` });
    }
  }
  return opts;
}

// IRS-leaning tax categories (capture only — the CPA export that consumes these
// is a later sprint).
export const TAX_CATEGORY_OPTIONS = [
  { value: "materials", label: "Materials" },
  { value: "subcontractors", label: "Subcontractors" },
  { value: "supplies", label: "Supplies" },
  { value: "equipment_rental", label: "Equipment rental" },
  { value: "vehicle", label: "Vehicle / fuel" },
  { value: "permits_fees", label: "Permits & fees" },
  { value: "labor", label: "Labor" },
  { value: "utilities", label: "Utilities" },
  { value: "other", label: "Other" },
];

/** Default tax category when the expense type chip changes (keeps badge + meta in sync). */
export const TAX_CATEGORY_BY_EXPENSE_TYPE: Record<string, string> = {
  material: "materials",
  subcontractor: "subcontractors",
  labor: "labor",
  permit: "permits_fees",
  equipment: "equipment_rental",
  vehicle: "vehicle",
  other: "other",
};

export interface ExpenseDraft {
  expense_type: string;
  vendor: string;
  amount: string;
  description: string;
  incurred_date: string;
  estimate_line_item_id: string; // parent or sub-item id, "" = unallocated
  tax_category: string;
  sub_id: string;
  save_to_price_book: boolean;
  material_name: string;
  material_unit: string;
}

export function emptyDraft(over: Partial<ExpenseDraft> = {}): ExpenseDraft {
  return {
    expense_type: "material",
    vendor: "",
    amount: "",
    description: "",
    incurred_date: new Date().toISOString().slice(0, 10),
    estimate_line_item_id: "",
    tax_category: "materials",
    sub_id: "",
    save_to_price_book: false,
    material_name: "",
    material_unit: "ea",
    ...over,
  };
}

/** Build the JSON body for POST/PUT /api/expenses (or the confirm seam). */
export function draftToBody(d: ExpenseDraft, jobId: string | null) {
  return {
    job_id: jobId,
    expense_type: d.expense_type,
    vendor: d.vendor.trim() || null,
    amount: Number(d.amount),
    description: d.description.trim() || null,
    incurred_date: d.incurred_date,
    estimate_line_item_id: d.estimate_line_item_id || null,
    tax_category: d.tax_category || null,
    sub_id: expenseTypeAllowsVendorLink(d.expense_type) ? d.sub_id.trim() || null : null,
    save_to_price_book: d.expense_type === "material" && d.save_to_price_book,
    material_name: d.material_name.trim() || null,
    material_unit: d.material_unit.trim() || null,
  };
}

interface SubOption {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  primary_contact: string | null;
  trade: string | null;
  phone: string | null;
}

function subLabel(s: SubOption): string {
  return [s.company_name, s.contact_name || s.primary_contact].filter(Boolean).join(" — ");
}

function subMatchesQuery(s: SubOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    subLabel(s).toLowerCase().includes(q) ||
    (s.trade ?? "").toLowerCase().includes(q) ||
    (s.phone ?? "").toLowerCase().includes(q)
  );
}

/** Single-select sub search — same interaction as BidRequestModal, scoped to one sub. */
function ExpenseSubPicker({
  subId,
  onChange,
}: {
  subId: string;
  onChange: (id: string) => void;
}) {
  const [subs, setSubs] = useState<SubOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const d = await api.get<{ subcontractors: SubOption[] }>(
          "/api/subcontractors?active=1&limit=200",
        );
        let list = d.subcontractors ?? [];
        if (subId && !list.some((s) => s.id === subId)) {
          try {
            const one = await api.get<{ subcontractor: SubOption }>(`/api/subcontractors/${subId}`);
            if (one.subcontractor) list = [one.subcontractor, ...list];
          } catch {
            /* inactive or missing — still show id-less state below */
          }
        }
        if (!cancelled) setSubs(list);
      } catch {
        if (!cancelled) setSubs([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subId]);

  useEffect(() => {
    const onDocMouseDown = (ev: MouseEvent) => {
      if (!pickerRef.current?.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  const selected = subs.find((s) => s.id === subId) ?? null;
  const suggestions = subs.filter((s) => subMatchesQuery(s, search));

  const pick = (id: string) => {
    onChange(id);
    setSearch("");
    setOpen(false);
  };

  const clear = () => {
    onChange("");
    setSearch("");
    setOpen(true);
  };

  if (loading) return <Spinner />;

  return (
    <FormField
      label="Worker / subcontractor"
      hint="Link a person from your subcontractor list for 1099 / QBO vendor tracking."
    >
      <div class="bid-sub-picker" ref={pickerRef}>
        {selected ? (
          <span class="badge badge--brand bid-sub-chip">
            <span class="bid-sub-chip__label">
              {subLabel(selected)}
              {selected.trade ? (
                <span class="bid-sub-chip__trade badge badge--secondary">{selected.trade}</span>
              ) : null}
            </span>
            <button
              type="button"
              class="bid-sub-chip__remove"
              onClick={clear}
              title="Change linked worker"
              aria-label="Change linked worker"
            >
              ×
            </button>
          </span>
        ) : (
          <>
            <input
              class="form-input"
              type="text"
              placeholder="Type a name or trade…"
              value={search}
              autoComplete="off"
              onFocus={() => setOpen(true)}
              onInput={(e) => {
                setSearch((e.target as HTMLInputElement).value);
                setOpen(true);
              }}
            />
            {open ? (
              <div class="catalog-ac bid-sub-picker__dropdown" role="listbox">
                {suggestions.length === 0 ? (
                  <div class="catalog-ac__empty">
                    {search.trim() ? "No subs match" : "No active subs found"}
                  </div>
                ) : (
                  suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      class="catalog-ac__item bid-sub-picker__option"
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => pick(s.id)}
                    >
                      <div class="catalog-ac__item-top">
                        <span class="catalog-ac__item-name">{subLabel(s)}</span>
                        {s.trade ? (
                          <span class="badge badge--secondary" style={{ fontSize: "11px", flexShrink: 0 }}>
                            {s.trade}
                          </span>
                        ) : null}
                      </div>
                      {s.phone ? <div class="catalog-ac__item-desc">{s.phone}</div> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </FormField>
  );
}

/** The reusable field set. Controlled by a draft + setter from the caller. */
export function ExpenseFields({
  draft,
  set,
  lines,
  hideJobAlignment,
}: {
  draft: ExpenseDraft;
  set: <K extends keyof ExpenseDraft>(k: K, v: ExpenseDraft[K]) => void;
  lines: CostingLineLite[];
  /** Hide the single whole-receipt alignment dropdown (per-item mode on receipts). */
  hideJobAlignment?: boolean;
}) {
  const alignOptions = useMemo(() => buildAlignOptions(lines), [lines]);

  const showVendorLink = expenseTypeAllowsVendorLink(draft.expense_type);
  const isMaterial = draft.expense_type === "material";

  return (
    <>
      <FormField label="Type" required>
        <div class="expense-type-grid">
          {EXPENSE_TYPE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              class={`chip${draft.expense_type === o.value ? " chip--active" : ""}`}
              onClick={() => {
                set("expense_type", o.value);
                if (!expenseTypeAllowsVendorLink(o.value)) set("sub_id", "");
                const tax = TAX_CATEGORY_BY_EXPENSE_TYPE[o.value];
                if (tax) set("tax_category", tax);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </FormField>

      <div class="form-row">
        <FormField label="Amount" required style={{ flex: "2", minWidth: 0 }}>
          <input
            class="form-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            style={{ minWidth: 0, width: "100%" }}
            value={draft.amount}
            onInput={(e) => set("amount", (e.target as HTMLInputElement).value)}
          />
        </FormField>
        <FormField label="Date" required style={{ flex: "3", minWidth: 0 }}>
          <input
            class="form-input"
            type="date"
            value={draft.incurred_date}
            onInput={(e) => set("incurred_date", (e.target as HTMLInputElement).value)}
          />
        </FormField>
      </div>

      <FormField label="Vendor">
        <input
          class="form-input"
          value={draft.vendor}
          placeholder="e.g. Lowe's"
          onInput={(e) => set("vendor", (e.target as HTMLInputElement).value)}
        />
      </FormField>

      <FormField label="Description">
        <input
          class="form-input"
          value={draft.description}
          onInput={(e) => set("description", (e.target as HTMLInputElement).value)}
        />
      </FormField>

      {!hideJobAlignment && (
        <FormField label="Job costing alignment" hint="Pick the trade or sub-item this cost belongs to. Leave Unallocated if unknown.">
          <Select
            value={draft.estimate_line_item_id}
            options={alignOptions}
            onChange={(v) => set("estimate_line_item_id", v)}
          />
        </FormField>
      )}

      <FormField label="Tax category">
        <Select
          value={draft.tax_category}
          options={TAX_CATEGORY_OPTIONS}
          onChange={(v) => set("tax_category", v)}
        />
      </FormField>

      {showVendorLink && <ExpenseSubPicker subId={draft.sub_id} onChange={(id) => set("sub_id", id)} />}

      {isMaterial && (
        <div class="stack" style={{ gap: "var(--space-xs)" }}>
          <label class="quote-check">
            <input
              type="checkbox"
              checked={draft.save_to_price_book}
              onChange={(e) => set("save_to_price_book", (e.target as HTMLInputElement).checked)}
            />
            <span>Save to material price book</span>
          </label>
          {draft.save_to_price_book && (
            <div class="form-row">
              <FormField label="Material name" required>
                <input
                  class="form-input"
                  value={draft.material_name}
                  placeholder="e.g. 2x4x8 stud"
                  onInput={(e) => set("material_name", (e.target as HTMLInputElement).value)}
                />
              </FormField>
              <FormField label="Unit">
                <input
                  class="form-input"
                  value={draft.material_unit}
                  placeholder="ea"
                  onInput={(e) => set("material_unit", (e.target as HTMLInputElement).value)}
                />
              </FormField>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Full "+ Add Expense" / edit modal posting to /api/expenses. */
export function ExpenseFormModal({
  jobId,
  lines,
  initial,
  editId,
  onClose,
  onSaved,
}: {
  jobId: string;
  lines: CostingLineLite[];
  initial?: Partial<ExpenseDraft>;
  editId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ExpenseDraft>(emptyDraft(initial));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ExpenseDraft>(k: K, v: ExpenseDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const amt = Number(draft.amount);
  const valid =
    Number.isFinite(amt) &&
    amt > 0 &&
    (!(draft.expense_type === "material" && draft.save_to_price_book) || draft.material_name.trim());

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const body = draftToBody(draft, jobId);
      if (editId) await api.put(`/api/expenses/${editId}`, body);
      else await api.post(`/api/expenses`, body);
      toast.push("success", editId ? "Expense updated" : "Expense added");
      onSaved();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={editId ? "Edit Expense" : "Add Expense"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving…" : editId ? "Save" : "Add Expense"}
          </Button>
        </>
      }
    >
      <ExpenseFields draft={draft} set={set} lines={lines} />
    </Modal>
  );
}
