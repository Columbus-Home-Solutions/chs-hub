/** Stored on schedule_entries.entry_type. Permit inspections are not stored here. */
export const SCHEDULE_ENTRY_TYPES = ["job_task", "deadline"] as const;
export type ScheduleEntryType = (typeof SCHEDULE_ENTRY_TYPES)[number];

export function isScheduleEntryType(value: unknown): value is ScheduleEntryType {
  return value === "job_task" || value === "deadline";
}

export function normalizeScheduleEntryType(value: unknown): ScheduleEntryType {
  return value === "deadline" ? "deadline" : "job_task";
}
