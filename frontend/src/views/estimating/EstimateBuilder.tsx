import type { RoutableProps } from "preact-router";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate, formatStatus } from "../../lib/format";
import {
  buildDefaultMilestones,
  defaultDepositAmount,
  depositFromSchedule,
  effectiveDeposit,
  isCostPlusSchedule,
  isScheduleUnconfigured,
  milestoneAmount,
  milestonePercentage,
  shouldAutoPopulateSchedule,
  isPerLineItemBilling,
} from "../../lib/estimate-milestones";
import { canDeleteEstimate, DeleteEstimateButton } from "./DeleteEstimateButton";
import {
  BILLING_MODELS,
  BILLING_MODEL_DESCRIPTIONS,
  type BillingModel,
  ESTIMATE_MODES,
  LOST_REASONS,
  PAYMENT_TRIGGERS,
  SUB_ITEM_CATEGORIES,
  type Estimate,
  type EstimateLineItem,
  type EstimateTemplate,
  type SavedReview,
  type VendorMaterial,
} from "../../types";

interface BuilderProps extends RoutableProps {
  requestId?: string;
}

const LOW_MARGIN = 15;

export function EstimateBuilder({ requestId }: BuilderProps) {
  const toast = useToast();
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<EstimateTemplate[]>([]);
  const [reviews, setReviews] = useState<SavedReview[]>([]);
  const [mobileView, setMobileView] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [defaultScheduleNote, setDefaultScheduleNote] = useState(false);
  const [restorationHintDismissed, setRestorationHintDismissed] = useState(false);
  const scheduleBootstrappedRef = useRef<string | null>(null);

  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

  // Create-or-open the estimate for this request on mount.
  useEffect(() => {
    let cancelled = false;
    if (!requestId) {
      setError("No request specified.");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await api.post<{ estimate: Estimate; created: boolean }>("/api/estimates", {
          estimate_request_id: requestId,
        });
        if (cancelled) return;
        setEstimate(res.estimate);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  // Load active templates + reviews for the selectors.
  useEffect(() => {
    api
      .get<{ templates: EstimateTemplate[] }>("/api/estimate-templates")
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
    api
      .get<{ reviews: SavedReview[] }>("/api/reviews?active=true")
      .then((r) => setReviews(r.reviews))
      .catch(() => setReviews([]));
  }, []);

  // First open: apply defaults when contract/billing are set but schedule is blank.
  useEffect(() => {
    if (!estimate || estimate.status === "sent" || estimate.status === "approved") return;
    if (scheduleBootstrappedRef.current === estimate.id) return;
    scheduleBootstrappedRef.current = estimate.id;
    if (isPerLineItemBilling(estimate.billing_model)) return;
    if (!isScheduleUnconfigured(estimate.payment_schedule)) return;
    void applyDefaultSchedule(estimate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimate?.id]);

  useEffect(() => {
    if (estimate?.job_type !== "restoration") {
      setRestorationHintDismissed(false);
    }
  }, [estimate?.job_type]);

  const reload = async () => {
    if (!estimate) return;
    try {
      const res = await api.get<{ estimate: Estimate }>(`/api/estimates/${estimate.id}`);
      setEstimate(res.estimate);
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  async function applyDefaultSchedule(est: Estimate, successMsg?: string) {
    if (!est || est.status === "sent" || est.status === "approved") return;
    if (isPerLineItemBilling(est.billing_model)) return;
    if (!isScheduleUnconfigured(est.payment_schedule)) return;
    setSaving(true);
    try {
      const milestones = buildDefaultMilestones(est);
      await api.put(`/api/estimates/${est.id}/payment-schedule`, { milestones });
      await reload();
      setDefaultScheduleNote(true);
      if (successMsg) toast.push("success", successMsg);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  // Generic mutation: run an API call, refresh from the server (source of truth).
  const mutate = async (fn: () => Promise<unknown>, successMsg?: string) => {
    if (!estimate) return;
    setSaving(true);
    try {
      await fn();
      await reload();
      if (successMsg) toast.push("success", successMsg);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Spinner center />;
  if (error || !estimate) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">🔍</div>
        <div class="empty-state__title">Couldn't open the builder</div>
        <div>{error ?? "Estimate not found."}</div>
        <div class="mt-md">
          <Button variant="secondary" onClick={() => go("/estimating")}>
            Back to pipeline
          </Button>
        </div>
      </div>
    );
  }

  const e = estimate;
  const sent = e.status === "sent" || e.status === "approved";
  const marginLow = e.total > 0 && e.margin_percent < LOW_MARGIN;

  const patchHeader = (body: Record<string, unknown>, msg?: string) =>
    mutate(() => api.put(`/api/estimates/${e.id}`, body), msg);

  const patchWithAutoSchedule = (body: Record<string, unknown>, msg?: string) => {
    const merged = { ...e, ...body } as Estimate;
    const switchingToPerLineItem =
      "billing_model" in body &&
      body.billing_model != null &&
      isPerLineItemBilling(String(body.billing_model)) &&
      !isPerLineItemBilling(e.billing_model);
    const tryAuto = shouldAutoPopulateSchedule(body, e);
    const scheduleMsg = switchingToPerLineItem
      ? msg
        ? `${msg} — payment schedule cleared`
        : "Payment schedule cleared"
      : tryAuto
        ? msg
          ? `${msg} — payment schedule updated`
          : "Payment schedule updated"
        : msg;
    return mutate(async () => {
      // Persist header fields first. A no-op billing_model change returns 400 — don't
      // block schedule refresh when the schedule still needs defaults.
      try {
        await api.put(`/api/estimates/${e.id}`, body);
      } catch (err) {
        if (!(tryAuto || switchingToPerLineItem) || !(err instanceof ApiError && err.status === 400)) {
          throw err;
        }
      }
      if (switchingToPerLineItem) {
        await api.put(`/api/estimates/${e.id}/payment-schedule`, { milestones: [] });
        setDefaultScheduleNote(false);
      } else if (tryAuto) {
        const milestones = buildDefaultMilestones(merged);
        await api.put(`/api/estimates/${e.id}/payment-schedule`, { milestones });
        setDefaultScheduleNote(true);
      }
    }, scheduleMsg);
  };

  return (
    <div class="builder">
      <div class="view-header">
        <div>
          <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
            <h1 class="view-title">
              EST-{String(e.estimate_number ?? 0).padStart(3, "0")}
              {e.version > 1 ? ` · v${e.version}` : ""}
            </h1>
            <Badge tone={e.status === "sent" ? "info" : e.status === "approved" ? "success" : "neutral"}>
              {formatStatus(e.status)}
            </Badge>
            {saving && <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>Saving…</span>}
          </div>
          <p class="view-subtitle">
            {e.client_name ?? "—"} · {e.title ?? formatStatus(e.job_type ?? "")}
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => e.request_id && go(`/estimating/${e.request_id}`)}>
            ← Request
          </Button>
          {sent && (
            <Button variant="secondary" onClick={() => mutate(() => api.post(`/api/estimates/${e.id}/revise`).then((r: any) => go(`/estimating/${r.estimate.request_id}/estimate`)), "Revision created")}>
              Revise
            </Button>
          )}
          {sent && e.status !== "approved" && (
            <MarkLostButton estimate={e} mutate={mutate} />
          )}
          {canDeleteEstimate(e) && <DeleteEstimateButton estimate={e} />}
        </div>
      </div>

      {sent && <SentStatusCard estimate={e} />}

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <Card>
        <div class="builder__topbar">
          <div class="builder__controls">
            <div class="builder__control">
              <div class="builder__control-label">Mode</div>
              <div class="segmented">
                {ESTIMATE_MODES.map((m) => (
                  <button
                    key={m.value}
                    class={`segmented__btn${e.estimate_mode === m.value ? " segmented__btn--active" : ""}`}
                    onClick={() =>
                      e.estimate_mode !== m.value &&
                      patchWithAutoSchedule({ estimate_mode: m.value }, "Estimate mode updated")
                    }
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div class="builder__control builder__control--billing">
              <div class="builder__control-label">Billing Model</div>
              <Select
                value={e.billing_model ?? ""}
                options={BILLING_MODELS}
                onChange={(v) => patchWithAutoSchedule({ billing_model: v }, "Billing model updated")}
              />
              <BillingModelHint
                visible={
                  e.job_type === "restoration" &&
                  !isPerLineItemBilling(e.billing_model) &&
                  !restorationHintDismissed
                }
                onApply={() => {
                  setRestorationHintDismissed(true);
                  void patchWithAutoSchedule({ billing_model: "per_line_item" }, "Billing model updated");
                }}
                onDismiss={() => setRestorationHintDismissed(true)}
              />
            </div>
            <TemplateApplier
              templates={templates}
              hasLineItems={e.line_items.length > 0}
              onApply={(tid) =>
                mutate(() => api.post(`/api/estimates/${e.id}/apply-template/${tid}`), "Template applied")
              }
            />
          </div>
          {e.billing_model && BILLING_MODEL_DESCRIPTIONS[e.billing_model as BillingModel] && (
            <p class="builder__billing-desc">
              {BILLING_MODEL_DESCRIPTIONS[e.billing_model as BillingModel]}
            </p>
          )}

          <div class={`margin-summary${marginLow ? " margin-summary--low" : ""}`}>
            <div class="margin-summary__item">
              <span class="margin-summary__label">Client Price</span>
              <span class="margin-summary__value">{formatCurrency(e.total)}</span>
            </div>
            <div class="margin-summary__item">
              <span class="margin-summary__label">Internal Cost</span>
              <span class="margin-summary__value">{formatCurrency(e.internal_cost)}</span>
            </div>
            <div class="margin-summary__item">
              <span class="margin-summary__label">Margin</span>
              <span class={`margin-summary__value${marginLow ? " text--margin-low" : ""}`}>
                {e.margin_percent}%
              </span>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Mobile edit/preview toggle ──────────────────────────── */}
      <div class="builder__mobile-toggle">
        <button
          class={`segmented__btn${mobileView === "edit" ? " segmented__btn--active" : ""}`}
          onClick={() => setMobileView("edit")}
        >
          Edit
        </button>
        <button
          class={`segmented__btn${mobileView === "preview" ? " segmented__btn--active" : ""}`}
          onClick={() => setMobileView("preview")}
        >
          Preview
        </button>
      </div>

      <div class="builder__panels">
        {/* ── Left: line item editor ───────────────────────────── */}
        <div class={`builder__panel builder__panel--editor${mobileView === "preview" ? " is-hidden-mobile" : ""}`}>
          <LineItemEditor estimate={e} mutate={mutate} />

          {isPerLineItemBilling(e.billing_model) && (
            <PerLineItemDeposit estimate={e} patchHeader={patchHeader} />
          )}

          {!isPerLineItemBilling(e.billing_model) && (
            <PaymentScheduleBuilder
              estimate={e}
              mutate={mutate}
              showDefaultNote={defaultScheduleNote}
              showCostPlusNote={isCostPlusSchedule(e)}
              onUserEdit={() => setDefaultScheduleNote(false)}
              onApplyDefaults={() => void applyDefaultSchedule(e, "Default payment schedule added")}
            />
          )}

          <OptionsCard estimate={e} reviews={reviews} patchHeader={patchHeader} patchWithAutoSchedule={patchWithAutoSchedule} />
        </div>

        {/* ── Right: live client preview ───────────────────────── */}
        <div class={`builder__panel builder__panel--preview${mobileView === "edit" ? " is-hidden-mobile" : ""}`}>
          <ClientPreview estimate={e} reviews={reviews} />
        </div>
      </div>

      {/* ── Footer actions ──────────────────────────────────────── */}
      <div class="builder__footer">
        <SaveTemplate estimate={e} toast={toast} onSaved={() => api.get<{ templates: EstimateTemplate[] }>("/api/estimate-templates").then((r) => setTemplates(r.templates))} />
        <div class="flex gap-sm">
          <Button variant="secondary" onClick={() => toast.push("success", "Draft saved")}>
            Save Draft
          </Button>
          <SendButton estimate={e} mutate={mutate} toast={toast} />
        </div>
      </div>
    </div>
  );
}

// ─── Template applier (with confirm when line items exist) ────────────────────

function BillingModelHint({
  visible,
  onApply,
  onDismiss,
}: {
  visible: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  if (!visible) return null;
  return (
    <div class="builder__hint" role="status">
      <span>💡 Restoration jobs typically use Pay-As-Completed billing.</span>
      <Button size="sm" variant="primary" onClick={onApply}>
        Apply
      </Button>
      <button type="button" class="builder__hint-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

function TemplateApplier({
  templates,
  hasLineItems,
  onApply,
}: {
  templates: EstimateTemplate[];
  hasLineItems: boolean;
  onApply: (templateId: string) => void;
}) {
  const [pending, setPending] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const choose = (v: string) => {
    if (!v) return;
    if (hasLineItems) {
      setPending(v);
      setConfirmOpen(true);
    } else {
      onApply(v);
    }
  };

  return (
    <div class="builder__control" style={{ minWidth: "200px" }}>
      <div class="builder__control-label">Template</div>
      <Select
        value=""
        placeholder={templates.length ? "Apply a template…" : "No templates"}
        options={templates.map((t) => ({ value: t.id, label: `${t.name} (${formatStatus(t.job_type)})` }))}
        onChange={choose}
      />
      <Modal
        open={confirmOpen}
        title="Apply template?"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmOpen(false);
                onApply(pending);
              }}
            >
              Append template items
            </Button>
          </>
        }
      >
        <p>
          This estimate already has line items. Applying a template will add its line items on top of
          the existing ones. Continue?
        </p>
      </Modal>
    </div>
  );
}

// ─── Line item editor ─────────────────────────────────────────────────────────

function LineItemEditor({
  estimate,
  mutate,
}: {
  estimate: Estimate;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const addLineItem = () =>
    mutate(
      () =>
        api.post(`/api/estimates/${estimate.id}/line-items`, {
          product_service: "New Line Item",
          description: "",
          quantity: 1,
          unit_price: 0,
        }),
      "Line item added",
    );

  const onDrop = (targetId: string) => {
    const src = dragId;
    setDragId(null);
    setOverId(null);
    if (!src || src === targetId) return;
    const ids = estimate.line_items.map((li) => li.id);
    const from = ids.indexOf(src);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    void mutate(() => api.put(`/api/estimates/${estimate.id}/line-items/reorder`, { ids }));
  };

  return (
    <Card title="Line Items" actions={<Button size="sm" variant="primary" onClick={addLineItem}>+ Add Line Item</Button>}>
      {estimate.line_items.length === 0 ? (
        <div class="empty-state" style={{ padding: "var(--space-xl)" }}>
          <div class="empty-state__title">No line items yet</div>
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Add a line item to start building, or apply a template above.
          </div>
        </div>
      ) : (
        <div class="li-list">
          {estimate.line_items.map((li) => (
            <LineItemCard
              key={li.id}
              item={li}
              mutate={mutate}
              dragging={dragId === li.id}
              over={overId === li.id}
              onDragStart={() => setDragId(li.id)}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={() => setOverId(li.id)}
              onDrop={() => onDrop(li.id)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function LineItemCard({
  item,
  mutate,
  dragging,
  over,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  item: EstimateLineItem;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
  dragging: boolean;
  over: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fields, setFields] = useState({
    product_service: item.product_service,
    description: item.description,
    quantity: item.quantity ?? 1,
    unit: item.unit ?? "",
    unit_price: item.unit_price ?? 0,
    includes_note: item.includes_note ?? "",
  });

  useEffect(() => {
    setFields({
      product_service: item.product_service,
      description: item.description,
      quantity: item.quantity ?? 1,
      unit: item.unit ?? "",
      unit_price: item.unit_price ?? 0,
      includes_note: item.includes_note ?? "",
    });
  }, [item.id, item.product_service, item.description, item.quantity, item.unit, item.unit_price, item.includes_note]);

  const save = (patch: Record<string, unknown>) => mutate(() => api.put(`/api/line-items/${item.id}`, patch));
  const previewTotal = (Number(fields.quantity) || 0) * (Number(fields.unit_price) || 0);

  return (
    <div
      class={`li-card${dragging ? " li-card--dragging" : ""}${over ? " li-card--over" : ""}`}
      onDragOver={(ev) => {
        ev.preventDefault();
        onDragOver();
      }}
      onDrop={(ev) => {
        ev.preventDefault();
        onDrop();
      }}
    >
      <div class="li-card__head">
        <span
          class="li-card__drag"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title="Drag to reorder"
        >
          ⠿
        </span>
        <button class="li-card__toggle" onClick={() => setExpanded((x) => !x)} title="Show/hide sub-items">
          {expanded ? "▾" : "▸"}
        </button>
        <input
          class="form-input li-card__name"
          value={fields.product_service}
          placeholder="Product / service"
          onInput={(ev) => setFields((f) => ({ ...f, product_service: (ev.target as HTMLInputElement).value }))}
          onBlur={() => fields.product_service !== item.product_service && save({ product_service: fields.product_service })}
        />
        <span class="li-card__total">{formatCurrency(previewTotal)}</span>
        <button
          class="li-card__del"
          title="Remove line item"
          onClick={() => mutate(() => api.del(`/api/line-items/${item.id}`), "Line item removed")}
        >
          ✕
        </button>
      </div>

      <div class="li-card__row">
        <textarea
          class="form-textarea li-card__desc"
          placeholder="Scope of work for this line item…"
          value={fields.description}
          onInput={(ev) => setFields((f) => ({ ...f, description: (ev.target as HTMLTextAreaElement).value }))}
          onBlur={() => fields.description !== item.description && save({ description: fields.description })}
        />
      </div>

      <div class="li-card__inputs">
        <label class="li-input">
          <span>Qty</span>
          <input
            class="form-input"
            type="number"
            step="any"
            value={fields.quantity}
            onInput={(ev) => setFields((f) => ({ ...f, quantity: Number((ev.target as HTMLInputElement).value) }))}
            onBlur={() => Number(fields.quantity) !== (item.quantity ?? 1) && save({ quantity: Number(fields.quantity) })}
          />
        </label>
        <label class="li-input">
          <span>Unit</span>
          <input
            class="form-input"
            value={fields.unit}
            placeholder="each"
            onInput={(ev) => setFields((f) => ({ ...f, unit: (ev.target as HTMLInputElement).value }))}
            onBlur={() => (fields.unit || null) !== (item.unit ?? null) && save({ unit: fields.unit })}
          />
        </label>
        <label class="li-input">
          <span>Unit Price</span>
          <input
            class="form-input"
            type="number"
            step="any"
            value={fields.unit_price}
            onInput={(ev) => setFields((f) => ({ ...f, unit_price: Number((ev.target as HTMLInputElement).value) }))}
            onBlur={() => Number(fields.unit_price) !== (item.unit_price ?? 0) && save({ unit_price: Number(fields.unit_price) })}
          />
        </label>
      </div>

      <input
        class="form-input li-card__includes"
        value={fields.includes_note}
        placeholder='Includes note (e.g. "Price includes labor and materials")'
        onInput={(ev) => setFields((f) => ({ ...f, includes_note: (ev.target as HTMLInputElement).value }))}
        onBlur={() => (fields.includes_note || null) !== (item.includes_note ?? null) && save({ includes_note: fields.includes_note })}
      />

      {expanded && <SubItemList item={item} mutate={mutate} />}
      <div class="li-card__internal">
        Internal cost: {formatCurrency(item.internal_cost)} · margin{" "}
        {item.total > 0 ? Math.round(((item.total - item.internal_cost) / item.total) * 100) : 0}%
      </div>
    </div>
  );
}

// ─── Sub-items (internal cost) ─────────────────────────────────────────────────

function SubItemList({
  item,
  mutate,
}: {
  item: EstimateLineItem;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
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
          <Button size="sm" variant="secondary" onClick={addSub}>
            + Add Sub-Item
          </Button>
        </div>
      </div>
      {item.sub_items.length === 0 ? (
        <div class="subitems__empty">No sub-items. Add material, labor, or sub costs.</div>
      ) : (
        item.sub_items.map((s) => <SubItemRow key={s.id} sub={s} mutate={mutate} />)
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
}: {
  sub: import("../../types").EstimateSubItem;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
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
        type="number"
        step="any"
        value={f.unit_cost}
        placeholder="Cost"
        onInput={(ev) => setF((p) => ({ ...p, unit_cost: Number((ev.target as HTMLInputElement).value) }))}
        onBlur={() => Number(f.unit_cost) !== (sub.unit_cost ?? 0) && save({ unit_cost: Number(f.unit_cost) })}
      />
      <span class="subitem__total">{formatCurrency(sub.total_cost)}</span>
      <button class="li-card__del" title="Remove sub-item" onClick={() => mutate(() => api.del(`/api/sub-items/${sub.id}`))}>
        ✕
      </button>
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
      const r = await api.get<{ materials: VendorMaterial[] }>(
        `/api/materials/search?q=${encodeURIComponent(q)}`,
      );
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
        {busy && <Spinner center />}
        {!busy && searched && results.length === 0 && (
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            No materials found. The vendor/material database fills in automatically as expenses are
            logged (Sprint 10). You can add this cost manually instead.
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

// ─── Payment schedule builder ──────────────────────────────────────────────────

function PerLineItemDeposit({
  estimate,
  patchHeader,
}: {
  estimate: Estimate;
  patchHeader: (body: Record<string, unknown>, msg?: string) => Promise<void>;
}) {
  const requireDeposit = (estimate.deposit_amount ?? 0) > 0;
  const defaultAmount = defaultDepositAmount(estimate.total, estimate.billing_model);
  const [amountStr, setAmountStr] = useState(
    String((estimate.deposit_amount ?? 0) > 0 ? estimate.deposit_amount : defaultAmount),
  );

  useEffect(() => {
    if ((estimate.deposit_amount ?? 0) > 0) {
      setAmountStr(String(estimate.deposit_amount));
    }
  }, [estimate.deposit_amount, estimate.id]);

  const persistAmount = () => {
    if (!requireDeposit) return;
    const parsed = parseFloat(amountStr.replace(/[^0-9.]/g, ""));
    if (Number.isNaN(parsed) || parsed < 0) return;
    const rounded = Math.round(parsed * 100) / 100;
    if (Math.abs(rounded - (estimate.deposit_amount ?? 0)) > 0.009) {
      void patchHeader({ deposit_amount: rounded, deposit_type: "fixed" }, "Deposit updated");
    }
  };

  return (
    <Card title="Deposit">
      <label class="form-check" style={{ marginBottom: requireDeposit ? "var(--space-sm)" : 0 }}>
        <input
          type="checkbox"
          checked={requireDeposit}
          onChange={(ev) => {
            const checked = (ev.target as HTMLInputElement).checked;
            if (checked) {
              void patchHeader(
                {
                  deposit_amount: defaultAmount,
                  deposit_type: "percentage",
                  deposit_percentage: 33,
                },
                "Deposit enabled",
              );
            } else {
              void patchHeader(
                {
                  deposit_amount: 0,
                  deposit_type: "fixed",
                  deposit_percentage: null,
                },
                "Deposit removed",
              );
            }
          }}
        />
        Require deposit
      </label>
      {requireDeposit && (
        <FormField label="Deposit">
          <input
            class="form-input"
            type="text"
            inputMode="decimal"
            value={amountStr}
            onInput={(ev) => setAmountStr((ev.target as HTMLInputElement).value)}
            onBlur={persistAmount}
          />
        </FormField>
      )}
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-sm)" }}>
        Single upfront amount due at signing, applied toward the first invoice.
      </p>
    </Card>
  );
}

function PaymentScheduleBuilder({
  estimate,
  mutate,
  showDefaultNote,
  showCostPlusNote,
  onUserEdit,
  onApplyDefaults,
}: {
  estimate: Estimate;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
  showDefaultNote: boolean;
  showCostPlusNote: boolean;
  onUserEdit: () => void;
  onApplyDefaults: () => void;
}) {
  const unconfigured = isScheduleUnconfigured(estimate.payment_schedule);
  const [rows, setRows] = useState(
    estimate.payment_schedule.map((p) => ({
      description: p.description,
      percentage: p.percentage,
      fixed_amount: p.fixed_amount,
      is_deposit: p.is_deposit,
      trigger: p.trigger ?? "",
    })),
  );

  const scheduleKey = estimate.payment_schedule
    .map((p) => `${p.id}:${p.sort_order}:${p.description}:${p.percentage}:${p.fixed_amount}:${p.is_deposit}`)
    .join("|");

  useEffect(() => {
    setRows(
      estimate.payment_schedule.map((p) => ({
        description: p.description,
        percentage: p.percentage,
        fixed_amount: p.fixed_amount,
        is_deposit: p.is_deposit,
        trigger: p.trigger ?? "",
      })),
    );
  }, [estimate.id, scheduleKey]);

  const pctRows = rows.filter((r) => r.percentage != null && r.fixed_amount == null);
  const pctSum = pctRows.reduce((a, r) => a + (Number(r.percentage) || 0), 0);
  const pctValid = pctRows.length === 0 || Math.abs(pctSum - 100) < 0.01;

  const persist = (next: typeof rows, edited = true) => {
    if (edited) onUserEdit();
    return mutate(() =>
      api.put(`/api/estimates/${estimate.id}/payment-schedule`, {
        milestones: next.map((r, i) => ({
          sort_order: i,
          description: r.description || `Payment ${i + 1}`,
          percentage: r.percentage,
          fixed_amount: r.fixed_amount,
          is_deposit: r.is_deposit,
          trigger: r.trigger || null,
        })),
      }),
    );
  };

  const addRow = () => {
    if (unconfigured) {
      onApplyDefaults();
      return;
    }
    const next = [...rows, { description: "", percentage: null as number | null, fixed_amount: null as number | null, is_deposit: rows.length === 0, trigger: "" }];
    setRows(next);
    void persist(next);
  };
  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    void persist(next);
  };
  const update = (i: number, patch: Partial<(typeof rows)[number]>) => {
    onUserEdit();
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  return (
    <Card
      title="Payment Schedule"
      actions={<Button size="sm" variant="primary" onClick={addRow}>+ Add Milestone</Button>}
    >
      {unconfigured && rows.length > 0 && (
        <div class="text--muted" style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-sm)" }}>
          Milestones have no amounts yet.{" "}
          <button type="button" class="link-btn" onClick={onApplyDefaults}>
            Apply default schedule
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          No milestones yet — click <strong>+ Add Milestone</strong> to apply the default schedule for
          this contract type.
        </div>
      ) : (
        <div class="pay-list">
          {rows.map((r, i) => {
            const isPctBased = r.percentage != null && r.fixed_amount == null;
            const isFixedBased = r.fixed_amount != null && r.fixed_amount > 0 && r.percentage == null;
            const computedDollar = milestoneAmount(
              { percentage: r.percentage, fixed_amount: r.fixed_amount, amount: 0 },
              estimate.total,
            );
            const computedPct =
              isFixedBased && r.fixed_amount != null
                ? milestonePercentage(r.fixed_amount, estimate.total)
                : null;

            return (
            <div class="pay-row" key={i}>
              <input
                class="form-input"
                placeholder="Description"
                value={r.description}
                onInput={(ev) => update(i, { description: (ev.target as HTMLInputElement).value })}
                onBlur={() => persist(rows)}
              />
              <label class="pay-row__num">
                <span>%</span>
                {isFixedBased && computedPct != null ? (
                  <span class="pay-row__computed-val" title="Computed from dollar amount ÷ total">
                    {computedPct}
                  </span>
                ) : (
                  <input
                    class="form-input"
                    type="number"
                    step="any"
                    value={r.percentage ?? ""}
                    onInput={(ev) => {
                      const v = (ev.target as HTMLInputElement).value;
                      update(i, { percentage: v === "" ? null : Number(v), fixed_amount: null });
                    }}
                    onBlur={() => persist(rows)}
                  />
                )}
              </label>
              <label class="pay-row__num">
                <span>$</span>
                {isPctBased ? (
                  <span class="pay-row__computed-val" title="Computed from percentage × total">
                    {formatCurrency(computedDollar)}
                  </span>
                ) : (
                  <input
                    class="form-input"
                    type="number"
                    step="any"
                    value={r.fixed_amount ?? ""}
                    onInput={(ev) => {
                      const v = (ev.target as HTMLInputElement).value;
                      update(i, { fixed_amount: v === "" ? null : Number(v), percentage: null });
                    }}
                    onBlur={() => persist(rows)}
                  />
                )}
              </label>
              <Select
                value={r.trigger}
                placeholder="Trigger…"
                options={PAYMENT_TRIGGERS.map((t) => ({ value: t, label: formatStatus(t) }))}
                onChange={(v) => {
                  update(i, { trigger: v });
                  persist(rows.map((row, idx) => (idx === i ? { ...row, trigger: v } : row)));
                }}
              />
              <label class="pay-row__dep" title="Deposit milestone">
                <input
                  type="checkbox"
                  checked={r.is_deposit}
                  onChange={(ev) => {
                    const checked = (ev.target as HTMLInputElement).checked;
                    update(i, { is_deposit: checked });
                    persist(rows.map((row, idx) => (idx === i ? { ...row, is_deposit: checked } : row)));
                  }}
                />
                Deposit
              </label>
              <button class="li-card__del" onClick={() => removeRow(i)} title="Remove">
                ✕
              </button>
            </div>
            );
          })}
        </div>
      )}
      {showDefaultNote && (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-sm) 0 0" }}>
          Default payment schedule added. Adjust amounts as needed.
        </p>
      )}
      {showCostPlusNote && (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-sm) 0 0" }}>
          Remaining payments are generated automatically each billing cycle.
        </p>
      )}
      {pctRows.length > 0 && (
        <div class={`pay-validate${pctValid ? "" : " pay-validate--bad"}`}>
          Percentages total {Math.round(pctSum * 100) / 100}% {pctValid ? "✓" : "— must equal 100% before sending"}
        </div>
      )}
    </Card>
  );
}

// ─── Options (validity, reviews, contract) ─────────────────────────────────────

function OptionsCard({
  estimate,
  reviews,
  patchHeader,
  patchWithAutoSchedule,
}: {
  estimate: Estimate;
  reviews: SavedReview[];
  patchHeader: (body: Record<string, unknown>, msg?: string) => Promise<void>;
  patchWithAutoSchedule: (body: Record<string, unknown>, msg?: string) => Promise<void>;
}) {
  const [days, setDays] = useState(estimate.valid_days);
  useEffect(() => setDays(estimate.valid_days), [estimate.valid_days]);

  return (
    <Card title="Quote Options">
      <div class="stack">
        <label class="li-input" style={{ maxWidth: "200px" }}>
          <span>Validity (days)</span>
          <input
            class="form-input"
            type="number"
            value={days}
            onInput={(ev) => setDays(Number((ev.target as HTMLInputElement).value))}
            onBlur={() => Number(days) !== estimate.valid_days && patchHeader({ valid_days: Number(days) })}
          />
        </label>

        <label class="builder__check">
          <input
            type="checkbox"
            checked={estimate.include_reviews}
            onChange={(ev) => patchHeader({ include_reviews: (ev.target as HTMLInputElement).checked })}
          />
          Include customer reviews ({reviews.length} active)
        </label>

        <label class="builder__check">
          <input
            type="checkbox"
            checked={estimate.include_contract}
            onChange={(ev) =>
              patchWithAutoSchedule({ include_contract: (ev.target as HTMLInputElement).checked })
            }
          />
          Include service agreement / contract
        </label>

        <FormField label="Contract">
          <Select
            value={estimate.contract_template_id ?? "standard_service_agreement"}
            options={[
              { value: "standard_service_agreement", label: "Standard Service Agreement" },
              { value: "cost_plus_billing_agreement", label: "Cost-Plus Billing Agreement" },
            ]}
            onChange={(v) => {
              if (!v) return;
              void patchWithAutoSchedule({ contract_template_id: v }, "Contract type updated");
            }}
          />
        </FormField>
      </div>
    </Card>
  );
}

// ─── Client-facing preview (sub-items NEVER appear here) ───────────────────────

function ClientPreview({ estimate, reviews }: { estimate: Estimate; reviews: SavedReview[] }) {
  const e = estimate;
  const depositDue = effectiveDeposit(e);
  const shownReviews = useMemo(() => reviews.filter((r) => r.is_active).slice(0, 3), [reviews]);

  return (
    <Card title="Client Preview">
      <div class="preview theme-light">
        <div class="preview__brand">
          <div class="preview__logo">CHS</div>
          <div>
            <div class="preview__company">Columbus Home Solutions</div>
            <div class="preview__est-num">
              EST-{String(e.estimate_number ?? 0).padStart(3, "0")}
              {e.version > 1 ? ` · Revision ${e.version}` : ""}
            </div>
          </div>
          <span class="preview__status">{formatStatus(e.status)}</span>
        </div>

        <div class="preview__meta">
          <div>
            <div class="preview__meta-label">Prepared for</div>
            <div>{e.client_name ?? "—"}</div>
            <div class="preview__meta-sub">
              {[e.property_address, e.property_city, e.property_state, e.property_zip].filter(Boolean).join(", ")}
            </div>
          </div>
          {depositDue > 0 && (
            <div class="preview__deposit">
              <div class="preview__meta-label">Deposit to begin</div>
              <div class="preview__deposit-amount">{formatCurrency(depositDue)}</div>
            </div>
          )}
        </div>

        {e.title && <div class="preview__title">{e.title}</div>}

        <div class="preview__lines">
          {e.line_items.length === 0 ? (
            <div class="preview__empty">Line items will appear here as you build the estimate.</div>
          ) : (
            e.line_items.map((li) => (
              <div class="preview__line" key={li.id}>
                <div class="preview__line-main">
                  <span class="preview__line-name">{li.product_service}</span>
                  <span class="preview__line-total">{formatCurrency(li.total)}</span>
                </div>
                {li.description && <div class="preview__line-desc">{li.description}</div>}
                <div class="preview__line-qty">
                  {li.quantity ?? 1}
                  {li.unit ? ` ${li.unit}` : ""} × {formatCurrency(li.unit_price)}
                  {li.includes_note ? ` · ${li.includes_note}` : ""}
                </div>
              </div>
            ))
          )}
        </div>

        <div class="preview__totals">
          <div class="preview__total-row">
            <span>Subtotal</span>
            <span>{formatCurrency(e.subtotal)}</span>
          </div>
          {e.tax_amount > 0 && (
            <div class="preview__total-row">
              <span>Tax</span>
              <span>{formatCurrency(e.tax_amount)}</span>
            </div>
          )}
          <div class="preview__total-row preview__total-row--grand">
            <span>Total</span>
            <span>{formatCurrency(e.total)}</span>
          </div>
        </div>

        {e.payment_schedule.length > 0 && (
          <div class="preview__section">
            <div class="preview__section-title">Payment Schedule</div>
            {e.payment_schedule.map((p) => (
              <div class="preview__pay" key={p.id}>
                <span>
                  {p.description}
                  {p.is_deposit ? " (deposit)" : ""}
                  {p.percentage != null && p.fixed_amount == null ? ` · ${p.percentage}%` : ""}
                </span>
                <span>{formatCurrency(milestoneAmount(p, e.total))}</span>
              </div>
            ))}
          </div>
        )}

        {e.include_reviews && shownReviews.length > 0 && (
          <div class="preview__section">
            <div class="preview__section-title">What our clients say</div>
            {shownReviews.map((r) => (
              <div class="preview__review" key={r.id}>
                <div class="preview__stars">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</div>
                <div class="preview__review-text">{r.review_text}</div>
                <div class="preview__review-by">— {r.reviewer_name}</div>
              </div>
            ))}
          </div>
        )}

        {e.include_contract && (
          <div class="preview__notice">
            Includes our{" "}
            {e.contract_template_id === "cost_plus_billing_agreement"
              ? "cost-plus billing agreement"
              : "standard service agreement"}{" "}
            with a digital signature.
          </div>
        )}

        <div class="preview__validity">
          {e.expiration_date
            ? `Valid until ${formatDate(e.expiration_date)}`
            : `Valid for ${e.valid_days} days from the day it's sent.`}
        </div>
      </div>
    </Card>
  );
}

// ─── Sent status: client link + progress (Sprint 5) ───────────────────────────

function SentStatusCard({ estimate }: { estimate: Estimate }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const link = estimate.portal_path
    ? `${window.location.origin}${estimate.portal_path}`
    : null;

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.push("success", "Client link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.push("error", "Couldn't copy — select and copy manually.");
    }
  };

  // Progress: Sent → Viewed → Signed → Deposit Paid (approved).
  const steps = [
    { label: "Sent", done: true, when: estimate.sent_at },
    { label: "Viewed", done: !!estimate.viewed_date || ["viewed", "approved"].includes(estimate.status), when: estimate.viewed_date },
    { label: "Signed", done: estimate.signed, when: estimate.signed_date },
    { label: "Deposit Paid", done: estimate.status === "approved", when: estimate.approved_date },
  ];

  return (
    <Card title="Client Quote Link">
      <div class="stack">
        <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <input
            class="form-input"
            style={{ flex: "1", minWidth: "240px" }}
            readOnly
            value={link ?? "Link will appear once the quote is sent."}
            onFocus={(ev) => (ev.target as HTMLInputElement).select()}
          />
          <Button variant="secondary" disabled={!link} onClick={copy}>
            {copied ? "Copied ✓" : "Copy link"}
          </Button>
          {link && (
            <Button variant="tertiary" onClick={() => window.open(link, "_blank")}>
              Open
            </Button>
          )}
        </div>
        <div class="quote-progress">
          {steps.map((s, i) => (
            <div key={i} class={`quote-progress__step${s.done ? " is-done" : ""}`}>
              <span class="quote-progress__dot">{s.done ? "✓" : i + 1}</span>
              <span class="quote-progress__label">
                {s.label}
                {s.when ? <span class="quote-progress__when"> · {formatDate(s.when)}</span> : ""}
              </span>
            </div>
          ))}
        </div>
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          Automated email/SMS delivery of this link arrives with the Notification engine (Sprint 7).
          For now, copy and send it to the client.
        </p>
      </div>
    </Card>
  );
}

function MarkLostButton({
  estimate,
  mutate,
}: {
  estimate: Estimate;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Mark Lost
      </Button>
      <Modal
        open={open}
        title="Mark estimate as lost"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!reason}
              onClick={() => {
                setOpen(false);
                void mutate(
                  () => api.post(`/api/estimates/${estimate.id}/lost`, { reason, notes: notes || null }),
                  "Marked as lost",
                );
              }}
            >
              Mark Lost
            </Button>
          </>
        }
      >
        <FormField label="Reason" required>
          <Select
            value={reason}
            placeholder="Select a reason…"
            options={LOST_REASONS.map((x) => ({ value: x, label: formatStatus(x) }))}
            onChange={setReason}
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
    </>
  );
}

// ─── Save-as-template + Send ────────────────────────────────────────────────────

function SaveTemplate({
  estimate,
  toast,
  onSaved,
}: {
  estimate: Estimate;
  toast: ReturnType<typeof useToast>;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post("/api/estimate-templates", {
        name,
        job_type: estimate.job_type ?? "other",
        default_billing_model: estimate.billing_model,
        from_estimate_id: estimate.id,
      });
      toast.push("success", "Saved as template");
      setOpen(false);
      setName("");
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="tertiary" onClick={() => setOpen(true)} disabled={estimate.line_items.length === 0}>
        Save as Template
      </Button>
      <Modal
        open={open}
        title="Save as template"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name || busy} onClick={save}>
              Save Template
            </Button>
          </>
        }
      >
        <FormField label="Template name" required>
          <input
            class="form-input"
            value={name}
            placeholder="e.g. Bathroom Remodel"
            onInput={(ev) => setName((ev.target as HTMLInputElement).value)}
          />
        </FormField>
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          Captures the current line items and sub-items as a reusable template.
        </p>
      </Modal>
    </>
  );
}

function SendButton({
  estimate,
  mutate,
  toast,
}: {
  estimate: Estimate;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
  toast: ReturnType<typeof useToast>;
}) {
  const [open, setOpen] = useState(false);
  const perLineItem = isPerLineItemBilling(estimate.billing_model);
  const hasLine = estimate.line_items.length > 0;
  const hasDeposit = perLineItem
    ? (estimate.deposit_amount ?? 0) > 0
    : depositFromSchedule(estimate) > 0;
  const depositOk = perLineItem || hasDeposit;
  const pctRows = estimate.payment_schedule.filter((p) => p.percentage != null && p.fixed_amount == null);
  const pctOk =
    perLineItem ||
    pctRows.length === 0 ||
    Math.abs(pctRows.reduce((a, p) => a + (p.percentage ?? 0), 0) - 100) < 0.01;
  const blocked = !hasLine || !depositOk || !pctOk;
  const sent = estimate.status === "sent" || estimate.status === "approved";

  const confirmSend = () => {
    if (estimate.billing_model !== "per_line_item" && depositFromSchedule(estimate) <= 0) {
      toast.push("error", "Add a deposit milestone to the payment schedule before sending.");
      return;
    }
    setOpen(false);
    void mutate(() => api.post(`/api/estimates/${estimate.id}/send`), "Estimate sent");
  };

  return (
    <>
      <Button variant="primary" disabled={sent} onClick={() => setOpen(true)}>
        {sent ? "Sent" : "Send Estimate"}
      </Button>
      <Modal
        open={open}
        title="Send estimate"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={blocked}
              onClick={confirmSend}
            >
              Confirm Send
            </Button>
          </>
        }
      >
        <ul class="send-checklist">
          <li class={hasLine ? "ok" : "bad"}>{hasLine ? "✓" : "✕"} At least one line item</li>
          {perLineItem ? (
            <li class="ok">
              ✓{" "}
              {hasDeposit
                ? `Deposit configured (${formatCurrency(estimate.deposit_amount)})`
                : "No deposit required"}
            </li>
          ) : (
            <>
              <li class={hasDeposit ? "ok" : "bad"}>
                {hasDeposit ? "✓" : "✕"} Deposit milestone configured
              </li>
              <li class={pctOk ? "ok" : "bad"}>
                {pctOk ? "✓" : "✕"} Percentage milestones total 100%
              </li>
            </>
          )}
        </ul>
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          Marks the estimate as sent, freezes the contract text, and makes the secure client quote
          link live (sign + pay deposit). Copy the link to the client from the card above — automated
          email/SMS delivery arrives with the Notification engine (Sprint 7).
        </p>
      </Modal>
    </>
  );
}
