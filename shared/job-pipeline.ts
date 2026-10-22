/**
 * Columns the Jobs list, Kanban, and search actually render.
 * The status-change machine stays on the original six. Unscheduled and
 * action_required are live Jobber statuses that must still appear.
 */
export const BOARD_PIPELINE_STATUSES = [
  "action_required",
  "unscheduled",
  "deposit_paid",
  "scheduled",
  "in_progress",
  "punch_list",
  "complete",
  "closed",
] as const;

export type BoardPipelineStatus = (typeof BOARD_PIPELINE_STATUSES)[number];

/** Statuses the job page can drag between. The two live extras are view-only. */
export const MOVABLE_JOB_STATUSES = [
  "deposit_paid",
  "scheduled",
  "in_progress",
  "punch_list",
  "complete",
  "closed",
] as const;

/**
 * Statuses that can move onto on_hold. Complete, closed, cancelled, and
 * archived stay out. on_hold itself is not in this list.
 */
export const HOLDABLE_JOB_STATUSES = [
  "deposit_paid",
  "scheduled",
  "in_progress",
  "punch_list",
  "action_required",
  "unscheduled",
] as const;

export function isHoldableJobStatus(status: string | null | undefined): boolean {
  return (HOLDABLE_JOB_STATUSES as readonly string[]).includes((status ?? "").trim());
}

export function groupJobPipeline<T extends { status?: string | null }>(
  cards: T[],
): {
  statuses: readonly BoardPipelineStatus[];
  counts: Record<BoardPipelineStatus, number>;
  pipeline: Record<BoardPipelineStatus, T[]>;
} {
  const pipeline = {} as Record<BoardPipelineStatus, T[]>;
  const counts = {} as Record<BoardPipelineStatus, number>;
  for (const status of BOARD_PIPELINE_STATUSES) {
    pipeline[status] = [];
    counts[status] = 0;
  }
  for (const card of cards) {
    const status = String(card.status ?? "") as BoardPipelineStatus;
    if (!(status in pipeline)) continue;
    pipeline[status].push(card);
    counts[status]++;
  }
  return { statuses: BOARD_PIPELINE_STATUSES, counts, pipeline };
}

/**
 * Name for a client already joined by jobs.client_id.
 * Imported clients often leave `name` blank and store first and last instead.
 */
export function clientDisplayName(
  name: string | null | undefined,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  companyName?: string | null,
): string | null {
  const stored = (name ?? "").trim();
  if (stored) return stored;
  const joined = [firstName, lastName].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
  if (joined) return joined;
  const company = (companyName ?? "").trim();
  return company || null;
}
