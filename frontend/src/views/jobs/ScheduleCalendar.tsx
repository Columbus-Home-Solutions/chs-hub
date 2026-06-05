import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { go } from "../../lib/nav";
import { formatDate, formatStatus } from "../../lib/format";
import { useWeather, weatherEmoji } from "../../store/weather";
import {
  type CalendarEvent,
  CALENDAR_LEGEND,
  eventTypeLabel,
  getCalendarColor,
} from "../../lib/calendar-colors";

type Mode = "day" | "week" | "month";

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - x.getUTCDay());
  return x;
}
function monthGridRange(d: Date): { from: Date; to: Date } {
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: startOfWeek(first), to: addDays(startOfWeek(last), 6) };
}

function formatEventTime(e: CalendarEvent): string {
  if (e.start_time) return `${e.start_time}${e.end_time ? `–${e.end_time}` : ""}`;
  return "";
}

function assigneeLabel(e: CalendarEvent): string | null {
  return e.assigned_user_name ?? e.assigned_sub_name ?? null;
}

export function ScheduleCalendar(_props: RoutableProps) {
  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [activeEvent, setActiveEvent] = useState<CalendarEvent | null>(null);
  const weather = useWeather();
  const forecastMap = useMemo(
    () => new Map((weather?.forecast ?? []).map((d) => [d.date, d])),
    [weather],
  );
  const alertDates = useMemo(
    () => new Set((weather?.scheduleAlerts ?? []).map((a) => a.date)),
    [weather],
  );

  const range = useMemo(() => {
    if (mode === "day") return { from: anchor, to: anchor, gridFrom: anchor, gridTo: anchor };
    if (mode === "week") {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6), gridFrom: from, gridTo: addDays(from, 6) };
    }
    const g = monthGridRange(anchor);
    return { from: g.from, to: g.to, gridFrom: g.from, gridTo: g.to };
  }, [mode, anchor]);

  const { data, loading } = useApi<{ events: CalendarEvent[] }>(
    `/api/calendar/events?from=${iso(range.from)}&to=${iso(range.to)}`,
  );

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of data?.events ?? []) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return map;
  }, [data]);

  const days: string[] = [];
  for (let d = new Date(range.gridFrom); d <= range.gridTo; d = addDays(d, 1)) days.push(iso(d));

  const shift = (dir: number) => {
    if (mode === "day") setAnchor(addDays(anchor, dir));
    else if (mode === "week") setAnchor(addDays(anchor, dir * 7));
    else setAnchor(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + dir, 1)));
  };

  const title =
    mode === "month"
      ? anchor.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
      : mode === "week"
        ? `Week of ${formatDate(iso(startOfWeek(anchor)))}`
        : formatDate(iso(anchor));

  const selectedEntries = selectedDay ? byDay.get(selectedDay) ?? [] : [];

  const openEvent = (e: CalendarEvent, ev: Event) => {
    ev.stopPropagation();
    setActiveEvent(e);
  };

  return (
    <div class="view">
      <div class="view-header">
        <div>
          <h1 class="view-title">Schedule</h1>
          <p class="view-subtitle">Jobs, warranty calls, estimates &amp; meetings</p>
        </div>
        <div class="view-header__right flex gap-sm">
          <Button variant="tertiary" size="sm" onClick={() => go("/jobs")}>
            Jobs →
          </Button>
        </div>
      </div>

      <div class="cal-legend">
        {CALENDAR_LEGEND.map((item) => (
          <span class="cal-legend__item" key={item.label}>
            <span class="cal-legend__dot" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>

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
        <div class="flex gap-xs">
          {(["day", "week", "month"] as Mode[]).map((m) => (
            <button
              key={m}
              class={`job-tab${mode === m ? " job-tab--active" : ""}`}
              onClick={() => setMode(m)}
            >
              {formatStatus(m)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <Spinner center />
      ) : (
        <div class={`cal cal--${mode}`}>
          {mode === "month" && (
            <div class="cal__weekdays">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div class="cal__weekday" key={d}>
                  {d}
                </div>
              ))}
            </div>
          )}
          <div class={mode === "month" ? "cal__month-grid" : "cal__list"}>
            {days.map((day) => {
              const entries = byDay.get(day) ?? [];
              const inMonth = mode !== "month" || new Date(day + "T00:00:00Z").getUTCMonth() === anchor.getUTCMonth();
              const wx = forecastMap.get(day);
              const wxAlert = alertDates.has(day);
              return (
                <div
                  class={`cal-cell${inMonth ? "" : " cal-cell--muted"}${selectedDay === day ? " cal-cell--selected" : ""}`}
                  key={day}
                  onClick={() => setSelectedDay(day)}
                >
                  <div class="cal-cell__date">
                    {mode === "month"
                      ? new Date(day + "T00:00:00Z").getUTCDate()
                      : formatDate(day)}
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
                    {entries.slice(0, mode === "month" ? 3 : 50).map((e) => (
                      <button
                        class="cal-chip"
                        key={`${e.type}-${e.id}`}
                        style={{ borderLeftColor: getCalendarColor(e) }}
                        title={e.title}
                        onClick={(ev) => openEvent(e, ev)}
                      >
                        <span class="cal-chip__work">{e.title}</span>
                        {e.job_number != null && (
                          <span class="cal-chip__job">
                            JOB-{String(e.job_number).padStart(3, "0")}
                          </span>
                        )}
                      </button>
                    ))}
                    {mode === "month" && entries.length > 3 && (
                      <span class="cal-cell__more">+{entries.length - 3} more</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
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

      {selectedDay && (
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
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
