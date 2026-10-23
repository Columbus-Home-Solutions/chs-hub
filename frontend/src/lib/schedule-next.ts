/** Right Now / Next Up selection for Overall Schedule → Today. */

export interface SchedulePick {
  id: string;
  date: string;
  start_time: string | null;
  status?: string | null;
}

export function pickRightNow<T extends SchedulePick>(todayEvents: T[]): T | null {
  return (
    todayEvents.find((e) => e.status === "in_progress") ??
    todayEvents.find((e) => e.start_time) ??
    todayEvents[0] ??
    null
  );
}

function rank(event: SchedulePick): string {
  return event.start_time ? `0${event.start_time}` : "1";
}

/**
 * The soonest later item. Timed clocks beat an all-day item on the same day.
 * A same-day item earlier than Right Now is not upcoming.
 */
export function pickNextUp<T extends SchedulePick>(events: T[], today: string, rightNow: T | null): T | null {
  return (
    events
      .filter((e) => e.date > today || (e.date === today && rightNow != null && e.id !== rightNow.id))
      .filter((e) => {
        if (e.date !== today || !rightNow?.start_time || !e.start_time) return true;
        return e.start_time > rightNow.start_time;
      })
      .sort((a, b) => {
        const byDay = a.date.localeCompare(b.date);
        return byDay !== 0 ? byDay : rank(a).localeCompare(rank(b));
      })[0] ?? null
  );
}
