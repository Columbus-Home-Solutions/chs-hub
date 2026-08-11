import type { RoutableProps } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { useUrlTab } from "../../hooks/useUrlTab";
import { useViewportTier } from "../../hooks/useViewportTier";
import { Card } from "../../components/ui/Card";
import { WarrantyExpirationCallout } from "../../components/WarrantyExpirationCallout";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { Timeline } from "../../components/Timeline";
import { SlideUpSheet } from "../../components/layout/SlideUpSheet";
import { CommunicationModal } from "../clients/ClientDetail";
import { PhotosTab } from "./PhotosTab";
import { DocumentsTab } from "./DocumentsTab";
import { DailyLogsTab } from "./DailyLogsTab";
import { FinancialTab } from "./FinancialTab";
import { ChangeOrdersTab } from "./ChangeOrdersTab";
import { ScheduleTab } from "./ScheduleTab";
import { PermitsTab } from "./PermitsTab";
import { WarrantyTab } from "./WarrantyTab";
import { PunchListTab } from "./PunchListTab";
import { SmartNotesPanel } from "./SmartNotesPanel";
import { BidsTab } from "./BidsTab";
import { SelectionsTab } from "./SelectionsTab";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { useAuth } from "../../store/auth";
import { isOwner } from "../../lib/rbac";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate, formatDateTime, formatPhone, formatStatus } from "../../lib/format";
import {
  JOB_STAGES,
  JOB_BACKWARD_EXCEPTIONS,
  type BillingScheduleRow,
  type CloseEligibilityResult,
  type Communication,
  type EligibilityCheck,
  type JobDetailResponse,
  type JobStatus,
  type Task,
  type TaskGroup,
} from "../../types";

interface DetailProps extends RoutableProps {
  id?: string;
}

type TabKey =
  | "overview"
  | "scope"
  | "selections"
  | "tasks"
  | "punch_list"
  | "schedule"
  | "financial"
  | "change_orders"
  | "bids"
  | "permits"
  | "warranty"
  | "photos"
  | "documents"
  | "daily_logs"
  | "notes"
  | "activity";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "scope", label: "Scope of Work" },
  { key: "selections", label: "Selections" },
  { key: "tasks", label: "Tasks" },
  { key: "punch_list", label: "Punch List" },
  { key: "schedule", label: "Schedule" },
  { key: "financial", label: "Financial" },
  { key: "change_orders", label: "Change Orders" },
  { key: "bids", label: "Bids" },
  { key: "permits", label: "Permits" },
  { key: "warranty", label: "Warranty" },
  { key: "photos", label: "Photos" },
  { key: "documents", label: "Documents" },
  { key: "daily_logs", label: "Daily Logs" },
  { key: "notes", label: "Field Notes" },
  { key: "activity", label: "Activity" },
];

/** Phone/tablet primary strip — field workflow. Remaining tabs live in More sheet. */
const PRIORITY_TAB_KEYS: TabKey[] = [
  "overview",
  "tasks",
  "punch_list",
  "photos",
  "daily_logs",
];

const MORE_TABS: { key: TabKey; label: string }[] = [
  { key: "scope", label: "Scope of Work" },
  { key: "selections", label: "Selections" },
  { key: "schedule", label: "Schedule" },
  { key: "financial", label: "Financial" },
  { key: "change_orders", label: "Change Orders" },
  { key: "bids", label: "Bids" },
  { key: "permits", label: "Permits" },
  { key: "warranty", label: "Warranty" },
  { key: "documents", label: "Documents" },
  { key: "notes", label: "Field Notes" },
  { key: "activity", label: "Activity" },
];

const MORE_TAB_KEYS = new Set<TabKey>(MORE_TABS.map((t) => t.key));
const PRIORITY_TABS = TABS.filter((t) => PRIORITY_TAB_KEYS.includes(t.key));

