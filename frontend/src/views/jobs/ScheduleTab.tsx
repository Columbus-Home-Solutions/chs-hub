import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { useWeather, weatherEmoji } from "../../store/weather";
import { api, ApiError } from "../../api";
import { formatDate, formatStatus } from "../../lib/format";

/**
 * Job Detail → Schedule tab (Sprint 13). A day-by-day grid spanning the job's
 * start_date → target_end_date, with add/edit entries, a sub picker, drag-to-
 * reschedule, status chips, and a "sub notified" indicator (reads
 * notification_sent). Owner-write; the client portal Schedule tab is read-only.
 */

interface ScheduleEntry {
  id: string;
  job_id: string;
  scheduled_date: string | null;
  trade_or_work: string | null;
  sub_id: string | null;
  sub_name: string | null;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  status: string;
  sub_notified: boolean;
}
interface ScheduleResponse {
  job_id: string;
  start_date: string | null;
  target_end_date: string | null;
  suggest_status_scheduled: boolean;
  entries: ScheduleEntry[];
}
interface Sub {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  trade: string | null;
}

type ToastApi = ReturnType<typeof useToast>;

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "error" | "info"> = {
  scheduled: "info",
  in_progress: "warning",
  completed: "success",
  cancelled: "neutral",
  weather_delay: "error",
};
const STATUS_OPTIONS = [
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
  { value: "weather_delay", label: "Weather delay" },
  { value: "cancelled", label: "Cancelled" },
];

