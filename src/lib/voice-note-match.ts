/**
 * Sprint 33 voice-note → job matching. Shared by /api/voice-notes and
 * consolidated New Note (/api/smart-notes with auto_match_job).
 * Keep the prompt/logic here so both paths stay identical.
 */

import type { Env } from "../env.js";
import { claudeMessages } from "./claude.js";

const ACTIVE_JOB_STATUSES = ["deposit_paid", "scheduled", "in_progress", "punch_list"] as const;

export interface ActiveJobForMatch {
  id: string;
  title: string | null;
  client_name: string | null;
  property_address: string | null;
}

export async function loadActiveJobsForMatch(env: Env): Promise<ActiveJobForMatch[]> {
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.title, j.property_address,
            COALESCE(c.first_name || ' ' || c.last_name, c.name) AS client_name
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
      WHERE j.status IN (${ACTIVE_JOB_STATUSES.map(() => "?").join(",")})
      ORDER BY j.updated_at DESC
      LIMIT 50`,
  )
    .bind(...ACTIVE_JOB_STATUSES)
    .all<ActiveJobForMatch>();
  return results ?? [];
}

export async function matchJobFromTranscript(
  env: Env,
  transcript: string,
  activeJobs: ActiveJobForMatch[],
): Promise<string | null> {
  if (activeJobs.length === 0) return null;

  const jobList = activeJobs
    .map(
      (j) =>
        `- ID: ${j.id} | Title: ${j.title ?? ""} | Client: ${j.client_name ?? ""} | Address: ${j.property_address ?? ""}`,
    )
    .join("\n");

  const prompt = `You are helping match a field voice note to a construction job.

Active jobs:
${jobList}

Voice note transcript:
"${transcript}"

If the note clearly refers to one of the jobs above, return ONLY the job ID.
If you cannot confidently match a job, return ONLY the word "UNMATCHED".`;

  const call = await claudeMessages(env, {
    system: "Return only a job ID or the word UNMATCHED. No other text.",
    messages: [{ role: "user", content: prompt }],
    maxTokens: 100,
    model: "claude-sonnet-4-6",
  });

  if (!call.ok || !call.text) return null;

  const answer = call.text.trim();
  if (answer.toUpperCase() === "UNMATCHED") return null;

  const matched = activeJobs.find((j) => j.id === answer);
  return matched?.id ?? null;
}
