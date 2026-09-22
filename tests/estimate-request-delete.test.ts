import { describe, expect, it } from "vitest";
import {
  activeLeadDeleteError,
  deleteNewRequestLeads,
  maybeDeleteOrphanClient,
  performEstimateRequestDelete,
  shouldDeleteOrphanClient,
  type EstimateRequestDeleteRow,
} from "../src/lib/estimate-request-delete.js";
import type { Env } from "../src/env.js";

interface ClientRow {
  id: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}

interface RequestRow {
  id: string;
  request_number: number;
  status: string;
  client_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  lead_source: string | null;
  source: string | null;
  estimate_id: string | null;
  converted_job_id: string | null;
}

interface EstimateRow {
  id: string;
  client_id: string;
  request_id: string | null;
  status: string;
}

interface JobRow {
  id: string;
  client_id: string;
  estimate_id: string | null;
}

interface AuditRow {
  action: string;
  entity_type: string;
  entity_id: string;
  details: string;
  user_email: string;
}

function makeEnv(seed: {
  clients?: ClientRow[];
  requests?: RequestRow[];
  estimates?: EstimateRow[];
  jobs?: JobRow[];
}) {
  const clients = [...(seed.clients ?? [])];
  const requests = [...(seed.requests ?? [])];
  const estimates = [...(seed.estimates ?? [])];
  const jobs = [...(seed.jobs ?? [])];
  const auditLogs: AuditRow[] = [];

  const db = {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, " ").trim();
      return {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async first() {
          if (norm.includes("COUNT(*)") && norm.includes("FROM estimate_requests")) {
            const clientId = this._args[0] as string;
            return { n: requests.filter((r) => r.client_id === clientId).length };
          }
          if (norm.includes("COUNT(*)") && norm.includes("FROM estimates")) {
            const clientId = this._args[0] as string;
            return { n: estimates.filter((e) => e.client_id === clientId).length };
          }
          if (norm.includes("COUNT(*)") && norm.includes("FROM jobs")) {
            const clientId = this._args[0] as string;
            return { n: jobs.filter((j) => j.client_id === clientId).length };
          }
          if (norm.includes("FROM estimate_requests er") && norm.includes("LEFT JOIN clients")) {
            const id = this._args[0] as string;
            const er = requests.find((r) => r.id === id);
            if (!er) return null;
            const c = clients.find((cl) => cl.id === er.client_id) ?? null;
            return {
              ...er,
              client_first: c?.first_name ?? null,
              client_last: c?.last_name ?? null,
              client_display_name: c?.name ?? null,
              client_phone: c?.phone ?? null,
            };
          }
          if (norm.includes("FROM clients") && norm.includes("WHERE id")) {
            const id = this._args[0] as string;
            return clients.find((c) => c.id === id) ?? null;
          }
          if (norm.includes("FROM estimates") && norm.includes("request_id") && norm.includes("approved")) {
            const requestId = this._args[0] as string;
            return estimates.find((e) => e.request_id === requestId && e.status === "approved") ?? null;
          }
          if (norm.includes("FROM jobs j") && norm.includes("e.request_id")) {
            const requestId = this._args[0] as string;
            const est = estimates.find((e) => e.request_id === requestId);
            if (!est) return null;
            return jobs.find((j) => j.estimate_id === est.id) ?? null;
          }
          return null;
        },
        async all() {
          if (norm.includes("FROM estimates") && norm.includes("request_id")) {
            const requestId = this._args[0] as string;
            return { results: estimates.filter((e) => e.request_id === requestId).map((e) => ({ id: e.id })) };
          }
          if (norm.includes("FROM estimates") && norm.includes("client_id")) {
            const clientId = this._args[0] as string;
            return { results: estimates.filter((e) => e.client_id === clientId).map((e) => ({ id: e.id })) };
          }
          if (norm.includes("FROM jobs") && norm.includes("client_id")) {
            const clientId = this._args[0] as string;
            return {
              results: jobs
                .filter((j) => j.client_id === clientId)
                .map((j) => ({ id: j.id, estimate_id: j.estimate_id })),
            };
          }
          if (norm.includes("FROM estimate_requests") && norm.includes("client_id")) {
            const clientId = this._args[0] as string;
            return { results: requests.filter((r) => r.client_id === clientId).map((r) => ({ id: r.id })) };
          }
          return { results: [] };
        },
        async run() {
          if (norm.startsWith("INSERT INTO audit_logs")) {
            auditLogs.push({
              action: this._args[2] as string,
              entity_type: this._args[3] as string,
              entity_id: this._args[4] as string,
              details: this._args[5] as string,
              user_email: this._args[1] as string,
            });
          }
          if (norm.startsWith("DELETE FROM estimate_requests WHERE id")) {
            const id = this._args[0] as string;
            const idx = requests.findIndex((r) => r.id === id);
            if (idx >= 0) requests.splice(idx, 1);
          }
          if (norm.startsWith("DELETE FROM estimate_requests WHERE client_id")) {
            const clientId = this._args[0] as string;
            for (let i = requests.length - 1; i >= 0; i--) {
              if (requests[i].client_id === clientId) requests.splice(i, 1);
            }
          }
          if (norm.startsWith("DELETE FROM estimates WHERE id")) {
            const id = this._args[0] as string;
            const idx = estimates.findIndex((e) => e.id === id);
            if (idx >= 0) estimates.splice(idx, 1);
          }
          if (norm.startsWith("DELETE FROM jobs WHERE id")) {
            const id = this._args[0] as string;
            const idx = jobs.findIndex((j) => j.id === id);
            if (idx >= 0) jobs.splice(idx, 1);
          }
          if (norm.startsWith("DELETE FROM clients WHERE id")) {
            const id = this._args[0] as string;
            const idx = clients.findIndex((c) => c.id === id);
            if (idx >= 0) clients.splice(idx, 1);
          }
          if (norm.startsWith("DELETE FROM audit_logs")) {
            const entityId = this._args[0] as string;
            for (let i = auditLogs.length - 1; i >= 0; i--) {
              if (auditLogs[i].entity_id === entityId) auditLogs.splice(i, 1);
            }
          }
          return { meta: {} };
        },
      };
    },
  };

  return {
    env: { DB: db } as unknown as Env,
    clients,
    requests,
    estimates,
    jobs,
    auditLogs,
  };
}

