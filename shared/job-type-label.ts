/**
 * Display / title helpers for job_type + optional free-text description
 * (`job_type_detail` — any job type, not only "other").
 */

/** Fragment used in auto-generated titles: "{fragment} — {address}". */
export function jobTypeTitleFragment(
  jobType: string | null | undefined,
  detail?: string | null,
): string {
  const d = (detail ?? "").trim();
  if (d) return d;
  const t = (jobType ?? "").trim();
  return (t || "Estimate").replace(/_/g, " ");
}

/** Human label for UI (badges, kv rows, kanban). */
export function jobTypeDisplayLabel(
  jobType: string | null | undefined,
  detail?: string | null,
): string {
  const d = (detail ?? "").trim();
  if (d) return d;
  const t = (jobType ?? "").trim();
  if (!t) return "—";
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
