import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Env } from "../src/env.js";
import { isCheckinDate, centralDate, addDays } from "../shared/labor-week.js";
import { dayRateMessage, nextDayRateSendAt, queueDayRateNotice } from "../src/lib/day-rate-notify.js";
import {
  handleCheckinDelete,
  handleCheckinGet,
  handleCheckinPost,
  handleCheckinPunch,
  handleCheckinSchedule,
  handleLaborConfirm,
} from "../src/routes/labor-checkin.js";
import { buildJobCosting } from "../src/lib/job-costing.js";

const USER = {
  id: "user-1",
  email: "tony@example.com",
  first_name: "Tony",
  last_name: "Columbus",
  role: "owner",
  is_active: 1,
};

function db(handler: (sql: string) => { first?: () => unknown; all?: () => unknown; run?: () => unknown }): Env {
  return {
    DB: {
      prepare(sql: string) {
        const row = handler(sql);
        return {
          bind() {
            return this;
          },
          async first() {
            return row.first ? row.first() : null;
          },
          async all() {
            return row.all ? row.all() : { results: [] };
          },
          async run() {
            return row.run ? row.run() : { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
  } as unknown as Env;
}

describe("check-in dates", () => {
  const today = "2026-10-02";
  it("allows today and yesterday only", () => {
    expect(isCheckinDate(today, today)).toBe(true);
    expect(isCheckinDate(addDays(today, -1), today)).toBe(true);
    expect(isCheckinDate(addDays(today, -2), today)).toBe(false);
  });
});

describe("day-rate texts", () => {
  it("collapses several changes into one sentence and deep-links punch", () => {
    const link = "https://client.homesolutionsar.com/sub/abc";
    expect(dayRateMessage({ kind: "schedule", count: 3, label: "ignored", link })).toContain("(3 changes)");
    expect(dayRateMessage({ kind: "schedule", count: 3, label: "ignored", link })).toContain("/schedule");
    expect(dayRateMessage({ kind: "punch", count: 1, label: "101 Pergola Repair", link })).toContain("/punch");
    expect(dayRateMessage({ kind: "punch", count: 1, label: "101 Pergola Repair", link })).not.toContain("2511");
  });

  it("holds overnight messages until 7:00 Central", () => {
    const when = nextDayRateSendAt(new Date("2026-10-03T02:30:00Z"));
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(when));
    expect(hour).toBe("07");
  });

  it("does not queue when text updates are off", async () => {
    let inserted = false;
    const env = db((sql) => ({
      first: () => {
        if (sql.includes("FROM subcontractors")) {
          return { id: "w1", worker_type: "day_rate_labor", phone: "5015550100", email: null, text_updates_enabled: 0, is_active: 1, name: "ZZ" };
        }
        return null;
      },
      run: () => {
        inserted = true;
        return { success: true };
      },
    }));
    const result = await queueDayRateNotice(env, { subId: "w1", kind: "schedule", label: "added", link: "https://client.homesolutionsar.com/sub/abc" });
    expect(result.queued).toBe(false);
    expect(inserted).toBe(false);
  });
});

describe("public check-in", () => {
  it("does not require an Access email and hides client fields", async () => {
    const env = db((sql) => ({
      first: () => {
        if (sql.includes("FROM sub_access_tokens")) {
          return {
            token: "tok",
            sub_id: "w1",
            disabled_at: null,
            schedule_seen_at: null,
            punch_seen_at: null,
            company_name: "ZZ Worker",
            contact_name: "Maria Lopez",
            day_rate: 150,
            worker_type: "day_rate_labor",
            is_active: 1,
            text_updates_enabled: 0,
          };
        }
        return null;
      },
      all: () => ({
        results: sql.includes("FROM jobs")
          ? [{ id: "j1", job_number: 101, title: "Pergola", property_address: "2511 Lilac", last_worked: "2026-10-01" }]
          : [],
      }),
    }));
    const res = await handleCheckinGet(env, "tok-long-enough");
    expect(res.status).toBe(200);
    const body = await res.json() as { greeting: string; jobs: Record<string, unknown>[] };
    expect(body.greeting).toBe("Hi Maria");
    expect(body.jobs[0]).toEqual({ id: "j1", job_number: 101, title: "Pergola", street: "2511 Lilac" });
    expect(JSON.stringify(body)).not.toMatch(/email|phone|day_rate|client/i);
  });

  it("uses one generic 404 for a bad token", async () => {
    const env = db(() => ({ first: () => null }));
    const res = await handleCheckinGet(env, "nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  it("rejects a day older than yesterday", async () => {
    const today = centralDate();
    const env = db((sql) => ({
      first: () => {
        if (sql.includes("FROM sub_access_tokens")) {
          return { token: "tok", sub_id: "w1", disabled_at: null, day_rate: 150, worker_type: "day_rate_labor", is_active: 1, contact_name: "Maria", company_name: "ZZ" };
        }
        if (sql.includes("COUNT(*)")) return { n: 0 };
        return null;
      },
    }));
    const res = await handleCheckinPost(
      env,
      "tok-long-enough",
      new Request("https://client.example/api/sub/tok/checkin", {
        method: "POST",
        body: JSON.stringify({ job_id: "j1", work_date: addDays(today, -2), days: 1 }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("Ask Tony");
  });

  it("refuses confirm until a positive rate is saved", async () => {
    const env = db((sql) => ({
      first: () => {
        if (sql.includes("FROM users")) return USER;
        if (sql.includes("FROM labor_entries")) return { id: "e1", status: "pending", day_rate: 0, deleted_at: null, expense_id: null };
        return null;
      },
    }));
    const res = await handleLaborConfirm(
      new Request("https://app.example/api/labor/pending/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "Cf-Access-Authenticated-User-Email": USER.email },
        body: JSON.stringify({ entry_ids: ["e1"] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("day_rate_required");
  });

  it("keeps a later worker rate off the row until Confirm is given one", async () => {
    const env = db((sql) => ({
      first: () => {
        if (sql.includes("FROM users")) return USER;
        if (sql.includes("FROM labor_entries")) return { id: "e1", status: "pending", day_rate: 0, deleted_at: null, expense_id: null };
        if (sql.includes("FROM subcontractors")) return { day_rate: 160 };
        return null;
      },
    }));
    const res = await handleLaborConfirm(
      new Request("https://app.example/api/labor/pending/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "Cf-Access-Authenticated-User-Email": USER.email },
        body: JSON.stringify({ entry_ids: ["e1"] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("day_rate_required");
  });
});

describe("pending days are not job cost", () => {
  it("only sums confirmed labor", async () => {
    const sqls: string[] = [];
    const env = db((sql) => {
      sqls.push(sql);
      return {
        first: () => ({ v: 0 }),
        all: () => ({ results: [] }),
      };
    });
    await buildJobCosting(env, "job-1").catch(() => undefined);
    const laborSql = sqls.filter((sql) => sql.includes("labor_entries"));
    expect(laborSql.length).toBeGreaterThan(0);
    expect(laborSql.every((sql) => sql.includes("confirmed"))).toBe(true);
  });
});

const DAY_RATE = {
  token: "tok-a",
  sub_id: "worker-a",
  disabled_at: null,
  schedule_seen_at: "2026-10-01 00:00:00",
  punch_seen_at: "2026-10-01 00:00:00",
  company_name: "ZZ Worker",
  contact_name: "Maria Lopez",
  day_rate: 150,
  worker_type: "day_rate_labor",
  is_active: 1,
  text_updates_enabled: 0,
  preferred_language: "en",
};

describe("public pages stay on this worker", () => {
  it("hides client, pricing, and other workers on schedule and punch", async () => {
    const env = db((sql) => ({
      first: () => (sql.includes("FROM sub_access_tokens") ? DAY_RATE : null),
      all: () => ({
        results: [{
          id: "row-1",
          scheduled_date: "2026-10-05",
          start_time: "08:00",
          end_time: null,
          status: "scheduled",
          created_at: "2026-10-02 12:00:00",
          job_number: 101,
          title: "Pergola",
          property_address: "2511 Lilac",
          description: "Touch up paint",
          client_name: "Secret Client",
          client_phone: "501-555-0100",
          client_email: "secret@example.com",
          day_rate: 150,
          other_worker: "Luis Seed",
        }],
      }),
    }));
    const schedule = await handleCheckinSchedule(env, "tok-long-enough");
    const punch = await handleCheckinPunch(env, "tok-long-enough");
    expect(schedule.status).toBe(200);
    expect(punch.status).toBe(200);
    const scheduleBody = JSON.stringify(await schedule.json());
    const punchBody = JSON.stringify(await punch.json());
    for (const body of [scheduleBody, punchBody]) {
      expect(body).not.toMatch(/Secret Client|501-555-0100|secret@example.com|Luis Seed|day_rate|150/);
    }
    expect(scheduleBody).toContain("2511 Lilac");
    expect(punchBody).toContain("Touch up paint");
  });

  it("refuses a true subcontractor on every check-in endpoint", async () => {
    const env = db((sql) => ({
      first: () => (sql.includes("FROM sub_access_tokens") ? { ...DAY_RATE, worker_type: "subcontractor" } : null),
    }));
    const token = "tok-long-enough";
    const post = new Request("https://client.example/checkin", {
      method: "POST",
      body: JSON.stringify({ job_id: "j1", work_date: "2026-10-02", days: 1 }),
    });
    const responses = await Promise.all([
      handleCheckinGet(env, token),
      handleCheckinPost(env, token, post),
      handleCheckinDelete(env, token, "entry-1"),
      handleCheckinSchedule(env, token),
      handleCheckinPunch(env, token),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("not_available");
    }
  });

  it("does not let worker A's token read, create, undo, or confirm worker B", async () => {
    const binds: unknown[][] = [];
    let wrote = false;
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              binds.push(args);
              return this;
            },
            async first() {
              if (sql.includes("FROM sub_access_tokens")) return DAY_RATE;
              if (sql.includes("COUNT(*)")) return { n: 0 };
              if (sql.includes("FROM jobs")) return { id: "j1" };
              if (sql.includes("SUM(days)")) return { days: 0 };
              if (sql.includes("SELECT id, days, status")) return null;
              if (sql.includes("FROM labor_entries")) {
                return {
                  id: "entry-b",
                  status: "pending",
                  sub_id: "worker-b",
                  deleted_at: null,
                  expense_id: null,
                  submitted_at: "2026-10-02",
                  work_date: "2026-10-02",
                };
              }
              return null;
            },
            async all() {
              expect(sql).toContain("sub_id = ?");
              return { results: [] };
            },
            async run() {
              wrote = true;
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;

    const read = await handleCheckinGet(env, "tok-long-enough");
    expect(read.status).toBe(200);
    expect(binds.some((args) => args[0] === "worker-a")).toBe(true);

    wrote = false;
    const created = await handleCheckinPost(
      env,
      "tok-long-enough",
      new Request("https://client.example/checkin", {
        method: "POST",
        body: JSON.stringify({ sub_id: "worker-b", job_id: "j1", work_date: centralDate(), days: 1 }),
      }),
    );
    expect(created.status).toBe(201);
    expect(binds.some((args) => args[1] === "worker-a" && args.includes("worker-b") === false && args[2] === "j1")).toBe(true);

    wrote = false;
    const removed = await handleCheckinDelete(env, "tok-long-enough", "entry-b");
    expect(removed.status).toBe(404);
    expect(((await removed.json()) as { error: string }).error).toBe("not_found");
    expect(wrote).toBe(false);

    const confirmed = await handleLaborConfirm(
      new Request("https://client.example/api/sub/tok-long-enough/checkin", {
        method: "POST",
        body: JSON.stringify({ entry_ids: ["entry-b"] }),
      }),
      env,
    );
    expect(confirmed.status).toBe(401);
    expect(wrote).toBe(false);
  });

  it("confirms rated days and flags an unrated day instead of failing the batch", async () => {
    const updated: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first() {
                  if (sql.includes("FROM users")) return USER;
                  const id = String(args[0]);
                  if (id === "rated") return { id, status: "pending", day_rate: 160, deleted_at: null, expense_id: null };
                  if (id === "unrated") return { id, status: "pending", day_rate: 0, deleted_at: null, expense_id: null };
                  return null;
                },
                async run() {
                  if (sql.startsWith("UPDATE")) updated.push(String(args[args.length - 1]));
                  return { success: true, meta: { changes: 1 } };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const res = await handleLaborConfirm(
      new Request("https://app.example/api/labor/pending/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "Cf-Access-Authenticated-User-Email": USER.email },
        body: JSON.stringify({ entry_ids: ["unrated", "rated"] }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { confirmed: string[]; needs_rate: string[] };
    expect(body.confirmed).toEqual(["rated"]);
    expect(body.needs_rate).toEqual(["unrated"]);
    expect(updated).toEqual(["rated"]);
  });
});

describe("public host allowlist", () => {
  it("allows every method under /api/sub and /sub on the client host", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain('p.startsWith("/api/sub/")');
    expect(source).toContain('p.startsWith("/sub/")');
    expect(source).toContain("handleCheckinPost");
  });
});
