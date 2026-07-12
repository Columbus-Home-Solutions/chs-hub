import { useMemo, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";

/**
 * Shared expense field set + form (Sprint 10).
 *
 * Used by the Financial tab "+ Add Expense" modal AND the receipt-confirm seam
 * so a receipt-sourced expense lands in the SAME full form (estimate-line-item
 * alignment, tax category, sub/1099) rather than a minimal stub.
 */

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

export const EXPENSE_TYPE_OPTIONS = [
  { value: "material", label: "Material" },
  { value: "subcontractor", label: "Subcontractor" },
  { value: "labor", label: "Labor" },
  { value: "permit", label: "Permit" },
  { value: "equipment", label: "Equipment" },
  { value: "vehicle", label: "Vehicle / Fuel" },
  { value: "other", label: "Other" },
];

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

export interface ExpenseDraft {
  expense_type: string;
  vendor: string;
  amount: string;
  description: string;
  incurred_date: string;
  estimate_line_item_id: string; // parent or sub-item id, "" = unallocated
  tax_category: string;
  sub_id: string;
  is_1099_reportable: boolean;
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
    is_1099_reportable: false,
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
    sub_id: d.expense_type === "subcontractor" ? d.sub_id.trim() || null : null,
    is_1099_reportable: d.expense_type === "subcontractor" && d.is_1099_reportable,
    save_to_price_book: d.expense_type === "material" && d.save_to_price_book,
    material_name: d.material_name.trim() || null,
    material_unit: d.material_unit.trim() || null,
  };
}

/** The reusable field set. Controlled by a draft + setter from the caller. */
export function ExpenseFields({
  draft,
  set,
  lines,
}: {
  draft: ExpenseDraft;
  set: <K extends keyof ExpenseDraft>(k: K, v: ExpenseDraft[K]) => void;
  lines: CostingLineLite[];
}) {
  // Alignment selector: flat list of parent lines + their sub-items. The stored
  // value is the most specific id chosen (sub-item) or the parent id.
  const alignOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: "", label: "— Unallocated —" }];
    for (const l of lines) {
      opts.push({ value: l.line_item_id, label: l.name });
      for (const s of l.sub_items) {
        opts.push({ value: s.id, label: `   ↳ ${s.description ?? s.category} (${s.category})` });
      }
    }
    return opts;
  }, [lines]);

  const isSub = draft.expense_type === "subcontractor";
  const isMaterial = draft.expense_type === "material";

  return (
    <>
      <FormField label="Type" required>
        <div
          class="chip-row"
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(7.5rem, 1fr))", gap: "var(--space-xs)" }}
        >
          {EXPENSE_TYPE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              class={`chip${draft.expense_type === o.value ? " chip--active" : ""}`}
              style={{ width: "100%", textAlign: "center" }}
              onClick={() => set("expense_type", o.value)}
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

      <FormField label="Job costing alignment" hint="Pick the trade or sub-item this cost belongs to. Leave Unallocated if unknown.">
        <Select
          value={draft.estimate_line_item_id}
          options={alignOptions}
          onChange={(v) => set("estimate_line_item_id", v)}
        />
      </FormField>

      <FormField label="Tax category">
        <Select
          value={draft.tax_category}
          options={TAX_CATEGORY_OPTIONS}
          onChange={(v) => set("tax_category", v)}
        />
      </FormField>

      {isSub && (
        <div class="form-row">
          <FormField label="Subcontractor ID">
            <input
              class="form-input"
              value={draft.sub_id}
              placeholder="sub id"
              onInput={(e) => set("sub_id", (e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="1099">
            <label class="quote-check" style={{ marginTop: "8px" }}>
              <input
                type="checkbox"
                checked={draft.is_1099_reportable}
                onChange={(e) => set("is_1099_reportable", (e.target as HTMLInputElement).checked)}
              />
              <span>1099-reportable</span>
            </label>
          </FormField>
        </div>
      )}

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
