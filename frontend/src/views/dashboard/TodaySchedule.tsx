import { route } from "preact-router";
import { go } from "../../lib/nav";
import type { ScheduleEntry } from "./types";

interface Props {
  entries: ScheduleEntry[];
  loading: boolean;
  error: string | null;
}

function formatTime(t: string | null): string {
  if (!t) return "";
  // Handles "HH:MM" or "HH:MM:SS" stored as strings.
  const parts = t.split(":");
  if (parts.length < 2) return t;
  const h = parseInt(parts[0], 10);
  const m = parts[1];
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
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
          entries.map((entry) => (
            <button
              key={entry.id}
              class="schedule-row"
              onClick={() => route(entry.link)}
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
          ))
        )}
      </div>
    </div>
  );
}
