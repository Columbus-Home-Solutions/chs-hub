/**
 * "No reply needed" silences inbound SMS already waiting.
 * It must not insert, edit, or delete communications rows.
 * A newer inbound counts again. Mark unread and reply keep working.
 * The badge total is clients unread plus unassigned unreviewed.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { Env } from "../src/env.js";
import {
  combinedMessageCenterBadge,
  countUnreviewedMissedCalls,
  missedCallUnassignedNotes,
} from "../shared/message-center-unassigned";
import {
  handleSmsConversationState,
  handleSmsConversations,
  handleSmsReply,
  handleSmsThread,
} from "../src/routes/sms.js";

const ANN = "1877f15f-d31f-4ecb-9a83-4be4d7086ace";
const ARCHIVED = "archived-client";
const REPLY = "reply-client";

let mf: Miniflare;
let env: Env;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: { DB: "sms-no-reply-needed" },
    d1Persist: false,
  });
  const bindings = await mf.getBindings<{ DB: Env["DB"] }>();
  env = { DB: bindings.DB, NOTIFICATIONS_DISPATCH_MODE: "simulate" } as Env;
  await env.DB.prepare("PRAGMA foreign_keys = ON").run();
  await env.DB.prepare(
    `CREATE TABLE clients (
      id TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      phone TEXT,
      sms_opt_out INTEGER DEFAULT 0,
      last_interaction_date TEXT,
      updated_at TEXT
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      channel TEXT,
      direction TEXT,
      summary TEXT,
      body TEXT,
      sent_via TEXT,
      twilio_sid TEXT,
      logged_by TEXT,
      job_id TEXT,
      created_at TEXT
    )`,
  ).run();
  await env.DB.prepare(`CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT)`).run();
  await env.DB.prepare(
    `CREATE TABLE estimate_requests (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      status TEXT,
      request_number INTEGER,
      created_at TEXT
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE sms_conversation_state (
      client_id TEXT PRIMARY KEY,
      archived_at TEXT,
      flagged_at TEXT,
      pinned_at TEXT,
      unread_override_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ).run();
  const migration = readFileSync("migrations/0141_sms_no_reply_needed.sql", "utf8");
  await env.DB.prepare(migration).run();
  const cols = await env.DB.prepare("PRAGMA table_info(sms_conversation_state)").all<{ name: string }>();
  expect((cols.results ?? []).map((c) => c.name)).toContain("no_reply_needed_at");
});

afterAll(async () => {
  await mf.dispose();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM communications").run();
  await env.DB.prepare("DELETE FROM sms_conversation_state").run();
  await env.DB.prepare("DELETE FROM clients").run();
});

async function seedClient(id: string, first: string) {
  await env.DB.prepare(
    `INSERT INTO clients (id, first_name, last_name, phone, sms_opt_out)
     VALUES (?, ?, 'Test', '5015550100', 0)`,
  ).bind(id, first).run();
}

async function seedSms(id: string, clientId: string, direction: string, body: string, createdAt: string) {
  await env.DB.prepare(
    `INSERT INTO communications (id, client_id, channel, direction, summary, body, created_at)
     VALUES (?, ?, 'text_sms', ?, ?, ?, ?)`,
  ).bind(id, clientId, direction, body, body, createdAt).run();
}

async function commCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM communications").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function list(archived = false) {
  const url = new URL(`http://local/api/sms/conversations${archived ? "?archived=1" : ""}`);
  const res = await handleSmsConversations(env, url);
  return res.json() as Promise<{
    conversations: {
      client_id: string;
      unread_count: number;
      unread_override: boolean;
      archived_at: string | null;
      no_reply_needed_at: string | null;
    }[];
    unread_total: number;
  }>;
}

function patch(clientId: string, body: Record<string, boolean>) {
  return handleSmsConversationState(
    new Request(`http://local/api/sms/conversations/${clientId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    env,
    clientId,
  );
}

const unassigned = [
  {
    id: "missed-1",
    entered_via: "missed_call",
    created_at: "2026-10-01 12:00:00",
    raw_content: "unknown caller",
  },
];

describe("no reply needed", () => {
  it("drops a multi-message unread by exactly that count and leaves communications untouched", async () => {
    await seedClient(ANN, "Ann");
    await seedSms("out-1", ANN, "outbound", "Work begins tomorrow", "2026-10-11 23:01:27");
    await seedSms("in-1", ANN, "inbound", "Thanks for let us know. See y'all tomorrow", "2026-10-11 23:32:53");
    await seedSms("in-2", ANN, "inbound", "One more thing", "2026-10-11 23:33:10");

    const before = await list();
    const ann = before.conversations.find((c) => c.client_id === ANN);
    expect(ann?.unread_count).toBe(2);
    expect(before.unread_total).toBe(2);
    expect(countUnreviewedMissedCalls(unassigned, [])).toBe(1);
    expect(missedCallUnassignedNotes(unassigned)).toHaveLength(1);
    expect(combinedMessageCenterBadge(before.unread_total, 1)).toBe(3);

    const beforeCount = await commCount();
    const res = await patch(ANN, { no_reply_needed: true });
    expect(res.status).toBe(200);
    const body = await res.json() as { no_reply_needed_at: string | null };
    expect(body.no_reply_needed_at).toBeTruthy();
    expect(await commCount()).toBe(beforeCount);

    const silenced = await list();
    const row = silenced.conversations.find((c) => c.client_id === ANN);
    expect(row?.unread_count).toBe(0);
    expect(row?.unread_override).toBe(false);
    expect(silenced.unread_total).toBe(0);
    expect(combinedMessageCenterBadge(silenced.unread_total, countUnreviewedMissedCalls(unassigned, []))).toBe(1);

    const marked = await patch(ANN, { unread: true });
    expect(marked.status).toBe(200);
    const markedList = await list();
    const markedRow = markedList.conversations.find((c) => c.client_id === ANN);
    expect(markedRow?.unread_count).toBe(0);
    expect(markedRow?.unread_override).toBe(true);
    expect(markedList.unread_total).toBe(1);
    expect(markedRow?.no_reply_needed_at).toBeTruthy();

    const threadRes = await handleSmsThread(env, ANN);
    const thread = await threadRes.json() as { unread_count: number; unread_override: boolean; messages: unknown[] };
    expect(thread.messages).toHaveLength(3);
    expect(thread.unread_override).toBe(false);
    expect(thread.unread_count).toBe(0);
    expect(await commCount()).toBe(beforeCount);
    const afterOpen = await list();
    expect(afterOpen.unread_total).toBe(0);

    await seedSms("in-later", ANN, "inbound", "Actually tomorrow changed", "2099-01-01 00:00:00");
    const again = await list();
    expect(again.conversations.find((c) => c.client_id === ANN)?.unread_count).toBe(1);
    expect(again.unread_total).toBe(1);
  });

  it("clears an archived unread without unarchiving or removing the row", async () => {
    await seedClient(ARCHIVED, "Pat");
    await seedSms("arch-in", ARCHIVED, "inbound", "Still waiting", "2026-10-12 08:00:00");
    const archived = await patch(ARCHIVED, { archived: true });
    expect(archived.status).toBe(200);

    const hidden = await list(false);
    expect(hidden.conversations.find((c) => c.client_id === ARCHIVED)).toBeUndefined();
    expect(hidden.unread_total).toBe(1);
    const shown = await list(true);
    expect(shown.conversations[0]?.unread_count).toBe(1);
    expect(shown.conversations[0]?.archived_at).toBeTruthy();

    const beforeCount = await commCount();
    await patch(ARCHIVED, { no_reply_needed: true });
    expect(await commCount()).toBe(beforeCount);

    const after = await list(false);
    expect(after.unread_total).toBe(0);
    const stillArchived = await list(true);
    expect(stillArchived.conversations).toHaveLength(1);
    expect(stillArchived.conversations[0]?.archived_at).toBeTruthy();
    expect(stillArchived.conversations[0]?.unread_count).toBe(0);
  });

  it("lets a reply work after no reply needed, then counts a newer inbound", async () => {
    await seedClient(REPLY, "Sam");
    await seedSms("reply-out", REPLY, "outbound", "On our way", "2026-10-11 23:01:27");
    await seedSms("reply-in", REPLY, "inbound", "Thanks", "2026-10-11 23:32:53");
    expect((await list()).unread_total).toBe(1);

    const beforeCount = await commCount();
    await patch(REPLY, { no_reply_needed: true });
    expect(await commCount()).toBe(beforeCount);
    expect((await list()).unread_total).toBe(0);

    const reply = await handleSmsReply(
      new Request("http://local/api/sms/reply", {
        method: "POST",
        body: JSON.stringify({ client_id: REPLY, body: "See you then" }),
      }),
      env,
    );
    expect(reply.status).toBe(200);
    expect(await commCount()).toBe(beforeCount + 1);
    expect((await list()).unread_total).toBe(0);

    await seedSms("reply-later", REPLY, "inbound", "Running late", "2099-01-01 00:00:00");
    expect((await list()).conversations.find((c) => c.client_id === REPLY)?.unread_count).toBe(1);
  });
});
