import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleTwilioInbound, TWILIO_INBOUND_PUBLIC_URL } from "../src/routes/webhooks-twilio.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_URL = "https://client.homesolutionsar.com/api/webhooks/twilio/inbound";

const WORKER = {
  id: "w1",
  worker_type: "day_rate_labor",
  name: "Test Worker",
};
const CLIENT = {
  id: "c1",
  name: null,
  first_name: "Pat",
  last_name: "Client",
};
const OWNER = {
  id: "u1",
  email: "owner@example.com",
  first_name: "Tony",
  last_name: "C",
  phone: null,
};

function scripted(opts: { workers?: unknown[]; client?: unknown | null }): {
  env: Env;
  writes: { sql: string; args: unknown[] }[];
} {
  const writes: { sql: string; args: unknown[] }[] = [];
  const env = {
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "token",
    TWILIO_FROM_NUMBER: "+15015550199",
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            args = bound;
            return this;
          },
          async first() {
            if (sql.includes("FROM subcontractors")) return opts.workers?.[0] ?? null;
            if (sql.includes("role = 'owner'")) return OWNER;
            if (sql.includes("FROM clients") && sql.includes("notification_preferences")) {
              return { notification_preferences: null };
            }
            if (sql.includes("FROM clients")) return opts.client ?? null;
            return null;
          },
          async all() {
            if (sql.includes("FROM subcontractors")) return { results: opts.workers ?? [] };
            return { results: [] };
          },
          async run() {
            writes.push({ sql, args });
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, writes };
}

