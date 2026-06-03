/**
 * Monthly content-schedule planner (Sprint 16, Deliverable C).
 *
 * The hard orchestration piece. This module owns the PURE planning logic — it
 * takes the jobs expected to complete in a month plus recent posting history and
 * returns a balanced, dated batch of planned posts. The route layer
 * (src/routes/content-schedules.ts) does the IO: it queries the jobs, drives
 * Claude per planned post (Deliverable B), writes the batch into `social_posts`
 * as `pending_approval`, and creates the `content_schedules` row set to active.
 *
 * Linkage to a schedule is by month/year (the `v_content_schedule_counts` view
 * joins on strftime(scheduled_date) = cs.month/year). There is NO schedule_id FK
 * on social_posts and this sprint does not add one.
 *
 * Balancing rules (spec §3 + business rule #3 "schedule is a suggestion"):
 *   - target 3–4 posts/week,
 *   - job-completion posts land on the job's real completion date (only jobs
 *     WITH social-ready photos; others are skipped and the owner is notified),
 *   - seasonal (2–4) + tips (2–3) are spread across the month so no single week
 *     is nothing but job-completions and the feed isn't clustered.
 */

import type { PostType } from "./social.js";

export interface SchedulableJob {
  id: string;
  jobType: string | null;
  /** ISO date (YYYY-MM-DD...) the job is expected to / did complete. */
  completionDate: string;
  hasSocialReady: boolean;
}

export interface PlanInput {
  month: number; // 1–12
  year: number;
  jobs: SchedulableJob[];
  /** Recently-used scheduled_date day-strings, to nudge spacing (optional). */
  recentPostDates?: string[];
  targetPerWeek?: number;
}

export interface PlannedPost {
  post_type: PostType;
  /** ISO datetime, e.g. 2026-06-14T18:00:00. */
  scheduled_date: string;
  job_id: string | null;
  /** Topic for non-job posts (drives caption + image generation). */
  topic: string | null;
  season: string | null;
  /** Whether this non-job post should attempt AI image generation. */
  wants_image: boolean;
}

export interface PlanResult {
  posts: PlannedPost[];
  /** Job ids skipped because they had no social-ready photos (owner notified). */
  skippedJobs: string[];
}

const SEASONAL_TOPICS: Record<string, string[]> = {
  winter: [
    "winterizing your home and preventing frozen pipes",
    "cozy winter remodel ideas to beat the cold",
    "sealing drafts and improving winter energy efficiency",
  ],
  spring: [
    "spring home refresh and exterior touch-ups",
    "planning a spring remodel before the busy season",
    "spring maintenance checklist for Arkansas homeowners",
  ],
  summer: [
    "beat-the-heat summer home upgrades",
    "outdoor living and deck/patio projects for summer",
    "summer energy-saving home improvements",
  ],
  fall: [
    "fall home maintenance before winter hits",
    "fall remodel projects to finish before the holidays",
    "gutter and roof checks for the rainy season",
  ],
};

const TIPS_TOPICS = [
  "choosing durable finishes that last",
  "how to budget for a remodel without surprises",
  "questions to ask before hiring a contractor",
  "small upgrades that add the most home value",
  "signs it's time to renovate vs. repair",
  "planning a kitchen layout that actually works",
];

export function seasonForMonth(month: number): string {
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "fall";
}

