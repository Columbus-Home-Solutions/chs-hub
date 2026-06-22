import { route } from "preact-router";
import { go } from "../../lib/nav";
import type { ScheduleEntry } from "./types";

interface Props {
  entries: ScheduleEntry[];
  loading: boolean;
  error: string | null;
}

/** Formats "HH:MM" or "HH:MM:SS" time strings. */
function formatTimeStr(t: string): string {
  const parts = t.split(":");
  if (parts.length < 2) return t;
  const h = parseInt(parts[0], 10);
  const m = parts[1];
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

/** Formats any time value — ISO datetime or "HH:MM" string. */
function formatTime(t: string | null | undefined): string {
  if (!t) return "";
  // ISO datetime: "2026-06-22T11:00:00.000Z" or "2026-06-22T11:00:00"
  if (t.includes("T")) {
    const d = new Date(t);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    }
  }
  return formatTimeStr(t);
}

/** Formats a time range for GCal events. */
function formatTimeRange(start: string | null, end: string | null | undefined): string {
  const s = formatTime(start);
  const e = formatTime(end);
  if (s && e) return `${s} – ${e}`;
  return s;
}

export function TodaySchedule({ entries, loading, error }: Props) {
  if (loading) {
    return (
      <div class="dash-card">
        <div class="dash-card__header">
          <h2 class="dash-card__title">Today's Schedule</h2>
        </div>
        <div class="dash-card__body">
          {[...Array(3)].map((_, i) => (
            <div key={i} class="schedule-row schedule-row--skeleton" aria-hidden="true" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="dash-card">
        <div class="dash-card__header"><h2 class="dash-card__title">Today's Schedule</h2></div>
        <div class="dash-card__body dash-card__body--error">Unable to load schedule.</div>
      </div>
    );
  }

  return (
    <div class="dash-card">
      <div class="dash-card__header">
        <h2 class="dash-card__title">Today's Schedule</h2>
        <button class="link-btn" onClick={() => go("/schedule")}>
          View Full Calendar →
        </button>
      </div>
      <div class="dash-card__body">
        {entries.length === 0 ? (
          <div class="schedule__empty">
            Nothing scheduled today.{" "}
            <button class="link-btn" onClick={() => go("/schedule")}>
              Open calendar →
            </button>
          </div>
        ) : (
          entries.map((entry) => {
            if (entry.entry_type === "google_calendar" || entry.type === "google_calendar") {
              return (
                <div key={entry.id} class="schedule-row schedule-row--gcal">
                  <span class="schedule-row__time">
                    {formatTimeRange(entry.startTime, entry.endTime) || "—"}
                  </span>
                  <div class="schedule-row__info">
                    <span class="schedule-row__label">
                      <span class="schedule-row__gcal-icon" aria-hidden="true">📅</span>
                      {entry.label}
                    </span>
                  </div>
                  {entry.meetLink && (
                    <a
                      href={entry.meetLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="schedule-row__join-btn"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Join
                    </a>
                  )}
                </div>
              );
            }

            return (
              <button
                key={entry.id}
                class="schedule-row"
                onClick={() => entry.link && route(entry.link)}
              >
                <span class="schedule-row__time">
                  {formatTime(entry.startTime) || "—"}
                </span>
                <div class="schedule-row__info">
                  <span class="schedule-row__label">{entry.label}</span>
                  {entry.description && (
                    <span class="schedule-row__desc">{entry.description}</span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
