/**
 * Behavioral checks for a complete Jobber import on the release line.
 * The replay fixture starts #110 in_progress, matching the Oct 7 snapshot.
 * These tests move it to complete the way the status handler does.
 */
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { formatDatePlusFiveYears } from "../src/lib/document-generator.js";
import { warrantyExpirationDate } from "../src/lib/invoicing.js";
import { ensureJobPortalToken } from "../src/lib/job-portal-token.js";
import { handleJobDetail, handleJobList, handleJobPipeline, handleJobStatus } from "../src/routes/jobs-api.js";
import { correctionStatements } from "../scripts/jobber-import/correct-imported-status.js";
import { JOB_106, OWNER, openProductionReplay } from "./production-replay-db.js";

const JOB_110 = "ba9f5359-d69f-45ed-a086-61dbb547a28d";
const JOB_102 = "d53d33c9-2e62-403f-8bcc-29fc0b0779e7";
const JOB_91 = "Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=";
const JOB_108 = "590bfb77-a786-424b-ae1a-2917e75752fc";
const JOB_107 = "0f80002e-29e6-4eb4-8021-ab67ee81f086";
const JOB_109 = "99190438-f0a8-4d36-ae78-f8b19a805931";
const JOB_111 = "17522999-ad05-427d-9f5a-6428ed4b506e";
const JOB_105 = "8fb106bc-321b-4342-bbd4-d31bc26318e2";

let env: Env;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const replay = await openProductionReplay();
  env = replay.env;
  dispose = replay.dispose;
});

afterAll(async () => {
  await dispose();
});

function statusRequest(id: string): Request {
  return new Request(`http://replay.local/api/jobs/${id}/status`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "Cf-Access-Authenticated-User-Email": OWNER,
    },
    body: JSON.stringify({ status: "complete" }),
  });
}

function fakeCtx(waited: Promise<unknown>[]): ExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      waited.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;
}

type Card = {
  id: string;
  job_number: number;
  status: string | null;
  client_name: string | null;
  title: string | null;
  payments_received: number;
  source: string | null;
};

async function listJobs(url = "http://replay.local/api/jobs"): Promise<Card[]> {
  const res = await handleJobList(env, new URL(url));
  const body = (await res.json()) as { jobs: Card[] };
  return body.jobs;
}

