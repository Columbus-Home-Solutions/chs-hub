import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("0038_prod_parity_seed migration", () => {
  const sql = read("migrations/0038_prod_parity_seed.sql");

  it("is idempotent — INSERT OR IGNORE only, never OR REPLACE", () => {
    expect(sql).toMatch(/INSERT OR IGNORE INTO/);
    // No actual OR REPLACE statement (the header comment warns against it, which
    // is fine — we only forbid the executable form `... OR REPLACE INTO`).
    expect(sql).not.toMatch(/OR REPLACE INTO/i);
  });

  it("seeds the 5 S15 document templates by their exact prod ids", () => {
    // These must match the ids hand-inserted on prod (verified via remote
    // PRAGMA during the S17 deploy) so INSERT OR IGNORE is a true no-op there.
    for (const id of [
      "'tpl-s15-service'",
      "'tpl-s15-costplus'",
      "'tpl-s15-changeorder'",
      "'tpl-s15-lienwaiver'",
      "'tpl-s15-warranty'",
    ]) {
      expect(sql).toContain(id);
    }
    // Guard against the local-only `seed-` prefix sneaking back in.
    expect(sql).not.toContain("seed-tpl-s15-");
  });

  it("seeds the completion-package template with the reconciled key + prod id", () => {
    expect(sql).toContain("nt-completion-package-sent-email");
    expect(sql).toContain("completion_package_sent");
    expect(sql).not.toContain("seed-ntpl-s15-cp");
  });

  it("seeds the 3 social system_settings respecting value_type", () => {
    expect(sql).toContain("social_brand_voice");
    expect(sql).toMatch(/'social_publish_mode', 'SIMULATE', 'string'/);
    expect(sql).toMatch(/'social_image_gen_count', '\{\}', 'json'/);
  });

  it("contains no schema ALTER (data seed only)", () => {
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });
});

describe("completion_package_sent naming reconcile", () => {
  it("the live send path fires completion_package_sent", () => {
    const route = read("src/routes/completion-package.ts");
    expect(route).toContain('"completion_package_sent"');
  });

  it("the notification engine treats completion_package_sent as transactional", () => {
    const engine = read("src/lib/notification-engine.ts");
    // The TRANSACTIONAL_EVENTS set must include the reconciled key.
    expect(engine).toContain('"completion_package_sent"');
  });
});

describe("dev seed is gitignored, not staged", () => {
  it("scripts/*.local.sql is ignored", () => {
    const gitignore = read(".gitignore");
    expect(gitignore).toContain("scripts/*.local.sql");
  });
});
