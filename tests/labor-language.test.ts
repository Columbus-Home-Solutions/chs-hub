import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  dayRateMessage,
  inviteText,
  retranslateQueuedDayRate,
  smsSegmentCount,
  workerLang,
} from "../src/lib/day-rate-notify.js";
import { handleWorkerLanguage } from "../src/routes/labor-checkin.js";
import { t } from "../frontend/src/lib/worker-copy.ts";

const LINK = "https://client.homesolutionsar.com/sub/abc";

function db(handler: (sql: string) => { first?: () => unknown; all?: () => unknown; run?: (binds: unknown[]) => unknown }): Env {
  return {
    DB: {
      prepare(sql: string) {
        const row = handler(sql);
        const bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound.splice(0, bound.length, ...args);
            return this;
          },
          async first() {
            return row.first ? row.first() : null;
          },
          async all() {
            return row.all ? row.all() : { results: [] };
          },
          async run() {
            return row.run ? row.run(bound) : { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
  } as unknown as Env;
}

const dayRate = {
  token: "tok-long-enough",
  sub_id: "w1",
  disabled_at: null,
  worker_type: "day_rate_labor",
  is_active: 1,
  contact_name: "Maria",
  company_name: "ZZ",
  preferred_language: "en",
};

describe("worker language", () => {
  it("defaults to English", () => {
    expect(workerLang(null)).toBe("en");
    expect(workerLang(undefined)).toBe("en");
    expect(workerLang("en")).toBe("en");
  });

  it("writes Spanish texts with STOP still in English and leaves the job name as typed", () => {
    const added = dayRateMessage({
      kind: "schedule",
      count: 1,
      label: "102 Kitchen Repair",
      when: "2026-10-05",
      added: true,
      link: LINK,
      language: "es",
    });
    expect(added).toContain("Tony agregó 102 Kitchen Repair");
    expect(added).toContain("lun");
    expect(added).toContain("oct");
    expect(added).toContain("STOP");
    expect(added).not.toContain("Reply STOP");
    const several = dayRateMessage({ kind: "schedule", count: 3, label: "102 Kitchen Repair", link: LINK, language: "es" });
    expect(several).toContain("(3 cambios)");
    const delay = dayRateMessage({
      kind: "schedule",
      count: 1,
      label: "104 Bath Remodel",
      when: "2026-10-05",
      status: "weather_delay",
      link: LINK,
      language: "es",
    });
    expect(delay).toContain("retraso por clima");
    expect(delay).toContain("104 Bath Remodel");
    const punch = dayRateMessage({ kind: "punch", count: 1, label: "101 Pergola Repair", link: LINK, language: "es" });
    expect(punch).toContain("Nuevo pendiente en 101 Pergola Repair");
    expect(punch).toContain("/punch");
  });

  it("keeps an English worker on the English invite and text", () => {
    expect(inviteText(LINK, "en")).toContain("Full day or Half day");
    expect(inviteText(LINK, null)).toContain("Tony here");
    expect(dayRateMessage({ kind: "schedule", count: 2, label: "102 Kitchen Repair", link: LINK })).toContain("(2 changes)");
  });

  it("counts the longest Spanish text in UCS-2 because of accents", () => {
    const samples = [
      dayRateMessage({ kind: "schedule", count: 1, label: "102 Kitchen Repair", when: "2026-10-05", added: true, link: LINK, language: "es" }),
      dayRateMessage({ kind: "schedule", count: 3, label: "102 Kitchen Repair", link: LINK, language: "es" }),
      dayRateMessage({ kind: "schedule", count: 1, label: "104 Bath Remodel", when: "2026-10-05", status: "weather_delay", link: LINK, language: "es" }),
      dayRateMessage({ kind: "punch", count: 1, label: "101 Pergola Repair", link: LINK, language: "es" }),
      inviteText(LINK, "es"),
    ];
    const texts = samples.slice(0, 4);
    const counted = texts.map((text) => ({ text, ...smsSegmentCount(text) }));
    const longest = counted.sort((a, b) => b.text.length - a.text.length)[0];
    expect(longest.encoding).toBe("ucs2");
    expect(longest.segments).toBe(smsSegmentCount(longest.text).segments);
    expect(longest.text).toContain("STOP");
    expect(longest.segments).toBeGreaterThanOrEqual(2);
    expect(longest.segments).toBe(3);
    expect(smsSegmentCount(samples[4]).encoding).toBe("ucs2");
  });

  it("rewrites a held message when the language changes before release", async () => {
    const payload = {
      kind: "schedule",
      count: 1,
      label: "102 Kitchen Repair",
      when: "2026-10-05",
      added: true,
      link: LINK,
    };
    let saved = "";
    const env = db((sql) => ({
      first: () => (sql.includes("FROM subcontractors") ? { phone: "5015550100", email: null, preferred_language: "es" } : null),
      all: () => ({ results: [{ id: "n1", error_message: JSON.stringify(payload) }] }),
      run: (binds) => {
        saved = String(binds[0]);
        return { success: true };
      },
    }));
    await retranslateQueuedDayRate(env, "w1");
    expect(saved).toContain("agregó");
    expect(saved).toContain("102 Kitchen Repair");
    expect(saved).toContain("STOP");
  });

  it("saves the worker's own toggle and rejects anything else", async () => {
    let saved = "";
    const env = db((sql) => ({
      first: () => (sql.includes("FROM sub_access_tokens") ? dayRate : null),
      run: (binds) => {
        saved = String(binds[0]);
        return { success: true };
      },
      all: () => ({ results: [] }),
    }));
    const ok = await handleWorkerLanguage(env, "tok-long-enough", new Request("https://client.example/api/sub/tok/language", {
      method: "PUT",
      body: JSON.stringify({ language: "es" }),
    }));
    expect(ok.status).toBe(200);
    expect(saved).toBe("es");
    const bad = await handleWorkerLanguage(env, "tok-long-enough", new Request("https://client.example/api/sub/tok/language", {
      method: "PUT",
      body: JSON.stringify({ language: "fr" }),
    }));
    expect(bad.status).toBe(400);
  });

  it("uses the generic 404 for a bad token and refuses a true subcontractor", async () => {
    const missing = db(() => ({ first: () => null }));
    const gone = await handleWorkerLanguage(missing, "tok-long-enough", new Request("https://client.example/language", {
      method: "PUT",
      body: JSON.stringify({ language: "es" }),
    }));
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: string }).error).toBe("not_found");

    const sub = db((sql) => ({
      first: () => (sql.includes("FROM sub_access_tokens") ? { ...dayRate, worker_type: "subcontractor" } : null),
    }));
    const denied = await handleWorkerLanguage(sub, "tok-long-enough", new Request("https://client.example/language", {
      method: "PUT",
      body: JSON.stringify({ language: "es" }),
    }));
    expect(denied.status).toBe(404);
    expect(((await denied.json()) as { error: string }).error).toBe("not_available");
  });

  it("falls back to English when a Spanish key is missing", () => {
    expect(t("es", "full_day")).toBe("Día completo");
    expect(t("es", "only_en")).toBe("English only");
  });
});
