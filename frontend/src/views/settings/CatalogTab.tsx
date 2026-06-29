import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { FormField } from "../../components/ui/FormField";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { formatCurrency } from "../../lib/format";

export interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  unit: string | null;
  unit_price: number;
  is_active: boolean;
  sort_order: number;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

type Draft = {
  name: string;
  description: string;
  unit: string;
  unit_price: string;
};

function emptyDraft(): Draft {
  return { name: "", description: "", unit: "", unit_price: "" };
}

function draftFromItem(item: CatalogItem): Draft {
  return {
    name: item.name,
    description: item.description ?? "",
    unit: item.unit ?? "",
    unit_price: String(item.unit_price),
  };
}

function ItemFormFields({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
}) {
  return (
    <>
      <FormField label="Name" required>
        <input
          class="form-input"
          value={draft.name}
          onInput={(e) => onChange({ ...draft, name: (e.target as HTMLInputElement).value })}
        />
      </FormField>
      <FormField label="Description" hint="Client sees this in the estimate">
        <textarea
          class="form-textarea"
          value={draft.description}
          onInput={(e) => onChange({ ...draft, description: (e.target as HTMLTextAreaElement).value })}
        />
      </FormField>
      <div class="form-row">
        <FormField label="Unit">
          <input
            class="form-input"
            placeholder="sqft / each / lf / hour"
            value={draft.unit}
            onInput={(e) => onChange({ ...draft, unit: (e.target as HTMLInputElement).value })}
          />
        </FormField>
        <FormField label="Unit price" required>
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            value={draft.unit_price}
            onInput={(e) => onChange({ ...draft, unit_price: (e.target as HTMLInputElement).value })}
          />
        </FormField>
      </div>
    </>
  );
}

export function CatalogTab() {
  const toast = useToast();
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const qs = showInactive ? "?include_inactive=true" : "";
      const r = await api.get<{ items: CatalogItem[] }>(`/api/catalog${qs}`);
      setItems(r.items);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [showInactive]);

  const startEdit = (item: CatalogItem) => {
    setEditingId(item.id);
    setEditDraft(draftFromItem(item));
    setAdding(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(emptyDraft());
  };

  const saveNew = async () => {
    const unitPrice = Number(addDraft.unit_price);
    if (!addDraft.name.trim()) {
      toast.push("error", "Name is required");
      return;
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      toast.push("error", "Unit price must be zero or greater");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/catalog", {
        name: addDraft.name.trim(),
        description: addDraft.description.trim() || null,
        unit: addDraft.unit.trim() || null,
        unit_price: unitPrice,
      });
      toast.push("success", "Item added");
      setAdding(false);
      setAddDraft(emptyDraft());
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (id: string) => {
    const unitPrice = Number(editDraft.unit_price);
    if (!editDraft.name.trim()) {
      toast.push("error", "Name is required");
      return;
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      toast.push("error", "Unit price must be zero or greater");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/catalog/${id}`, {
        name: editDraft.name.trim(),
        description: editDraft.description.trim() || null,
        unit: editDraft.unit.trim() || null,
        unit_price: unitPrice,
      });
      toast.push("success", "Item updated");
      cancelEdit();
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item: CatalogItem) => {
    if (!window.confirm("Delete this item?")) return;
    try {
      await api.del(`/api/catalog/${item.id}`);
      toast.push("success", "Item deleted");
      if (editingId === item.id) cancelEdit();
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const deactivate = async (item: CatalogItem) => {
    try {
      await api.put(`/api/catalog/${item.id}`, { is_active: false });
      toast.push("success", "Item deactivated");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const reactivate = async (item: CatalogItem) => {
    try {
      await api.put(`/api/catalog/${item.id}`, { is_active: true });
      toast.push("success", "Item reactivated");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <Card
      title="Services & pricing"
      actions={
        <div class="flex items-center gap-md">
          <label class="flex items-center gap-sm" style={{ fontSize: "var(--text-sm)" }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive((e.target as HTMLInputElement).checked)}
            />
            Show inactive
          </label>
          <Button size="sm" variant="primary" onClick={() => { setAdding(true); cancelEdit(); }}>
            Add item
          </Button>
        </div>
      }
    >
      {adding && (
        <div class="stack mb-lg" style={{ padding: "var(--space-md)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-md)" }}>
          <ItemFormFields draft={addDraft} onChange={setAddDraft} />
          <div class="flex gap-sm">
            <Button variant="primary" disabled={busy} onClick={saveNew}>
              Save
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => { setAdding(false); setAddDraft(emptyDraft()); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner center />
      ) : items.length === 0 ? (
        <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          No services saved yet. Add your first item to speed up estimate building.
        </div>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Unit</th>
              <th>Price</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) =>
              editingId === item.id ? (
                <tr key={item.id}>
                  <td colSpan={4}>
                    <div class="stack" style={{ padding: "var(--space-sm) 0" }}>
                      <ItemFormFields draft={editDraft} onChange={setEditDraft} />
                      <div class="flex gap-sm">
                        <Button variant="primary" size="sm" disabled={busy} onClick={() => saveEdit(item.id)}>
                          Save
                        </Button>
                        <Button variant="secondary" size="sm" disabled={busy} onClick={cancelEdit}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr
                  key={item.id}
                  style={{
                    cursor: "pointer",
                    ...(item.is_active ? {} : { opacity: 0.55 }),
                  }}
                  onClick={() => startEdit(item)}
                >
                  <td>{item.name}</td>
                  <td>{item.unit || "—"}</td>
                  <td>{formatCurrency(item.unit_price)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div class="flex gap-sm">
                      <Button size="sm" variant="secondary" onClick={() => startEdit(item)}>
                        Edit
                      </Button>
                      {item.is_active ? (
                        <Button size="sm" variant="tertiary" onClick={() => deactivate(item)}>
                          Deactivate
                        </Button>
                      ) : (
                        <Button size="sm" variant="secondary" onClick={() => reactivate(item)}>
                          Reactivate
                        </Button>
                      )}
                      <Button size="sm" variant="danger" onClick={() => remove(item)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </Card>
  );
}