describe("complete import stays visible", () => {
  it("shows #110 on the board, list, search, and detail after it is marked complete", async () => {
    const waited: Promise<unknown>[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    let res: Response;
    try {
      res = await handleJobStatus(statusRequest(JOB_110), env, JOB_110, fakeCtx(waited));
    } finally {
      console.log = log;
      console.error = error;
    }
    expect(res!.status).toBe(200);
    expect(waited).toEqual([]);
    expect(logs.join("\n")).not.toContain(`[wc] job_status_changed job=${JOB_110}`);
    expect(logs.join("\n")).not.toContain(`[AUTOTRIGGER] jobs-api complete — jobId=${JOB_110}`);
    expect(errors.join("\n")).not.toContain("maybeGenerateJobCompletionPost");
    expect(errors.join("\n")).not.toContain("[AUTOTRIGGER] FAILED");

    const detail = (await (await handleJobDetail(env, JOB_110)).json()) as {
      job: { job_number: number; status: string; client_name: string; actual_end_date: string; source: string };
    };
    expect(detail.job).toMatchObject({
      job_number: 110,
      status: "complete",
      client_name: "Alicia Johnson",
      source: "jobber_import",
    });
    expect(detail.job.actual_end_date.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const pipeline = (await (await handleJobPipeline(env)).json()) as {
      pipeline: Record<string, Card[]>;
      cancelled: Card[];
    };
    expect(pipeline.pipeline.complete.map((card) => card.job_number)).toContain(110);
    expect(pipeline.pipeline.complete.find((card) => card.job_number === 110)?.client_name).toBe("Alicia Johnson");

    const listed = await listJobs();
    expect(listed.find((card) => card.id === JOB_110)?.status).toBe("complete");
    expect(listed.map((card) => card.id)).not.toContain(JOB_91);
    expect(listed.map((card) => card.id)).not.toContain(JOB_108);

    const search = await listJobs("http://replay.local/api/jobs?q=alicia");
    expect(search.map((card) => card.job_number)).toEqual([110]);

    const docs = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_documents").first<{ n: number }>();
    const notes = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_logs").first<{ n: number }>();
    expect(docs?.n).toBe(0);
    expect(notes?.n).toBe(0);
  });

  it("still fires completion side effects for a native job", async () => {
    const waited: Promise<unknown>[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const res = await handleJobStatus(statusRequest(JOB_102), env, JOB_102, fakeCtx(waited));
      await Promise.all(waited);
      expect(res.status).toBe(200);
    } finally {
      console.log = log;
      console.error = error;
    }
    const text = logs.join("\n");
    expect(text).toContain(`[wc] job_status_changed job=${JOB_102}`);
    expect(text).toContain(`[AUTOTRIGGER] jobs-api complete — jobId=${JOB_102}`);
    expect(text).toContain(`[AUTOTRIGGER] maybeAutoGenerateDocument START — job=${JOB_102} type=warranty_certificate`);
    expect(errors.join("\n")).toContain("maybeGenerateJobCompletionPost");
    const row = await env.DB.prepare("SELECT status, source FROM jobs WHERE id = ?")
      .bind(JOB_102)
      .first<{ status: string; source: string }>();
    expect(row).toEqual({ status: "complete", source: "estimate" });
  });

  it("lists cancelled #106 with the $400 payment and leaves late and archived off that list", async () => {
    const pipeline = (await (await handleJobPipeline(env)).json()) as { cancelled: Card[] };
    const numbers = pipeline.cancelled.map((card) => card.job_number);
    expect(numbers).toContain(106);
    expect(numbers).not.toContain(91);
    expect(numbers).not.toContain(108);
    const clayton = pipeline.cancelled.find((card) => card.id === JOB_106);
    expect(clayton).toMatchObject({
      job_number: 106,
      client_name: "Clayton Price",
      payments_received: 400,
      status: "cancelled",
    });
    const cancelled = await listJobs("http://replay.local/api/jobs?status=cancelled");
    expect(cancelled.map((card) => card.job_number)).toEqual([106]);
  });
});

describe("warranty term and portal token on package send", () => {
  it("computes October 22, 2031 from Alicia's completion date", () => {
    expect(warrantyExpirationDate("2026-10-22")).toBe("2031-10-22");
    expect(formatDatePlusFiveYears("2026-10-22")).toBe("October 22, 2031");
  });

  it("mints a portal token once and keeps an existing token", async () => {
    const first = await ensureJobPortalToken(env.DB, JOB_110, null);
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    const stored = await env.DB.prepare("SELECT portal_token FROM jobs WHERE id = ?")
      .bind(JOB_110)
      .first<{ portal_token: string }>();
    expect(stored?.portal_token).toBe(first);
    const second = await ensureJobPortalToken(env.DB, JOB_110, first);
    expect(second).toBe(first);
    const kept = await ensureJobPortalToken(env.DB, JOB_106, "already-there");
    expect(kept).toBe("already-there");
    const clayton = await env.DB.prepare("SELECT portal_token FROM jobs WHERE id = ?")
      .bind(JOB_106)
      .first<{ portal_token: string | null }>();
    expect(clayton?.portal_token).toBeNull();
  });
});

describe("imported status correction against the replay", () => {
  async function apply(): Promise<void> {
    for (const statement of correctionStatements()) {
      await env.DB.prepare(statement.replace(/;\s*$/, "")).run();
    }
  }

  it("applies once, leaves dates null, and does nothing the second time", async () => {
    await apply();
    const rows = await env.DB.prepare(
      `SELECT id, status, actual_end_date, start_date FROM jobs WHERE id IN (?, ?, ?, ?, ?, ?)`,
    )
      .bind(JOB_107, JOB_109, JOB_111, JOB_105, JOB_106, JOB_110)
      .all<{ id: string; status: string; actual_end_date: string | null; start_date: string | null }>();
    const byId = new Map((rows.results ?? []).map((row) => [row.id, row]));
    expect(byId.get(JOB_107)).toMatchObject({ status: "complete", actual_end_date: null, start_date: null });
    expect(byId.get(JOB_109)).toMatchObject({ status: "complete", actual_end_date: null, start_date: null });
    expect(byId.get(JOB_111)).toMatchObject({ status: "scheduled", actual_end_date: null, start_date: null });
    expect(byId.get(JOB_105)?.status).toBe("action_required");
    expect(byId.get(JOB_106)?.status).toBe("cancelled");
    expect(byId.get(JOB_110)?.status).toBe("complete");

    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE user_email = 'correction-script'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(3);

    await apply();
    const again = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE user_email = 'correction-script'",
    ).first<{ n: number }>();
    expect(again?.n).toBe(3);

    const visible = await listJobs();
    expect(visible.map((card) => card.job_number).sort((a, b) => a - b)).toEqual(
      expect.arrayContaining([105, 107, 109, 110, 111]),
    );
    expect(visible.map((card) => card.id)).not.toContain(JOB_91);
    expect(visible.map((card) => card.id)).not.toContain(JOB_108);
  });

  it("refuses --remote and --apply", () => {
    const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
    const script = new URL("../scripts/jobber-import/correct-imported-status.ts", import.meta.url).pathname;
    const remote = spawnSync(tsx, [script, "--remote"], { encoding: "utf8" });
    expect(remote.status).toBe(1);
    expect(remote.stderr).toContain("Refusing to run against remote");
    const applyFlag = spawnSync(tsx, [script, "--apply"], { encoding: "utf8" });
    expect(applyFlag.status).toBe(1);
    expect(applyFlag.stderr).toContain("Refusing --apply");
  });
});
