/**
 * Weekly client recap generator (Sprint 38 Run 2).
 *
 * Generates a 3-5 sentence homeowner-friendly recap of the week's activity on
 * a given job, grounded strictly in real queried data (daily logs, schedule
 * entries, photo count). For cost-plus jobs only, includes a budget note.
 *
 * Uses the CLAUDE_MODEL constant from claude.ts — configurable, not hardcoded.
 * Fails gracefully: if Claude is unavailable or data is sparse, returns a
 * plain-language "quiet week" fallback rather than fabricating detail.
 */

import type { Env } from "../env.js";
import { claudeMessages, CLAUDE_MODEL } from "./claude.js";

interface DailyLogRow {
  log_date: string;
  work_performed: string;
  issues: string | null;
  materials_used: string | null;
}

interface ScheduleRow {
  scheduled_date: string;
  trade_or_work: string;
  status: string;
}

interface BudgetSnapshot {
  projected_total: number | null;
  actual_total: number | null;
  cycle_status: string;
}

export interface WeeklyRecapInput {
  jobId: string;
  jobTitle: string;
  weekStart: string; // ISO date YYYY-MM-DD (Monday of the week)
  weekEnd: string;   // ISO date YYYY-MM-DD (Sunday of the week)
  photoCount: number;
  isCostPlus: boolean;
}

const SYSTEM_PROMPT = `You are a project update writer for Columbus Home Solutions, a residential contractor in central Arkansas. 
Write a brief, friendly weekly update for a homeowner about progress on their project this week.

Rules:
- Write exactly 3-5 sentences in plain, conversational language. No construction jargon.
- Ground every sentence in the data provided. Do NOT invent activity, timelines, or materials not in the data.
- If the week was quiet with little data, acknowledge it warmly — e.g. "It was a lighter week on your project…" or "Your project is moving along steadily…"
- Never mention specific dollar amounts, percentages, or budget figures unless the budget section is explicitly provided.
- Do not use bullet points, headers, or markdown. Just clean prose.
- End with something forward-looking if there is upcoming schedule data, or a brief reassurance if not.
- Keep the tone warm and professional — imagine updating a neighbor, not writing a legal document.`;

