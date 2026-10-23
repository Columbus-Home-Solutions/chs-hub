/**
 * Legacy Jobber rows keep a historical `source` and only
 * `data_source = 'jobber_import'`. Completing one must stay as quiet as a
 * row whose `source` is already `jobber_import`. A person can still send a
 * review by hand. Native jobs still run the completion side effects.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { jobberQuietSendBlock } from "../src/lib/jobber-board.js";
import { sendImmediateReviewRequest } from "../src/lib/review-followups.js";
import { handleJobStatus } from "../src/routes/jobs-api.js";
import { OWNER, openProductionReplay } from "./production-replay-db.js";

const LEGACY = "aaaaaaaa-aaaa-4aaa-8aaa-000000000078";
const SOURCE_ONLY = "aaaaaaaa-aaaa-4aaa-8aaa-000000000096";
const NATIVE = "aaaaaaaa-aaaa-4aaa-8aaa-000000000102";
const CLIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000000c1";

let env: Env;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const replay = await openProductionReplay();
  env = replay.env;
  dispose = replay.dispose;
  await env.DB.prepare(
    `INSERT INTO clients (id, name, first_name, last_name, phone, email, is_test)
     VALUES (?, 'ZZTEST Quiet', 'ZZTEST', 'Quiet', '5555550199', NULL, 1)`,
  )
    .bind(CLIENT)
    .run();
  const jobs = [
    { id: LEGACY, num: 99078, source: "GQL_API", dataSource: "jobber_import" },
    { id: SOURCE_ONLY, num: 99096, source: "jobber_import", dataSource: null },
    { id: NATIVE, num: 99102, source: "estimate", dataSource: null },
  ];
  for (const job of jobs) {
    await env.DB.prepare(
      `INSERT INTO jobs (
        id, job_number, title, status, client_id, billing_model, job_type, source, data_source,
        property_city, property_state, deposit_amount, deposit_paid,
        conversion_complete, conversion_reversed, created_at, updated_at
      ) VALUES (?, ?, 'ZZTEST quiet completion', 'in_progress', ?, 'fixed', 'remodel', ?, ?, 'Conway', 'AR', 0, 0, 1, 0, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    )
      .bind(job.id, job.num, CLIENT, job.source, job.dataSource)
      .run();
  }
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

async function complete(id: string): Promise<{ status: number; waited: Promise<unknown>[]; logs: string[] }> {
  const waited: Promise<unknown>[] = [];
  const logs: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  let res: Response;
  try {
    res = await handleJobStatus(statusRequest(id), env, id, fakeCtx(waited));
  } finally {
    console.log = log;
    console.error = error;
  }
  return { status: res!.status, waited, logs };
}

async function count(sql: string, id: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(id).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("legacy import source stays quiet on complete", () => {
  it("completes a data_source import with a legacy source and fires nothing", async () => {
    const result = await complete(LEGACY);
    expect(result.status).toBe(200);
    expect(result.waited).toEqual([]);
    expect(result.logs.join("\n")).not.toContain("[wc] job_status_changed");
    expect(result.logs.join("\n")).not.toContain("[AUTOTRIGGER]");
    const status = await env.DB.prepare("SELECT status, actual_end_date FROM jobs WHERE id = ?")
      .bind(LEGACY)
      .first<{ status: string; actual_end_date: string | null }>();
    expect(status?.status).toBe("complete");
    expect(status?.actual_end_date).toBeTruthy();
    expect(await count("SELECT COUNT(*) AS n FROM job_documents WHERE job_id = ?", LEGACY)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM notification_logs WHERE job_id = ?", LEGACY)).toBe(0);
    expect(await jobberQuietSendBlock(env, LEGACY)).toBeNull();
  });

  it("still stays quiet when source itself is jobber_import", async () => {
    const result = await complete(SOURCE_ONLY);
    expect(result.status).toBe(200);
    expect(result.waited).toEqual([]);
    expect(result.logs.join("\n")).not.toContain("[AUTOTRIGGER]");
    expect(await count("SELECT COUNT(*) AS n FROM job_documents WHERE job_id = ?", SOURCE_ONLY)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM notification_logs WHERE job_id = ?", SOURCE_ONLY)).toBe(0);
  });

  it("still fires completion side effects for a native estimate job", async () => {
    const result = await complete(NATIVE);
    expect(result.status).toBe(200);
    expect(result.waited.length).toBe(1);
    expect(result.logs.join("\n")).toContain(`[wc] job_status_changed job=${NATIVE}`);
    expect(result.logs.join("\n")).toContain(`[AUTOTRIGGER] jobs-api complete — jobId=${NATIVE}`);
    await Promise.allSettled(result.waited);
  });

  it("still sends a manual review request on a completed legacy import", async () => {
    await env.DB.prepare("ALTER TABLE jobs ADD COLUMN review_enabled INTEGER DEFAULT 1").run();
    await env.DB.prepare("ALTER TABLE clients ADD COLUMN notification_preferences TEXT").run();
    await env.DB.prepare(
      "CREATE TABLE google_reviews (id TEXT PRIMARY KEY, matched_client_id TEXT, match_confidence TEXT)",
    ).run();
    await env.DB.prepare(
      "CREATE TABLE notification_templates (id TEXT PRIMARY KEY, body_template TEXT, subject TEXT)",
    ).run();
    for (const column of [
      "template_id",
      "recipient_type",
      "recipient_name",
      "recipient_contact",
      "channel",
      "subject",
      "body",
      "status",
      "dedupe_key",
      "sent_at",
    ]) {
      await env.DB.prepare(`ALTER TABLE notification_logs ADD COLUMN ${column} TEXT`).run();
    }
    await env.DB.prepare(
      `INSERT INTO notification_templates (id, body_template, subject)
       VALUES ('tmpl-google-review-request-sms', 'Hi {{client_first_name}}', NULL)`,
    ).run();
    await env.DB.prepare("UPDATE jobs SET review_enabled = 1 WHERE id = ?").bind(LEGACY).run();

    await sendImmediateReviewRequest(env, LEGACY, CLIENT);

    const logged = await env.DB.prepare(
      `SELECT trigger_event, channel, status, recipient_contact
         FROM notification_logs WHERE job_id = ?`,
    )
      .bind(LEGACY)
      .all<{ trigger_event: string; channel: string; status: string; recipient_contact: string }>();
    expect(logged.results).toEqual([
      {
        trigger_event: "google_review_request",
        channel: "sms",
        status: "simulated",
        recipient_contact: "5555550199",
      },
    ]);
  });
});
