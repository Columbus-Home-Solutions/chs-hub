import { describe, expect, it } from "vitest";
import {
  cascadeDeleteJob,
  CascadeStepError,
  DELETABLE_JOB_STATUSES,
} from "../src/lib/cascade-delete.js";
import type { Env } from "../src/env.js";

type Row = Record<string, unknown>;

/**
 * In-memory fake D1 that applies DELETE/UPDATE for job cascade tables.
 * Records SQL and mutates row stores so assertions can prove children are gone.
 */
function makeJobCascadeEnv(jobId: string) {
  const tables: Record<string, Row[]> = {
    notification_logs: [
      { id: "nl1", job_id: jobId },
      { id: "nl2", communication_id: "c1" },
    ],
    communications: [{ id: "c1", job_id: jobId }],
    punch_list_items: [{ id: "pli1", job_id: jobId, punch_list_id: "pl1" }],
    punch_lists: [{ id: "pl1", job_id: jobId }],
    signature_events: [{ id: "se1", job_document_id: "jd1" }],
    job_documents: [
      { id: "jd1", job_id: jobId },
      { id: "jd2", job_id: jobId },
    ],
    tasks: [
      { id: "t1", job_id: jobId },
      { id: "t2", job_id: jobId },
    ],
    time_entries: [],
    expenses: [],
    payments: [{ id: "pay1", job_id: jobId }],
    client_lien_waivers: [],
    invoices: [],
    change_orders: [],
    schedule_entries: [],
    daily_logs: [{ id: "dl1", job_id: jobId }],
    job_files: [],
    photos: [],
    notes: [],
    lien_waivers: [],
    warranties: [],
    billing_cycles: [],
    billing_schedule: [],
    permits: [],
    warranty_calls: [],
    smart_notes: [],
    mileage: [],
    documents: [],
    social_posts: [],
    line_items: [],
    files: [],
    receipt_photos: [],
    expense_line_items: [],
    estimate_requests: [{ id: "er1", converted_job_id: jobId }],
    users: [{ id: "u1", current_job_id: jobId }],
    jobs: [{ id: jobId, created_by: "u1", status: "closed" }],
    bid_requests: [{ id: "br1", job_id: jobId }],
    selections: [{ id: "sel1", job_id: jobId }],
    quotes: [{ id: "q1", job_id: jobId }],
    audit_logs: [{ id: "a1", entity_id: jobId }],
  };

  const statements: { sql: string; binds: unknown[] }[] = [];

  function deleteWhere(table: string, pred: (row: Row) => boolean): number {
    const before = tables[table]?.length ?? 0;
    tables[table] = (tables[table] ?? []).filter((r) => !pred(r));
    return before - (tables[table]?.length ?? 0);
  }

  function updateWhere(table: string, pred: (row: Row) => boolean, patch: (row: Row) => void): number {
    let n = 0;
    for (const row of tables[table] ?? []) {
      if (pred(row)) {
        patch(row);
        n++;
      }
    }
    return n;
  }

  const env = {
    DB: {
      prepare(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim();
        return {
          _binds: [] as unknown[],
          bind(...binds: unknown[]) {
            this._binds = binds;
            return this;
          },
          async run() {
            statements.push({ sql: norm, binds: this._binds });
            const id = this._binds[0];

            if (norm.startsWith("DELETE FROM notification_logs WHERE communication_id IN")) {
              const commIds = new Set(
                (tables.communications ?? []).filter((c) => c.job_id === id).map((c) => c.id),
              );
              deleteWhere("notification_logs", (r) => commIds.has(r.communication_id as string));
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("DELETE FROM notification_logs WHERE job_id")) {
              deleteWhere("notification_logs", (r) => r.job_id === id);
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("DELETE FROM communications WHERE job_id")) {
              deleteWhere("communications", (r) => r.job_id === id);
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("DELETE FROM signature_events")) {
              const docIds = new Set(
                (tables.job_documents ?? []).filter((d) => d.job_id === id).map((d) => d.id),
              );
              deleteWhere("signature_events", (r) => docIds.has(r.job_document_id as string));
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("DELETE FROM audit_logs WHERE entity_id")) {
              deleteWhere("audit_logs", (r) => r.entity_id === id);
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("DELETE FROM ")) {
              const m = norm.match(/^DELETE FROM (\w+) WHERE job_id/);
              if (m) {
                deleteWhere(m[1], (r) => r.job_id === id);
                return { success: true, meta: { changes: 1 } };
              }
            }
            if (norm.startsWith("UPDATE estimate_requests SET converted_job_id = NULL")) {
              updateWhere("estimate_requests", (r) => r.converted_job_id === id, (r) => {
                r.converted_job_id = null;
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("UPDATE users SET current_job_id = NULL")) {
              updateWhere("users", (r) => r.current_job_id === id, (r) => {
                r.current_job_id = null;
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("UPDATE jobs SET created_by = NULL")) {
              updateWhere("jobs", (r) => r.id === id, (r) => {
                r.created_by = null;
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("UPDATE bid_requests SET job_id = NULL")) {
              updateWhere("bid_requests", (r) => r.job_id === id, (r) => {
                r.job_id = null;
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("UPDATE selections SET job_id = NULL")) {
              updateWhere("selections", (r) => r.job_id === id, (r) => {
                r.job_id = null;
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.startsWith("UPDATE quotes SET job_id = NULL")) {
              updateWhere("quotes", (r) => r.job_id === id, (r) => {
                r.job_id = null;
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (norm.includes("receipt_photos") || norm.includes("expense_line_items")) {
              return { success: true, meta: { changes: 0 } };
            }
            return { success: true, meta: { changes: 0 } };
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [] };
          },
        };
      },
    },
  } as unknown as Env;

  return { env, tables, statements };
}

describe("cascadeDeleteJob", () => {
  it("only allows closed or cancelled statuses at the API guard", () => {
    expect(DELETABLE_JOB_STATUSES.has("closed")).toBe(true);
    expect(DELETABLE_JOB_STATUSES.has("cancelled")).toBe(true);
    expect(DELETABLE_JOB_STATUSES.has("in_progress")).toBe(false);
  });

  it("removes punch lists, tasks, messages, documents, and signature events for a closed job", async () => {
    const jobId = "job-closed-1";
    const { env, tables, statements } = makeJobCascadeEnv(jobId);

    await cascadeDeleteJob(env, jobId);
    // Caller deletes the job row after cascade (same as handleJobDelete).
    tables.jobs = tables.jobs.filter((j) => j.id !== jobId);

    expect(tables.notification_logs).toHaveLength(0);
    expect(tables.communications).toHaveLength(0);
    expect(tables.punch_list_items).toHaveLength(0);
    expect(tables.punch_lists).toHaveLength(0);
    expect(tables.signature_events).toHaveLength(0);
    expect(tables.job_documents).toHaveLength(0);
    expect(tables.tasks).toHaveLength(0);
    expect(tables.payments).toHaveLength(0);
    expect(tables.daily_logs).toHaveLength(0);
    expect(tables.jobs).toHaveLength(0);
    expect(tables.audit_logs).toHaveLength(0);

    expect(tables.users[0]?.current_job_id).toBeNull();
    expect(tables.bid_requests[0]?.job_id).toBeNull();
    expect(tables.estimate_requests[0]?.converted_job_id).toBeNull();

    const sqlOrder = statements.map((s) => s.sql);
    const idx = (needle: string) => sqlOrder.findIndex((s) => s.includes(needle));
    expect(idx("DELETE FROM notification_logs WHERE job_id")).toBeGreaterThanOrEqual(0);
    expect(idx("DELETE FROM punch_list_items")).toBeLessThan(idx("DELETE FROM punch_lists"));
    expect(idx("DELETE FROM signature_events")).toBeLessThan(idx("DELETE FROM job_documents"));
    expect(idx("DELETE FROM tasks")).toBeGreaterThan(idx("DELETE FROM punch_list_items"));
  });

  it("reports the failing table instead of swallowing the error", async () => {
    const jobId = "job-fail";
    const { env } = makeJobCascadeEnv(jobId);
    const original = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      const stmt = original(sql);
      if (sql.includes("DELETE FROM punch_lists")) {
        return {
          bind(..._binds: unknown[]) {
            return {
              async run() {
                throw new Error("FOREIGN KEY constraint failed");
              },
            };
          },
        } as ReturnType<typeof original>;
      }
      return stmt;
    };

    let caught: unknown;
    try {
      await cascadeDeleteJob(env, jobId);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CascadeStepError);
    expect((caught as CascadeStepError).table).toBe("punch_lists");
    expect((caught as CascadeStepError).message).toContain("punch_lists");
  });
});
