import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useUrlTab } from "../../hooks/useUrlTab";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { go } from "../../lib/nav";
import { formatDate } from "../../lib/format";
import { useWeather, weatherEmoji } from "../../store/weather";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import {
  type CalendarEvent,
  type CalendarEventType,
  type JobRag,
  type ScheduleJob,
  CALENDAR_LEGEND,
  eventTypeLabel,
  getCalendarColor,
  subBadgeLabel,
} from "../../lib/calendar-colors";
import { countdownLabel, initials, startOfMondayWeek } from "../../lib/schedule-banner";

type Mode = "today" | "week" | "timeline" | "month";
const MODES: Mode[] = ["today", "week", "timeline", "month"];
const MODE_LABEL: Record<Mode, string> = {
  today: "Today",
  week: "This Week",
  timeline: "Timeline",
  month: "Month",
};
const TYPE_FILTERS: CalendarEventType[] = [
  "job_appointment",
  "warranty_call",
  "estimate_visit",
  "proposal_review",
  "permit_inspection",
  "deadline",
  "google_meeting",
];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function startOfSundayWeek(d: Date): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - x.getUTCDay());
  return x;
}
function monthGridRange(d: Date): { from: Date; to: Date } {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: startOfSundayWeek(first), to: addDays(startOfSundayWeek(last), 6) };
}

function formatEventTime(e: CalendarEvent): string {
  if (e.start_time) return `${e.start_time}${e.end_time ? `–${e.end_time}` : ""}`;
  return "";
}

function assigneeLabel(e: CalendarEvent): string | null {
  return e.assigned_user_name ?? e.assigned_sub_name ?? null;
}

function ragLabel(rag: JobRag): string {
  if (rag === "behind") return "Behind";
  if (rag === "at_risk") return "At risk";
  return "On track";
}

function jobLabel(job: ScheduleJob): string {
  const num = job.job_number != null ? `JOB-${String(job.job_number).padStart(3, "0")}` : null;
  const title = (job.title ?? "").trim() || "Job";
  return num ? `${num} · ${title}` : title;
}

function EventChip({ e, onOpen }: { e: CalendarEvent; onOpen: (e: CalendarEvent, ev: Event) => void }) {
  const sub = subBadgeLabel(e.assigned_sub_name);
  return (
    <button
      class="cal-chip"
      style={{ borderLeftColor: getCalendarColor(e) }}
      title={e.title}
      onClick={(ev) => onOpen(e, ev)}
    >
      <span class="cal-chip__work">{e.title}</span>
      {sub && <span class="sched-sub-badge">{sub}</span>}
      {e.job_number != null && (
        <span class="cal-chip__job">JOB-{String(e.job_number).padStart(3, "0")}</span>
      )}
    </button>
  );
}

