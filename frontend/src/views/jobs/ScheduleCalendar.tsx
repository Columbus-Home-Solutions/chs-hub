import type { RoutableProps } from "preact-router";
import { useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { go } from "../../lib/nav";
import { formatDate, formatStatus } from "../../lib/format";
import { useWeather, weatherEmoji } from "../../store/weather";

/**
 * Schedule Calendar — cross-job view (Sprint 13, spec §5.5). Day / week / month,
 * color-coded by job. Click a day to see that day's work; click an entry to jump
 * to its job. Reuses the token-styled grid — no calendar library.
 */

interface CalEntry {
  id: string;
  job_id: string;
  job_title: string | null;
  job_number: number | null;
  scheduled_date: string | null;
  trade_or_work: string | null;
  sub_name: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
}
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
// Stable per-job hue so each job keeps one color across the grid.
function jobHue(jobId: string): number {
  let h = 0;
  for (let i = 0; i < jobId.length; i++) h = (h * 31 + jobId.charCodeAt(i)) % 360;
  return h;
}

export function ScheduleCalendar(_props: RoutableProps) {
  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
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

  const { data, loading } = useApi<{ entries: CalEntry[] }>(
    `/api/schedule?from=${iso(range.from)}&to=${iso(range.to)}`,
  );

  const byDay = useMemo(() => {
    const map = new Map<string, CalEntry[]>();
    for (const e of data?.entries ?? []) {
      if (!e.scheduled_date) continue;
      if (!map.has(e.scheduled_date)) map.set(e.scheduled_date, []);
      map.get(e.scheduled_date)!.push(e);
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

  return (
    <div class="view">
      <div class="view-header">
        <div>
          <h1 class="view-title">Schedule</h1>
          <p class="view-subtitle">Cross-job calendar</p>
        </div>
        <div class="view-header__right flex gap-sm">
          <Button variant="tertiary" size="sm" onClick={() => go("/jobs")}>
            Jobs →
          </Button>
        </div>
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
                        key={e.id}
                        style={{ borderLeftColor: `hsl(${jobHue(e.job_id)}, 70%, 55%)` }}
                        title={`${e.job_title ?? "Job"} · ${e.trade_or_work ?? ""}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          go(`/jobs/${e.job_id}`);
                        }}
                      >
                        <span class="cal-chip__work">{e.trade_or_work}</span>
                        <span class="cal-chip__job">
                          {e.job_number != null ? `JOB-${String(e.job_number).padStart(3, "0")}` : ""}
                        </span>
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

      {selectedDay && (
        <Card title={`Work on ${formatDate(selectedDay)}`}>
          {selectedEntries.length === 0 ? (
            <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
              No scheduled work this day.
            </p>
          ) : (
            <div class="invoice-list">
              {selectedEntries.map((e) => (
                <div class="invoice-row" key={e.id} onClick={() => go(`/jobs/${e.job_id}`)} style={{ cursor: "pointer" }}>
                  <div class="invoice-row__main">
                    <div class="invoice-row__title">
                      <span style={{ color: `hsl(${jobHue(e.job_id)}, 70%, 60%)` }}>●</span> {e.trade_or_work}
                    </div>
                    <div class="invoice-row__meta">
                      {e.job_number != null ? `JOB-${String(e.job_number).padStart(3, "0")} · ` : ""}
                      {e.job_title ?? ""}
                      {e.start_time ? ` · ${e.start_time}${e.end_time ? `–${e.end_time}` : ""}` : ""}
                      {e.sub_name ? ` · ${e.sub_name}` : ""}
                    </div>
                  </div>
                  <span class={`er-status`}>{formatStatus(e.status)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