function daysInMonth(month: number, year: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0-based week bucket for a day-of-month (0..~4). */
function weekOf(day: number): number {
  return Math.floor((day - 1) / 7);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function iso(year: number, month: number, day: number, hour: number): string {
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:00:00`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Produce a balanced, dated batch for the given month. Deterministic so it's
 * unit-testable: same input → same plan.
 */
export function planSchedule(input: PlanInput): PlanResult {
  const { month, year } = input;
  const targetPerWeek = input.targetPerWeek ?? 3;
  const dim = daysInMonth(month, year);
  const weekCount = Math.ceil(dim / 7); // typically 5

  const perWeekCount: number[] = new Array(weekCount).fill(0);
  const perWeekJob: number[] = new Array(weekCount).fill(0);
  const perWeekNonJob: number[] = new Array(weekCount).fill(0);
  const usedDays = new Set<number>();
  const posts: PlannedPost[] = [];
  const skippedJobs: string[] = [];
  const season = seasonForMonth(month);

  // 1) Job-completion posts on their real completion dates (social-ready only).
  for (const job of input.jobs) {
    if (!job.hasSocialReady) {
      skippedJobs.push(job.id);
      continue;
    }
    const day = dayInMonth(job.completionDate, month, year);
    if (day == null) continue; // completion outside the month → not this schedule
    posts.push({
      post_type: "job_completion",
      scheduled_date: iso(year, month, day, 18),
      job_id: job.id,
      topic: null,
      season: null,
      wants_image: false,
    });
    perWeekCount[weekOf(day)]++;
    perWeekJob[weekOf(day)]++;
    usedDays.add(day);
  }

  // 2) How many non-job posts to add — fill each week toward the target, then
  //    clamp to the spec's seasonal(2–4) + tips(2–3) envelope (4–7 total).
  let deficit = 0;
  for (let w = 0; w < weekCount; w++) deficit += Math.max(0, targetPerWeek - perWeekCount[w]);
  const nonJobTotal = clamp(deficit, 4, 7);
  let seasonalCount = clamp(Math.round(nonJobTotal * 0.55), 2, 4);
  let tipsCount = clamp(nonJobTotal - seasonalCount, 2, 3);
  // Re-balance if clamping pushed the sum off.
  while (seasonalCount + tipsCount < nonJobTotal && (seasonalCount < 4 || tipsCount < 3)) {
    if (seasonalCount < 4) seasonalCount++;
    else if (tipsCount < 3) tipsCount++;
  }

  // 3) Place non-job posts into the most under-filled week first (greedy),
  //    alternating type so seasonal/tips interleave across the month.
  const queue: { post_type: PostType; topic: string; wants_image: boolean }[] = [];
  const seasonalPool = SEASONAL_TOPICS[season];
  for (let i = 0; i < seasonalCount; i++) {
    queue.push({
      post_type: "seasonal_tips",
      topic: seasonalPool[i % seasonalPool.length],
      wants_image: true,
    });
  }
  for (let i = 0; i < tipsCount; i++) {
    queue.push({
      post_type: "tips_tricks",
      topic: TIPS_TOPICS[i % TIPS_TOPICS.length],
      wants_image: true,
    });
  }
  // Interleave seasonal/tips for a varied feed.
  queue.sort((a, b) => (a.post_type === b.post_type ? 0 : a.post_type === "seasonal_tips" ? -1 : 1));
  const interleaved = interleaveByType(queue);

  let hourToggle = 0;
  for (const item of interleaved) {
    const w = placeNonJobWeek(perWeekCount, perWeekJob, perWeekNonJob, weekCount, targetPerWeek + 1);
    const day = pickDay(w, weekCount, dim, usedDays);
    usedDays.add(day);
    perWeekCount[w]++;
    perWeekNonJob[w]++;
    posts.push({
      post_type: item.post_type,
      // Alternate morning (08:00) / evening (18:00) optimal windows.
      scheduled_date: iso(year, month, day, hourToggle++ % 2 === 0 ? 8 : 18),
      job_id: null,
      topic: item.topic,
      season: item.post_type === "seasonal_tips" ? season : null,
      wants_image: item.wants_image,
    });
  }

  posts.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
  return { posts, skippedJobs };
}

/** Map an ISO date to its day-of-month, or null if it's in another month. */
function dayInMonth(isoDate: string, month: number, year: number): number | null {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  if (Number(m[1]) !== year || Number(m[2]) !== month) return null;
  const day = Number(m[3]);
  return day >= 1 && day <= 31 ? day : null;
}

/**
 * Choose the week for the next non-job post. De-clusters first: a week that has
 * job-completions but NO non-job post yet (and room) gets the post, so no week
 * ends up being exclusively job-completions. Otherwise fall back to the
 * least-filled week.
 */
function placeNonJobWeek(
  perWeekCount: number[],
  perWeekJob: number[],
  perWeekNonJob: number[],
  weekCount: number,
  cap: number,
): number {
  let target = -1;
  for (let w = 0; w < weekCount; w++) {
    if (perWeekJob[w] >= 1 && perWeekNonJob[w] === 0 && perWeekCount[w] < cap) {
      // Prefer the most-clustered such week (most job posts).
      if (target === -1 || perWeekJob[w] > perWeekJob[target]) target = w;
    }
  }
  if (target !== -1) return target;
  return leastFilledWeek(perWeekCount, weekCount);
}

function leastFilledWeek(perWeekCount: number[], weekCount: number): number {
  let best = 0;
  for (let w = 1; w < weekCount; w++) {
    if (perWeekCount[w] < perWeekCount[best]) best = w;
  }
  return best;
}

/** Pick an unused day within week `w`; widen the search if the week is full. */
function pickDay(w: number, weekCount: number, dim: number, used: Set<number>): number {
  const start = w * 7 + 1;
  const end = Math.min(start + 6, dim);
  // Prefer mid-week (Tue–Thu-ish) days that are free.
  const order = [3, 4, 2, 5, 1, 6, 7].map((off) => start + off - 1).filter((d) => d <= end);
  for (const d of order) if (!used.has(d)) return d;
  // Week full — scan the whole month for any free day.
  for (let d = 1; d <= dim; d++) if (!used.has(d)) return d;
  return start; // pathological fallback
}

/** Round-robin the two non-job types so the feed alternates. */
function interleaveByType<T extends { post_type: PostType }>(items: T[]): T[] {
  const seasonal = items.filter((i) => i.post_type === "seasonal_tips");
  const tips = items.filter((i) => i.post_type === "tips_tricks");
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < seasonal.length || j < tips.length) {
    if (i < seasonal.length) out.push(seasonal[i++]);
    if (j < tips.length) out.push(tips[j++]);
  }
  return out;
}
