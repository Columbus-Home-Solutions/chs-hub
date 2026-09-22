import { describe, expect, it } from "vitest";
import {
  captureGoogleLsaLead,
  GOOGLE_LSA_UNMATCHED_CONTACT_NAME,
  phonesMatchTracking,
} from "../src/lib/google-lsa-capture.js";
import { LEAD_OUTREACH_CANDIDATE_SQL } from "../src/lib/new-lead-outreach.js";
import { scorePhoneCloseness } from "../src/lib/twilio-lsa-number.js";
import { buildForwardDialTwiml } from "../src/lib/twilio-voice-twiml.js";
import type { Env } from "../src/env.js";

interface ClientRow {
  id: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  lead_source: string | null;
  created_by: string | null;
}

interface EstimateRequestRow {
  id: string;
  request_number: number;
  status: string;
  client_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  source: string;
  created_at: string;
}

function last10(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? digits : "";
}

function makeCaptureEnv(seed?: { clients?: ClientRow[]; requests?: EstimateRequestRow[] }) {
  const clients: ClientRow[] = [...(seed?.clients ?? [])];
  const requests: EstimateRequestRow[] = [...(seed?.requests ?? [])];
  const settings = new Map<string, string>([["next_request_number", "100"]]);

  const db = {
    prepare(sql: string) {
      return {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async first() {
          if (sql.includes("FROM estimate_requests er") && sql.includes("LEFT JOIN clients")) {
            const phone10 = this._args[0] as string;
            const matches = requests
              .filter((er) => {
                if (er.source !== "google_lsa") return false;
                if (er.status === "won" || er.status === "lost") return false;
                const erPhone = last10(er.contact_phone);
                const client = clients.find((c) => c.id === er.client_id);
                const cPhone = last10(client?.phone);
                return erPhone === phone10 || cPhone === phone10;
              })
              .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
            const row = matches[0];
            return row ? { id: row.id, client_id: row.client_id } : null;
          }
          if (sql.includes("FROM clients") && sql.includes("substr(replace")) {
            const phone10 = this._args[0] as string;
            const c = clients.find((cl) => last10(cl.phone) === phone10);
            return c ? { id: c.id, first_name: c.first_name, last_name: c.last_name } : null;
          }
          if (sql.includes("UPDATE system_settings") && sql.includes("RETURNING")) {
            const key = this._args[0] as string;
            const cur = Number.parseInt(settings.get(key) ?? "", 10);
            if (!Number.isFinite(cur) || cur < 1) return null;
            settings.set(key, String(cur + 1));
            return { n: cur };
          }
          if (sql.includes("MAX(request_number)")) {
            return { n: requests.reduce((m, r) => Math.max(m, r.request_number), 0) };
          }
          if (sql.includes("FROM users")) return null;
          return null;
        },
        async run() {
          if (sql.includes("INSERT OR IGNORE INTO system_settings")) {
            const key = this._args[0] as string;
            const value = String(this._args[1]);
            if (!settings.has(key)) settings.set(key, value);
            return { success: true, meta: {} };
          }
          if (sql.includes("INSERT INTO clients")) {
            clients.push({
              id: this._args[0] as string,
              phone: this._args[1] as string,
              first_name: null,
              last_name: null,
              lead_source: this._args[2] as string,
              created_by: this._args[5] as string,
            });
          } else if (sql.includes("INSERT INTO estimate_requests")) {
            requests.push({
              id: this._args[0] as string,
              request_number: this._args[1] as number,
              status: "new_request",
              client_id: this._args[2] as string,
              contact_name: this._args[3] as string | null,
              contact_phone: this._args[4] as string,
              source: "google_lsa",
              created_at: (this._args[6] as string) ?? new Date().toISOString(),
            });
          }
          return { success: true, meta: {} };
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };

  return { env: { DB: db } as unknown as Env, clients, requests };
}

const UNKNOWN_FROM = "+15015550001";
const LSA_TO = "+15012632058";


describe("phonesMatchTracking", () => {
  it("matches last-10 regardless of formatting", () => {
    expect(phonesMatchTracking("+15012632050", "(501) 263-2050")).toBe(true);
    expect(phonesMatchTracking("+15015511814", "501-263-2050")).toBe(false);
    expect(phonesMatchTracking("", "5012632050")).toBe(false);
  });
});

describe("scorePhoneCloseness", () => {
  it("scores an exact match highest", () => {
    expect(scorePhoneCloseness("5012632050")).toBeGreaterThan(scorePhoneCloseness("5012632049"));
    expect(scorePhoneCloseness("5012632049")).toBeGreaterThan(scorePhoneCloseness("5013704686"));
  });

  it("prefers the same 501-263 prefix over a random 501", () => {
    expect(scorePhoneCloseness("+15012639999")).toBeGreaterThan(scorePhoneCloseness("+15015511814"));
  });
});

describe("buildForwardDialTwiml", () => {
  it("dials immediately with no whisper, Gather, or Hangup", () => {
    const xml = buildForwardDialTwiml("+15015511814");
    expect(xml).toContain("<Dial>");
    expect(xml).toContain("+15015511814");
    expect(xml).not.toContain("url=");
    expect(xml).not.toContain("<Gather");
    expect(xml).not.toContain("<Hangup");
  });

  it("may attach a Dial-complete action without delaying the Dial", () => {
    const xml = buildForwardDialTwiml(
      "+15015511814",
      "https://client.homesolutionsar.com/api/webhooks/twilio/call-status?lsa=1&x=1",
    );
    expect(xml).toContain("<Dial action=");
    expect(xml).toContain("lsa=1");
    expect(xml).toContain("<Number>+15015511814</Number>");
    expect(xml).not.toContain("<Gather");
    expect(xml).not.toContain("<Hangup");
    expect(xml).not.toContain("<Say");
    const actionAttr = xml.match(/action="([^"]+)"/)?.[1] ?? "";
    expect(actionAttr).toContain("&amp;");
    expect(actionAttr).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("XML-escapes the forward number", () => {
    const xml = buildForwardDialTwiml("<+1>");
    expect(xml).toContain("&lt;+1&gt;");
  });
});

describe("captureGoogleLsaLead — phone-only client on no match", () => {
  it("creates a phone-only client and links estimate_requests.client_id", async () => {
    const { env, clients, requests } = makeCaptureEnv();
    const result = await captureGoogleLsaLead(env, {
      from: UNKNOWN_FROM,
      to: LSA_TO,
      callSid: "CA-new",
    });

    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.clientId).toBeTruthy();
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe(result.clientId);
    expect(clients[0].phone).toBe(UNKNOWN_FROM);
    expect(clients[0].first_name).toBeNull();
    expect(clients[0].last_name).toBeNull();
    expect(clients[0].lead_source).toBe("google_lsa");
    expect(clients[0].created_by).toBe("twilio_lsa_webhook");
    expect(JSON.stringify(clients[0])).not.toContain("Unknown Caller");

    expect(requests).toHaveLength(1);
    expect(requests[0].client_id).toBe(result.clientId);
    expect(requests[0].contact_name).toBe(GOOGLE_LSA_UNMATCHED_CONTACT_NAME);
    expect(requests[0].contact_name).toBe("Google LSA Lead");
  });

  it("dedupes a second call while the LSA lead is still open — no second client", async () => {
    const { env, clients, requests } = makeCaptureEnv();
    const first = await captureGoogleLsaLead(env, {
      from: UNKNOWN_FROM,
      to: LSA_TO,
      callSid: "CA-1",
    });
    const second = await captureGoogleLsaLead(env, {
      from: UNKNOWN_FROM,
      to: LSA_TO,
      callSid: "CA-2",
    });

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("deduped");
    if (first.kind !== "created" || second.kind !== "deduped") return;
    expect(second.requestId).toBe(first.requestId);
    expect(second.clientId).toBe(first.clientId);
    expect(clients).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("after the first lead is closed, a second call matches the existing client", async () => {
    const { env, clients, requests } = makeCaptureEnv();
    const first = await captureGoogleLsaLead(env, {
      from: UNKNOWN_FROM,
      to: LSA_TO,
      callSid: "CA-open",
    });
    expect(first.kind).toBe("created");
    requests[0].status = "lost";

    const second = await captureGoogleLsaLead(env, {
      from: UNKNOWN_FROM,
      to: LSA_TO,
      callSid: "CA-again",
    });

    expect(second.kind).toBe("created");
    if (first.kind !== "created" || second.kind !== "created") return;
    expect(second.clientId).toBe(first.clientId);
    expect(clients).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].client_id).toBe(first.clientId);
    // Matched path uses the real client name (blank), not the unmatched Kanban label.
    expect(requests[1].contact_name).toBeNull();
    expect(clients[0].first_name).toBeNull();
  });

  it("uses the real client name on contact_name when the phone already matches", async () => {
    const { env, requests } = makeCaptureEnv({
      clients: [
        {
          id: "c-betty",
          phone: "(501) 555-0001",
          first_name: "Betty",
          last_name: "Jones",
          lead_source: "manual",
          created_by: "owner",
        },
      ],
    });
    const result = await captureGoogleLsaLead(env, {
      from: UNKNOWN_FROM,
      to: LSA_TO,
      callSid: "CA-match",
    });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.clientId).toBe("c-betty");
    expect(requests[0].contact_name).toBe("Betty Jones");
  });
});

describe("LEAD_OUTREACH_CANDIDATE_SQL", () => {
  it("INNER JOINs clients so a linked client_id is required for outreach", () => {
    expect(LEAD_OUTREACH_CANDIDATE_SQL).toMatch(/JOIN clients c ON c\.id = er\.client_id/);
    expect(LEAD_OUTREACH_CANDIDATE_SQL).not.toMatch(/LEFT\s+JOIN\s+clients/i);
  });
});

describe("CHS Leads Kanban pipeline sort", () => {
  it("orders by datetime() so ISO and SQLite timestamp formats don't invert newest-first", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../src/routes/estimate-requests.ts", import.meta.url), "utf8");
    expect(src).toMatch(/ORDER BY datetime\(er\.updated_at\) DESC/);
  });
});

describe("LSA Dial status callback", () => {
  it("logs DialCallStatus on the LSA path and never runs missed-call SMS", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../src/routes/webhooks-twilio.ts", import.meta.url), "utf8");
    expect(src).toMatch(/searchParams\.get\("lsa"\) === "1"/);
    expect(src).toMatch(/twilio_lsa_dial_status/);
    const lsaBranch = src.slice(src.indexOf('searchParams.get("lsa")'));
    const missedIdx = lsaBranch.indexOf("handleMissedCall");
    const returnIdx = lsaBranch.indexOf("return twiml()");
    expect(returnIdx).toBeGreaterThan(0);
    expect(missedIdx).toBeGreaterThan(returnIdx);
  });
});
