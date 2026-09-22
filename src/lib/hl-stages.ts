/**
 * HighLevel sales-pipeline stage IDs (location lZ8L8FAf6K2niuHoFbaw).
 * Match on these IDs. Opportunity status open/lost is not the filter.
 * Lead Nurture Campaigns and the two Job Completed stages are intentionally absent.
 */

export const HL_STAGE_NEW_LEAD = "adb468b0-7c7e-42b4-9ae9-fad4af5c0ec5";
export const HL_STAGE_CONTACTED = "27df8419-2d30-453a-8b6a-64ac6aa4281c";
export const HL_STAGE_APPOINTMENT_SET = "a85d0a99-a3ad-4257-a842-416b0306437d";
export const HL_STAGE_CREATE_ESTIMATE = "c19a86f7-e719-45a3-b098-5af180584173";
export const HL_STAGE_ESTIMATE_SENT = "f867aae0-2783-4ef2-9b5c-632276b54307";
export const HL_STAGE_JOB_COLLECTED = "f2a3e3f2-f20e-4218-8d54-e02912d85083";
export const HL_STAGE_JOB_UNCOLLECTED = "cde68ce3-4a41-4014-b5fa-b90a354a4cd2";
export const HL_STAGE_DEAD_LEAD = "021fb348-4343-494e-a6a0-41af99b2b0ef";

export type MirroredLeadStatus = "contacted" | "appointment_set" | "building" | "sent";

/** Stages the mirror copies, in pipeline order. */
export const HL_MIRROR_STAGE_TO_CHS: Record<string, MirroredLeadStatus> = {
  [HL_STAGE_CONTACTED]: "contacted",
  [HL_STAGE_APPOINTMENT_SET]: "appointment_set",
  [HL_STAGE_CREATE_ESTIMATE]: "building",
  [HL_STAGE_ESTIMATE_SENT]: "sent",
};

export const HL_MIRROR_STAGE_IDS = Object.keys(HL_MIRROR_STAGE_TO_CHS);

/** Day 1/2/3 only when the HL stage change is this recent. */
export const HL_STAGE_CHANGE_FRESH_MS = 24 * 60 * 60 * 1000;

export function isFreshHlStageChange(
  lastStageChangeAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastStageChangeAt) return false;
  const t = new Date(lastStageChangeAt).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= HL_STAGE_CHANGE_FRESH_MS && t <= now.getTime();
}
