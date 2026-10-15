import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

vi.mock("../src/lib/notification-engine.js", () => ({
  triggerNotification: vi.fn(async () => ({ enqueued: 0, reasons: [] })),
  notifySignatureNeeded: vi.fn(async () => {}),
}));

vi.mock("../src/lib/review-followups.js", () => ({
  sendImmediateReviewRequest: vi.fn(async () => {}),
}));

import { handleCompletionPackageRecompile } from "../src/routes/completion-package.js";
import { triggerNotification } from "../src/lib/notification-engine.js";
import { sendImmediateReviewRequest } from "../src/lib/review-followups.js";

const JOB = "d53d33c9-2e62-403f-8bcc-29fc0b0779e7";
const DOC = "pkg-betty";
const KEY = `documents/job/${JOB}/completion_package/${DOC}.html`;
const SENT_AT = "2026-10-14 18:00:00";
const OLD_HTML = "<html>OLD PACKAGE $4,300.00</html>";

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
};

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDb;
};

interface MemFile {
  body: Uint8Array;
  type: string;
}

function memR2() {
  const store = new Map<string, MemFile>();
  return {
    store,
    async put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }) {
      const body = typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? new Uint8Array(value)
          : new Uint8Array(value);
      store.set(key, { body, type: opts?.httpMetadata?.contentType ?? "application/octet-stream" });
    },
    async get(key: string) {
      const hit = store.get(key);
      if (!hit) return null;
      const body = hit.body;
      return {
        size: body.byteLength,
        httpMetadata: { contentType: hit.type },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    },
  };
}

function asDb(db: SqliteDb) {
  const statement = (sql: string, args: unknown[]) => ({
    bind(...more: unknown[]) {
      return statement(sql, more);
    },
    async first<T>() {
      return (db.prepare(sql).get(...(args as never[])) as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: db.prepare(sql).all(...(args as never[])) as T[] };
    },
    async run() {
      const info = db.prepare(sql).run(...(args as never[]));
      return { meta: { changes: info.changes } };
    },
  });
  return { prepare(sql: string) { return statement(sql, []); } };
}

