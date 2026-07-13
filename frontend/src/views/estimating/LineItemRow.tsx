import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { Modal } from "../../components/ui/Modal";
import { api } from "../../api";
import { formatCurrency, formatStatus } from "../../lib/format";
import { useCatalogAutocomplete } from "../../hooks/useCatalogAutocomplete";
import type { CatalogItem } from "../settings/CatalogTab";
import {
  SUB_ITEM_CATEGORIES,
  type EstimateLineItem,
  type EstimateSubItem,
  type VendorMaterial,
} from "../../types";
import { BidRequestModal } from "./BidRequestModal";
import { BidComparisonView } from "./BidComparisonView";

export interface LineItemRowProps {
  item: EstimateLineItem;
  isNew?: boolean;
  dragging: boolean;
  over: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
  reload?: () => Promise<void>;
  onNewConsumed?: () => void;
}

function highlightName(name: string, query: string) {
  if (!query.trim()) return name;
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  const i = lower.indexOf(q);
  if (i === -1) return name;
  return (
    <>
      {name.slice(0, i)}
      <mark class="catalog-ac__mark">{name.slice(i, i + query.length)}</mark>
      {name.slice(i + query.length)}
    </>
  );
}

function unitCostFromItem(item: EstimateLineItem): number {
  const qty = item.quantity ?? 1;
  if (!qty || item.internal_cost <= 0) return 0;
  return item.internal_cost / qty;
}