// Legal status targets from the current status: every later stage (forward-only)
// plus the one sanctioned backward exception. The API re-validates and gates
// punch-list / unpaid-invoice rules.
function statusTargets(status: JobStatus): JobStatus[] {
  const order = JOB_STAGES.map((s) => s.key);
  const i = order.indexOf(status);
  const forward = i === -1 ? [] : order.slice(i + 1);
  const back = JOB_BACKWARD_EXCEPTIONS[status];
  return back ? [back, ...forward] : forward;
}

const TAB_KEYS = new Set<TabKey>(TABS.map((t) => t.key));

export function JobDetail({ id }: DetailProps) {
  const { data, loading, error, refetch } = useApi<JobDetailResponse>(id ? `/api/jobs/${id}` : null);
  const toast = useToast();
  const { user } = useAuth();
  const tier = useViewportTier();
  const compactTabs = tier === "mobile" || tier === "tablet";
  const [tab, setTab] = useUrlTab([...TAB_KEYS], "overview");
  const [moreOpen, setMoreOpen] = useState(false);

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">🔍</div>
        <div class="empty-state__title">Job not found</div>
        <div>{error ?? "This job doesn't exist."}</div>
        <div class="mt-md">
          <Button variant="secondary" onClick={() => go("/jobs")}>
            Back to pipeline
          </Button>
        </div>
      </div>
    );
  }

  const job = data.job;
  const fullAddress = [job.property_address, job.property_city, job.property_state, job.property_zip]
    .filter(Boolean)
    .join(", ");
  const moreTabActive = compactTabs && MORE_TAB_KEYS.has(tab as TabKey);

  return (
    <div class="job-detail">
      <div class="view-header">
        <div>
          <div class="flex items-center gap-sm" style={{ flexWrap: "wrap" }}>
            <h1 class="view-title">{job.title ?? job.client_name ?? "Job"}</h1>
            <span class={`er-status job-status--${job.status}`}>{formatStatus(job.status)}</span>
            {!job.conversion_complete && <Badge tone="warning">Setup pending</Badge>}
            {job.overdue && <Badge tone="error">Overdue</Badge>}
          </div>
          <p class="view-subtitle">
            {job.job_display ?? "JOB"}
            {job.client_name && job.client_id ? (
              <>
                {" · "}
                <a
                  href={`/app/clients/${job.client_id}`}
                  style={{ color: "inherit", textDecoration: "underline", textDecorationColor: "var(--color-border)", textUnderlineOffset: "2px" }}
                  onClick={(e) => { e.preventDefault(); go(`/clients/${job.client_id}`); }}
                >
                  {job.client_name}
                </a>
              </>
            ) : job.client_name ? ` · ${job.client_name}` : ""}
            {fullAddress ? ` · ${fullAddress}` : ""}
          </p>
        </div>
        <div class="view-header__right">
          {isOwner(user) && id && <WeeklyRecapButton jobId={id} />}
          <Button variant="tertiary" onClick={() => go("/jobs")}>
            ← Pipeline
          </Button>
        </div>
      </div>

      {job.conversion_reversed && (
        <div class="job-detail__reversal-banner callout callout--warning" role="status">
          ⚠ This job&apos;s conversion has been reversed.
          {job.reversal_reason && (
            <>
              {" "}
              Reason: {job.reversal_reason}
            </>
          )}
          {job.reversed_at && (
            <>
              {" "}
              Reversed:{" "}
              {new Date(job.reversed_at).toLocaleDateString("en-US", {
                month: "numeric",
                day: "numeric",
                year: "numeric",
              })}
            </>
          )}
        </div>
      )}

      <div class="job-tabs">
        {(compactTabs ? PRIORITY_TABS : TABS).map((t) => (
          <button
            key={t.key}
            type="button"
            class={`job-tab${tab === t.key ? " job-tab--active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        {compactTabs && (
          <button
            type="button"
            class={`job-tab${moreTabActive ? " job-tab--active" : ""}`}
            onClick={() => setMoreOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
          >
            ••• More
          </button>
        )}
      </div>

      {compactTabs && (
        <SlideUpSheet
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          title="More"
          ariaLabel="More job tabs"
        >
          <nav class="more-nav-sheet__nav">
            {MORE_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                class={`more-nav-sheet__row${tab === t.key ? " more-nav-sheet__row--active" : ""}`}
                onClick={() => {
                  setTab(t.key);
                  setMoreOpen(false);
                }}
              >
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
        </SlideUpSheet>
      )}

      {tab === "overview" && <OverviewTab data={data} refetch={refetch} toast={toast} />}
      {tab === "scope" && <ScopeOfWorkTab estimateId={job.estimate_id} jobSource={job.source} />}
      {tab === "selections" && id && (
        <SelectionsTab jobId={id} estimateId={job.estimate_id} />
      )}
      {tab === "tasks" && id && <TasksTab jobId={id} groups={data.task_groups} refetch={refetch} toast={toast} />}
      {tab === "punch_list" && id && (
        <PunchListTab
          jobId={id}
          jobTitle={job.title ?? "Job"}
          jobStatus={job.status}
          refetchJob={refetch}
        />
      )}
      {tab === "schedule" && id && <ScheduleTab jobId={id} />}
      {tab === "financial" && id && <FinancialTab jobId={id} />}
      {tab === "change_orders" && id && (
        <ChangeOrdersTab jobId={id} portalToken={data.job.portal_token} />
      )}
      {tab === "bids" && id && <BidsTab jobId={id} />}
      {tab === "permits" && id && <PermitsTab jobId={id} />}
      {tab === "warranty" && id && (
        <WarrantyTab jobId={id} warrantyExpiration={data.job.warranty_expiration} />
      )}
      {tab === "photos" && id && <PhotosTab jobId={id} />}
      {tab === "documents" && id && <DocumentsTab jobId={id} />}
      {tab === "daily_logs" && id && <DailyLogsTab jobId={id} />}
      {tab === "notes" && id && <SmartNotesPanel jobId={id} />}
      {tab === "activity" && (
        <ActivityTab activity={data.activity} jobId={id} clientId={data.job.client_id} />
      )}
    </div>
  );
}

type ToastApi = ReturnType<typeof useToast>;

// ─── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({
  data,
  refetch,
  toast,
}: {
  data: JobDetailResponse;
  refetch: () => void;
  toast: ToastApi;
}) {
  const job = data.job;
  const allTargets = statusTargets(job.status);
  // Remove "closed" from dropdown — it gets its own dedicated Close Job button.
  const dropdownTargets = allTargets.filter((t) => t !== "closed");

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [eligibility, setEligibility] = useState<CloseEligibilityResult | null>(null);
  const [closeLoading, setCloseLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const changeStatus = async (status: string) => {
    try {
      await api.put(`/api/jobs/${job.id}/status`, { status });
      toast.push("success", `Moved to ${formatStatus(status)}`);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const handleCloseJobClick = async () => {
    setCloseLoading(true);
    try {
      const result = await api.get<CloseEligibilityResult>(`/api/jobs/${job.id}/close-eligibility`);
      setEligibility(result);
      if (result.eligible) {
        setConfirmOpen(true);
      } else {
        setDrawerOpen(true);
      }
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setCloseLoading(false);
    }
  };

  const confirmClose = async () => {
    setConfirmBusy(true);
    try {
      await api.put(`/api/jobs/${job.id}/status`, { status: "closed" });
      toast.push("success", "Job closed successfully");
      setConfirmOpen(false);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <div class="detail-grid">
      <div class="stack">
        <Card title="Client">
          <div class="kv">
            <ProjectManagerField job={job} refetch={refetch} toast={toast} />
            <div class="kv__row">
              <span class="kv__label">Name</span>
              <span class="kv__value">{job.client_name ?? "—"}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Phone</span>
              <span class="kv__value">{formatPhone(job.client_phone)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Email</span>
              <span class="kv__value">{job.client_email ?? "—"}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Job Type</span>
              <span class="kv__value">{formatStatus(job.job_type)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Days in Status</span>
              <span class="kv__value">{job.days_in_status}</span>
            </div>
          </div>
        </Card>

        <Card title="Financial">
          <div class="kv">
            <div class="kv__row">
              <span class="kv__label">Billing Model</span>
              <span class="kv__value">{formatStatus(job.billing_model)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Contract Total</span>
              <span class="kv__value">{formatCurrency(data.financial.contract_total)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Deposit</span>
              <span class="kv__value">{formatCurrency(data.financial.deposit_amount)}</span>
            </div>
            <div class="kv__row">
              <span class="kv__label">Collected to Date</span>
              <span class="kv__value">{formatCurrency(data.financial.deposit_paid_to_date)}</span>
            </div>
          </div>
        </Card>

        <BillingScheduleCard rows={data.billing_schedule} />

        <PortalLinkCard data={data} toast={toast} />

        <DatesCard data={data} refetch={refetch} toast={toast} />

        {(job.status === "closed" || job.status === "cancelled") && (
          <DeleteJobCard job={job} />
        )}
      </div>

      <div class="stack">
        <Card title="Status">
          <div class="stack">
            <div class="flex items-center gap-sm">
              <span class={`er-status job-status--${job.status}`}>{formatStatus(job.status)}</span>
            </div>
            <WarrantyExpirationCallout expiration={job.warranty_expiration} compact />
            {dropdownTargets.length > 0 && (
              <FormField label="Move to">
                <Select
                  value=""
                  placeholder="Select status…"
                  options={dropdownTargets.map((t) => ({ value: t, label: stageLabel(t) }))}
                  onChange={(v) => v && changeStatus(v)}
                />
              </FormField>
            )}
            {job.status === "complete" && (
              <Button
                variant="primary"
                onClick={handleCloseJobClick}
                disabled={closeLoading}
              >
                {closeLoading ? "Checking…" : "Close Job"}
              </Button>
            )}
            {job.status === "closed" && (
              <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                This job is closed — no further status changes.
              </div>
            )}
          </div>
        </Card>
      </div>

      {drawerOpen && eligibility && (
        <CloseOutDrawer
          checks={eligibility.checks}
          onClose={() => setDrawerOpen(false)}
        />
      )}

      <Modal
        open={confirmOpen}
        title="Close this job?"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={confirmClose} disabled={confirmBusy}>
              {confirmBusy ? "Closing…" : "Confirm Close"}
            </Button>
          </>
        }
      >
        <p>This action cannot be undone. The job will be marked as closed.</p>
      </Modal>
    </div>
  );
}

// ─── Project Manager assignment ──────────────────────────────────────────────

interface AssignableUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

let assignableUsersCache: AssignableUser[] | null = null;

function pmRoleLabel(role: string): string {
  return role === "owner" ? "Owner" : "PM";
}

function ProjectManagerField({
  job,
  refetch,
  toast,
}: {
  job: JobDetailResponse["job"];
  refetch: () => void;
  toast: ToastApi;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [users, setUsers] = useState<AssignableUser[]>(assignableUsersCache ?? []);
  const [draft, setDraft] = useState(job.assigned_to ?? "");

  useEffect(() => {
    if (!editing) setDraft(job.assigned_to ?? "");
  }, [job.assigned_to, editing]);

  const openEditor = async () => {
    setEditing(true);
    if (assignableUsersCache) {
      setUsers(assignableUsersCache);
      return;
    }
    setLoadingUsers(true);
    try {
      const res = await api.get<{ users: AssignableUser[] }>("/api/users/assignable");
      assignableUsersCache = res.users;
      setUsers(res.users);
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setEditing(false);
    } finally {
      setLoadingUsers(false);
    }
  };

  const save = async (userId: string | null) => {
    setSaving(true);
    try {
      await api.put(`/api/jobs/${job.id}`, { assigned_to: userId });
      toast.push("success", "Project Manager updated");
      setEditing(false);
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div class="kv__row">
        <span class="kv__label">Project Manager</span>
        <div class="kv__value stack gap-xs">
          {loadingUsers ? (
            <Spinner />
          ) : (
            <Select
              value={draft}
              options={[
                { value: "", label: "— Unassigned —" },
                ...users.map((u) => ({
                  value: u.id,
                  label: `${u.name} (${pmRoleLabel(u.role)})`,
                })),
              ]}
              onChange={(v) => {
                setDraft(v);
                void save(v === "" ? null : v);
              }}
              disabled={saving}
            />
          )}
          {saving && <Spinner />}
          <Button variant="tertiary" size="sm" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div class="kv__row">
      <span class="kv__label">Project Manager</span>
      <span class="kv__value flex items-center gap-sm flex-wrap">
        {job.assigned_to_name ? (
          <>
            <span>{job.assigned_to_name}</span>
            <Button variant="secondary" onClick={openEditor}>
              Change
            </Button>
          </>
        ) : (
          <>
            <span class="text--muted">Unassigned</span>
            <Button variant="secondary" onClick={openEditor}>
              Assign →
            </Button>
          </>
        )}
      </span>
    </div>
  );
}

// ─── Close-Out Checklist Drawer ───────────────────────────────────────────────

function CloseOutDrawer({
  checks,
  onClose,
}: {
  checks: EligibilityCheck[];
  onClose: () => void;
}) {
  return (
    <>
      <div class="mc-backdrop" onClick={onClose} />
      <div class="mc-panel mc-panel--open" role="dialog" aria-label="Close-Out Checklist">
        <div class="mc-header">
          <span class="mc-header__title">Close-Out Checklist</span>
          <button class="mc-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div class="closeout-drawer__body">
          <p class="closeout-drawer__intro text--muted">
            Resolve all items below before closing this job.
          </p>
          <div class="closeout-drawer__checks">
            {checks.map((check) => (
              <div key={check.id} class={`closeout-check${check.passed ? " closeout-check--pass" : " closeout-check--fail"}`}>
                <span class="closeout-check__icon">{check.passed ? "✅" : "❌"}</span>
                <div class="closeout-check__body">
                  <span class="closeout-check__label">{check.label}</span>
                  {check.detail && (
                    <span class="closeout-check__detail">{check.detail}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div class="closeout-drawer__footer">
            <Button variant="primary" disabled title="Resolve all items above to close this job.">
              Close Job
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function DeleteJobCard({ job }: { job: JobDetailResponse["job"] }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = job.job_display ?? `Job #${job.job_number ?? "—"}`;

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/jobs/${job.id}`);
      toast.push("success", "Job deleted");
      go("/jobs");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      <Card title="Danger zone">
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-sm)" }}>
          Permanently remove this job and all related invoices, payments, photos, and documents.
        </p>
        <Button variant="danger" onClick={() => setOpen(true)}>
          Delete Job
        </Button>
      </Card>
      <Modal
        open={open}
        title="Delete job"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              Yes, delete
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Permanently delete {label}? All invoices, payments, photos, and documents for this job will
          be deleted. This cannot be undone.
        </p>
      </Modal>
    </>
  );
}

function BillingScheduleCard({ rows }: { rows: BillingScheduleRow[] }) {
  return (
    <Card title="Billing Schedule">
      {rows.length === 0 ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          No billing schedule yet.
        </p>
      ) : (
        <div class="billing-list">
          {rows.map((b) => (
            <div class="billing-list__row" key={b.id}>
              <div>
                <div class="billing-list__label">{b.label}</div>
                <div class="billing-list__meta">
                  {formatStatus(b.trigger_type)}
                  {b.percentage != null ? ` · ${b.percentage}%` : ""}
                  {b.period_start ? ` · ${formatDate(b.period_start)}–${formatDate(b.period_end)}` : ""}
                </div>
              </div>
              <div class="billing-list__amount">
                {b.amount != null ? formatCurrency(b.amount) : "—"}
                <Badge tone="neutral">{formatStatus(b.status)}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Owner/PM-only control to view + copy the client's portal link (Sprint 12).
// Internal-only; the link itself is the client's token-gated portal URL.
function PortalLinkCard({ data, toast }: { data: JobDetailResponse; toast: ToastApi }) {
  const job = data.job;
  if (!job.portal_token) return null;
  const url = job.portal_url ?? `/portal/${job.portal_token}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.push("success", "Portal link copied");
    } catch {
      toast.push("error", "Couldn't copy — select and copy manually");
    }
  };

  return (
    <Card title="Client Portal">
      <div class="stack">
        <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          Share this private link so {job.client_name ?? "the client"} can view photos, pay invoices,
          and message you. The link is the credential — only share it with the client.
          {job.portal_type === "cost_plus" ? " (Cost-plus: includes the Budget & Costs view.)" : ""}
        </div>
        <input class="form-input" readOnly value={url} onFocus={(e) => (e.target as HTMLInputElement).select()} />
        <div class="flex gap-sm">
          <Button variant="primary" size="sm" onClick={copy}>
            Copy link
          </Button>
          <Button variant="secondary" size="sm" onClick={() => window.open(url, "_blank")}>
            Open
          </Button>
        </div>
      </div>
    </Card>
  );
}

function DatesCard({
  data,
  refetch,
  toast,
}: {
  data: JobDetailResponse;
  refetch: () => void;
  toast: ToastApi;
}) {
  const job = data.job;
  const [start, setStart] = useState(job.start_date ?? "");
  const [target, setTarget] = useState(job.target_end_date ?? "");

  useEffect(() => {
    setStart(job.start_date ?? "");
    setTarget(job.target_end_date ?? "");
  }, [job.id, job.start_date, job.target_end_date]);

  const save = async (field: "start_date" | "target_end_date", value: string) => {
    const current = field === "start_date" ? job.start_date : job.target_end_date;
    if ((current ?? "") === value) return;
    try {
      await api.put(`/api/jobs/${job.id}`, { [field]: value || null });
      toast.push("success", "Dates updated");
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <Card title="Schedule Dates">
      <div class="stack">
        <FormField label="Start date">
          <input
            class="form-input"
            type="date"
            value={start}
            onInput={(e) => setStart((e.target as HTMLInputElement).value)}
            onBlur={() => save("start_date", start)}
          />
        </FormField>
        <FormField label="Target end date">
          <input
            class="form-input"
            type="date"
            value={target}
            onInput={(e) => setTarget((e.target as HTMLInputElement).value)}
            onBlur={() => save("target_end_date", target)}
          />
        </FormField>
        {job.actual_end_date && (
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Completed {formatDate(job.actual_end_date)}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

function TasksTab({
  jobId,
  groups,
  refetch,
  toast,
}: {
  jobId: string;
  groups: TaskGroup[];
  refetch: () => void;
  toast: ToastApi;
}) {
  const [addOpen, setAddOpen] = useState(false);

  const complete = async (task: Task) => {
    try {
      await api.put(`/api/tasks/${task.id}/complete`, {});
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const reopen = async (task: Task) => {
    try {
      await api.put(`/api/tasks/${task.id}`, { status: "pending" });
      refetch();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const existingGroups = groups.map((g) => g.group);

  return (
    <div class="stack">
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {groups.reduce((n, g) => n + g.tasks.length, 0)} tasks across {groups.length} group(s)
        </span>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
          + Add Task
        </Button>
      </div>

      {groups.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">📋</div>
          <div class="empty-state__title">No tasks yet</div>
          <div>Add a task to start tracking this job's work.</div>
        </div>
      ) : (
        groups.map((g) => (
          <Card key={g.group} title={g.group}>
            <div class="task-list">
              {g.tasks.map((t) => {
                const done = t.status === "complete";
                return (
                  <div class={`task-row${done ? " task-row--done" : ""}`} key={t.id}>
                    <input
                      type="checkbox"
                      class="task-row__check"
                      checked={done}
                      onChange={() => (done ? reopen(t) : complete(t))}
                    />
                    <div class="task-row__body">
                      <div class="task-row__title">
                        {t.title}
                        {t.is_punch_list && <Badge tone="warning">Punch</Badge>}
                      </div>
                      <div class="task-row__meta">
                        {formatStatus(t.status)}
                        {t.assigned_to ? ` · ${t.assigned_to}` : ""}
                        {t.scheduled_date ? ` · ${formatDate(t.scheduled_date)}` : ""}
                        {done && t.completed_date ? ` · done ${formatDate(t.completed_date)}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ))
      )}

      <AddTaskModal
        open={addOpen}
        jobId={jobId}
        existingGroups={existingGroups}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false);
          refetch();
        }}
        toast={toast}
      />
    </div>
  );
}

function AddTaskModal({
  open,
  jobId,
  existingGroups,
  onClose,
  onAdded,
  toast,
}: {
  open: boolean;
  jobId: string;
  existingGroups: string[];
  onClose: () => void;
  onAdded: () => void;
  toast: ToastApi;
}) {
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [punch, setPunch] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setGroup(existingGroups[0] ?? "");
      setNewGroup("");
      setPunch(false);
      setBusy(false);
    }
  }, [open, existingGroups]);

  const NEW = "__new__";
  const resolvedGroup = group === NEW || existingGroups.length === 0 ? newGroup.trim() : group;
  const valid = title.trim() && resolvedGroup;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.post(`/api/jobs/${jobId}/tasks`, {
        title: title.trim(),
        task_group: resolvedGroup,
        is_punch_list: punch,
      });
      toast.push("success", "Task added");
      onAdded();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  const groupOptions = [
    ...existingGroups.map((g) => ({ value: g, label: g })),
    { value: NEW, label: "+ New group…" },
  ];

  return (
    <Modal
      open={open}
      title="Add Task"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Adding…" : "Add Task"}
          </Button>
        </>
      }
    >
      <FormField label="Title" required>
        <input
          class="form-input"
          value={title}
          placeholder="e.g. Rough-in plumbing"
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
      </FormField>
      {existingGroups.length > 0 && (
        <FormField label="Group" required>
          <Select
            value={group}
            options={groupOptions}
            onChange={setGroup}
          />
        </FormField>
      )}
      {(group === NEW || existingGroups.length === 0) && (
        <FormField label="New group name" required>
          <input
            class="form-input"
            value={newGroup}
            placeholder="e.g. Punch List"
            onInput={(e) => setNewGroup((e.target as HTMLInputElement).value)}
          />
        </FormField>
      )}
      <label class="quote-check" style={{ marginTop: "var(--space-sm)" }}>
        <input type="checkbox" checked={punch} onChange={(e) => setPunch((e.target as HTMLInputElement).checked)} />
        <span>This is a punch-list item</span>
      </label>
    </Modal>
  );
}

// ─── Activity ──────────────────────────────────────────────────────────────────

function ActivityTab({
  activity,
  jobId,
  clientId,
}: {
  activity: JobDetailResponse["activity"];
  jobId?: string;
  clientId?: string | null;
}) {
  const toast = useToast();
  const [logModal, setLogModal] = useState(false);
  const comms = useApi<{ communications: Communication[] }>(
    jobId ? `/api/jobs/${jobId}/communications` : null,
  );
  return (
    <div class="stack">
      <Card
        title="Communication timeline"
        actions={
          clientId ? (
            <Button size="sm" variant="secondary" onClick={() => setLogModal(true)}>
              + Log
            </Button>
          ) : undefined
        }
      >
        {comms.loading ? (
          <Spinner />
        ) : (
          <Timeline entries={comms.data?.communications ?? []} />
        )}
      </Card>

      {logModal && clientId && jobId && (
        <CommunicationModal
          clientId={clientId}
          jobId={jobId}
          onClose={() => setLogModal(false)}
          onSaved={() => {
            setLogModal(false);
            comms.refetch();
            toast.push("success", "Communication logged");
          }}
        />
      )}

      <Card title="Activity Log">
        {activity.length === 0 ? (
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            No activity yet.
          </p>
        ) : (
          <div class="timeline">
            {activity.map((a) => (
              <div key={a.id} class="timeline__item">
                <span class="timeline__dot" />
                <div class="timeline__content">
                  <div class="timeline__summary">{formatStatus(a.action.replace(/^job_/, ""))}</div>
                  <div class="timeline__meta">
                    {a.user_email} · {formatDateTime(a.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function stageLabel(key: JobStatus): string {
  return JOB_STAGES.find((s) => s.key === key)?.label ?? formatStatus(key);
}

// ─── Scope of Work ────────────────────────────────────────────────────────────

interface ScopeLineItem {
  id: string;
  product_service: string;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  total: number | null;
}

interface EstimateResponse {
  estimate: {
    id: string;
    status: string;
    line_items: ScopeLineItem[];
  };
}

function ScopeOfWorkTab({ estimateId, jobSource }: { estimateId: string | null; jobSource?: string | null }) {
  const { data, loading, error } = useApi<EstimateResponse>(
    estimateId ? `/api/estimates/${estimateId}` : null,
  );

  if (!estimateId) {
    const isQuickJob = jobSource === "quick_job";
    return (
      <div class="empty-state" style={{ marginTop: "var(--space-lg)" }}>
        <div class="empty-state__icon">{isQuickJob ? "⚡" : "📋"}</div>
        <div class="empty-state__title">{isQuickJob ? "Quick Job — no scope of work" : "No estimate linked"}</div>
        <div>
          {isQuickJob
            ? "This is a Quick Job created without an estimate. Use the Financial tab to add invoices and track payments."
            : "This job does not have a linked estimate. Scope of work is only available for jobs created through the quote-to-job conversion flow."}
        </div>
      </div>
    );
  }

  if (loading) return <Spinner center />;
  if (error) {
    return (
      <div class="empty-state" style={{ marginTop: "var(--space-lg)" }}>
        <div class="empty-state__title">Couldn&apos;t load scope</div>
        <div>{error}</div>
      </div>
    );
  }

  const lineItems = data?.estimate?.line_items ?? [];
  const grandTotal = lineItems.reduce((sum, li) => sum + (li.total ?? 0), 0);

  return (
    <div class="tab-content">
      <div class="flex items-center justify-between gap-sm" style={{ marginBottom: "var(--space-md)" }}>
        <h2 class="view-title" style={{ fontSize: "var(--text-lg)", margin: 0 }}>Scope of Work</h2>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => go(`/estimates/${estimateId}`)}
        >
          View full estimate →
        </Button>
      </div>

      {lineItems.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__title">No line items</div>
          <div>This estimate has no line items yet.</div>
        </div>
      ) : (
        <>
          <table class="data-table">
            <thead>
              <tr>
                <th style={{ width: "45%" }}>Product / Service</th>
                <th style={{ width: "10%", textAlign: "right" }}>Qty</th>
                <th style={{ width: "20%", textAlign: "right" }}>Unit Price</th>
                <th style={{ width: "25%", textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li) => (
                <tr key={li.id}>
                  <td>
                    <div style={{ fontWeight: "var(--font-semibold)" }}>{li.product_service}</div>
                    {li.description && (
                      <div class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: "2px", whiteSpace: "pre-wrap" }}>
                        {li.description}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {li.quantity != null ? li.quantity : "—"}
                    {li.unit ? ` ${li.unit}` : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {li.unit_price != null ? formatCurrency(li.unit_price) : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {li.total != null ? formatCurrency(li.total) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} style={{ textAlign: "right", fontWeight: "var(--font-semibold)", borderTop: "2px solid var(--color-border)" }}>
                  Total Price
                </td>
                <td style={{ textAlign: "right", fontWeight: "var(--font-semibold)", borderTop: "2px solid var(--color-border)" }}>
                  {formatCurrency(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}

// ── Owner-only: manual weekly recap trigger ───────────────────────────────────
interface RecapResponse {
  ok: boolean;
  recap?: string;
  sent_to?: string;
  photo_count?: number;
  week_start?: string;
  week_end?: string;
}

function WeeklyRecapButton({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post<RecapResponse>(`/api/jobs/${jobId}/test-weekly-recap`, {});
      const preview = res.recap ? `"${res.recap.slice(0, 100).replace(/\n/g, " ")}…"` : "";
      toast.push(
        "success",
        `Weekly recap sent to ${res.sent_to ?? "client"}. ${preview}`,
      );
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Failed to send recap");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void fire()}
      disabled={busy}
      title="Owner only — manually triggers the weekly recap email for this job"
    >
      {busy ? "Sending…" : "Send Weekly Recap"}
    </Button>
  );
}
