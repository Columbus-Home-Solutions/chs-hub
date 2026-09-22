/** A New Lead is stale once it has sat for more than an hour. */
export const UNTOUCHED_STALE_MS = 60 * 60 * 1000;

export function untouchedIsAmber(oldestCreatedAt: string | null, now = Date.now()): boolean {
  if (!oldestCreatedAt) return false;
  const raw = oldestCreatedAt.includes("T")
    ? oldestCreatedAt
    : oldestCreatedAt.replace(" ", "T") + "Z";
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return false;
  return now - t > UNTOUCHED_STALE_MS;
}