function junkRequest(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "er-junk",
    request_number: 88,
    status: "new_request",
    client_id: "c-junk",
    contact_name: "Unknown Lead",
    contact_phone: "5015550100",
    lead_source: "google_lsa",
    source: "google_lsa",
    estimate_id: null,
    converted_job_id: null,
    ...over,
  };
}

function junkClient(over: Partial<ClientRow> = {}): ClientRow {
  return {
    id: "c-junk",
    name: null,
    first_name: "Unknown",
    last_name: "Lead",
    email: null,
    phone: "5015550100",
    ...over,
  };
}

function asDeleteRow(r: RequestRow, c?: ClientRow): EstimateRequestDeleteRow {
  return {
    ...r,
    client_first: c?.first_name ?? null,
    client_last: c?.last_name ?? null,
    client_display_name: c?.name ?? null,
    client_phone: c?.phone ?? null,
  };
}

describe("new_request delete guard", () => {
  it("allows new_request and blocks every other stage", () => {
    expect(activeLeadDeleteError("new_request")).toBeNull();
    for (const status of [
      "appointment_set",
      "visit_done",
      "building",
      "sent",
      "follow_up",
      "won",
      "lost",
    ]) {
      const err = activeLeadDeleteError(status);
      expect(err?.error).toBe("cannot_delete_active_lead");
      expect(err?.message).toMatch(/Only New Request leads can be deleted/);
    }
  });

  it("deletes an orphan client only when no other real records remain", () => {
    expect(shouldDeleteOrphanClient({ requests: 0, estimates: 0, jobs: 0 })).toBe(true);
    expect(shouldDeleteOrphanClient({ requests: 1, estimates: 0, jobs: 0 })).toBe(false);
    expect(shouldDeleteOrphanClient({ requests: 0, estimates: 1, jobs: 0 })).toBe(false);
    expect(shouldDeleteOrphanClient({ requests: 0, estimates: 0, jobs: 1 })).toBe(false);
  });
});

