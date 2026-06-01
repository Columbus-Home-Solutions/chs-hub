/**
 * Job costing endpoint (Sprint 10).
 *
 *   GET /api/jobs/:id/costing   budget (estimate sub-items → parents) vs. actual
 *                               (aligned expenses + time-entry labor + subs),
 *                               per-line variance + color, Unallocated bucket.
 *
 * Read endpoint (host-gated like the rest); the Financial tab gates the costing
 * section to O/PM client-side (business rule #9). The actuals math lives in the
 * reusable src/lib/job-costing.ts helper that Sprint 11 cost-plus reconciliation
 * will call with a date window.
 */

import type { Env } from "../env.js";
import { buildJobCosting } from "../lib/job-costing.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
}

export async function handleJobCosting(env: Env, jobId: string): Promise<Response> {
  const job = await env.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string }>();
  if (!job) return json({ error: "not_found", message: "Job not found." }, { status: 404 });
  const costing = await buildJobCosting(env, jobId);
  return json({ costing });
}