function schema(db: SqliteDb) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT, role TEXT, is_active INTEGER
    );
    CREATE TABLE clients (
      id TEXT PRIMARY KEY, name TEXT, first_name TEXT, last_name TEXT
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, job_number INTEGER, title TEXT, client_id TEXT, contract_total REAL,
      portal_token TEXT, property_address TEXT, property_city TEXT, property_state TEXT, property_zip TEXT,
      warranty_expiration TEXT, completion_package_sent_at TEXT
    );
    CREATE TABLE change_orders (
      id TEXT PRIMARY KEY, job_id TEXT, amount REAL, status TEXT, applied_at TEXT
    );
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY, job_id TEXT, amount REAL, total_due REAL, status TEXT
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY, job_id TEXT, amount REAL
    );
    CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT, file_type TEXT, file_size INTEGER, r2_key TEXT,
      document_category TEXT, is_signed INTEGER, is_active INTEGER, signed_date TEXT,
      job_id TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE photos (
      id TEXT PRIMARY KEY, job_id TEXT, caption TEXT, is_active INTEGER, photo_type TEXT,
      category TEXT, is_before_photo INTEGER, is_after_photo INTEGER, taken_at TEXT, created_at TEXT
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_id TEXT,
      details TEXT, created_at TEXT
    );
  `);
}

function seed(db: SqliteDb, files: ReturnType<typeof memR2>, opts?: { sent?: boolean; signed?: boolean; active?: boolean; file?: boolean }) {
  const sent = opts?.sent !== false;
  const signed = opts?.signed !== false;
  const active = opts?.active !== false;
  const file = opts?.file !== false;
  db.exec(`
    INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES
      ('u-owner', 'tony@homesolutionsar.com', 'Tony', 'Columbus', 'owner', 1),
      ('u-pm', 'pm@example.com', 'Pat', 'Pm', 'project_manager', 1);
    INSERT INTO clients (id, name, first_name, last_name) VALUES ('c1', 'Betty Hamilton', 'Betty', 'Hamilton');
    INSERT INTO jobs (
      id, job_number, title, client_id, contract_total, portal_token, property_address, completion_package_sent_at
    ) VALUES (
      '${JOB}', 102, 'Hamilton kitchen', 'c1', 3800, 'tok', '1 Main',
      ${sent ? `'${SENT_AT}'` : "NULL"}
    );
    INSERT INTO change_orders (id, job_id, amount, status, applied_at) VALUES
      ('co-1', '${JOB}', 500, 'approved', '2026-10-13T16:59:00.000Z');
    INSERT INTO invoices (id, job_id, amount, total_due, status) VALUES
      ('inv-1', '${JOB}', 2150, 2150, 'paid');
    INSERT INTO payments (id, job_id, amount) VALUES
      ('pay-deposit', '${JOB}', 1650),
      ('pay-final', '${JOB}', 2150);
    INSERT INTO documents (
      id, title, file_type, file_size, r2_key, document_category, is_signed, is_active,
      signed_date, job_id, created_at, updated_at
    ) VALUES (
      '${DOC}', 'Completion Package', 'text/html', ${OLD_HTML.length}, '${KEY}',
      'completion_package', ${signed ? 1 : 0}, ${active ? 1 : 0},
      '2026-10-14T18:00:00.000Z', '${JOB}', '2026-10-14T18:00:00.000Z', '2026-10-14T18:00:00.000Z'
    );
  `);
  if (file) {
    files.store.set(KEY, { body: new TextEncoder().encode(OLD_HTML), type: "text/html; charset=utf-8" });
  }
}

function harness(opts?: { sent?: boolean; signed?: boolean; active?: boolean; file?: boolean }) {
  const db = new DatabaseSync(":memory:");
  schema(db);
  const files = memR2();
  seed(db, files, opts);
  const env = { DB: asDb(db), FILES: files } as unknown as Env;
  return { db, env, files };
}

function ownerRequest() {
  return new Request("https://app.example/api/jobs/x/completion-package/recompile", {
    method: "POST",
    headers: { "Cf-Access-Authenticated-User-Email": "tony@homesolutionsar.com" },
  });
}

describe("completion package recompile", () => {
  beforeEach(() => {
    vi.mocked(triggerNotification).mockClear();
    vi.mocked(sendImmediateReviewRequest).mockClear();
  });

  it("replaces Betty's saved package in place and keeps the old file", async () => {
    const { db, env, files } = harness();
    const res = await handleCompletionPackageRecompile(ownerRequest(), env, JOB);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      document_id: string;
      r2_key: string;
      superseded_r2_key: string;
      summary: { contract_total: number; change_order_total: number; adjusted_total: number; balance: number };
    };
    expect(body.document_id).toBe(DOC);
    expect(body.r2_key).toBe(KEY);
    expect(body.superseded_r2_key).toMatch(/\.superseded-.*\.html$/);
    expect(body.summary).toMatchObject({
      contract_total: 3300,
      change_order_total: 500,
      adjusted_total: 3800,
      balance: 0,
    });

    const row = db.prepare(
      "SELECT d.id, d.r2_key, j.completion_package_sent_at FROM documents d JOIN jobs j ON j.id = d.job_id WHERE d.id = ?",
    ).get(DOC) as { id: string; r2_key: string; completion_package_sent_at: string };
    expect(row.id).toBe(DOC);
    expect(row.r2_key).toBe(KEY);
    expect(row.completion_package_sent_at).toBe(SENT_AT);

    const saved = new TextDecoder().decode(files.store.get(KEY)!.body);
    expect(saved).toContain("$3,300.00");
    expect(saved).toContain("$500.00");
    expect(saved).toContain("$3,800.00");
    expect(saved).toContain("$0.00");
    expect(saved).not.toContain("$4,300.00");

    const prior = new TextDecoder().decode(files.store.get(body.superseded_r2_key)!.body);
    expect(prior).toBe(OLD_HTML);

    const audit = db.prepare(
      "SELECT details FROM audit_logs WHERE action = 'completion_package.recompile'",
    ).get() as { details: string };
    const details = JSON.parse(audit.details) as { r2_key: string; superseded_r2_key: string; document_id: string };
    expect(details.document_id).toBe(DOC);
    expect(details.r2_key).toBe(KEY);
    expect(details.superseded_r2_key).toBe(body.superseded_r2_key);

    expect(triggerNotification).not.toHaveBeenCalled();
    expect(sendImmediateReviewRequest).not.toHaveBeenCalled();
  });

  it("refuses a project manager, a package that was not sent, and a missing signed file", async () => {
    const pm = harness();
    const denied = await handleCompletionPackageRecompile(
      new Request("https://app.example/recompile", {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "pm@example.com" },
      }),
      pm.env,
      JOB,
    );
    expect(denied.status).toBe(403);
    expect(pm.files.store.size).toBe(1);

    const unsent = harness({ sent: false });
    const notSent = await handleCompletionPackageRecompile(ownerRequest(), unsent.env, JOB);
    expect(notSent.status).toBe(409);

    const draft = harness({ signed: false });
    const unsigned = await handleCompletionPackageRecompile(ownerRequest(), draft.env, JOB);
    expect(unsigned.status).toBe(409);

    const inactive = harness({ active: false });
    const hidden = await handleCompletionPackageRecompile(ownerRequest(), inactive.env, JOB);
    expect(hidden.status).toBe(409);

    const missing = harness({ file: false });
    const gone = await handleCompletionPackageRecompile(ownerRequest(), missing.env, JOB);
    expect(gone.status).toBe(409);
    expect(missing.db.prepare("SELECT completion_package_sent_at FROM jobs WHERE id = ?").get(JOB)).toEqual({
      completion_package_sent_at: SENT_AT,
    });
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(sendImmediateReviewRequest).not.toHaveBeenCalled();
  });

  it("shows the owner one update button and a confirm step that does not message the client", () => {
    const source = readFileSync(
      new URL("../frontend/src/views/jobs/CompletionPackageReview.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('user?.role === "owner"');
    expect(source).toContain("Update saved package");
    expect(source).toContain("Replaces the package on the portal. Does not text or email the client.");
    expect(source).toContain("/completion-package/recompile");
    expect(source).toContain('title="Update saved package?"');
  });
});