describe("orphan client cleanup", () => {
  it("deletes the client when the request was their only record", async () => {
    const { env, clients, requests, auditLogs } = makeEnv({
      clients: [junkClient()],
      requests: [junkRequest()],
    });

    await performEstimateRequestDelete(env, asDeleteRow(junkRequest(), junkClient()), "tony@chs.local");

    expect(requests.find((r) => r.id === "er-junk")).toBeUndefined();
    expect(clients.find((c) => c.id === "c-junk")).toBeUndefined();

    const reqAudit = auditLogs.filter((a) => a.action === "estimate_request_deleted");
    const clientAudit = auditLogs.filter((a) => a.action === "client_deleted");
    expect(reqAudit).toHaveLength(1);
    expect(clientAudit).toHaveLength(1);
    expect(JSON.parse(reqAudit[0].details)).toMatchObject({
      name: "Unknown Lead",
      phone: "5015550100",
      source: "google_lsa",
    });
    expect(JSON.parse(clientAudit[0].details)).toMatchObject({
      via: "orphan_after_estimate_request_delete",
      phone: "5015550100",
    });
  });

  it("keeps the client when they have another job or estimate", async () => {
    const { env, clients, requests, jobs } = makeEnv({
      clients: [junkClient({ id: "c-real", first_name: "Pat", last_name: "Jones" })],
      requests: [junkRequest({ id: "er-extra", client_id: "c-real" })],
      jobs: [{ id: "job-1", client_id: "c-real", estimate_id: null }],
    });

    await performEstimateRequestDelete(
      env,
      asDeleteRow(junkRequest({ id: "er-extra", client_id: "c-real" }), junkClient({ id: "c-real" })),
      "tony@chs.local",
    );

    expect(requests.find((r) => r.id === "er-extra")).toBeUndefined();
    expect(clients.find((c) => c.id === "c-real")).toBeTruthy();
    expect(jobs.find((j) => j.id === "job-1")).toBeTruthy();
  });

  it("keeps the client when they have another estimate_request", async () => {
    const { env, clients, requests } = makeEnv({
      clients: [junkClient()],
      requests: [
        junkRequest({ id: "er-a" }),
        junkRequest({ id: "er-b", request_number: 89 }),
      ],
    });

    const deleted = await maybeDeleteOrphanClient(env, "c-junk", "tony@chs.local");
    expect(deleted).toBe(false);
    expect(clients.find((c) => c.id === "c-junk")).toBeTruthy();
    expect(requests).toHaveLength(2);
  });
});

describe("bulk-delete New Request only", () => {
  it("deletes eligible ids, skips progressed leads, and does not abort the batch", async () => {
    const { env, requests, clients, auditLogs } = makeEnv({
      clients: [
        junkClient({ id: "c-1", first_name: "Spam", last_name: "Co", phone: "5011111111" }),
        junkClient({ id: "c-2", first_name: "Junk", last_name: "Inc", phone: "5012222222" }),
        junkClient({ id: "c-3", first_name: "Real", last_name: "Lead", phone: "5013333333" }),
      ],
      requests: [
        junkRequest({ id: "er-1", client_id: "c-1", contact_name: "Spam Co", contact_phone: "5011111111" }),
        junkRequest({ id: "er-2", client_id: "c-2", contact_name: "Junk Inc", contact_phone: "5012222222" }),
        junkRequest({
          id: "er-3",
          client_id: "c-3",
          status: "appointment_set",
          contact_name: "Real Lead",
        }),
      ],
    });

    const result = await deleteNewRequestLeads(env, ["er-1", "er-3", "er-2", "er-missing"], "tony@chs.local");

    expect(result.deleted.map((d) => d.id)).toEqual(["er-1", "er-2"]);
    expect(result.deleted.every((d) => d.client_deleted)).toBe(true);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "er-3",
          status: 409,
          error: "cannot_delete_active_lead",
        }),
        expect.objectContaining({ id: "er-missing", status: 404, error: "not_found" }),
      ]),
    );

    expect(requests.find((r) => r.id === "er-1")).toBeUndefined();
    expect(requests.find((r) => r.id === "er-2")).toBeUndefined();
    expect(requests.find((r) => r.id === "er-3")).toBeTruthy();
    expect(clients.find((c) => c.id === "c-3")).toBeTruthy();
    expect(clients.find((c) => c.id === "c-1")).toBeUndefined();
    expect(clients.find((c) => c.id === "c-2")).toBeUndefined();

    const reqAudits = auditLogs.filter((a) => a.action === "estimate_request_deleted");
    expect(reqAudits).toHaveLength(2);
    expect(reqAudits.map((a) => a.entity_id).sort()).toEqual(["er-1", "er-2"]);
    expect(auditLogs.filter((a) => a.action === "client_deleted")).toHaveLength(2);
  });

  it("leaves a shared client until the last remaining request is gone", async () => {
    const { env, clients, requests } = makeEnv({
      clients: [junkClient()],
      requests: [
        junkRequest({ id: "er-a" }),
        junkRequest({ id: "er-b", request_number: 89 }),
      ],
    });

    const first = await deleteNewRequestLeads(env, ["er-a"], "tony@chs.local");
    expect(first.deleted[0].client_deleted).toBe(false);
    expect(clients.find((c) => c.id === "c-junk")).toBeTruthy();
    expect(requests.map((r) => r.id)).toEqual(["er-b"]);

    const second = await deleteNewRequestLeads(env, ["er-b"], "tony@chs.local");
    expect(second.deleted[0].client_deleted).toBe(true);
    expect(clients.find((c) => c.id === "c-junk")).toBeUndefined();
  });
});
