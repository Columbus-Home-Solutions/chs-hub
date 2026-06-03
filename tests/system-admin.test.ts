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

  it("seeds the 5 S15 document templates by their prod ids", () => {
    for (const id of [
      "seed-tpl-s15-service",
      "seed-tpl-s15-costplus",
      "seed-tpl-s15-changeorder",
      "seed-tpl-s15-lienwaiver",
      "seed-tpl-s15-warranty",
    ]) {
      expect(sql).toContain(id);
    }
  });

  it("seeds the completion-package template with the reconciled key", () => {
    expect(sql).toContain("seed-ntpl-s15-cp");
    expect(sql).toContain("completion_package_sent");
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