async function sign(url: string, params: Array<[string, string]>, token: string): Promise<string> {
  const sorted = [...params].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let data = url;
  for (const [key, value] of sorted) data += key + value;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

async function post(
  env: Env,
  fields: Record<string, string>,
  signature: string | null,
): Promise<Response> {
  const params = Object.entries(fields);
  const req = new Request(PUBLIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(signature ? { "X-Twilio-Signature": signature } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
  void params;
  return handleTwilioInbound(req, env);
}

function messages(xml: string): number {
  return xml.match(/<Message>/g)?.length ?? 0;
}

function inserted(writes: { sql: string }[], table: string): boolean {
  return writes.some((w) => w.sql.includes(`INSERT INTO ${table}`));
}

describe("inbound SMS is worker-aware", () => {
  it("worker STOP turns the switch off, cancels queued rows, bells, and sends no CHS confirmation", async () => {
    const { env, writes } = scripted({ workers: [WORKER] });
    const fields = { From: "+15015550100", Body: "Stop.", OptOutType: "STOP", MessageSid: "SMSTOP" };
    const res = await post(env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
    const xml = await res.text();
    expect(res.status).toBe(200);
    expect(messages(xml)).toBe(0);
    expect(writes.some((w) => w.sql.includes("text_updates_enabled = 0") && w.sql.includes("inbound_stop"))).toBe(true);
    expect(writes.some((w) => w.args.includes("suppressed:inbound_stop"))).toBe(true);
    expect(writes.some((w) => w.args.includes("Worker STOP: text updates turned off."))).toBe(true);
    expect(inserted(writes, "clients")).toBe(false);
    expect(inserted(writes, "estimate_requests")).toBe(false);
  });

  it("worker START or YES leaves the switch off and bells", async () => {
    for (const body of ["START", "YES"]) {
      const { env, writes } = scripted({ workers: [WORKER] });
      const fields = { From: "+15015550100", Body: body, MessageSid: `SM${body}` };
      const res = await post(env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
      expect(res.status).toBe(200);
      expect(messages(await res.text())).toBe(0);
      expect(writes.some((w) => w.sql.includes("text_updates_enabled"))).toBe(false);
      expect(writes.some((w) => w.args.includes("Worker replied START: switch is still OFF until you turn it on."))).toBe(true);
      expect(writes.some((w) => w.sql.includes("audit_logs") && w.args.includes("worker_text_start"))).toBe(true);
    }
  });

  it("a plain worker reply is logged and belled and does not create a lead", async () => {
    const { env, writes } = scripted({ workers: [WORKER], client: CLIENT });
    const fields = { From: "+15015550100", Body: "ok", MessageSid: "SMOK" };
    const res = await post(env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.args.includes("Worker reply: ok"))).toBe(true);
    expect(writes.some((w) => w.args.includes("worker_text_reply") && w.args.includes("w1"))).toBe(true);
    expect(inserted(writes, "clients")).toBe(false);
    expect(inserted(writes, "estimate_requests")).toBe(false);
    expect(inserted(writes, "communications")).toBe(false);
  });

  it("a number that is both a client and a worker opts out both, with one confirmation at most", async () => {
    const withType = scripted({ workers: [WORKER], client: CLIENT });
    const typed = { From: "+15015550100", Body: "STOP", OptOutType: "STOP", MessageSid: "SMBOTH1" };
    const typedRes = await post(withType.env, typed, await sign(PUBLIC_URL, Object.entries(typed), "token"));
    expect(messages(await typedRes.text())).toBe(0);
    expect(withType.writes.some((w) => w.sql.includes("text_updates_enabled = 0"))).toBe(true);
    expect(withType.writes.some((w) => w.sql.includes("sms_opt_out = 1"))).toBe(true);

    const plain = scripted({ workers: [WORKER], client: CLIENT });
    const fields = { From: "+15015550100", Body: "STOP", MessageSid: "SMBOTH2" };
    const res = await post(plain.env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
    expect(messages(await res.text())).toBe(1);
    expect(plain.writes.some((w) => w.sql.includes("sms_opt_out = 1"))).toBe(true);
    expect(plain.writes.some((w) => w.sql.includes("text_updates_enabled = 0"))).toBe(true);
  });

  it("a client STOP keeps its confirmation unless OptOutType says Twilio already replied", async () => {
    const typed = scripted({ client: CLIENT });
    const typedFields = { From: "+15015550100", Body: "STOP", OptOutType: "STOP", MessageSid: "SMCLIENT1" };
    const typedRes = await post(typed.env, typedFields, await sign(PUBLIC_URL, Object.entries(typedFields), "token"));
    expect(messages(await typedRes.text())).toBe(0);
    expect(typed.writes.some((w) => w.sql.includes("sms_opt_out = 1"))).toBe(true);

    const plain = scripted({ client: CLIENT });
    const fields = { From: "+15015550100", Body: "STOP", MessageSid: "SMCLIENT2" };
    const res = await post(plain.env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
    const xml = await res.text();
    expect(messages(xml)).toBe(1);
    expect(xml).toContain("unsubscribed");
  });

  it("an unknown keyword creates no lead, and an unknown plain reply still does", async () => {
    for (const body of ["STOP", "START", "HELP"]) {
      const { env, writes } = scripted({});
      const fields = { From: "+15015550100", Body: body, MessageSid: `SMU${body}` };
      await post(env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
      expect(inserted(writes, "clients")).toBe(false);
      expect(inserted(writes, "estimate_requests")).toBe(false);
    }
    const { env, writes } = scripted({});
    const fields = { From: "+15015550100", Body: "ok", MessageSid: "SMUOK" };
    await post(env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
    expect(inserted(writes, "clients")).toBe(true);
    expect(inserted(writes, "estimate_requests")).toBe(true);
  });

  it("treats OptOutType STOP as STOP even when the body is not a keyword", async () => {
    const { env, writes } = scripted({ workers: [WORKER] });
    const fields = { From: "+15015550100", Body: "stop please", OptOutType: "STOP", MessageSid: "SMODD" };
    await post(env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
    expect(writes.some((w) => w.sql.includes("text_updates_enabled = 0"))).toBe(true);
    expect(inserted(writes, "estimate_requests")).toBe(false);
  });
});

describe("inbound webhook exposure and signature", () => {
  it("exposes only the inbound path on the public client host", () => {
    expect(TWILIO_INBOUND_PUBLIC_URL).toBe(PUBLIC_URL);
    const src = readFileSync(join(repoRoot, "src/index.ts"), "utf8");
    const guard = src.slice(
      src.indexOf('url.hostname === "client.homesolutionsar.com"'),
      src.indexOf("if (!allowed)"),
    );
    expect(guard).toContain('p === "/api/webhooks/twilio/inbound"');
    expect(guard).not.toContain("/api/webhooks/twilio/status");
  });

  it("accepts a valid signature, rejects a bad one with 403, and returns 503 with no token", async () => {
    const fields = { From: "+15015550100", Body: "STOP", MessageSid: "SMSIG" };
    const good = scripted({});
    const ok = await post(good.env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
    expect(ok.status).toBe(200);

    const bad = scripted({ workers: [WORKER] });
    const rejected = await post(bad.env, fields, "not-a-signature");
    expect(rejected.status).toBe(403);
    expect(bad.writes.some((w) => w.sql.includes("text_updates_enabled"))).toBe(false);

    const missing = scripted({});
    missing.env.TWILIO_AUTH_TOKEN = "";
    missing.env.TWILIO_ACCOUNT_SID = "";
    missing.env.TWILIO_FROM_NUMBER = "";
    const unconfigured = await post(missing.env, fields, await sign(PUBLIC_URL, Object.entries(fields), "token"));
    expect(unconfigured.status).toBe(503);
  });
});