function formatCurrency(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function buildUserPrompt(
  input: WeeklyRecapInput,
  logs: DailyLogRow[],
  schedule: ScheduleRow[],
  budget: BudgetSnapshot | null,
): string {
  const parts: string[] = [];

  parts.push(`Project: ${input.jobTitle}`);
  parts.push(`Week: ${input.weekStart} through ${input.weekEnd}`);
  parts.push(`Photos taken this week: ${input.photoCount}`);

  if (logs.length > 0) {
    parts.push("\nDAILY LOG ENTRIES THIS WEEK:");
    for (const log of logs) {
      let entry = `- ${log.log_date}: ${log.work_performed}`;
      if (log.materials_used) entry += ` (materials: ${log.materials_used})`;
      if (log.issues) entry += ` [note: ${log.issues}]`;
      parts.push(entry);
    }
  } else {
    parts.push("\nDAILY LOG ENTRIES THIS WEEK: None recorded.");
  }

  const completedWork = schedule.filter((s) => s.status === "completed");
  const upcomingWork = schedule.filter((s) => s.status !== "completed" && s.scheduled_date > input.weekEnd);
  const thisWeekScheduled = schedule.filter((s) => s.scheduled_date >= input.weekStart && s.scheduled_date <= input.weekEnd);

  if (thisWeekScheduled.length > 0 || upcomingWork.length > 0) {
    parts.push("\nSCHEDULE:");
    for (const s of thisWeekScheduled) {
      parts.push(`- ${s.scheduled_date} (${s.status}): ${s.trade_or_work}`);
    }
    if (upcomingWork.length > 0) {
      parts.push("\nUPCOMING SCHEDULED WORK:");
      for (const s of upcomingWork.slice(0, 3)) {
        parts.push(`- ${s.scheduled_date}: ${s.trade_or_work}`);
      }
    }
  } else {
    parts.push("\nSCHEDULE: No schedule entries this week.");
  }

  // Budget info is ONLY included for cost-plus jobs
  if (input.isCostPlus && budget) {
    const projected = budget.projected_total ?? 0;
    const actual = budget.actual_total ?? 0;
    if (projected > 0) {
      const delta = actual - projected;
      const sign = delta > 0 ? "above" : delta < 0 ? "below" : "on track with";
      const absDelta = Math.abs(delta);
      parts.push(
        `\nBUDGET (open-book project): This billing cycle is ${sign} the projected total${absDelta > 0 ? ` by ${formatCurrency(absDelta)}` : ""}. Projected: ${formatCurrency(projected)}. Actual to date: ${formatCurrency(actual)}.`,
      );
    }
  }

  parts.push(
    "\nWrite the homeowner update now — 3 to 5 sentences, plain prose, no markdown, no invented detail:",
  );

  return parts.join("\n");
}

export async function generateWeeklyRecap(
  env: Env,
  input: WeeklyRecapInput,
): Promise<string> {
  const fallback = `Your project is progressing this week${input.photoCount > 0 ? ` — we added ${input.photoCount} new photo${input.photoCount === 1 ? "" : "s"} to your portal` : ""}. We'll keep you updated as work continues. Check the link below to see the latest.`;

  // ── Query daily logs for the week ────────────────────────────────────────
  const logsResult = await env.DB.prepare(
    `SELECT log_date, work_performed, issues, materials_used
       FROM daily_logs
      WHERE job_id = ?
        AND log_date >= ? AND log_date <= ?
      ORDER BY log_date ASC`,
  )
    .bind(input.jobId, input.weekStart, input.weekEnd)
    .all<DailyLogRow>()
    .catch(() => ({ results: [] as DailyLogRow[] }));
  const logs = logsResult.results ?? [];

  // ── Query schedule entries for the week (and upcoming) ──────────────────
  // Window: from weekStart to 14 days out (captures upcoming work in the prompt)
  const twoWeeksOut = new Date(new Date(input.weekEnd + "T00:00:00Z").getTime() + 14 * 86400000)
    .toISOString()
    .slice(0, 10);
  const schedResult = await env.DB.prepare(
    `SELECT scheduled_date, trade_or_work, status
       FROM schedule_entries
      WHERE job_id = ?
        AND scheduled_date >= ? AND scheduled_date <= ?
      ORDER BY scheduled_date ASC`,
  )
    .bind(input.jobId, input.weekStart, twoWeeksOut)
    .all<ScheduleRow>()
    .catch(() => ({ results: [] as ScheduleRow[] }));
  const schedule = schedResult.results ?? [];

  // ── Query budget snapshot (cost-plus only) ───────────────────────────────
  let budget: BudgetSnapshot | null = null;
  if (input.isCostPlus) {
    // Get the most recent open/active billing cycle
    budget = await env.DB.prepare(
      `SELECT projected_total, actual_total, status AS cycle_status
         FROM billing_cycles
        WHERE job_id = ?
          AND status IN ('open', 'active', 'closed')
        ORDER BY cycle_number DESC LIMIT 1`,
    )
      .bind(input.jobId)
      .first<BudgetSnapshot>()
      .catch(() => null);
  }

  // ── Check if there's enough data to generate a meaningful recap ──────────
  const hasAnyData = logs.length > 0 || schedule.length > 0 || input.photoCount > 0;
  if (!hasAnyData) {
    return `It was a quieter week on your project — no logged activity to report. Our team is working to keep things moving, and we'll update you as soon as there's more to share. Check the link below any time you want to see your project portal.`;
  }

  // ── Build the prompt and call Claude ─────────────────────────────────────
  const userPrompt = buildUserPrompt(input, logs, schedule, budget);

  const result = await claudeMessages(env, {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 300,
    model: CLAUDE_MODEL,
  });

  if (!result.ok || !result.text) {
    console.warn(
      `[weekly_recap] Claude unavailable for job ${input.jobId}: ${result.error ?? "no text"}`,
    );
    return fallback;
  }

  // Sanity: strip any accidental markdown the model returned
  const cleaned = result.text.replace(/^#+\s+/gm, "").replace(/\*\*/g, "").replace(/\*/g, "").trim();
  return cleaned || fallback;
}
