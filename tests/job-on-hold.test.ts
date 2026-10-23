/**
 * On hold is a list status, not a board column. Hold and release are
 * owner-only and do not run the status-change machine.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { Env } from "../src/env.js";
import { CUSTOMER_AUTOMATION_EVENTS, customerFacingJobStatus } from "../src/lib/job-hold.js";
import { triggerNotification } from "../src/lib/notification-engine.js";
import { processReviewFollowUps, sendImmediateReviewRequest } from "../src/lib/review-followups.js";
import { handleExpenseCreateJson } from "../src/routes/expenses.js";
import { handleInvoiceCreate } from "../src/routes/invoices.js";
import { handleJobHealth } from "../src/routes/job-health.js";
import {
  handleJobHold,
  handleJobList,
  handleJobPipeline,
  handleJobRelease,
  handleJobStatus,
  handleJobUpdate,
} from "../src/routes/jobs-api.js";
import { handleNoteCreate } from "../src/routes/notes.js";
import { JOB_105, OWNER, openProductionReplay } from "./production-replay-db.js";

const JOB_102 = "d53d33c9-2e62-403f-8bcc-29fc0b0779e7";

const PM = "pm-hold@homesolutionsar.com";
const CLIENT = "23933c84-e62a-4748-9928-857bf6d464ac";

let env: Env;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const replay = await openProductionReplay();
  env = replay.env;
  dispose = replay.dispose;
  await env.DB.prepare(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active)
     VALUES ('pm-hold', ?, 'Pat', 'Manager', 'project_manager', 1)`,
  ).bind(PM).run();
  await env.DB.prepare(
    `INSERT INTO jobs (id, job_number, title, status, source, client_id, created_at, actual_end_date)
     VALUES
       ('hold-complete', 9101, 'Finished work', 'complete', 'estimate', ?, '2026-01-01', '2026-01-02'),
       ('hold-closed', 9102, 'Closed work', 'closed', 'estimate', ?, '2026-01-01', NULL),
       ('hold-cancelled', 9103, 'Cancelled work', 'cancelled', 'jobber_import', ?, '2026-01-01', NULL),
       ('hold-archived', 9104, 'Archived work', 'archived', 'jobber_import', ?, '2026-01-01', NULL),
       ('hold-quick', 9105, 'Quick hold', 'scheduled', 'quick_job', ?, '2026-01-01', NULL)`,
  ).bind(CLIENT, CLIENT, CLIENT, CLIENT, CLIENT).run();
  await env.DB.prepare("ALTER TABLE jobs ADD COLUMN notes TEXT").run();
  await env.DB.prepare(
    `CREATE TABLE notes (
      id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, category TEXT, raw_text TEXT,
      summary TEXT, tags TEXT, tasks_extracted TEXT, task_count INTEGER, status TEXT,
      archived_at TEXT, meeting_source TEXT, job_id TEXT
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE expenses (
      id TEXT PRIMARY KEY, job_id TEXT, amount REAL, description TEXT, incurred_at TEXT,
      incurred_date TEXT, synced_at TEXT, vendor TEXT, expense_type TEXT,
      estimate_line_item_id TEXT, tax_category TEXT, is_1099_reportable INTEGER,
      sub_id TEXT, receipt_photo_id TEXT, receipt_r2_key TEXT, entered_via TEXT,
      is_active INTEGER, pushed_to_qbo INTEGER, created_at TEXT, created_by TEXT
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY, value TEXT, value_type TEXT, category TEXT,
      label TEXT, description TEXT, updated_at TEXT
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE daily_logs (id TEXT PRIMARY KEY, job_id TEXT, created_at TEXT)`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE smart_notes (id TEXT PRIMARY KEY, job_id TEXT, created_at TEXT)`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE photos (id TEXT PRIMARY KEY, job_id TEXT, is_active INTEGER, created_at TEXT)`,
  ).run();
});

afterAll(async () => {
  await dispose();
});

function req(url: string, method: string, body: unknown, email = OWNER): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "Cf-Access-Authenticated-User-Email": email,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function jobRow(id: string) {
  return env.DB.prepare(
    "SELECT status, hold_reason, hold_previous_status, held_at, actual_end_date, notes FROM jobs WHERE id = ?",
  ).bind(id).first<{
    status: string;
    hold_reason: string | null;
    hold_previous_status: string | null;
    held_at: string | null;
    actual_end_date: string | null;
    notes: string | null;
  }>();
}

describe("hold and release", () => {
  it("rejects an empty reason, a non-owner, and statuses that cannot be held", async () => {
    const empty = await handleJobHold(req("http://replay.local/api/jobs/x/hold", "POST", { reason: "   " }), env, JOB_105);
    expect(empty.status).toBe(400);

    const pm = await handleJobHold(
      req("http://replay.local/api/jobs/x/hold", "POST", { reason: "insurance" }, PM),
      env,
      JOB_105,
    );
    expect(pm.status).toBe(403);

    for (const id of ["hold-complete", "hold-closed", "hold-cancelled", "hold-archived"]) {
      const before = await jobRow(id);
      const res = await handleJobHold(
        req(`http://replay.local/api/jobs/${id}/hold`, "POST", { reason: "no" }),
        env,
        id,
      );
      expect(res.status).toBe(400);
      expect((await jobRow(id))?.status).toBe(before?.status);
    }
  });

  it("holds an imported action_required job without completion side effects", async () => {
    const before = await jobRow(JOB_105);
    const logs: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    let res: Response;
    try {
      res = await handleJobHold(
        req("http://replay.local/api/jobs/105/hold", "POST", { reason: "Insurance claim is disputed" }),
        env,
        JOB_105,
      );
    } finally {
      console.log = log;
      console.error = error;
    }
    expect(res!.status).toBe(200);
    const row = await jobRow(JOB_105);
    expect(row?.status).toBe("on_hold");
    expect(row?.hold_previous_status).toBe("action_required");
    expect(row?.hold_reason).toBe("Insurance claim is disputed");
    expect(row?.held_at).toBeTruthy();
    expect(row?.actual_end_date).toBe(before?.actual_end_date ?? null);

    const audit = await env.DB.prepare(
      "SELECT action, details FROM audit_logs WHERE entity_id = ? AND action = 'job_on_hold'",
    ).bind(JOB_105).first<{ action: string; details: string }>();
    expect(audit?.action).toBe("job_on_hold");
    expect(audit?.details).toContain("action_required");
    const statusAudit = await env.DB.prepare(
      "SELECT id FROM audit_logs WHERE entity_id = ? AND action = 'job_status_changed'",
    ).bind(JOB_105).first();
    expect(statusAudit).toBeNull();
    const noise = logs.concat(errors).join("\n");
    expect(noise).not.toContain("[wc]");
    expect(noise).not.toContain("[AUTOTRIGGER]");

    const again = await handleJobHold(
      req("http://replay.local/api/jobs/105/hold", "POST", { reason: "again" }),
      env,
      JOB_105,
    );
    expect(again.status).toBe(409);
  });

  it("refuses the generic status endpoint in both directions", async () => {
    const toHold = await handleJobStatus(
      req("http://replay.local/api/jobs/105/status", "PUT", { status: "on_hold" }),
      env,
      JOB_105,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );
    expect(toHold.status).toBe(400);
    const leave = await handleJobStatus(
      req("http://replay.local/api/jobs/105/status", "PUT", { status: "in_progress" }),
      env,
      JOB_105,
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );
    expect(leave.status).toBe(400);
    expect((await jobRow(JOB_105))?.status).toBe("on_hold");
  });

  it("keeps a held import on the list and in search, and off the board and job health", async () => {
    const pipeline = await (await handleJobPipeline(env)).json() as {
      counts: Record<string, number>;
      pipeline: Record<string, { id: string }[]>;
      on_hold: { id: string; hold_reason: string; hold_previous_status: string; days_held: number }[];
    };
    expect(pipeline.on_hold.map((j) => j.id)).toContain(JOB_105);
    const held = pipeline.on_hold.find((j) => j.id === JOB_105);
    expect(held?.hold_previous_status).toBe("action_required");
    expect(held?.hold_reason).toContain("Insurance");
    expect(held?.days_held).toBe(0);
    for (const cards of Object.values(pipeline.pipeline)) {
      expect(cards.map((j) => j.id)).not.toContain(JOB_105);
    }
    const active = Object.values(pipeline.counts).reduce((a, b) => a + b, 0);
    const visible = Object.values(pipeline.pipeline).reduce((n, cards) => n + cards.length, 0);
    expect(active).toBe(visible);

    const listed = await (await handleJobList(env, new URL("http://replay.local/api/jobs?status=on_hold"))).json() as {
      jobs: { id: string }[];
    };
    expect(listed.jobs.map((j) => j.id)).toContain(JOB_105);

    for (const q of ["jon", "gwatney", "105", "drywall and flooring"]) {
      const found = await (await handleJobList(env, new URL(`http://replay.local/api/jobs?q=${encodeURIComponent(q)}`))).json() as {
        jobs: { id: string }[];
      };
      expect(found.jobs.map((j) => j.id)).toContain(JOB_105);
    }

    const healthBefore = await (await handleJobHealth(env, req("http://replay.local/api/jobs/health", "GET", null))).json() as {
      jobs: { id: string }[];
    };
    expect(healthBefore.jobs.map((j) => j.id)).toContain(JOB_102);
    const heldNative = await handleJobHold(
      req("http://replay.local/api/jobs/102/hold", "POST", { reason: "Waiting on the homeowner" }),
      env,
      JOB_102,
    );
    expect(heldNative.status).toBe(200);
    const healthAfter = await (await handleJobHealth(env, req("http://replay.local/api/jobs/health", "GET", null))).json() as {
      jobs: { id: string }[];
    };
    expect(healthAfter.jobs.map((j) => j.id)).not.toContain(JOB_102);
    const after = await (await handleJobPipeline(env)).json() as {
      pipeline: Record<string, { id: string }[]>;
      on_hold: { id: string }[];
    };
    expect(after.on_hold.map((j) => j.id)).toContain(JOB_102);
    for (const cards of Object.values(after.pipeline)) {
      expect(cards.map((j) => j.id)).not.toContain(JOB_102);
    }
  });

  it("still saves notes, an expense, and an invoice, and shows a quick job", async () => {
    const notes = await handleJobUpdate(
      req("http://replay.local/api/jobs/105", "PUT", { notes: "Claim file is in the office." }),
      env,
      JOB_105,
    );
    expect(notes.status).toBe(200);
    expect((await jobRow(JOB_105))?.notes).toBe("Claim file is in the office.");
    expect((await jobRow(JOB_105))?.status).toBe("on_hold");

    const note = await handleNoteCreate(env, req("http://replay.local/api/notes", "POST", {
      raw_text: "Called the adjuster.",
      job_id: JOB_105,
    }));
    expect(note.status).toBe(201);

    const expense = await handleExpenseCreateJson(
      env,
      req("http://replay.local/api/expenses", "POST", {
        job_id: JOB_105,
        amount: 42,
        vendor: "ZZTEST Lumber",
        description: "While the job is on hold",
      }),
      { waitUntil() {}, passThroughOnException() {} } as ExecutionContext,
    );
    expect(expense.status).toBe(201);
    const savedExpense = await env.DB.prepare(
      "SELECT job_id, amount FROM expenses WHERE description = ?",
    ).bind("While the job is on hold").first<{ job_id: string; amount: number }>();
    expect(savedExpense?.job_id).toBe(JOB_105);

    const invoice = await handleInvoiceCreate(
      req("http://replay.local/api/invoices", "POST", { job_id: JOB_105, amount: 100, title: "Hold invoice" }),
      env,
    );
    expect(invoice.status).toBe(201);

    const quick = await handleJobHold(
      req("http://replay.local/api/jobs/quick/hold", "POST", { reason: "Material delay" }),
      env,
      "hold-quick",
    );
    expect(quick.status).toBe(200);
    const pipeline = await (await handleJobPipeline(env)).json() as { on_hold: { id: string }[] };
    expect(pipeline.on_hold.map((j) => j.id)).toContain("hold-quick");

    for (const file of [
      "src/routes/documents.ts",
      "src/routes/expenses.ts",
      "src/routes/invoices.ts",
      "src/routes/notes.ts",
    ]) {
      expect(readFileSync(file, "utf8")).not.toContain("on_hold");
    }
  });

  it("releases back to the previous status in one action", async () => {
    const beforeEnd = (await jobRow(JOB_105))?.actual_end_date ?? null;
    const logs: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    let res: Response;
    try {
      res = await handleJobRelease(req("http://replay.local/api/jobs/105/release", "POST", {}), env, JOB_105);
    } finally {
      console.log = log;
    }
    expect(res!.status).toBe(200);
    const row = await jobRow(JOB_105);
    expect(row?.status).toBe("action_required");
    expect(row?.hold_reason).toBeNull();
    expect(row?.hold_previous_status).toBeNull();
    expect(row?.held_at).toBeNull();
    expect(row?.actual_end_date).toBe(beforeEnd);
    expect(logs.join("\n")).not.toContain("[wc]");
    const audit = await env.DB.prepare(
      "SELECT details FROM audit_logs WHERE entity_id = ? AND action = 'job_released'",
    ).bind(JOB_105).first<{ details: string }>();
    expect(audit?.details).toContain("action_required");

    const stray = await handleJobRelease(req("http://replay.local/api/jobs/105/release", "POST", {}), env, JOB_105);
    expect(stray.status).toBe(409);

    const pipeline = await (await handleJobPipeline(env)).json() as {
      pipeline: Record<string, { id: string }[]>;
      on_hold: { id: string }[];
    };
    expect(pipeline.on_hold.map((j) => j.id)).not.toContain(JOB_105);
    expect(pipeline.pipeline.action_required.map((j) => j.id)).toContain(JOB_105);
  });

  it("restores complete without running completion side effects", async () => {
    await env.DB.prepare(
      `UPDATE jobs
          SET status = 'on_hold',
              hold_previous_status = 'complete',
              hold_reason = 'Payment dispute after completion',
              held_at = '2026-10-22T12:00:00.000Z',
              actual_end_date = '2026-10-01'
        WHERE id = 'hold-complete'`,
    ).run();
    const logs: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    let res: Response;
    try {
      res = await handleJobRelease(
        req("http://replay.local/api/jobs/hold-complete/release", "POST", {}),
        env,
        "hold-complete",
      );
    } finally {
      console.log = log;
    }
    expect(res!.status).toBe(200);
    const row = await jobRow("hold-complete");
    expect(row?.status).toBe("complete");
    expect(row?.actual_end_date).toBe("2026-10-01");
    expect(row?.hold_reason).toBeNull();
    const noise = logs.join("\n");
    expect(noise).not.toContain("[wc]");
    expect(noise).not.toContain("[AUTOTRIGGER]");
    expect(noise).not.toContain("warranty");
    expect(noise).not.toContain("lien");
  });
});

describe("customer automations", () => {
  let notify: Env;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { async fetch() { return new Response(null, { status: 404 }); } }",
      d1Databases: { DB: "on-hold-notify" },
      d1Persist: false,
    });
    const bindings = await mf.getBindings<{ DB: Env["DB"] }>();
    notify = { DB: bindings.DB, NOTIFICATIONS_DISPATCH_MODE: "simulate" } as Env;
    close = () => mf.dispose();
    await notify.DB.prepare(
      `CREATE TABLE jobs (
        id TEXT PRIMARY KEY, status TEXT, title TEXT, client_id TEXT,
        property_address TEXT, property_city TEXT, property_state TEXT, property_zip TEXT,
        portal_token TEXT, contract_total REAL, deposit_amount REAL, start_date TEXT,
        completion_package_sent_at TEXT, review_enabled INTEGER, review_received INTEGER,
        hold_reason TEXT, hold_previous_status TEXT, held_at TEXT
      )`,
    ).run();
    await notify.DB.prepare(
      `CREATE TABLE clients (
        id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, name TEXT, email TEXT, phone TEXT
      )`,
    ).run();
    await notify.DB.prepare(
      `CREATE TABLE notification_templates (
        id TEXT PRIMARY KEY, trigger_event TEXT, name TEXT, recipient_type TEXT, channel TEXT,
        subject TEXT, body_template TEXT, merge_fields TEXT, is_active INTEGER,
        delay_minutes INTEGER, send_time TEXT, phase TEXT
      )`,
    ).run();
    await notify.DB.prepare(
      `CREATE TABLE notification_logs (
        id TEXT PRIMARY KEY, template_id TEXT, trigger_event TEXT, recipient_type TEXT,
        recipient_name TEXT, recipient_contact TEXT, recipient_user_id TEXT, channel TEXT,
        subject TEXT, body TEXT, status TEXT, scheduled_for TEXT, dedupe_key TEXT,
        is_read INTEGER, retry_count INTEGER, job_id TEXT, client_id TEXT,
        estimate_request_id TEXT, link_path TEXT, created_at TEXT
      )`,
    ).run();
    await notify.DB.prepare(
      "INSERT INTO clients (id, first_name, last_name, name, phone, email) VALUES ('c1', 'Alicia', 'Jones', 'Alicia Jones', '5015550100', 'alicia@example.com')",
    ).run();
    await notify.DB.prepare(
      `INSERT INTO jobs (id, status, title, client_id, review_enabled, review_received, completion_package_sent_at)
       VALUES ('held', 'on_hold', 'Held job', 'c1', 1, 0, '2026-10-01T12:00:00Z')`,
    ).run();
    for (const event of [...CUSTOMER_AUTOMATION_EVENTS, "sub_scheduled", "invoice_sent"]) {
      await notify.DB.prepare(
        `INSERT INTO notification_templates
           (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes)
         VALUES (?, ?, ?, 'client', 'sms', NULL, 'Hello', '[]', 1, 0)`,
      ).bind(`tpl-${event}`, event, event).run();
    }
  });

  afterAll(async () => {
    await close();
  });

  it("suppresses each customer automation while held and sends it after release", async () => {
    for (const event of CUSTOMER_AUTOMATION_EVENTS) {
      const blocked = await triggerNotification(notify, event, {
        jobId: "held",
        clientId: "c1",
        instanceKey: "auto",
      }, { skipImmediate: true });
      expect(blocked.enqueued).toBe(0);
      expect(blocked.reasons).toContain("job_on_hold");
    }
    const queued = await notify.DB.prepare("SELECT COUNT(*) AS n FROM notification_logs").first<{ n: number }>();
    expect(queued?.n).toBe(0);

    await sendImmediateReviewRequest(notify, "held", "c1");
    const follow = await processReviewFollowUps(notify);
    expect(follow.dispatched).toBe(0);
    const still = await notify.DB.prepare("SELECT COUNT(*) AS n FROM notification_logs").first<{ n: number }>();
    expect(still?.n).toBe(0);

    const manual = await triggerNotification(notify, "completion_package_sent", {
      jobId: "held",
      clientId: "c1",
      instanceKey: "manual",
    }, { skipImmediate: true, manual: true });
    expect(manual.enqueued).toBe(1);

    const feeManual = await triggerNotification(notify, "invoice_late_fee_added", {
      jobId: "held",
      clientId: "c1",
      instanceKey: "fee-manual",
    }, { skipImmediate: true, manual: true });
    expect(feeManual.enqueued).toBe(1);

    const worker = await triggerNotification(notify, "sub_scheduled", {
      jobId: "held",
      clientId: "c1",
      instanceKey: "crew",
    }, { skipImmediate: true });
    expect(worker.enqueued).toBe(1);

    await notify.DB.prepare(
      "UPDATE jobs SET status = 'in_progress', hold_reason = NULL, hold_previous_status = NULL, held_at = NULL WHERE id = 'held'",
    ).run();
    for (const event of CUSTOMER_AUTOMATION_EVENTS) {
      const sent = await triggerNotification(notify, event, {
        jobId: "held",
        clientId: "c1",
        instanceKey: "auto",
      }, { skipImmediate: true });
      expect(sent.enqueued).toBe(1);
    }
  });
});

describe("portal privacy", () => {
  it("maps a held job to a neutral status and never sends the reason", () => {
    expect(customerFacingJobStatus("on_hold")).toBe("in_progress");
    expect(customerFacingJobStatus("punch_list")).toBe("punch_list");
    const portal = readFileSync("src/routes/portal.ts", "utf8");
    expect(portal).toContain("customerFacingJobStatus");
    expect(portal).not.toContain("hold_reason");
  });
});
