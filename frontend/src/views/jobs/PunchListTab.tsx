/**
 * Job Detail → Punch List tab (Sprint 33).
 * iPad-first management view for Tony during final walkthrough.
 */

import "../../styles/punch.css";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { uploadPhoto } from "../../lib/capture";
import { formatDate } from "../../lib/format";
import type { JobStatus, PunchListItem, PunchListResponse } from "../../types";

interface Sub {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  trade: string | null;
  phone: string | null;
  email: string | null;
}

type ToastApi = ReturnType<typeof useToast>;

const ACTIVE_STATUSES: JobStatus[] = ["punch_list", "complete", "closed"];

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  sent: "Sent",
  closed: "Closed",
};

const STATUS_TONE: Record<string, "neutral" | "info" | "success"> = {
  open: "neutral",
  sent: "info",
  closed: "success",
};

export function PunchListTab({
  jobId,
  jobTitle,
  jobStatus,
  refetchJob,
}: {
  jobId: string;
  jobTitle: string;
  jobStatus: JobStatus;
  refetchJob?: () => void;
}) {
  const toast = useToast();
  const active = ACTIVE_STATUSES.includes(jobStatus);
  const { data, loading, error, refetch } = useApi<PunchListResponse>(
    active ? `/api/jobs/${jobId}/punch-list` : null,
  );
  const subsApi = useApi<{ subcontractors: Sub[] }>("/api/subcontractors?active=1");
  const subs = subsApi.data?.subcontractors ?? [];
  const subsById = useMemo(() => new Map(subs.map((s) => [s.id, s])), [subs]);

  const [addOpen, setAddOpen] = useState(false);
  const [editItem, setEditItem] = useState<PunchListItem | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);

  if (!active) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">📋</div>
        <div class="empty-state__title">Punch list not started</div>
        <div>Punch list is created when the job moves to Punch List status.</div>
      </div>
    );
  }

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__title">Could not load punch list</div>
        <div>{error ?? "Unknown error"}</div>
      </div>
    );
  }

  const { punch_list: pl } = data;

  const assignedCount = data.items.filter((i) => i.sub_id && i.status === "open").length;
  const allDone = data.items.length > 0 && data.items.every((i) => i.status === "done");
  const hasNewSinceSend =
    Boolean(pl.sent_at) &&
    data.items.some((i) => i.created_at > (pl.sent_at as string));

  const openCount = data.items.filter((i) => i.status === "open").length;

  return (
    <div class="stack">
      <div class="punch-tab-header">
        <div class="punch-tab-status">
          <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            PUNCH LIST — {jobTitle}
          </span>
          <Badge tone={STATUS_TONE[pl.status] ?? "neutral"}>{STATUS_LABEL[pl.status] ?? pl.status}</Badge>
          {pl.sent_at && (
            <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
              Sent {formatDate(pl.sent_at)}
            </span>
          )}
          <button
            type="button"
            class={`punch-schedule-btn${pl.scheduled_date ? " punch-schedule-btn--set" : ""}`}
            onClick={() => setScheduleOpen(true)}
          >
            Schedule: {pl.scheduled_date ? formatDate(pl.scheduled_date) : "Not set"}
          </button>
        </div>
        <div class="punch-tab-actions">
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
            + Add Item
          </Button>
          {pl.status === "sent" && hasNewSinceSend ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                if (!confirm("Re-notify subs about new punch list items?")) return;
                try {
                  await api.post(`/api/punch-lists/${pl.id}/renotify`, {});
                  toast.push("success", "Subs re-notified");
                  refetch();
                } catch (e) {
                  toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
                }
              }}
            >
              Re-notify Subs
            </Button>
          ) : pl.status !== "sent" && pl.status !== "closed" ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={assignedCount === 0}
              title={assignedCount === 0 ? "Assign at least one item to a sub first" : undefined}
              onClick={() => setSendOpen(true)}
            >
              Send to Subs ▶
            </Button>
          ) : null}
          {allDone && pl.status !== "closed" && (
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                if (!confirm("Close punch list and mark job complete?")) return;
                try {
                  await api.put(`/api/punch-lists/${pl.id}/close`, {});
                  if (jobStatus === "punch_list") {
                    await api.put(`/api/jobs/${jobId}/status`, { status: "complete" });
                  }
                  toast.push("success", "Punch list closed");
                  refetch();
                  refetchJob?.();
                } catch (e) {
                  toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
                }
              }}
            >
              Close Punch List
            </Button>
          )}
        </div>
      </div>

      {openCount > 0 && (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
          {openCount} open item(s)
        </p>
      )}

      {data.unassigned_items.length > 0 && (
        <PunchGroup
          title="Unassigned"
          items={data.unassigned_items}
          onEdit={setEditItem}
          onDelete={async (id) => {
            if (!confirm("Remove this item?")) return;
            try {
              await api.del(`/api/punch-list-items/${id}`);
              refetch();
            } catch (e) {
              toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
            }
          }}
          toast={toast}
        />
      )}

      {data.by_sub.map((group) => (
        <PunchGroup
          key={group.sub_id}
          title={group.sub_name}
          items={group.items}
          onEdit={setEditItem}
          onDelete={async (id) => {
            if (!confirm("Remove this item?")) return;
            try {
              await api.del(`/api/punch-list-items/${id}`);
              refetch();
            } catch (e) {
              toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
            }
          }}
          toast={toast}
        />
      ))}

      {data.items.length === 0 && (
        <div class="empty-state">
          <div class="empty-state__icon">✅</div>
          <div class="empty-state__title">No punch list items yet</div>
          <div>Add items during your final walkthrough, assign subs, then send.</div>
        </div>
      )}

      {addOpen && (
        <ItemModal
          jobId={jobId}
          subs={subs}
          listScheduledDate={pl.scheduled_date}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            refetch();
          }}
          toast={toast}
        />
      )}

      {editItem && (
        <ItemModal
          jobId={jobId}
          subs={subs}
          item={editItem}
          listScheduledDate={pl.scheduled_date}
          onClose={() => setEditItem(null)}
          onSaved={() => {
            setEditItem(null);
            refetch();
          }}
          toast={toast}
        />
      )}

      {scheduleOpen && (
        <ScheduleModal
          punchListId={pl.id}
          scheduledDate={pl.scheduled_date}
          onClose={() => setScheduleOpen(false)}
          onSaved={() => {
            setScheduleOpen(false);
            refetch();
          }}
          toast={toast}
        />
      )}

      {sendOpen && (
        <SendModal
          bySub={data.by_sub}
          subsById={subsById}
          busy={sendBusy}
          onClose={() => !sendBusy && setSendOpen(false)}
          onConfirm={async () => {
            setSendBusy(true);
            try {
              await api.post(`/api/punch-lists/${pl.id}/send`, {});
              toast.push("success", "Punch list sent to subs");
              setSendOpen(false);
              refetch();
            } catch (e) {
              toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
            } finally {
              setSendBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}

function PunchGroup({
  title,
  items,
  onEdit,
  onDelete,
}: {
  title: string;
  items: PunchListItem[];
  onEdit: (item: PunchListItem) => void;
  onDelete: (id: string) => void;
  toast: ToastApi;
}) {
  return (
    <Card title="">
      <div class="punch-group">
        <div class="punch-group__title">{title}</div>
        {items.map((item) => (
          <PunchRow key={item.id} item={item} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </div>
    </Card>
  );
}

function PunchRow({
  item,
  onEdit,
  onDelete,
}: {
  item: PunchListItem;
  onEdit: (item: PunchListItem) => void;
  onDelete: (id: string) => void;
}) {
  const done = item.status === "done";
  return (
    <div class={`punch-row${done ? " punch-row--done" : ""}`}>
      <input type="checkbox" class="punch-row__check" checked={done} readOnly aria-label={done ? "Done" : "Open"} />
      <div class="punch-row__main">
        <div class="punch-row__desc">{item.description}</div>
        <div class="punch-row__meta">
          {item.scheduled_date ? formatDate(item.scheduled_date) : null}
          {done && item.completed_at ? ` · Done ${formatDate(item.completed_at)}` : ""}
        </div>
        {item.photo_ids.length > 0 && (
          <div class="punch-row__thumbs">
            {item.photo_ids.map((pid) => (
              <a key={pid} href={`/api/photos/${pid}`} target="_blank" rel="noreferrer">
                <img src={`/api/photos/${pid}/thumb`} alt="" loading="lazy" />
              </a>
            ))}
          </div>
        )}
      </div>
      {!done && (
        <div class="punch-row__actions">
          <Button variant="tertiary" size="sm" onClick={() => onEdit(item)}>
            Edit
          </Button>
          <Button variant="tertiary" size="sm" onClick={() => onDelete(item.id)}>
            ✕
          </Button>
        </div>
      )}
    </div>
  );
}

function subLabel(s: Sub): string {
  if (s.contact_name && s.company_name) return `${s.contact_name} (${s.company_name})`;
  return s.company_name ?? s.contact_name ?? "Sub";
}

function ItemModal({
  jobId,
  subs,
  item,
  listScheduledDate,
  onClose,
  onSaved,
  toast,
}: {
  jobId: string;
  subs: Sub[];
  item?: PunchListItem;
  listScheduledDate: string | null;
  onClose: () => void;
  onSaved: () => void;
  toast: ToastApi;
}) {
  const [description, setDescription] = useState(item?.description ?? "");
  const [subId, setSubId] = useState(item?.sub_id ?? "");
  const [scheduledDate, setScheduledDate] = useState(item?.scheduled_date ?? "");
  const [photoIds, setPhotoIds] = useState<string[]>(item?.photo_ids ?? []);
  const [subFilter, setSubFilter] = useState("");
  const [subOpen, setSubOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!item) {
      setDescription("");
      setSubId("");
      setScheduledDate("");
      setPhotoIds([]);
      setSubFilter("");
    } else {
      const picked = subs.find((s) => s.id === item.sub_id);
      setSubFilter(picked ? subLabel(picked) : "");
    }
  }, [item, subs]);

  const filteredSubs = subs.filter((s) => {
    if (!subFilter.trim()) return true;
    const q = subFilter.toLowerCase();
    const name = `${s.company_name ?? ""} ${s.contact_name ?? ""} ${s.trade ?? ""}`.toLowerCase();
    return name.includes(q);
  });

  const pickSub = (s: Sub | null) => {
    setSubId(s?.id ?? "");
    setSubFilter(s ? subLabel(s) : "");
    setSubOpen(false);
  };

  const onPhoto = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadPhoto(file, { job_id: jobId, photo_type: "punch_list" }, { withGps: true });
      setPhotoIds((prev) => [...prev, res.id]);
      toast.push("success", "Photo attached");
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!description.trim()) {
      toast.push("error", "Description is required");
      return;
    }
    setBusy(true);
    try {
      const body = {
        description: description.trim(),
        sub_id: subId || null,
        scheduled_date: scheduledDate || null,
        photo_ids: photoIds,
      };
      if (item) {
        await api.put(`/api/punch-list-items/${item.id}`, body);
        toast.push("success", "Item updated");
      } else {
        await api.post(`/api/jobs/${jobId}/punch-list/items`, body);
        toast.push("success", "Item added");
      }
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={item ? "Edit punch item" : "Add punch item"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || uploading} onClick={submit}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <FormField label="Description" required>
        <textarea
          class="form-input"
          rows={3}
          style={{ fontSize: "1.05rem", minHeight: "88px" }}
          value={description}
          onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
          placeholder="What needs to be fixed?"
        />
      </FormField>

      <FormField label="Assign to sub">
        <input
          class="form-input punch-sub-search"
          type="search"
          placeholder="Search subs…"
          value={subFilter}
          autoComplete="off"
          onFocus={() => setSubOpen(true)}
          onBlur={() => window.setTimeout(() => setSubOpen(false), 150)}
          onInput={(e) => {
            setSubFilter((e.target as HTMLInputElement).value);
            setSubOpen(true);
            if (!subId) return;
            const picked = subs.find((s) => s.id === subId);
            if (picked && subLabel(picked) !== (e.target as HTMLInputElement).value) {
              setSubId("");
            }
          }}
        />
        {subOpen && (
          <div class="typeahead">
            <button type="button" class="typeahead__item" onMouseDown={() => pickSub(null)}>
              <strong>Unassigned</strong>
            </button>
            {filteredSubs.map((s) => (
              <button
                key={s.id}
                type="button"
                class={`typeahead__item${subId === s.id ? " typeahead__item--active" : ""}`}
                onMouseDown={() => pickSub(s)}
              >
                <strong>{subLabel(s)}</strong>
                {s.trade && <span class="text--muted">{s.trade}</span>}
              </button>
            ))}
            {filteredSubs.length === 0 && subFilter.trim() && (
              <div class="form-hint" style={{ padding: "var(--space-sm) var(--space-md)" }}>
                No matching subs.
              </div>
            )}
          </div>
        )}
      </FormField>

      <FormField label={`Scheduled date${listScheduledDate ? ` (list default: ${formatDate(listScheduledDate)})` : ""}`}>
        <input
          class="form-input"
          type="date"
          value={scheduledDate}
          onInput={(e) => setScheduledDate((e.target as HTMLInputElement).value)}
        />
      </FormField>

      <FormField label="Photo">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onPhoto} />
        <Button
          variant="secondary"
          class="punch-camera-btn"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          📷 {uploading ? "Uploading…" : photoIds.length ? "Add another photo" : "Attach photo"}
        </Button>
        {photoIds.length > 0 && (
          <div class="punch-row__thumbs" style={{ marginTop: "var(--space-sm)" }}>
            {photoIds.map((pid) => (
              <img key={pid} src={`/api/photos/${pid}/thumb`} alt="" />
            ))}
          </div>
        )}
      </FormField>
    </Modal>
  );
}

function ScheduleModal({
  punchListId,
  scheduledDate,
  onClose,
  onSaved,
  toast,
}: {
  punchListId: string;
  scheduledDate: string | null;
  onClose: () => void;
  onSaved: () => void;
  toast: ToastApi;
}) {
  const [date, setDate] = useState(scheduledDate?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/punch-lists/${punchListId}/schedule`, {
        scheduled_date: date || null,
      });
      toast.push("success", "Schedule date saved");
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Punch list schedule date"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
        Default &quot;be back by&quot; date for all items without their own override.
      </p>
      <FormField label="Scheduled date">
        <input class="form-input" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </FormField>
    </Modal>
  );
}

function SendModal({
  bySub,
  subsById,
  busy,
  onClose,
  onConfirm,
}: {
  bySub: PunchListResponse["by_sub"];
  subsById: Map<string, Sub>;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const lines = bySub
    .filter((g) => g.items.some((i) => i.status === "open"))
    .map((g) => {
      const count = g.items.filter((i) => i.status === "open").length;
      const sub = subsById.get(g.sub_id);
      const channels: string[] = [];
      if (sub?.phone) channels.push("SMS");
      if (sub?.email) channels.push("email");
      const channelText =
        channels.length === 0
          ? "no contact on file — link only"
          : channels.length === 2
            ? "SMS + email"
            : sub?.phone
              ? "SMS only"
              : "email only (no phone on file)";
      return { name: g.sub_name, count, channelText };
    });

  return (
    <Modal
      open
      title="Send punch list to subs?"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || lines.length === 0} onClick={onConfirm}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </>
      }
    >
      <ul class="punch-send-list">
        {lines.map((l) => (
          <li key={l.name}>
            <strong>{l.name}</strong> ({l.count} item{l.count === 1 ? "" : "s"}) — {l.channelText}
          </li>
        ))}
      </ul>
      {lines.length === 0 && (
        <p class="text--muted">No open items assigned to subs.</p>
      )}
    </Modal>
  );
}
