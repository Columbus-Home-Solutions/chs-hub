import { describe, expect, it } from "vitest";
import {
  allocateNextInvoiceNumber,
  allocateNextJobNumber,
  allocateNextRequestNumber,
  NEXT_INVOICE_NUMBER_KEY,
  NEXT_JOB_NUMBER_KEY,
  NEXT_REQUEST_NUMBER_KEY,
} from "../src/lib/number-counters.js";
import type { Env } from "../src/env.js";

type SettingRow = { key: string; value: string };
type EntityRow = { id: string; number: number };

/**
 * Fake D1 that stores counter rows + entity rows. DELETE removes an entity
 * without touching the counter — so the next allocate must not go backward.
 */
function makeCounterEnv(opts: {
  counterKey: string;
  initialNext: number;
  entities: EntityRow[];
}) {
  const settings = new Map<string, string>([[opts.counterKey, String(opts.initialNext)]]);
  const entities = [...opts.entities];
  const statements: string[] = [];

  const env = {
    DB: {
      prepare(sql: string) {
        return {
          _binds: [] as unknown[],
          bind(...binds: unknown[]) {
            this._binds = binds;
            return this;
          },
          async first<T>() {
            statements.push(sql);
            if (sql.includes("UPDATE system_settings") && sql.includes("RETURNING")) {
              const key = this._binds[0] as string;
              const cur = Number.parseInt(settings.get(key) ?? "", 10);
              if (!Number.isFinite(cur) || cur < 1) return null;
              settings.set(key, String(cur + 1));
              return { n: cur } as T;
            }
            if (sql.includes("MAX(request_number)") || sql.includes("MAX(job_number)") || sql.includes("MAX(invoice_number)")) {
              const max = entities.reduce((m, e) => Math.max(m, e.number), 0);
              return { n: max } as T;
            }
            if (sql.includes("FROM system_settings") && sql.includes("WHERE key")) {
              const key = this._binds[0] as string;
              const value = settings.get(key);
              return value != null ? ({ value } as T) : null;
            }
            return null;
          },
          async run() {
            statements.push(sql);
            if (sql.includes("INSERT OR IGNORE INTO system_settings") || sql.includes("INSERT INTO system_settings")) {
              const key = this._binds[0] as string;
              const value = String(this._binds[1]);
              if (!settings.has(key)) settings.set(key, value);
              return { success: true, meta: { changes: settings.has(key) ? 0 : 1 } };
            }
            if (sql.includes("UPDATE system_settings") && !sql.includes("RETURNING")) {
              const value = String(this._binds[0]);
              const key = this._binds[2] as string;
              settings.set(key, value);
              return { success: true, meta: { changes: 1 } };
            }
            if (sql.includes("DELETE FROM")) {
              const id = this._binds[0] as string;
              const idx = entities.findIndex((e) => e.id === id);
              if (idx >= 0) entities.splice(idx, 1);
              return { success: true, meta: { changes: idx >= 0 ? 1 : 0 } };
            }
            if (sql.includes("INSERT INTO estimate_requests") || sql.includes("INSERT INTO jobs") || sql.includes("INSERT INTO invoices")) {
              entities.push({ id: this._binds[0] as string, number: this._binds[1] as number });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          },
        };
      },
    },
  } as unknown as Env;

  return { env, settings, entities, statements };
}

describe("monotonic number counters", () => {
  it("request_number does not go backward after a delete", async () => {
    const { env, settings, entities } = makeCounterEnv({
      counterKey: NEXT_REQUEST_NUMBER_KEY,
      initialNext: 99202, // seeded to MAX+1 after reuse bug (MAX was 99201)
      entities: [
        { id: "ryan", number: 99201 },
        { id: "other", number: 99100 },
      ],
    });

    const a = await allocateNextRequestNumber(env);
    expect(a).toBe(99202);
    expect(settings.get(NEXT_REQUEST_NUMBER_KEY)).toBe("99203");
    entities.push({ id: "new-a", number: a });

    // Simulate deleting a request — entity gone, counter untouched.
    const idx = entities.findIndex((e) => e.id === "ryan");
    entities.splice(idx, 1);
    expect(entities.some((e) => e.number === 99201)).toBe(false);

    const b = await allocateNextRequestNumber(env);
    expect(b).toBe(99203);
    expect(b).toBeGreaterThan(a);
    // Must NOT reuse 99201 just because it is now free in the table.
    expect(b).not.toBe(99201);
  });

  it("job_number and invoice_number stay monotonic after deletes", async () => {
    const jobs = makeCounterEnv({
      counterKey: NEXT_JOB_NUMBER_KEY,
      initialNext: 105,
      entities: [{ id: "j1", number: 104 }],
    });
    const n1 = await allocateNextJobNumber(jobs.env);
    jobs.entities.splice(0, 1); // delete job 104
    const n2 = await allocateNextJobNumber(jobs.env);
    expect(n1).toBe(105);
    expect(n2).toBe(106);

    const inv = makeCounterEnv({
      counterKey: NEXT_INVOICE_NUMBER_KEY,
      initialNext: 2,
      entities: [{ id: "i1", number: 1 }],
    });
    const i1 = await allocateNextInvoiceNumber(inv.env);
    inv.entities.splice(0, 1);
    const i2 = await allocateNextInvoiceNumber(inv.env);
    expect(i1).toBe(2);
    expect(i2).toBe(3);
  });

  it("bootstraps from MAX when the counter row is missing", async () => {
    const settings = new Map<string, string>();
    let maxRequest = 50;
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            _binds: [] as unknown[],
            bind(...binds: unknown[]) {
              this._binds = binds;
              return this;
            },
            async first<T>() {
              if (sql.includes("UPDATE system_settings") && sql.includes("RETURNING")) {
                const key = this._binds[0] as string;
                const cur = Number.parseInt(settings.get(key) ?? "", 10);
                if (!Number.isFinite(cur) || cur < 1) return null;
                settings.set(key, String(cur + 1));
                return { n: cur } as T;
              }
              if (sql.includes("MAX(request_number)")) {
                return { n: maxRequest } as T;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO system_settings")) {
                const key = this._binds[0] as string;
                const value = String(this._binds[1]);
                if (!settings.has(key)) settings.set(key, value);
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;

    const n = await allocateNextRequestNumber(env);
    expect(n).toBe(51);
    expect(settings.get(NEXT_REQUEST_NUMBER_KEY)).toBe("52");

    // Delete the entity that held 50 — next must still be 52, not 50.
    maxRequest = 49;
    const n2 = await allocateNextRequestNumber(env);
    expect(n2).toBe(52);
  });
});
