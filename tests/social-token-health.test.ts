import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/env.js";
import {
  decideTokenAlert,
  interpretDebugToken,
  redactSecrets,
  runSocialTokenHealth,
  summarizeTokenHealth,
  tokenAlertMessage,
  type DebugTokenPayload,
} from "../src/lib/social-token-health.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-21T07:15:00Z");

describe("social token health", () => {
  it("treats is_valid false as already expired", () => {
    expect(interpretDebugToken({ data: { is_valid: false, expires_at: 0 } }, NOW)).toEqual({
      verdict: "expired",
      daysLeft: null,
    });
  });

  it("treats a Graph 190 as an unusable token", () => {
    expect(
      interpretDebugToken({ error: { code: 190, message: "Cannot parse access token" } }, NOW).verdict,
    ).toBe("expired");
  });

  it("warns when a valid token expires within 7 days", () => {
    const expiresAt = Math.floor(NOW / 1000) + 5 * 86_400;
    const interpreted = interpretDebugToken({ data: { is_valid: true, expires_at: expiresAt } }, NOW);
    expect(interpreted.verdict).toBe("expiring");
    expect(interpreted.daysLeft).toBe(5);
    expect(tokenAlertMessage("facebook", "expiring", interpreted.daysLeft)).toBe(
      "Facebook/Instagram token expires in 5 days — regenerate it before publishing breaks.",
    );
  });

  it("stays quiet for a non-expiring page token", () => {
    expect(interpretDebugToken({ data: { is_valid: true, expires_at: 0 } }, NOW).verdict).toBe("ok");
  });

  it("alerts the first night, then waits 7 days, and clears after a healthy check", () => {
    const expired = summarizeTokenHealth({ verdict: "expired", daysLeft: null }, null);
    const first = decideTokenAlert(
      { problem: null, subject: null, last_alert_at: null },
      expired,
      new Date(NOW),
    );
    expect(first.notify).toBe(true);
    expect(first.next.problem).toBe("expired");

    const nextNight = decideTokenAlert(first.next, expired, new Date(NOW + 86_400_000));
    expect(nextNight.notify).toBe(false);

    const weekLater = decideTokenAlert(first.next, expired, new Date(NOW + 8 * 86_400_000));
    expect(weekLater.notify).toBe(true);

    const recovered = decideTokenAlert(weekLater.next, summarizeTokenHealth({ verdict: "ok", daysLeft: null }, null), new Date(NOW));
    expect(recovered.notify).toBe(false);
    expect(recovered.next).toEqual({ problem: null, subject: null, last_alert_at: null });
  });

  it("names Instagram when only that token is dead and the page token is fine", () => {
    const problem = summarizeTokenHealth(
      { verdict: "ok", daysLeft: null },
      { verdict: "expired", daysLeft: null },
    );
    expect(problem.health).toBe("expired");
    expect(problem.message).toBe(
      "Instagram access token is invalid — Instagram publishing is currently broken.",
    );
  });

  it("never puts a token into the alert or a logged error", async () => {
    const secret = "EAAB" + "x".repeat(40);
    const inserts: Array<{ sql: string; args: unknown[] }> = [];
    let stored: string | null = null;
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                first: async () => {
                  if (args[0] === "social_facebook_page_token") return { value: secret };
                  if (args[0] === "social_instagram_user_token") return { value: "" };
                  if (args[0] === "social_token_health_state") return stored ? { value: stored } : null;
                  return null;
                },
                run: async () => {
                  inserts.push({ sql, args });
                  if (sql.includes("Social token health")) stored = String(args[1]);
                },
              };
            },
            first: async () => ({
              id: "owner-1",
              email: "tony@homesolutionsar.com",
              first_name: "Tony",
              last_name: null,
              phone: null,
            }),
          };
        },
      },
    } as unknown as Env;

    const debug = async (): Promise<DebugTokenPayload> => ({
      error: { code: 190, message: `Session has expired. token=${secret}` },
    });
    const result = await runSocialTokenHealth(env, { now: new Date(NOW), debug });
    expect(result.notified).toBe(true);
    expect(result.message).toBe(
      "Facebook/Instagram token has expired — social publishing is currently broken.",
    );
    const dumped = JSON.stringify(inserts);
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toMatch(/EAAB/);

    const again = await runSocialTokenHealth(env, {
      now: new Date(NOW + 86_400_000),
      debug,
    });
    expect(again.notified).toBe(false);
  });

  it("redacts a token that leaks into an error string", () => {
    const secret = "EAAG" + "z".repeat(30);
    expect(redactSecrets(`failed ${secret} end`, [secret])).toBe("failed [redacted] end");
  });

  it("does not add a cron trigger", () => {
    const toml = readFileSync(join(repoRoot, "wrangler.toml"), "utf8");
    const crons = toml.slice(toml.indexOf("crons = ["), toml.indexOf("]", toml.indexOf("crons = [")));
    expect(crons.match(/"/g)?.length).toBe(10);
    const src = readFileSync(join(repoRoot, "src/index.ts"), "utf8");
    expect(src).toContain("runSocialTokenHealth");
    expect(src).not.toMatch(/social_token_health[\s\S]{0,80}crons/);
  });
});