function marginPercent(unitPrice: number, unitCost: number): number | null {
  if (!unitPrice || unitPrice <= 0) return null;
  if (unitCost <= 0) return null;
  return Math.round(((unitPrice - unitCost) / unitPrice) * 100);
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.max(el.scrollHeight, 72)}px`;
}

/** Prefill quantities_notes from sub-item qty/unit, falling back to parent line item. */
function formatSubItemQuantities(sub: EstimateSubItem | null, lineItem: EstimateLineItem): string {
  if (!sub) return "";
  const subQty = sub.quantity;
  const subUnit = (sub.unit ?? "").trim();
  const lineQty = lineItem.quantity;
  const lineUnit = (lineItem.unit ?? "").trim();
  const hasSubQty = subQty != null && subQty !== 0;

  // 1. Sub-item has both quantity and unit
  if (hasSubQty && subUnit) return `${subQty} ${subUnit}`;
  // 2. Sub-item has quantity but no unit → parent line unit
  if (hasSubQty) {
    if (lineUnit) return `${subQty} ${lineUnit}`;
    return String(subQty);
  }
  // 3. Sub-item has neither → parent line quantity + unit together
  const hasLineQty = lineQty != null && lineQty !== 0;
  if (hasLineQty) {
    if (lineUnit) return `${lineQty} ${lineUnit}`;
    return String(lineQty);
  }
  // 4. Nothing to prefill
  return "";
}

interface BidRequestSummary {
  id: string;
  title: string;
  status: string;
  estimate_sub_item_id: string | null;
  estimate_line_item_id: string | null;
  submission_count: number;
  recipient_count: number;
}

function bidStatusLabel(br: BidRequestSummary): string {
  if (br.status === "awarded") return "Awarded";
  if (br.status === "cancelled") return "Cancelled";
  if (br.submission_count > 0) {
    return `Bids: ${br.submission_count} submitted`;
  }
  return "Awaiting responses";
}

function bidMatchesLineItem(br: BidRequestSummary, item: EstimateLineItem): boolean {
  if (br.estimate_line_item_id === item.id) return true;
  if (br.estimate_sub_item_id && item.sub_items.some((s) => s.id === br.estimate_sub_item_id)) {
    return true;
  }
  // Legacy rows (estimate_id only): match subcontractor scope on this line item.
  if (br.estimate_sub_item_id || br.estimate_line_item_id) return false;
  if (!item.sub_items.some((s) => s.category === "subcontractor")) return false;
  const title = br.title.toLowerCase();
  if (item.sub_items.some((s) => s.description && title.includes(s.description.toLowerCase()))) {
    return true;
  }
  if (item.product_service && title.includes(item.product_service.toLowerCase())) {
    return true;
  }
  return false;
}

function summarizeLineItemBids(
  bids: BidRequestSummary[],
): { label: string; badgeCls: string; primaryId: string } | null {
  if (bids.length === 0) return null;
  const primary = bids[0];
  if (bids.every((b) => b.status === "awarded")) {
    return {
      label: bids.length > 1 ? `Bids: ${bids.length} awarded` : "Bids: awarded",
      badgeCls: "success",
      primaryId: primary.id,
    };
  }
  const submitted = bids.reduce((n, b) => n + b.submission_count, 0);
  if (submitted > 0) {
    return {
      label: `Bids: ${submitted} submitted`,
      badgeCls: "info",
      primaryId: primary.id,
    };
  }
  return {
    label: bids.length > 1 ? `Bids: ${bids.length} awaiting` : "Bids: awaiting responses",
    badgeCls: "neutral",
    primaryId: primary.id,
  };
}

export function LineItemRow({
  item,
  isNew,
  dragging,
  over,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  mutate,
  reload,
  onNewConsumed,
}: LineItemRowProps) {
  const [expanded, setExpanded] = useState(!!isNew);
  const [fromCatalog, setFromCatalog] = useState(false);
  const [showAc, setShowAc] = useState(false);
  const [acIndex, setAcIndex] = useState(-1);
  const [fields, setFields] = useState({
    product_service: item.product_service,
    description: item.description,
    quantity: item.quantity ?? 1,
    unit: item.unit ?? "",
    unit_price: item.unit_price ?? 0,
    includes_note: item.includes_note ?? "",
  });
  const [myCostStr, setMyCostStr] = useState(String(unitCostFromItem(item)));

  const [bidOpen, setBidOpen] = useState(false);
  const [bidSubItem, setBidSubItem] = useState<EstimateSubItem | null>(null);
  const [freshBidId, setFreshBidId] = useState<string | null>(null);
  const [viewingBidId, setViewingBidId] = useState<string | null>(null);
  const [bidRequests, setBidRequests] = useState<BidRequestSummary[]>([]);

  const loadBidRequests = useCallback(() => {
    api
      .get<{ bid_requests: BidRequestSummary[] }>(`/api/bid-requests?estimate_id=${item.estimate_id}`)
      .then((d) => setBidRequests(d.bid_requests ?? []))
      .catch(() => setBidRequests([]));
  }, [item.estimate_id]);

  useEffect(() => {
    loadBidRequests();
  }, [loadBidRequests]);

  const lineItemBids = useMemo(
    () => bidRequests.filter((br) => bidMatchesLineItem(br, item)),
    [bidRequests, item],
  );

  const headerBidSummary = useMemo(() => summarizeLineItemBids(lineItemBids), [lineItemBids]);

  const bidsBySubItem = useMemo(() => {
    const map = new Map<string, BidRequestSummary>();
    for (const br of lineItemBids) {
      if (!br.estimate_sub_item_id) continue;
      if (!map.has(br.estimate_sub_item_id)) {
        map.set(br.estimate_sub_item_id, br);
      }
    }
    return map;
  }, [lineItemBids]);

  const hasOpenBids = lineItemBids.some((br) => br.status === "open");

  // Poll for new submissions while open bids exist (same 20s interval as estimate-request polling).
  useEffect(() => {
    if (!hasOpenBids) return;
    const poll = window.setInterval(() => loadBidRequests(), 20_000);
    return () => window.clearInterval(poll);
  }, [hasOpenBids, loadBidRequests]);

  const refreshAfterAward = useCallback(() => {
    loadBidRequests();
    void reload?.();
  }, [loadBidRequests, reload]);

  const openBidModal = (sub: EstimateSubItem | null) => {
    setBidSubItem(sub);
    setBidOpen(true);
  };

  const openComparison = (bidId: string) => {
    setViewingBidId(bidId);
    setFreshBidId(null);
  };

  const nameRef = useRef<HTMLInputElement>(null);
  const acWrapRef = useRef<HTMLDivElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const acQuery = showAc ? fields.product_service : "";
  const { results: catalogResults, loading: catalogLoading } = useCatalogAutocomplete(acQuery);

  const acOptions = catalogResults.length;
  const acTotal = acOptions + 1;

  useEffect(() => {
    setFields({
      product_service: item.product_service,
      description: item.description,
      quantity: item.quantity ?? 1,
      unit: item.unit ?? "",
      unit_price: item.unit_price ?? 0,
      includes_note: item.includes_note ?? "",
    });
    setMyCostStr(String(unitCostFromItem(item) || ""));
  }, [
    item.id,
    item.product_service,
    item.description,
    item.quantity,
    item.unit,
    item.unit_price,
    item.includes_note,
    item.internal_cost,
  ]);

  useEffect(() => {
    if (isNew) {
      setExpanded(true);
      requestAnimationFrame(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
      });
    }
  }, [isNew, item.id]);

  useEffect(() => {
    if (!showAc) return;
    const onDoc = (ev: MouseEvent) => {
      if (!acWrapRef.current?.contains(ev.target as Node)) {
        setShowAc(false);
        setAcIndex(-1);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showAc]);

  useEffect(() => {
    if (expanded && descRef.current) autoGrow(descRef.current);
  }, [expanded, fields.description]);

  const save = (patch: Record<string, unknown>) =>
    mutate(() => api.put(`/api/line-items/${item.id}`, patch));

  const previewTotal = (Number(fields.quantity) || 0) * (Number(fields.unit_price) || 0);
  const unitCost = Number(myCostStr) || 0;
  const margin = marginPercent(Number(fields.unit_price) || 0, unitCost);

  const applyCatalog = (cat: CatalogItem) => {
    const next = {
      product_service: cat.name,
      description: cat.description ?? "",
      unit: cat.unit ?? "",
      unit_price: cat.unit_price,
    };
    setFields((f) => ({ ...f, ...next }));
    setFromCatalog(true);
    setExpanded(true);
    setShowAc(false);
    setAcIndex(-1);
    void save({
      product_service: cat.name,
      description: next.description,
      unit: next.unit || null,
      unit_price: cat.unit_price,
    });
  };

  const selectAcIndex = (idx: number) => {
    if (idx < catalogResults.length) {
      applyCatalog(catalogResults[idx]);
    } else {
      setShowAc(false);
      setAcIndex(-1);
    }
  };

  const onNameKeyDown = (ev: KeyboardEvent) => {
    if (!showAc) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setAcIndex((i) => Math.min(i + 1, acTotal - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setAcIndex((i) => Math.max(i - 1, 0));
    } else if (ev.key === "Enter" && acIndex >= 0) {
      ev.preventDefault();
      selectAcIndex(acIndex);
    } else if (ev.key === "Escape") {
      setShowAc(false);
      setAcIndex(-1);
    }
  };

  const persistMyCost = () => {
    const parsed = Number(myCostStr);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const qty = Number(fields.quantity) || 1;
    const current = unitCostFromItem(item);
    if (Math.abs(parsed - current) < 0.009) return;

    if (item.sub_items.length === 0) {
      void mutate(
        () =>
          api.post(`/api/line-items/${item.id}/sub-items`, {
            description: "Labor & materials",
            category: "material",
            quantity: qty,
            unit_cost: parsed,
          }),
        undefined,
      );
      return;
    }
    if (item.sub_items.length === 1) {
      const sub = item.sub_items[0];
      void mutate(() => api.put(`/api/sub-items/${sub.id}`, { unit_cost: parsed, quantity: qty }));
    }
  };

  const onNameBlur = () => {
    if (fields.product_service !== item.product_service) {
      void save({ product_service: fields.product_service });
    }
    if (isNew && fields.product_service.trim() && fields.product_service !== "New Line Item") {
      onNewConsumed?.();
    }
    setTimeout(() => setShowAc(false), 150);
  };

  return (
    <div
      class={`li-row${dragging ? " li-row--dragging" : ""}${over ? " li-row--over" : ""}${expanded ? " li-row--expanded" : ""}`}
      onDragOver={(ev) => {
        ev.preventDefault();
        onDragOver();
      }}
      onDrop={(ev) => {
        ev.preventDefault();
        onDrop();
      }}
    >
      <div class="li-row__grid">
        <span
          class="li-row__drag"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title="Drag to reorder"
        >
          ⠿
        </span>
        <button
          type="button"
          class={`li-row__chevron${expanded ? " li-row__chevron--open" : ""}`}
          onClick={() => setExpanded((x) => !x)}
          title="Expand details"
          aria-expanded={expanded}
        >
          ›
        </button>
        <div class="li-row__name-wrap" ref={acWrapRef}>
          <input
            ref={nameRef}
            class="li-row__input li-row__input--name"
            value={fields.product_service}
            placeholder="Product / service"
            onInput={(ev) => {
              const v = (ev.target as HTMLInputElement).value;
              setFields((f) => ({ ...f, product_service: v }));
              setShowAc(v.trim().length >= 1);
              setAcIndex(-1);
            }}
            onFocus={() => {
              if (fields.product_service.trim().length >= 1) setShowAc(true);
            }}
            onBlur={onNameBlur}
            onKeyDown={onNameKeyDown}
          />
          {fromCatalog && <span class="li-row__catalog-badge">from catalog</span>}
          {showAc && fields.product_service.trim().length >= 1 && (
            <div class="catalog-ac" role="listbox">
              {catalogLoading && catalogResults.length === 0 && (
                <div class="catalog-ac__empty">Searching…</div>
              )}
              {catalogResults.map((cat, i) => (
                <button
                  type="button"
                  key={cat.id}
                  class={`catalog-ac__item${acIndex === i ? " catalog-ac__item--active" : ""}`}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => applyCatalog(cat)}
                >
                  <div class="catalog-ac__item-top">
                    <span class="catalog-ac__item-name">{highlightName(cat.name, fields.product_service)}</span>
                    <span class="catalog-ac__item-price">
                      {formatCurrency(cat.unit_price)}
                      {cat.unit ? `/${cat.unit}` : ""}
                    </span>
                  </div>
                  {cat.description && (
                    <div class="catalog-ac__item-desc">{cat.description}</div>
                  )}
                </button>
              ))}
              <button
                type="button"
                class={`catalog-ac__item catalog-ac__item--new${acIndex === acOptions ? " catalog-ac__item--active" : ""}`}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => selectAcIndex(acOptions)}
              >
                + Add &ldquo;{fields.product_service.trim()}&rdquo; as a new item
              </button>
            </div>
          )}
        </div>
        <input
          class="li-row__input li-row__input--qty"
          type="number"
          step="any"
          value={fields.quantity}
          onInput={(ev) => setFields((f) => ({ ...f, quantity: Number((ev.target as HTMLInputElement).value) }))}
          onBlur={() => Number(fields.quantity) !== (item.quantity ?? 1) && save({ quantity: Number(fields.quantity) })}
        />
        <input
          class="li-row__input li-row__input--unit"
          value={fields.unit}
          placeholder="each"
          onInput={(ev) => setFields((f) => ({ ...f, unit: (ev.target as HTMLInputElement).value }))}
          onBlur={() => (fields.unit || null) !== (item.unit ?? null) && save({ unit: fields.unit })}
        />
        <input
          class="li-row__input li-row__input--price"
          type="number"
          step="any"
          value={fields.unit_price}
          onInput={(ev) => setFields((f) => ({ ...f, unit_price: Number((ev.target as HTMLInputElement).value) }))}
          onBlur={() =>
            Number(fields.unit_price) !== (item.unit_price ?? 0) && save({ unit_price: Number(fields.unit_price) })
          }
        />
        <span class="li-row__total">{formatCurrency(previewTotal)}</span>
        <button
          type="button"
          class="li-row__del"
          title="Remove line item"
          onClick={() => mutate(() => api.del(`/api/line-items/${item.id}`), "Line item removed")}
        >
          ×
        </button>
      </div>

      {headerBidSummary && (
        <div class="li-row__bid-strip">
          <button
            type="button"
            class="li-row__bid-badge"
            onClick={() => openComparison(headerBidSummary.primaryId)}
            title="View bid comparison"
          >
            <span class={`badge badge--${headerBidSummary.badgeCls}`}>{headerBidSummary.label}</span>
            <span class="li-row__bid-badge-action">View</span>
          </button>
        </div>
      )}

      {expanded && (
        <div class="li-row__detail">
          <label class="li-row__detail-label">Scope of work (client sees this):</label>
          <textarea
            ref={descRef}
            class="li-row__textarea"
            placeholder="Scope of work for this line item…"
            value={fields.description}
            onInput={(ev) => {
              const el = ev.target as HTMLTextAreaElement;
              setFields((f) => ({ ...f, description: el.value }));
              autoGrow(el);
            }}
            onBlur={() => fields.description !== item.description && save({ description: fields.description })}
          />
          <div class="li-row__detail-row">
            <input
              class="li-row__input li-row__input--includes"
              value={fields.includes_note}
              placeholder="Price includes labor and materials"
              onInput={(ev) => setFields((f) => ({ ...f, includes_note: (ev.target as HTMLInputElement).value }))}
              onBlur={() =>
                (fields.includes_note || null) !== (item.includes_note ?? null) && save({ includes_note: fields.includes_note })
              }
            />
            <label class="li-row__cost-field">
              <span>My cost</span>
              <input
                class="li-row__input li-row__input--cost"
                type="number"
                step="any"
                min="0"
                value={myCostStr}
                disabled={item.sub_items.length > 1}
                title={item.sub_items.length > 1 ? "Edit costs in the breakdown below" : undefined}
                onInput={(ev) => setMyCostStr((ev.target as HTMLInputElement).value)}
                onBlur={persistMyCost}
              />
            </label>
            <div class="li-row__margin">
              <span class="li-row__margin-label">Margin</span>
              <span
                class={`li-row__margin-value${
                  margin == null ? " li-row__margin-value--muted" : margin <= 0 ? " li-row__margin-value--bad" : " li-row__margin-value--good"
                }`}
              >
                {margin != null ? `${margin}%` : "—"}
              </span>
            </div>
          </div>
          <SubItemList
            item={item}
            mutate={mutate}
            freshBidId={freshBidId}
            bidsBySubItem={bidsBySubItem}
            onOpenBidModal={openBidModal}
            onOpenComparison={openComparison}
            onDismissFreshBid={() => setFreshBidId(null)}
          />
        </div>
      )}

      <BidRequestModal
        open={bidOpen}
        onClose={() => setBidOpen(false)}
        onCreated={(id) => {
          setFreshBidId(id);
          loadBidRequests();
        }}
        estimateId={item.estimate_id}
        estimateLineItemId={item.id}
        estimateSubItemId={bidSubItem?.id}
        defaultTitle={bidSubItem?.description ?? item.product_service}
        defaultScope={bidSubItem ? "" : item.description}
        defaultQuantitiesNotes={formatSubItemQuantities(bidSubItem, item)}
      />

      {viewingBidId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 300,
            background: "var(--color-bg)",
            overflowY: "auto",
            padding: "var(--space-lg)",
          }}
        >
          <BidComparisonView
            bidRequestId={viewingBidId}
            onBack={() => {
              setViewingBidId(null);
              loadBidRequests();
            }}
            onAwarded={refreshAfterAward}
          />
        </div>
      )}
    </div>
  );
}

function SubItemList({
  item,
  mutate,
  freshBidId,
  bidsBySubItem,
  onOpenBidModal,
  onOpenComparison,
  onDismissFreshBid,
}: {
  item: EstimateLineItem;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
  freshBidId: string | null;
  bidsBySubItem: Map<string, BidRequestSummary>;
  onOpenBidModal: (sub: EstimateSubItem | null) => void;
  onOpenComparison: (bidId: string) => void;
  onDismissFreshBid: () => void;
}) {
  const [materialFor, setMaterialFor] = useState(false);

  const addSub = () =>
    mutate(
      () =>
        api.post(`/api/line-items/${item.id}/sub-items`, {
          description: "New cost item",
          category: "material",
          quantity: 1,
          unit_cost: 0,
        }),
      "Sub-item added",
    );

  return (
    <div class="subitems">
      <div class="subitems__head">
        <span class="subitems__title">Internal Cost Breakdown (not shown to client)</span>
        <div class="flex gap-sm">
          <Button size="sm" variant="tertiary" onClick={() => setMaterialFor(true)}>
            Search Materials
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onOpenBidModal(null)}>
            Request Bids
          </Button>
          <Button size="sm" variant="secondary" onClick={addSub}>
            + Add Sub-Item
          </Button>
        </div>
      </div>

      {freshBidId && (
        <div
          class="callout callout--info"
          style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-xs)" }}
        >
          <span style={{ flex: 1, fontSize: "var(--text-sm)" }}>
            Bid request created — invites sent to selected subs.
          </span>
          <Button size="sm" variant="primary" onClick={() => onOpenComparison(freshBidId)}>
            View Comparison
          </Button>
          <button
            type="button"
            class="link-btn"
            style={{ fontSize: "var(--text-xs)" }}
            onClick={onDismissFreshBid}
          >
            Dismiss
          </button>
        </div>
      )}

      {item.sub_items.length === 0 ? (
        <div class="subitems__empty">No sub-items. Add material, labor, or sub costs.</div>
      ) : (
        <>
          <div class="subitems__col-head" aria-hidden="true">
            <span>Description</span>
            <span>Category</span>
            <span>Vendor</span>
            <span>Qty</span>
            <span>Unit</span>
            <span>Unit Cost</span>
            <span>Total</span>
          </div>
          {item.sub_items.map((s) => (
            <SubItemRow
              key={s.id}
              sub={s}
              mutate={mutate}
              bidSummary={bidsBySubItem.get(s.id) ?? null}
              onViewComparison={onOpenComparison}
              onRequestBids={s.category === "subcontractor" ? () => onOpenBidModal(s) : undefined}
            />
          ))}
        </>
      )}

      <MaterialSearchModal
        open={materialFor}
        onClose={() => setMaterialFor(false)}
        onPick={(m) => {
          setMaterialFor(false);
          void mutate(
            () =>
              api.post(`/api/line-items/${item.id}/sub-items`, {
                description: m.material_name,
                category: m.category || "material",
                vendor: m.vendor_name,
                quantity: 1,
                unit: m.unit,
                unit_cost: m.last_price,
                material_id: m.id,
              }),
            "Material added",
          );
        }}
      />
    </div>
  );
}

function SubItemRow({
  sub,
  mutate,
  bidSummary,
  onViewComparison,
  onRequestBids,
}: {
  sub: EstimateSubItem;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
  bidSummary: BidRequestSummary | null;
  onViewComparison: (bidId: string) => void;
  onRequestBids?: () => void;
}) {
  const [f, setF] = useState({
    description: sub.description,
    category: sub.category,
    vendor: sub.vendor ?? "",
    quantity: sub.quantity ?? 0,
    unit: sub.unit ?? "",
    unit_cost: sub.unit_cost ?? 0,
  });
  useEffect(() => {
    setF({
      description: sub.description,
      category: sub.category,
      vendor: sub.vendor ?? "",
      quantity: sub.quantity ?? 0,
      unit: sub.unit ?? "",
      unit_cost: sub.unit_cost ?? 0,
    });
  }, [sub.id, sub.description, sub.category, sub.vendor, sub.quantity, sub.unit, sub.unit_cost]);

  const save = (patch: Record<string, unknown>) => mutate(() => api.put(`/api/sub-items/${sub.id}`, patch));

  return (
    <div>
      <div class="subitem">
        <input
          class="form-input"
          value={f.description}
          placeholder="Description"
          onInput={(ev) => setF((p) => ({ ...p, description: (ev.target as HTMLInputElement).value }))}
          onBlur={() => f.description !== sub.description && save({ description: f.description })}
        />
        <Select
          value={f.category}
          options={SUB_ITEM_CATEGORIES.map((c) => ({ value: c, label: formatStatus(c) }))}
          onChange={(v) => {
            setF((p) => ({ ...p, category: v }));
            if (v !== sub.category) save({ category: v });
          }}
        />
        <input
          class="form-input"
          value={f.vendor}
          placeholder="Vendor"
          onInput={(ev) => setF((p) => ({ ...p, vendor: (ev.target as HTMLInputElement).value }))}
          onBlur={() => (f.vendor || null) !== (sub.vendor ?? null) && save({ vendor: f.vendor })}
        />
        <input
          class="form-input subitem__num"
          type="number"
          step="any"
          value={f.quantity}
          placeholder="Qty"
          onInput={(ev) => setF((p) => ({ ...p, quantity: Number((ev.target as HTMLInputElement).value) }))}
          onBlur={() => Number(f.quantity) !== (sub.quantity ?? 0) && save({ quantity: Number(f.quantity) })}
        />
        <input
          class="form-input subitem__num"
          value={f.unit}
          placeholder="Unit"
          onInput={(ev) => setF((p) => ({ ...p, unit: (ev.target as HTMLInputElement).value }))}
          onBlur={() => (f.unit || null) !== (sub.unit ?? null) && save({ unit: f.unit || null })}
        />
        <input
          class="form-input subitem__num"
          type="number"
          step="any"
          value={f.unit_cost}
          placeholder="Cost"
          onInput={(ev) => setF((p) => ({ ...p, unit_cost: Number((ev.target as HTMLInputElement).value) }))}
          onBlur={() => Number(f.unit_cost) !== (sub.unit_cost ?? 0) && save({ unit_cost: Number(f.unit_cost) })}
        />
        <span class="subitem__total">{formatCurrency(sub.total_cost)}</span>
        {onRequestBids && (
          <button
            type="button"
            class="link-btn"
            style={{ fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}
            onClick={onRequestBids}
            title="Request competitive bids for this subcontractor scope"
          >
            Request Bids
          </button>
        )}
        <button class="li-row__del" title="Remove sub-item" onClick={() => mutate(() => api.del(`/api/sub-items/${sub.id}`))}>
          ×
        </button>
      </div>
      {bidSummary && (
        <div class="subitem-bid-status">
          <span
            class={`badge badge--${
              bidSummary.status === "awarded"
                ? "success"
                : bidSummary.submission_count > 0
                  ? "info"
                  : "neutral"
            }`}
          >
            {bidStatusLabel(bidSummary)}
          </span>
          <button
            type="button"
            class="link-btn"
            style={{ fontSize: "var(--text-xs)" }}
            onClick={() => onViewComparison(bidSummary.id)}
          >
            View Comparison
          </button>
        </div>
      )}
    </div>
  );
}

function MaterialSearchModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (m: VendorMaterial) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<VendorMaterial[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setQ("");
      setResults([]);
      setSearched(false);
    }
  }, [open]);

  const search = async () => {
    setBusy(true);
    try {
      const r = await api.get<{ materials: VendorMaterial[] }>(`/api/materials/search?q=${encodeURIComponent(q)}`);
      setResults(r.materials);
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
      setSearched(true);
    }
  };

  return (
    <Modal open={open} title="Search Materials" onClose={onClose}>
      <div class="flex gap-sm">
        <input
          class="form-input"
          placeholder="Search by material or vendor (e.g. 2x4)…"
          value={q}
          onInput={(ev) => setQ((ev.target as HTMLInputElement).value)}
          onKeyDown={(ev) => ev.key === "Enter" && search()}
        />
        <Button variant="primary" onClick={search} disabled={busy}>
          Search
        </Button>
      </div>
      <div class="mt-md">
        {busy && <div class="text--muted">Searching…</div>}
        {!busy && searched && results.length === 0 && (
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            No materials found. Add this cost manually instead.
          </div>
        )}
        {results.map((m) => (
          <button key={m.id} class="typeahead__item" onClick={() => onPick(m)}>
            <span>
              {m.material_name} — {formatCurrency(m.last_price)}/{m.unit}
            </span>
            <span class="text--muted">
              {m.vendor_name}
              {m.average_price != null ? ` · avg ${formatCurrency(m.average_price)}` : ""}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
