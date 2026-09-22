/** Outreach and new-lead acknowledgment send only between 9:00 and 7:00 America/Chicago. */

export const CHS_TIMEZONE = "America/Chicago";
export const SEND_WINDOW_START_HOUR = 9;
export const SEND_WINDOW_END_HOUR = 19;

interface CentralParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function centralParts(now: Date): CentralParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

export function isWithinCentralSendWindow(now: Date = new Date()): boolean {
  const { hour } = centralParts(now);
  return hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR;
}

/** UTC instant for a clock time in America/Chicago. */
export function centralClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: CHS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(utcGuess).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return new Date(utcGuess.getTime() - (asUtc - utcGuess.getTime()));
}

/** Now, or the next 9:00 AM Central if the window is closed. */
export function nextCentralSendInstant(now: Date = new Date()): Date {
  if (isWithinCentralSendWindow(now)) return now;
  const p = centralParts(now);
  if (p.hour < SEND_WINDOW_START_HOUR) {
    return centralClockToUtc(p.year, p.month, p.day, SEND_WINDOW_START_HOUR, 0);
  }
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day));
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return centralClockToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    SEND_WINDOW_START_HOUR,
    0,
  );
}
