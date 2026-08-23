import type { RoutableProps } from "preact-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "preact/hooks";
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
import {
  formatCurrency,
  formatDate,
  formatPhone,
  formatPropertySlashLine,
  formatStatus,
} from "../../lib/format";
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
import { MarkWonModal } from "./MarkWonModal";
import { LineItemRow } from "./LineItemRow";
import { SelectionFormModal, type EditChoiceValues, type EditSelectionValues } from "./SelectionFormModal";
import {
  BILLING_MODELS,
  BILLING_MODEL_DESCRIPTIONS,
  type BillingModel,
  ESTIMATE_MODES,
  LOST_REASONS,
  PAYMENT_TRIGGERS,
  type Estimate,
  type EstimateLineItem,
  type EstimateRequest,
  type EstimateTemplate,
  type SavedReview,
} from "../../types";

interface BuilderProps extends RoutableProps {
  requestId?: string;
  /** Direct estimate ID — used for Jobber-imported estimates that have no request_id. */
  estimateId?: string;
}

const LOW_MARGIN = 15;

export function EstimateBuilder({ requestId, estimateId }: BuilderProps) {
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
  const [wonRequest, setWonRequest] = useState<EstimateRequest | null>(null);
  const [wonLoading, setWonLoading] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [descSaving, setDescSaving] = useState(false);
  const scheduleBootstrappedRef = useRef<string | null>(null);

  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

  const saveDescription = async () => {
    const e = estimate;
    if (!e?.request_id || descSaving) return;
    const next = descDraft.trim();
    const prev = (e.job_type_detail ?? "").trim();
    if (next === prev) return;
    if (e.job_type === "other" && !next) {
      toast.push("error", "Description is required for Other job types");
      setDescDraft(e.job_type_detail ?? "");
      return;
    }
    setDescSaving(true);
    try {
      await api.put(`/api/estimate-requests/${e.request_id}`, {
        job_type_detail: next || null,
      });
      const refreshed = await api.get<{ estimate: Estimate }>(`/api/estimates/${e.id}`);
      setEstimate(refreshed.estimate);
      setDescDraft(refreshed.estimate.job_type_detail ?? "");
      toast.push("success", "Description updated");
    } catch (err) {
      toast.push("error", errMsg(err));
      setDescDraft(e.job_type_detail ?? "");
    } finally {
      setDescSaving(false);
    }
  };

  // Create-or-open the estimate. Two paths:
  //   1. requestId provided → POST create-or-open (normal workflow)
  //   2. estimateId provided, no requestId → GET by ID (Jobber-imported estimates)
  useEffect(() => {
    let cancelled = false;
    if (!requestId && !estimateId) {
      setError("No request specified.");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        let res: { estimate: Estimate };
        if (estimateId && !requestId) {
          res = await api.get<{ estimate: Estimate }>(`/api/estimates/${estimateId}`);
        } else {
          res = await api.post<{ estimate: Estimate; created: boolean }>("/api/estimates", {
            estimate_request_id: requestId,
          });
        }
        if (cancelled) return;
        setEstimate(res.estimate);
        setDescDraft(res.estimate.job_type_detail ?? "");
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId, estimateId]);

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
    if (!estimate || estimate.status === "sent" || estimate.status === "viewed" || estimate.status === "approved" || estimate.status === "signed") return;
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
    if (!est || est.status === "sent" || est.status === "viewed" || est.status === "approved" || est.status === "signed") return;
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
  const sent = e.status === "sent" || e.status === "viewed" || e.status === "approved" || e.status === "signed";
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
            <Badge tone={e.status === "sent" || e.status === "viewed" ? "info" : e.status === "approved" || e.status === "signed" ? "success" : "neutral"}>
              {formatStatus(e.status)}
            </Badge>
            {saving && <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>Saving…</span>}
          </div>
          <p class="view-subtitle">
            {e.client_id ? (
              <a
                href={`/app/clients/${e.client_id}`}
                style={{ color: "inherit", textDecoration: "underline", textDecorationColor: "var(--color-border)", textUnderlineOffset: "2px" }}
                onClick={(ev) => { ev.preventDefault(); go(`/clients/${e.client_id}`); }}
              >
                {e.client_name ?? "—"}
              </a>
            ) : (e.client_name ?? "—")}
            {" · "}{e.title ?? formatStatus(e.job_type ?? "")}
          </p>
          {e.request_id && (
            <div class="form-group" style={{ marginTop: "0.5rem", maxWidth: "28rem" }}>
              <label class="form-label" for="builder-desc">Description</label>
              <input
                id="builder-desc"
                class="form-input"
                type="text"
                value={descDraft}
                placeholder="e.g. Pergola repair"
                disabled={descSaving}
                onInput={(ev) => setDescDraft((ev.target as HTMLInputElement).value)}
                onBlur={() => void saveDescription()}
                onKeyDown={(ev) => {
                  if ((ev as KeyboardEvent).key === "Enter") {
                    (ev.target as HTMLInputElement).blur();
                  }
                }}
              />
            </div>
          )}
        </div>
        <div class="view-header__right">
          <Button
            variant="tertiary"
            onClick={() => e.request_id ? go(`/estimating/${e.request_id}`) : go("/estimates")}
          >
            {e.request_id ? "← Request" : "← Estimates"}
          </Button>
          {e.linked_job_id && e.is_current_version && (
            <Button variant="primary" onClick={() => go(`/jobs/${e.linked_job_id}`)}>
              Go to Job {e.linked_job_number != null ? `#${e.linked_job_number}` : ""} →
            </Button>
          )}
          {sent && (
            <Button variant="danger" onClick={() => mutate(() => api.post(`/api/estimates/${e.id}/revise`).then((r: any) => r.estimate.request_id ? go(`/estimating/${r.estimate.request_id}/estimate`) : go(`/estimates/${r.estimate.id}`)), "Revision created")}>
              Revise
            </Button>
          )}
          {sent && e.status !== "approved" && (
            <MarkLostButton estimate={e} mutate={mutate} />
          )}
          {sent && e.request_id && !e.linked_job_id && (
            <Button
              variant="primary"
              disabled={wonLoading}
              onClick={async () => {
                setWonLoading(true);
                try {
                  const res = await api.get<{ request: EstimateRequest }>(
                    `/api/estimate-requests/${e.request_id}`,
                  );
                  setWonRequest(res.request);
                } catch (err) {
                  toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
                } finally {
                  setWonLoading(false);
                }
              }}
            >
              {wonLoading
                ? "Loading…"
                : e.deposit_payment_method === "cash" || e.deposit_payment_method === "check"
                  ? "Mark Deposit Received"
                  : "Record Deposit & Convert to Job"}
            </Button>
          )}
          {canDeleteEstimate(e) && <DeleteEstimateButton estimate={e} />}
        </div>
      </div>

      {sent && <SentStatusCard estimate={e} mutate={mutate} />}

      {/* Revision chain notices */}
      {e.status === "revised" && (
        <div class="notice notice--warning" style={{ marginBottom: "var(--space-4)" }}>
          <strong>This estimate has been revised.</strong> It is a historical version and can no longer be edited or sent. The client's portal link now points to the current version.
        </div>
      )}
      {e.revised_from_id && e.status !== "revised" && (
        <div class="notice notice--info" style={{ marginBottom: "var(--space-4)" }}>
          <strong>Revision {e.version}</strong> — this is a revised version of an earlier estimate.
        </div>
      )}

      {/* Notice for imported estimates with no resolvable client (orphaned FK from Jobber migration) */}
      {!e.request_id && !e.client_name && (
        <div class="notice notice--warning" style={{ marginBottom: "var(--space-md)" }}>
          No client on file — imported from Jobber. Client identity was not carried over during migration.
        </div>
      )}

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
          <LineItemEditor estimate={e} mutate={mutate} reload={reload} />
          <AllowancesSection estimate={e} />

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
        </div>

        {/* ── Right: live client preview + quote options ───────── */}
        <div class={`builder__panel builder__panel--preview${mobileView === "edit" ? " is-hidden-mobile" : ""}`}>
          <ClientPreview estimate={e} reviews={reviews} />
          <OptionsCard
            estimate={e}
            reviews={reviews}
            patchHeader={patchHeader}
            patchWithAutoSchedule={patchWithAutoSchedule}
          />
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

      <MarkWonModal
        request={wonRequest}
        estimateId={e.id}
        preferredMethod={e.deposit_payment_method}
        title={
          e.deposit_payment_method === "cash" || e.deposit_payment_method === "check"
            ? "Mark Deposit Received"
            : "Mark as Won"
        }
        confirmLabel={
          e.deposit_payment_method === "cash" || e.deposit_payment_method === "check"
            ? "Confirm — Deposit Received"
            : "Confirm — Mark as Won"
        }
        onClose={() => setWonRequest(null)}
        onWon={(_jobId) => {
          setWonRequest(null);
          // Refresh estimate to reflect approved status
          if (requestId) {
            api.post<{ estimate: Estimate }>("/api/estimates", { estimate_request_id: requestId })
              .then((r) => setEstimate(r.estimate))
              .catch(() => undefined);
          } else if (estimateId) {
            api.get<{ estimate: Estimate }>(`/api/estimates/${estimateId}`)
              .then((r) => setEstimate(r.estimate))
              .catch(() => undefined);
          }
        }}
      />
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

// ─── Allowances & Selections ──────────────────────────────────────────────────

interface BuilderSelectionChoice {
  id: string;
  title: string;
  description: string | null;
  price: number;
  photo_ids: string[];
  vendor_name: string | null;
  approved: boolean;
}

interface BuilderSelection {
  id: string;
  title: string;
  category: string | null;
  location: string | null;
  allowance_amount: number;
  required: boolean;
  deadline_date: string | null;
  public_instructions: string | null;
  status: string;
  choices: BuilderSelectionChoice[];
}

function selectionEditable(sel: BuilderSelection): boolean {
  return sel.status === "pending";
}

function choiceEditable(sel: BuilderSelection, choice: BuilderSelectionChoice): boolean {
  return sel.status === "pending" && !choice.approved;
}

function AllowancesSection({ estimate }: { estimate: Estimate }) {
  const [selections, setSelections] = useState<BuilderSelection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allowanceOpen, setAllowanceOpen] = useState(false);
  const [addChoiceForId, setAddChoiceForId] = useState<string | null>(null);
  const [addChoiceTitle, setAddChoiceTitle] = useState("");
  const [editSelection, setEditSelection] = useState<EditSelectionValues | null>(null);
  const [editChoice, setEditChoice] = useState<EditChoiceValues | null>(null);
  const [expandedPhoto, setExpandedPhoto] = useState<string | null>(null);

  const estimateLocked = ["sent", "viewed", "approved", "signed", "won", "lost", "revised"].includes(
    estimate.status,
  );
  const defaultTitle =
    estimate.line_items[0]?.product_service || estimate.title || "Allowance";

  const loadSelections = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<{ selections: BuilderSelection[] }>(
        `/api/estimates/${estimate.id}/selections`,
      );
      setSelections(res.selections);
    } catch (e) {
      setLoadError((e as Error).message || "Failed to load allowances.");
      setSelections([]);
    } finally {
      setLoading(false);
    }
  }, [estimate.id]);

  useEffect(() => {
    void loadSelections();
  }, [loadSelections]);

  return (
    <>
      <Card title="Allowances & Selections">
        <div class="allowances-section__head">
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
            Material and finish choices the client will pick from in their portal.
          </p>
          {!estimateLocked && (
            <Button size="sm" variant="primary" onClick={() => setAllowanceOpen(true)}>
              + Add Allowance
            </Button>
          )}
        </div>

        {loading ? (
          <div class="text--muted" style={{ fontSize: "var(--text-sm)", padding: "var(--space-sm) 0" }}>
            Loading allowances…
          </div>
        ) : loadError ? (
          <div class="form-error">{loadError}</div>
        ) : selections.length === 0 ? (
          <div class="text--muted" style={{ fontSize: "var(--text-sm)", padding: "var(--space-sm) 0" }}>
            No allowances yet.{estimateLocked ? "" : " Use + Add Allowance to create one."}
          </div>
        ) : (
          <div class="allowances-section__list">
            {selections.map((sel) => (
              <div key={sel.id} class="allowances-section__card">
                <div class="allowances-section__card-head">
                  <button
                    type="button"
                    class={`allowances-section__card-main${selectionEditable(sel) ? " allowances-section__card-main--clickable" : ""}`}
                    disabled={!selectionEditable(sel)}
                    onClick={() => {
                      if (!selectionEditable(sel)) return;
                      setEditSelection({
                        id: sel.id,
                        title: sel.title,
                        category: sel.category,
                        location: sel.location,
                        allowance_amount: sel.allowance_amount,
                        required: sel.required,
                        deadline_date: sel.deadline_date,
                        public_instructions: sel.public_instructions,
                      });
                    }}
                    title={selectionEditable(sel) ? "Click to edit allowance" : undefined}
                  >
                    <div class="allowances-section__title">{sel.title}</div>
                    <div class="allowances-section__meta">
                      {formatCurrency(sel.allowance_amount)} allowance
                      {sel.category ? ` · ${sel.category}` : ""}
                      {sel.location ? ` · ${sel.location}` : ""}
                      {` · ${sel.choices.length} choice${sel.choices.length !== 1 ? "s" : ""}`}
                    </div>
                  </button>
                  <div class="allowances-section__actions">
                    <Badge tone={sel.status === "approved" ? "success" : sel.status === "sent" ? "warning" : "neutral"}>
                      {formatStatus(sel.status)}
                    </Badge>
                    {sel.status === "pending" && (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setAddChoiceForId(sel.id);
                          setAddChoiceTitle(sel.title);
                        }}
                      >
                        + Add Choice
                      </Button>
                    )}
                  </div>
                </div>
                {sel.choices.length > 0 && (
                  <div class="allowances-section__choices">
                    {sel.choices.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        class={`allowances-section__choice${choiceEditable(sel, c) ? " allowances-section__choice--clickable" : ""}`}
                        disabled={!choiceEditable(sel, c)}
                        onClick={() => {
                          if (!choiceEditable(sel, c)) return;
                          setEditChoice({
                            id: c.id,
                            selectionId: sel.id,
                            selectionTitle: sel.title,
                            title: c.title,
                            price: c.price,
                            description: c.description,
                            vendor_name: c.vendor_name,
                            photo_ids: c.photo_ids,
                          });
                        }}
                        title={choiceEditable(sel, c) ? "Click to edit choice" : undefined}
                      >
                        {c.photo_ids[0] && (
                          <span
                            class="allowances-section__choice-photo"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedPhoto(c.photo_ids[0]);
                            }}
                            role="presentation"
                          >
                            <img src={`/api/photos/${c.photo_ids[0]}/thumb`} alt="" loading="lazy" />
                          </span>
                        )}
                        <div class="allowances-section__choice-body">
                          <div class="allowances-section__choice-title">{c.title}</div>
                          {c.description && (
                            <div class="allowances-section__choice-desc">{c.description}</div>
                          )}
                          {c.vendor_name && (
                            <div class="allowances-section__choice-vendor">{c.vendor_name}</div>
                          )}
                        </div>
                        <div class="allowances-section__choice-price">{formatCurrency(c.price)}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <SelectionFormModal
        open={allowanceOpen}
        onClose={() => setAllowanceOpen(false)}
        onCreated={() => {
          setAllowanceOpen(false);
          void loadSelections();
        }}
        estimateId={estimate.id}
        defaultTitle={defaultTitle}
        linkedJobId={estimate.linked_job_id}
      />

      <SelectionFormModal
        open={!!addChoiceForId}
        onClose={() => {
          setAddChoiceForId(null);
          setAddChoiceTitle("");
        }}
        onCreated={() => {
          setAddChoiceForId(null);
          setAddChoiceTitle("");
          void loadSelections();
        }}
        selectionId={addChoiceForId ?? undefined}
        selectionTitle={addChoiceTitle}
        linkedJobId={estimate.linked_job_id}
      />

      <SelectionFormModal
        open={!!editSelection}
        onClose={() => setEditSelection(null)}
        onCreated={() => {
          setEditSelection(null);
          void loadSelections();
        }}
        editSelection={editSelection ?? undefined}
        linkedJobId={estimate.linked_job_id}
      />

      <SelectionFormModal
        open={!!editChoice}
        onClose={() => setEditChoice(null)}
        onCreated={() => {
          setEditChoice(null);
          void loadSelections();
        }}
        editChoice={editChoice ?? undefined}
        linkedJobId={estimate.linked_job_id}
      />

      {expandedPhoto && (
        <Modal open onClose={() => setExpandedPhoto(null)} title="Choice photo">
          <img
            src={`/api/photos/${expandedPhoto}`}
            alt=""
            style={{ width: "100%", borderRadius: "var(--radius-md)" }}
          />
        </Modal>
      )}
    </>
  );
}

// ─── Line item editor ─────────────────────────────────────────────────────────

function LineItemEditor({
  estimate,
  mutate,
  reload,
}: {
  estimate: Estimate;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [newItemId, setNewItemId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

  const addLineItem = async () => {
    setAdding(true);
    try {
      const res = await api.post<{ line_item: EstimateLineItem }>(`/api/estimates/${estimate.id}/line-items`, {
        product_service: "New Line Item",
        description: "",
        quantity: 1,
        unit_price: 0,
      });
      if (res.line_item?.id) setNewItemId(res.line_item.id);
      await reload();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setAdding(false);
    }
  };

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

  const marginTone =
    estimate.total > 0 && estimate.margin_percent > 0
      ? " li-table__stat-value--good"
      : estimate.margin_percent <= 0 && estimate.total > 0
        ? " li-table__stat-value--bad"
        : "";

  return (
    <Card title="Line Items">
      {estimate.line_items.length === 0 ? (
        <div class="empty-state" style={{ padding: "var(--space-xl)" }}>
          <div class="empty-state__title">No line items yet</div>
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Add a line item to start building, or apply a template above.
          </div>
          <div class="mt-md">
            <Button variant="primary" disabled={adding} onClick={addLineItem}>
              + Add line item
            </Button>
          </div>
        </div>
      ) : (
        <div class="li-table-wrap">
          <div class="li-table__head li-row__grid" aria-hidden="true">
            <span />
            <span />
            <span>Name</span>
            <span>Qty</span>
            <span>Unit</span>
            <span>Unit price</span>
            <span>Total</span>
            <span />
          </div>
          <div class="li-table">
            {estimate.line_items.map((li) => (
              <LineItemRow
                key={li.id}
                item={li}
                isNew={li.id === newItemId}
                dragging={dragId === li.id}
                over={overId === li.id}
                onDragStart={() => setDragId(li.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={() => setOverId(li.id)}
                onDrop={() => onDrop(li.id)}
                mutate={mutate}
                reload={reload}
                onNewConsumed={() => setNewItemId(null)}
              />
            ))}
          </div>
          <div class="li-table__footer">
            <Button variant="primary" disabled={adding} onClick={addLineItem}>
              + Add line item
            </Button>
            <div class="li-table__stats">
              <span>
                Cost: <strong>{formatCurrency(estimate.internal_cost)}</strong>
              </span>
              <span class="li-table__dot">·</span>
              <span>
                Total: <strong>{formatCurrency(estimate.total)}</strong>
              </span>
              <span class="li-table__dot">·</span>
              <span>
                Margin:{" "}
                <strong class={`li-table__stat-value${marginTone}`}>{estimate.margin_percent}%</strong>
              </span>
            </div>
          </div>
        </div>
      )}
    </Card>
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
              <button class="li-row__del" onClick={() => removeRow(i)} title="Remove">
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

const CLIENT_PREVIEW_STATUS: Record<string, string> = {
  draft: "Draft",
  sent: "Awaiting Response",
  viewed: "Viewed",
  signed: "Agreement Signed",
  approved: "Approved",
  expired: "Expired",
  revised: "Revised",
};

function ClientPreview({ estimate, reviews }: { estimate: Estimate; reviews: SavedReview[] }) {
  const e = estimate;
  const depositDue = effectiveDeposit(e);
  const shownReviews = useMemo(() => reviews.filter((r) => r.is_active).slice(0, 3), [reviews]);
  const estLabel = `Estimate #${e.estimate_number ?? "—"}`;
  const addressLine = formatPropertySlashLine({
    address: e.property_address,
    city: e.property_city,
    state: e.property_state,
    zip: e.property_zip,
  });
  const phone = e.client_phone ? formatPhone(e.client_phone) : "";
  const statusKey = e.status || "draft";
  const statusText = CLIENT_PREVIEW_STATUS[statusKey] ?? formatStatus(statusKey);

  return (
    <Card title="Client Preview">
      <div class="preview theme-light">
        <div class="preview__brand">
          <div class="preview__logo">CHS</div>
          <div>
            <div class="preview__company">Columbus Home Solutions</div>
            {e.version > 1 ? (
              <div class="preview__est-num">Revision {e.version}</div>
            ) : null}
          </div>
        </div>

        <div class="preview__header-grid">
          <div class="preview__header-main">
            <div class="preview__est-heading">{estLabel}</div>
            <div class="preview__client-name">{e.client_name ?? "—"}</div>
            {addressLine ? <div class="preview__meta-sub">{addressLine}</div> : null}
            {phone && phone !== "—" ? <div class="preview__meta-sub">{phone}</div> : null}
            {depositDue > 0 ? (
              <div class="preview__deposit-note">
                An outstanding deposit of {formatCurrency(depositDue)} will be required to begin.
              </div>
            ) : null}
          </div>
          <div class="preview__header-aside">
            <span class={`quote-status quote-status--${statusKey}`}>{statusText}</span>
            {e.sent_at ? (
              <div>
                <div class="preview__sent-on-label">Sent on</div>
                <div class="preview__sent-on-date">{formatDate(e.sent_at)}</div>
              </div>
            ) : null}
          </div>
        </div>

        <div class="preview__lines">
          {e.line_items.length === 0 ? (
            <div class="preview__empty">Line items will appear here as you build the estimate.</div>
          ) : (
            <>
              <div class="preview__lines-head" aria-hidden="true">
                <span>Product / Service</span>
                <span class="preview__lines-head-qty">Qty</span>
                <span class="preview__lines-head-total">Total</span>
              </div>
              {e.line_items.map((li) => {
                const detail = [li.description, li.includes_note].filter(Boolean).join("\n");
                return (
                  <div class="preview__line" key={li.id}>
                    <div>
                      <div class="preview__line-name">{li.product_service}</div>
                      {detail ? <div class="preview__line-desc">{detail}</div> : null}
                    </div>
                    <div class="preview__line-qty">{li.quantity ?? 1}</div>
                    <div class="preview__line-total">{formatCurrency(li.total)}</div>
                  </div>
                );
              })}
            </>
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

function SentStatusCard({
  estimate,
  mutate,
}: {
  estimate: Estimate;
  mutate: (fn: () => Promise<unknown>, msg?: string) => Promise<void>;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [resending, setResending] = useState(false);
  const link = estimate.portal_path
    ? `${window.location.origin}${estimate.portal_path}`
    : null;
  const clientLabel = estimate.client_name?.trim() || "the client";

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

  const resend = async () => {
    if (resending) return;
    if (!window.confirm(`Resend this estimate to ${clientLabel}?`)) return;
    setResending(true);
    try {
      await mutate(
        () => api.post(`/api/estimates/${estimate.id}/resend`),
        `Resent to ${clientLabel}`,
      );
    } finally {
      // Brief debounce so a fast double-click can't enqueue two sends.
      setTimeout(() => setResending(false), 1500);
    }
  };

  // Progress: Sent → Resent(s) → Viewed → Signed → Deposit Paid (approved).
  const steps: Array<{ label: string; done: boolean; when: string | null | undefined }> = [
    { label: "Sent", done: true, when: estimate.sent_at },
  ];
  const resentDates =
    estimate.resent_dates && estimate.resent_dates.length > 0
      ? estimate.resent_dates
      : estimate.last_resent_at
        ? [estimate.last_resent_at]
        : [];
  for (const when of resentDates) {
    steps.push({ label: "Resent", done: true, when });
  }
  steps.push(
    {
      label: "Viewed",
      done: !!estimate.viewed_date || ["viewed", "approved", "signed"].includes(estimate.status),
      when: estimate.viewed_date,
    },
    { label: "Signed", done: estimate.signed, when: estimate.signed_date },
    { label: "Deposit Paid", done: estimate.status === "approved", when: estimate.approved_date },
  );

  return (
    <Card title="Client Quote Link">
      <div class="stack">
        {estimate.deposit_payment_method &&
          (estimate.deposit_payment_method === "cash" ||
            estimate.deposit_payment_method === "check") &&
          estimate.status !== "approved" &&
          !estimate.linked_job_id && (
            <div class="notice notice--info">
              Client selected:{" "}
              <strong>
                {estimate.deposit_payment_method === "cash" ? "Cash" : "Check"}
              </strong>
              , awaiting confirmation
              {estimate.deposit_method_selected_at
                ? ` (${new Date(estimate.deposit_method_selected_at).toLocaleString()})`
                : ""}
              . Use <strong>Mark Deposit Received</strong> when you have the funds.
            </div>
          )}
        <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
          <input
            class="form-input"
            style={{ flex: "1", minWidth: "240px" }}
            readOnly
            value={link ?? "Link will appear once the quote is sent."}
            onFocus={(ev) => (ev.target as HTMLInputElement).select()}
          />
          <Button
            variant="secondary"
            disabled={!link}
            onClick={() => link && window.open(link, "_blank", "noopener,noreferrer")}
          >
            Open ↗
          </Button>
          <Button variant="secondary" disabled={!link} onClick={copy}>
            {copied ? "Copied ✓" : "Copy link"}
          </Button>
          <Button variant="secondary" disabled={resending} onClick={() => void resend()}>
            {resending ? "Resending…" : "Resend Estimate"}
          </Button>
        </div>
        <div class="quote-progress">
          {steps.map((s, i) => (
            <div key={`${s.label}-${i}`} class={`quote-progress__step${s.done ? " is-done" : ""}`}>
              <span class="quote-progress__dot">{s.done ? "✓" : i + 1}</span>
              <span class="quote-progress__label">
                {s.label}
                {s.when ? <span class="quote-progress__when"> · {formatDate(s.when)}</span> : ""}
              </span>
            </div>
          ))}
        </div>
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
  const standaloneDepositConfigured = (estimate.deposit_amount ?? 0) > 0;
  const scheduleDepositConfigured = depositFromSchedule(estimate) > 0;
  // per_line_item uses optional standalone deposit — never block send on deposit absence.
  const depositOk = perLineItem || scheduleDepositConfigured;
  const pctRows = estimate.payment_schedule.filter((p) => p.percentage != null && p.fixed_amount == null);
  const pctOk =
    perLineItem ||
    pctRows.length === 0 ||
    Math.abs(pctRows.reduce((a, p) => a + (p.percentage ?? 0), 0) - 100) < 0.01;
  const blocked = !hasLine || !depositOk || !pctOk;
  const sent = estimate.status === "sent" || estimate.status === "approved" || estimate.status === "signed";

  const confirmSend = () => {
    if (!perLineItem && depositFromSchedule(estimate) <= 0) {
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
              {standaloneDepositConfigured
                ? `Deposit configured (${formatCurrency(estimate.deposit_amount)})`
                : "No deposit required"}
            </li>
          ) : (
            <>
              <li class={scheduleDepositConfigured ? "ok" : "bad"}>
                {scheduleDepositConfigured ? "✓" : "✕"} Deposit milestone configured
              </li>
              <li class={pctOk ? "ok" : "bad"}>
                {pctOk ? "✓" : "✕"} Percentage milestones total 100%
              </li>
            </>
          )}
        </ul>
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          Marks the estimate as sent, freezes the contract text, and makes the secure client quote
          link live (sign + pay deposit). The client will also get email and SMS with the link.
        </p>
      </Modal>
    </>
  );
}
