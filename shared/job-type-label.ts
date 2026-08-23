/**
 * Display / title helpers for job_type (+ optional job_type_detail when type is "other").
 */

/** Fragment used in auto-generated titles: "{fragment} — {address}". */
export function jobTypeTitleFragment(
  jobType: string | null | undefined,
  detail?: string | null,
): string {
  const t = (jobType ?? "").trim();
  const d = (detail ?? "").trim();
  if (t === "other" && d) return d;
  return (t || "Estimate").replace(/_/g, " ");
}

/** Human label for UI (badges, kv rows, kanban). */
export function jobTypeDisplayLabel(
  jobType: string | null | undefined,
  detail?: string | null,
): string {
  const t = (jobType ?? "").trim();
  const d = (detail ?? "").trim();
  if (t === "other" && d) return d;
  if (!t) return d || "—";
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