function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return out;
  // Cap the grid so an unbounded range never renders thousands of rows.
  for (let d = new Date(s), n = 0; d <= e && n < 180; d.setUTCDate(d.getUTCDate() + 1), n++) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function ScheduleTab({ jobId }: { jobId: string }) {
  const { data, loading, error, refetch } = useApi<ScheduleResponse>(`/api/jobs/${jobId}/schedule`);
  const subsApi = useApi<{ subcontractors: Sub[] }>("/api/subcontractors?active=1");
  const toast = useToast();
  const weather = useWeather();
  const forecastMap = useMemo(
    () => new Map((weather?.forecast ?? []).map((d) => [d.date, d])),
    [weather],
  );
  const alertDates = useMemo(
    () => new Set((weather?.scheduleAlerts ?? []).map((a) => a.date)),
    [weather],
  );
  const [modalDate, setModalDate] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduleEntry | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const subs = subsApi.data?.subcontractors ?? [];

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduleEntry[]>();
    for (const e of data?.entries ?? []) {
      const k = e.scheduled_date ?? "unscheduled";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
    return map;
  }, [data]);

  if (loading) return <Spinner center />;
  if (error || !data) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">📅</div>
        <div class="empty-state__title">Schedule unavailable</div>
        <div>{error ?? "Could not load the schedule for this job."}</div>
      </div>
    );
  }

  const gridDays =
    data.start_date && data.target_end_date ? daysBetween(data.start_date, data.target_end_date) : [];
  // Any scheduled days that fall outside the start→end window still render.
  const extraDays = [...byDay.keys()]
    .filter((k) => k !== "unscheduled" && !gridDays.includes(k))
    .sort();
  const days = [...gridDays, ...extraDays];

  const moveTo = async (entry: ScheduleEntry, date: string) => {
    if (entry.scheduled_date === date) return;
    try {
      await api.put(`/api/schedule/${entry.id}`, { scheduled_date: date });
      toast.push("success", "Entry rescheduled");
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const markStatus = async (entry: ScheduleEntry, status: string) => {
    try {
      await api.put(`/api/schedule/${entry.id}`, { status });
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const promoteToScheduled = async () => {
    try {
      await api.put(`/api/jobs/${jobId}/status`, { status: "scheduled" });
      toast.push("success", "Job moved to Scheduled");
      refetch();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  return (
    <div class="stack">
      {data.suggest_status_scheduled && (
        <Card>
          <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
            <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
              This job has a start date and scheduled work — move it to <strong>Scheduled</strong>?
            </span>
            <Button size="sm" variant="primary" onClick={promoteToScheduled}>
              Move to Scheduled
            </Button>
          </div>
        </Card>
      )}

      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {data.entries.length} entr(ies)
          {data.start_date ? ` · ${formatDate(data.start_date)}` : ""}
          {data.target_end_date ? ` → ${formatDate(data.target_end_date)}` : ""}
        </span>
        <Button variant="primary" size="sm" onClick={() => setModalDate(data.start_date ?? new Date().toISOString().slice(0, 10))}>
          + Add Entry
        </Button>
      </div>

      {!data.start_date || !data.target_end_date ? (
        <Card>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Set a start date and target end date on the Overview tab to see the day-by-day grid. You
            can still add entries below.
          </p>
        </Card>
      ) : null}

      {days.length === 0 && data.entries.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">📅</div>
          <div class="empty-state__title">No schedule yet</div>
          <div>Add the first entry to start building this job's schedule.</div>
        </div>
      ) : (
        <div class="sched-grid">
          {days.map((day) => {
            const entries = byDay.get(day) ?? [];
            const wx = forecastMap.get(day);
            const wxAlert = alertDates.has(day);
            return (
              <div
                class={`sched-day${dragId ? " sched-day--drop" : ""}`}
                key={day}
                onDragOver={(e) => dragId && e.preventDefault()}
                onDrop={() => {
                  const ent = data.entries.find((x) => x.id === dragId);
                  if (ent) moveTo(ent, day);
                  setDragId(null);
                }}
              >
                <div class="sched-day__head">
                  <span class="sched-day__date">{formatDate(day)}</span>
                  {wx && (
                    <span
                      class={`sched-day__wx${wxAlert ? " sched-day__wx--alert" : ""}`}
                      title={`${wx.condition} · High ${wx.high}°F`}
                    >
                      {weatherEmoji(wx.icon)} {wx.high}°
                    </span>
                  )}
                  <button class="sched-day__add" title="Add entry" onClick={() => setModalDate(day)}>
                    +
                  </button>
                </div>
                <div class="sched-day__entries">
                  {entries.map((e) => (
                    <div
                      class="sched-entry"
                      key={e.id}
                      draggable
                      onDragStart={() => setDragId(e.id)}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => setEditing(e)}
                    >
                      <div class="sched-entry__top">
                        <span class="sched-entry__work">{e.trade_or_work}</span>
                        <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{formatStatus(e.status)}</Badge>
                      </div>
                      <div class="sched-entry__meta">
                        {e.start_time ? `${e.start_time}${e.end_time ? `–${e.end_time}` : ""} · ` : ""}
                        {e.sub_name ?? "Unassigned"}
                        {e.sub_id ? (e.sub_notified ? " · ✓ notified" : " · notify pending") : ""}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(byDay.get("unscheduled")?.length ?? 0) > 0 && (
        <Card title="Unscheduled">
          <div class="invoice-list">
            {(byDay.get("unscheduled") ?? []).map((e) => (
              <div class="invoice-row" key={e.id} onClick={() => setEditing(e)} style={{ cursor: "pointer" }}>
                <div class="invoice-row__main">
                  <div class="invoice-row__title">{e.trade_or_work}</div>
                  <div class="invoice-row__meta">{e.sub_name ?? "Unassigned"}</div>
                </div>
                <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{formatStatus(e.status)}</Badge>
              </div>
            ))}
          </div>
        </Card>
      )}

      {(modalDate || editing) && (
        <ScheduleModal
          jobId={jobId}
          subs={subs}
          entry={editing}
          defaultDate={modalDate}
          onClose={() => {
            setModalDate(null);
            setEditing(null);
          }}
          onSaved={() => {
            setModalDate(null);
            setEditing(null);
            refetch();
          }}
          onStatus={markStatus}
          toast={toast}
        />
      )}
    </div>
  );
}

function ScheduleModal({
  jobId,
  subs,
  entry,
  defaultDate,
  onClose,
  onSaved,
  toast,
}: {
  jobId: string;
  subs: Sub[];
  entry: ScheduleEntry | null;
  defaultDate: string | null;
  onClose: () => void;
  onSaved: () => void;
  onStatus: (e: ScheduleEntry, s: string) => void;
  toast: ToastApi;
}) {
  const [date, setDate] = useState(entry?.scheduled_date ?? defaultDate ?? "");
  const [work, setWork] = useState(entry?.trade_or_work ?? "");
  const [subId, setSubId] = useState(entry?.sub_id ?? "");
  const [startTime, setStartTime] = useState(entry?.start_time ?? "");
  const [endTime, setEndTime] = useState(entry?.end_time ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [status, setStatus] = useState(entry?.status ?? "scheduled");
  const [busy, setBusy] = useState(false);

  const subOptions = [
    { value: "", label: "Unassigned (no sub)" },
    ...subs.map((s) => ({
      value: s.id,
      label: `${s.company_name ?? s.contact_name ?? "Sub"}${s.trade ? ` · ${s.trade}` : ""}`,
    })),
  ];
  const valid = date && work.trim();

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const payload = {
      scheduled_date: date,
      trade_or_work: work.trim(),
      sub_id: subId || null,
      start_time: startTime || null,
      end_time: endTime || null,
      notes: notes.trim() || null,
      status,
    };
    try {
      if (entry) {
        await api.put(`/api/schedule/${entry.id}`, payload);
        toast.push("success", "Entry updated");
      } else {
        await api.post(`/api/jobs/${jobId}/schedule`, payload);
        toast.push("success", subId ? "Entry added — sub notified (simulated)" : "Entry added");
      }
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!entry || !confirm("Delete this schedule entry?")) return;
    setBusy(true);
    try {
      await api.del(`/api/schedule/${entry.id}`);
      toast.push("success", "Entry deleted");
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={entry ? "Edit schedule entry" : "Add schedule entry"}
      onClose={onClose}
      footer={
        <>
          {entry && (
            <Button variant="danger" onClick={remove} disabled={busy}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving…" : entry ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div class="form-row">
        <FormField label="Date" required>
          <input class="form-input" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Status">
          <Select value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        </FormField>
      </div>
      <FormField label="Trade / work" required>
        <input
          class="form-input"
          value={work}
          placeholder="e.g. Framing, Electrical rough-in"
          onInput={(e) => setWork((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Subcontractor">
        <Select value={subId} options={subOptions} onChange={setSubId} />
      </FormField>
      <div class="form-row">
        <FormField label="Start time">
          <input class="form-input" type="time" value={startTime} onInput={(e) => setStartTime((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="End time">
          <input class="form-input" type="time" value={endTime} onInput={(e) => setEndTime((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <FormField label="Notes">
        <textarea class="form-input" rows={2} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
      </FormField>
      {entry?.sub_id && (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {entry.sub_notified
            ? "This sub has been notified (simulated). Editing won't re-notify."
            : "Sub not yet notified."}
        </p>
      )}
    </Modal>
  );
}