export function ScheduleCalendar(_props: RoutableProps) {
  const [mode, setMode] = useUrlTab(MODES, "today", "view");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [activeEvent, setActiveEvent] = useState<CalendarEvent | null>(null);
  const [assignee, setAssignee] = useState("everyone");
  const [hiddenTypes, setHiddenTypes] = useState<Set<CalendarEventType>>(new Set());
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const weather = useWeather();
  const toast = useToast();
  const forecastMap = useMemo(
    () => new Map((weather?.forecast ?? []).map((d) => [d.date, d])),
    [weather],
  );
  const alertDates = useMemo(
    () => new Set((weather?.scheduleAlerts ?? []).map((a) => a.date)),
    [weather],
  );

  const today = iso(new Date());
  const feedFrom = iso(addDays(new Date(), -120));
  const feedTo = iso(addDays(new Date(), 240));

  const { data, loading, error, refetch } = useApi<{ events: CalendarEvent[]; jobs: ScheduleJob[] }>(
    `/api/calendar/events?from=${feedFrom}&to=${feedTo}`,
  );
  const usersApi = useApi<{ users: Array<{ id: string; name: string; calendar_color?: string }> }>(
    "/api/users/assignable",
  );
  const jobsApi = useApi<{ jobs: Array<{ id: string; job_number: number | null; title: string | null }> }>(
    "/api/jobs",
  );

  const events = data?.events ?? [];
  const jobs = data?.jobs ?? [];
  const users = usersApi.data?.users ?? [];

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (hiddenTypes.has(e.type)) return false;
      if (assignee === "everyone") return true;
      if (e.assigned_user_id === assignee) return true;
      const job = e.job_id ? jobs.find((j) => j.id === e.job_id) : null;
      return job?.assigned_to === assignee;
    });
  }, [events, hiddenTypes, assignee, jobs]);

  const filteredJobs = useMemo(() => {
    if (assignee === "everyone") return jobs;
    return jobs.filter((j) => j.assigned_to === assignee);
  }, [jobs, assignee]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of filteredEvents) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return map;
  }, [filteredEvents]);

  const monthRange = monthGridRange(anchor);
  const monthDays: string[] = [];
  for (let d = new Date(monthRange.from); d <= monthRange.to; d = addDays(d, 1)) monthDays.push(iso(d));

  const weekStart = startOfMondayWeek(anchor);
  const weekDays: string[] = [];
  for (let i = 0; i < 7; i++) weekDays.push(iso(addDays(weekStart, i)));

  const title =
    mode === "month"
      ? anchor.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
      : mode === "week"
        ? `Week of ${formatDate(iso(weekStart))}`
        : mode === "timeline"
          ? "Active jobs"
          : formatDate(today);

  const shift = (dir: number) => {
    if (mode === "week") setAnchor(addDays(anchor, dir * 7));
    else if (mode === "month") {
      setAnchor(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + dir, 1)));
    }
  };

  const selectedEntries = selectedDay ? byDay.get(selectedDay) ?? [] : [];

  const openEvent = (e: CalendarEvent, ev: Event) => {
    ev.stopPropagation();
    setActiveEvent(e);
  };

  const toggleType = (t: CalendarEventType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const todayEvents = (byDay.get(today) ?? []).slice().sort((a, b) =>
    (a.start_time ?? "").localeCompare(b.start_time ?? ""),
  );
  const rightNow =
    todayEvents.find((e) => e.status === "in_progress") ??
    todayEvents.find((e) => e.start_time) ??
    todayEvents[0] ??
    null;
  const nextUp =
    filteredEvents
      .filter((e) => e.date > today || (e.date === today && rightNow && e.id !== rightNow.id))
      .sort((a, b) => {
        const d = a.date.localeCompare(b.date);
        return d !== 0 ? d : (a.start_time ?? "").localeCompare(b.start_time ?? "");
      })[0] ?? null;

  return (
    <div class="view">
      <div class="view-header">
        <div>
          <h1 class="view-title">Overall Schedule</h1>
          <p class="view-subtitle">Jobs, warranty calls, estimates, inspections, deadlines &amp; meetings</p>
        </div>
        <div class="view-header__right flex gap-sm">
          <Button variant="secondary" size="sm" onClick={() => setDeadlineOpen(true)}>
            + Add Deadline
          </Button>
          <Button variant="tertiary" size="sm" onClick={() => go("/jobs")}>
            Jobs →
          </Button>
        </div>
      </div>

      <div class="cal-toolbar">
        <div class="flex gap-xs">
          {MODES.map((m) => (
            <button
              key={m}
              class={`job-tab${mode === m ? " job-tab--active" : ""}`}
              onClick={() => setMode(m)}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <label class="cal-showing">
          <span>Showing:</span>
          <select
            class="form-select"
            value={assignee}
            onChange={(e) => setAssignee((e.target as HTMLSelectElement).value)}
          >
            <option value="everyone">Everyone</option>
            {users.map((u) => (
              <option value={u.id} key={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div class="cal-legend">
        {CALENDAR_LEGEND.map((item) => (
          <span class="cal-legend__item" key={item.label}>
            <span class="cal-legend__dot" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>

      <div class="cal-type-filters">
        {TYPE_FILTERS.map((t) => (
          <button
            key={t}
            type="button"
            class={`cal-type-chip${hiddenTypes.has(t) ? " cal-type-chip--off" : ""}`}
            onClick={() => toggleType(t)}
          >
            {eventTypeLabel(t)}
          </button>
        ))}
      </div>

      {(mode === "week" || mode === "month") && (
        <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap", marginBottom: "var(--space-md)" }}>
          <div class="flex items-center gap-sm">
            <Button variant="secondary" size="sm" onClick={() => shift(-1)}>
              ‹
            </Button>
            <strong style={{ minWidth: "180px", textAlign: "center" }}>{title}</strong>
            <Button variant="secondary" size="sm" onClick={() => shift(1)}>
              ›
            </Button>
            <Button variant="tertiary" size="sm" onClick={() => setAnchor(new Date())}>
              Today
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner center />
      ) : error ? (
        <div class="empty-state">
          <div class="empty-state__icon">📅</div>
          <div class="empty-state__title">Schedule feed failed</div>
          <div>{error}</div>
        </div>
      ) : mode === "today" ? (
        <div class="os-today">
          <Card title="Right Now">
            {rightNow ? (
              <button class="os-today__item" onClick={(ev) => openEvent(rightNow, ev)}>
                <span class="os-today__dot" style={{ background: getCalendarColor(rightNow) }} />
                <div>
                  <div class="os-today__title">{rightNow.title}</div>
                  <div class="os-today__meta">
                    {eventTypeLabel(rightNow.type)}
                    {formatEventTime(rightNow) ? ` · ${formatEventTime(rightNow)}` : ""}
                    {assigneeLabel(rightNow) ? ` · ${assigneeLabel(rightNow)}` : ""}
                    {subBadgeLabel(rightNow.assigned_sub_name)
                      ? ` · ${subBadgeLabel(rightNow.assigned_sub_name)}`
                      : ""}
                  </div>
                </div>
              </button>
            ) : (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                Nothing happening today.
              </p>
            )}
          </Card>
          <Card title="Next Up">
            {nextUp ? (
              <button class="os-today__item" onClick={(ev) => openEvent(nextUp, ev)}>
                <span class="os-today__dot" style={{ background: getCalendarColor(nextUp) }} />
                <div>
                  <div class="os-today__title">{nextUp.title}</div>
                  <div class="os-today__meta">
                    {formatDate(nextUp.date)}
                    {formatEventTime(nextUp) ? ` · ${formatEventTime(nextUp)}` : ""}
                    {" · "}
                    {countdownLabel(nextUp.date, nextUp.start_time)}
                    {subBadgeLabel(nextUp.assigned_sub_name)
                      ? ` · ${subBadgeLabel(nextUp.assigned_sub_name)}`
                      : ""}
                  </div>
                </div>
              </button>
            ) : (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                Nothing coming up in the current window.
              </p>
            )}
          </Card>
        </div>
      ) : mode === "week" ? (
        <div class="os-week">
          {weekDays.map((day) => {
            const all = byDay.get(day) ?? [];
            const expanded = expandedDays.has(day);
            const visible = expanded ? all : all.slice(0, 4);
            const more = all.length - visible.length;
            return (
              <div class="os-week__day" key={day}>
                <div class="os-week__head">
                  {formatDate(day)}
                  {forecastMap.get(day) && (
                    <span class={`cal-cell__wx${alertDates.has(day) ? " cal-cell__wx--alert" : ""}`}>
                      {weatherEmoji(forecastMap.get(day)!.icon)} {forecastMap.get(day)!.high}°
                    </span>
                  )}
                </div>
                {visible.map((e) => (
                  <button class="os-week__row" key={`${e.type}-${e.id}`} onClick={(ev) => openEvent(e, ev)}>
                    <span class="os-today__dot" style={{ background: getCalendarColor(e) }} />
                    <span class="os-week__time">{formatEventTime(e) || "All day"}</span>
                    <span class="os-week__title">{e.title}</span>
                    <span class="os-week__who">{initials(assigneeLabel(e))}</span>
                    {subBadgeLabel(e.assigned_sub_name) && (
                      <span class="sched-sub-badge">{subBadgeLabel(e.assigned_sub_name)}</span>
                    )}
                  </button>
                ))}
                {more > 0 && (
                  <button
                    type="button"
                    class="os-week__more"
                    onClick={() => setExpandedDays((prev) => new Set(prev).add(day))}
                  >
                    +{more} more — tap to expand
                  </button>
                )}
                {all.length === 0 && <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>No entries</div>}
              </div>
            );
          })}
        </div>
      ) : mode === "timeline" ? (
        <TimelineView jobs={filteredJobs} />
      ) : (
        <div class={`cal cal--month`}>
          <div class="cal__weekdays">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div class="cal__weekday" key={d}>
                {d}
              </div>
            ))}
          </div>
          {chunk(monthDays, 7).map((week) => (
            <div class="cal-week" key={week[0]}>
              <div class="cal-week__bands">
                {filteredJobs.map((job) => {
                  const band = weekBand(job, week);
                  if (!band) return null;
                  return (
                    <div
                      key={job.id}
                      class={`cal-band${band.continuesStart ? " cal-band--flat-start" : ""}${band.continuesEnd ? " cal-band--flat-end" : ""}`}
                      style={{
                        left: band.left,
                        width: band.width,
                        background: job.assigned_to_color || "var(--color-info)",
                      }}
                      title={jobLabel(job)}
                    />
                  );
                })}
              </div>
              <div class="cal__month-grid">
                {week.map((day) => {
                  const entries = byDay.get(day) ?? [];
                  const inMonth = new Date(day + "T00:00:00Z").getUTCMonth() === anchor.getUTCMonth();
                  const wx = forecastMap.get(day);
                  const wxAlert = alertDates.has(day);
                  return (
                    <div
                      class={`cal-cell${inMonth ? "" : " cal-cell--muted"}${selectedDay === day ? " cal-cell--selected" : ""}`}
                      key={day}
                      onClick={() => setSelectedDay(day)}
                    >
                      <div class="cal-cell__date">
                        {new Date(day + "T00:00:00Z").getUTCDate()}
                        {wx && (
                          <span
                            class={`cal-cell__wx${wxAlert ? " cal-cell__wx--alert" : ""}`}
                            title={`${wx.condition} · High ${wx.high}°F`}
                          >
                            {weatherEmoji(wx.icon)} {wx.high}°
                          </span>
                        )}
                      </div>
                      <div class="cal-cell__entries">
                        {entries.slice(0, 3).map((e) => (
                          <EventChip e={e} key={`${e.type}-${e.id}`} onOpen={openEvent} />
                        ))}
                        {entries.length > 3 && <span class="cal-cell__more">+{entries.length - 3} more</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeEvent && (
        <div class="cal-popover-backdrop" onClick={() => setActiveEvent(null)}>
          <div class="cal-popover" onClick={(e) => e.stopPropagation()}>
            <div class="cal-popover__title">{activeEvent.title}</div>
            <div class="cal-popover__meta">
              {eventTypeLabel(activeEvent.type)}
              {activeEvent.date ? ` · ${formatDate(activeEvent.date)}` : ""}
              {formatEventTime(activeEvent) ? ` · ${formatEventTime(activeEvent)}` : ""}
            </div>
            {assigneeLabel(activeEvent) && (
              <div class="cal-popover__meta">Assigned: {assigneeLabel(activeEvent)}</div>
            )}
            {subBadgeLabel(activeEvent.assigned_sub_name) && (
              <div class="cal-popover__meta">
                <span class="sched-sub-badge">{subBadgeLabel(activeEvent.assigned_sub_name)}</span>
              </div>
            )}
            {activeEvent.description && (
              <div class="cal-popover__desc">{activeEvent.description}</div>
            )}
            <div class="flex gap-sm" style={{ marginTop: "var(--space-sm)" }}>
              {activeEvent.meet_link && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => window.open(activeEvent.meet_link!, "_blank", "noopener,noreferrer")}
                >
                  Join Meeting
                </Button>
              )}
              {activeEvent.link_path && (
                <Button variant="secondary" size="sm" onClick={() => go(activeEvent.link_path!)}>
                  View details
                </Button>
              )}
              <Button variant="tertiary" size="sm" onClick={() => setActiveEvent(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {mode === "month" && selectedDay && (
        <Card title={`Events on ${formatDate(selectedDay)}`}>
          {selectedEntries.length === 0 ? (
            <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
              Nothing scheduled this day.
            </p>
          ) : (
            <div class="invoice-list">
              {selectedEntries.map((e) => (
                <div
                  class="invoice-row"
                  key={`${e.type}-${e.id}`}
                  onClick={() => setActiveEvent(e)}
                  style={{ cursor: "pointer" }}
                >
                  <div class="invoice-row__main">
                    <div class="invoice-row__title">
                      <span style={{ color: getCalendarColor(e) }}>●</span> {e.title}
                    </div>
                    <div class="invoice-row__meta">
                      {eventTypeLabel(e.type)}
                      {e.job_number != null ? ` · JOB-${String(e.job_number).padStart(3, "0")}` : ""}
                      {formatEventTime(e) ? ` · ${formatEventTime(e)}` : ""}
                      {assigneeLabel(e) ? ` · ${assigneeLabel(e)}` : ""}
                      {subBadgeLabel(e.assigned_sub_name) ? ` · ${subBadgeLabel(e.assigned_sub_name)}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {deadlineOpen && (
        <DeadlineModal
          jobs={jobsApi.data?.jobs ?? jobs.map((j) => ({ id: j.id, job_number: j.job_number, title: j.title }))}
          onClose={() => setDeadlineOpen(false)}
          onSaved={() => {
            setDeadlineOpen(false);
            refetch();
            toast.push("success", "Deadline added");
          }}
          toast={toast}
        />
      )}
    </div>
  );
}

function TimelineView({ jobs }: { jobs: ScheduleJob[] }) {
  const axis = useMemo(() => {
    const dates = jobs.flatMap((j) => [j.start_date, j.target_end_date].filter(Boolean) as string[]);
    if (dates.length === 0) {
      const today = iso(new Date());
      return { start: today, end: iso(addDays(new Date(), 28)) };
    }
    dates.sort();
    return { start: dates[0], end: dates[dates.length - 1] };
  }, [jobs]);
  const startMs = Date.parse(`${axis.start}T00:00:00Z`);
  const endMs = Date.parse(`${axis.end}T00:00:00Z`);
  const span = Math.max(endMs - startMs, 86_400_000);

  if (jobs.length === 0) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">📅</div>
        <div class="empty-state__title">No active jobs</div>
        <div>Jobs in deposit paid through punch list show up here.</div>
      </div>
    );
  }

  return (
    <div class="os-timeline">
      {jobs.map((job) => {
        const s = job.start_date ? Date.parse(`${job.start_date}T00:00:00Z`) : startMs;
        const e = job.target_end_date ? Date.parse(`${job.target_end_date}T00:00:00Z`) : endMs;
        const left = `${Math.max(0, ((s - startMs) / span) * 100)}%`;
        const width = `${Math.max(2, ((Math.max(e, s) - s) / span) * 100)}%`;
        return (
          <button class="os-tl__row" key={job.id} onClick={() => go(`/jobs/${job.id}?tab=schedule`)}>
            <span class="os-today__dot" style={{ background: job.assigned_to_color || "var(--color-info)" }} />
            <div class="os-tl__who">
              <span class="os-tl__avatar">{initials(job.assigned_to_name)}</span>
              <div>
                <div class="os-tl__name">{jobLabel(job)}</div>
                <div class="os-tl__assignee">{job.assigned_to_name ?? "Unassigned"}</div>
              </div>
            </div>
            <span class={`os-rag os-rag--${job.rag}`}>
              <span class="os-rag__dot" />
              {ragLabel(job.rag)}
            </span>
            <div class="os-tl__axis">
              <div
                class="os-tl__bar"
                style={{ left, width, background: job.assigned_to_color || "var(--color-info)" }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function weekBand(job: ScheduleJob, week: string[]): { left: string; width: string; continuesStart: boolean; continuesEnd: boolean } | null {
  const start = job.start_date;
  const end = job.target_end_date;
  if (!start || !end) return null;
  const weekStart = week[0];
  const weekEnd = week[6];
  if (end < weekStart || start > weekEnd) return null;
  const clampedStart = start < weekStart ? weekStart : start;
  const clampedEnd = end > weekEnd ? weekEnd : end;
  const i0 = week.indexOf(clampedStart);
  const i1 = week.indexOf(clampedEnd);
  if (i0 < 0 || i1 < 0) return null;
  return {
    left: `${(i0 / 7) * 100}%`,
    width: `${((i1 - i0 + 1) / 7) * 100}%`,
    continuesStart: start < weekStart,
    continuesEnd: end > weekEnd,
  };
}

function DeadlineModal({
  jobs,
  onClose,
  onSaved,
  toast,
}: {
  jobs: Array<{ id: string; job_number: number | null; title: string | null }>;
  onClose: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [jobId, setJobId] = useState(jobs[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(iso(new Date()));
  const [busy, setBusy] = useState(false);
  const valid = jobId && title.trim() && date;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await api.post(`/api/jobs/${jobId}/schedule`, {
        scheduled_date: date,
        trade_or_work: title.trim(),
        entry_type: "deadline",
        status: "scheduled",
      });
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Add deadline"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving…" : "Add"}
          </Button>
        </>
      }
    >
      <FormField label="Job" required>
        <Select
          value={jobId}
          onChange={setJobId}
          options={jobs.map((j) => ({
            value: j.id,
            label: j.job_number != null ? `JOB-${String(j.job_number).padStart(3, "0")} · ${j.title ?? "Job"}` : (j.title ?? "Job"),
          }))}
        />
      </FormField>
      <FormField label="Title" required>
        <input
          class="form-input"
          value={title}
          placeholder="e.g. Permit expires, Material order cutoff"
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Date" required>
        <input class="form-input" type="date" value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
      </FormField>
    </Modal>
  );
}
