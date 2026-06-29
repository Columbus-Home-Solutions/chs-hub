import { useState } from "preact/hooks";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { formatCurrency } from "../../lib/format";
import type { ScopeDraftItem } from "../../types";

function Icon({ name, class: className }: { name: string; class?: string }) {
  return <i class={`ti ti-${name}${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}

interface ScopeDraftSectionProps {
  draft: ScopeDraftItem[];
  generating: boolean;
  onRegenerate: () => void;
  onPatchItem: (itemIndex: number, updates: Record<string, unknown>) => Promise<void>;
}

export function ScopeDraftSection({
  draft,
  generating,
  onRegenerate,
  onPatchItem,
}: ScopeDraftSectionProps) {
  const visibleCount = draft.filter((d) => d.status !== "discarded" && d.status !== "pushed").length;

  return (
    <div class="card scope-draft-card">
      <div class="card__header">
        <div class="scope-draft-card__title-row">
          <span class="card__title">Scope draft</span>
          {visibleCount > 0 && (
            <Badge tone="neutral">{String(visibleCount)}</Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={generating}
          onClick={() => void onRegenerate()}
        >
          <Icon name="refresh" /> {generating ? "Generating…" : "Regenerate"}
        </Button>
      </div>
      <div class="card__body">
        <p class="scope-draft-card__subtitle text--muted">
          From visit notes · Accept items then push to estimate
        </p>
        <div class="scope-draft-list">
          {draft.map((item, index) =>
            item.status === "discarded" || item.status === "pushed" ? null : (
              <ScopeDraftItemCard
                key={item.id}
                item={item}
                itemIndex={index}
                onPatch={onPatchItem}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function ScopeDraftItemCard({
  item,
  itemIndex,
  onPatch,
}: {
  item: ScopeDraftItem;
  itemIndex: number;
  onPatch: (itemIndex: number, updates: Record<string, unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editName, setEditName] = useState(item.product_service);
  const [editDesc, setEditDesc] = useState(item.description);
  const [editQty, setEditQty] = useState(String(item.quantity));
  const [editUnit, setEditUnit] = useState(item.unit);
  const [editPrice, setEditPrice] = useState(
    item.unit_price != null ? String(item.unit_price) : "",
  );

  const accepted = item.status === "accepted";
  const catalogMatch = item.catalog_match_id != null;

  const startEdit = () => {
    setEditName(item.product_service);
    setEditDesc(item.description);
    setEditQty(String(item.quantity));
    setEditUnit(item.unit);
    setEditPrice(item.unit_price != null ? String(item.unit_price) : "");
    setEditing(true);
  };

  const saveEdit = async () => {
    setBusy(true);
    try {
      await onPatch(itemIndex, {
        product_service: editName.trim(),
        description: editDesc.trim(),
        quantity: Number(editQty),
        unit: editUnit.trim(),
        unit_price: editPrice.trim() === "" ? null : Number(editPrice),
        status: "pending",
      });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    try {
      await onPatch(itemIndex, { status: "accepted" });
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await onPatch(itemIndex, { status: "discarded" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      class={`scope-draft-item${accepted ? " scope-draft-item--accepted" : ""}${
        catalogMatch && !accepted ? " scope-draft-item--catalog-match" : ""
      }`}
    >
      <div class="scope-draft-item__header">
        <div class="scope-draft-item__name">{item.product_service}</div>
        {accepted ? (
          <span class="scope-draft-item__accepted-label">
            <Icon name="check" /> Accepted
          </span>
        ) : catalogMatch ? (
          <Badge tone="success">Catalog match · {item.catalog_match_name}</Badge>
        ) : null}
      </div>

      {!editing ? (
        <>
          {item.description && (
            <p class="scope-draft-item__desc text--secondary">{item.description}</p>
          )}
          <div class="scope-draft-item__pills">
            <span class="scope-draft-pill">Qty {item.quantity}</span>
            <span class="scope-draft-pill">{item.unit}</span>
            <span class="scope-draft-pill">
              {item.unit_price != null ? formatCurrency(item.unit_price) : "—"}
            </span>
          </div>
          {!accepted && (
            <div class="scope-draft-item__actions">
              <Button
                size="sm"
                variant="secondary"
                class="scope-draft-btn--accept"
                disabled={busy}
                onClick={() => void accept()}
              >
                <Icon name="check" /> Accept
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={startEdit}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                class="scope-draft-btn--discard"
                disabled={busy}
                onClick={() => void discard()}
              >
                <Icon name="x" /> Discard
              </Button>
            </div>
          )}
        </>
      ) : (
        <div class="scope-draft-item__edit stack">
          <FormField label="Name">
            <input
              class="form-input"
              value={editName}
              onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
            />
          </FormField>
          <FormField label="Description">
            <textarea
              class="form-textarea"
              rows={3}
              value={editDesc}
              onInput={(e) => setEditDesc((e.target as HTMLTextAreaElement).value)}
            />
          </FormField>
          <div class="form-row">
            <FormField label="Quantity">
              <input
                class="form-input"
                type="number"
                min="0"
                step="any"
                value={editQty}
                onInput={(e) => setEditQty((e.target as HTMLInputElement).value)}
              />
            </FormField>
            <FormField label="Unit">
              <input
                class="form-input"
                value={editUnit}
                onInput={(e) => setEditUnit((e.target as HTMLInputElement).value)}
              />
            </FormField>
            <FormField label="Unit price">
              <input
                class="form-input"
                type="number"
                min="0"
                step="0.01"
                placeholder="Optional"
                value={editPrice}
                onInput={(e) => setEditPrice((e.target as HTMLInputElement).value)}
              />
            </FormField>
          </div>
          <div class="flex gap-sm">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveEdit()}>
              Save changes
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
