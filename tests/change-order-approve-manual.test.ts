import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import type { Env } from "../src/env.js";
import { computeSuggestions } from "../src/lib/invoicing.js";
import { applyChangeOrder } from "../src/routes/change-orders.js";
import {
  handleChangeOrderApprovalProof,
  handleChangeOrderApproveManual,
  handleJobChangeOrders,
} from "../src/routes/change-orders.js";
import { handlePortalApi } from "../src/routes/portal.js";
import { manualApprovalStamp } from "../shared/change-order-approval.js";

vi.mock("../src/lib/notification-engine.js", () => ({
  triggerChangeOrderApproved: vi.fn(async () => {}),
  triggerChangeOrderSent: vi.fn(async () => {}),
  createOwnerInApp: vi.fn(async () => {}),
}));

import * as notify from "../src/lib/notification-engine.js";

const TEMPLATE = readFileSync(new URL("./fixtures/change-order-live.docx", import.meta.url));
const APPROVED_AT = "2026-10-12T20:15:00.000Z";
const STAMP = manualApprovalStamp("phone", APPROVED_AT);

interface MemFile {
  body: Uint8Array;
  type: string;
}

function memR2() {
  const store = new Map<string, MemFile>();
  return {
    store,
    async put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      const body = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
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
        body: new Blob([body]).stream(),
      };
    },
    async head(key: string) {
      const hit = store.get(key);
      return hit ? { size: hit.body.byteLength } : null;
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

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
  return {
    prepare(sql: string) {
      return statement(sql, []);
    },
  };
}

function schema(db: SqliteDb) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT, role TEXT, is_active INTEGER
    );
    CREATE TABLE clients (
      id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, name TEXT, phone TEXT, email TEXT,
      address_street TEXT, address_city TEXT, address_state TEXT, address_postal TEXT
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, job_number INTEGER, title TEXT, client_id TEXT, billing_model TEXT,
      target_end_date TEXT, conversion_reversed INTEGER, contract_total REAL, source TEXT,
      portal_token TEXT, deposit_amount REAL, property_address TEXT, property_city TEXT,
      property_state TEXT, property_zip TEXT, start_date TEXT, actual_end_date TEXT, notes TEXT,
      warranty_expiration TEXT, assigned_to TEXT, status TEXT, estimate_id TEXT, payer_id TEXT,
      portal_type TEXT
    );
    CREATE TABLE change_orders (
      id TEXT PRIMARY KEY, job_id TEXT, change_order_number INTEGER, title TEXT, description TEXT,
      amount REAL, status TEXT, requested_date TEXT, approved_date TEXT, client_signature TEXT,
      triggered_by_note_id TEXT, created_by TEXT, created_at TEXT, applied_at TEXT,
      end_date_extension_days INTEGER, signed_name TEXT, signed_ip TEXT,
      approval_source TEXT, manual_approval_method TEXT, manual_approved_at TEXT,
      manual_approval_note TEXT, manual_approved_by TEXT, manual_recorded_at TEXT,
      manual_proof_r2_key TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, job_id TEXT, task_group TEXT, task_group_order INTEGER, title TEXT,
      status TEXT, notes TEXT, sort_order INTEGER, is_punch_list INTEGER, created_at TEXT
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, user_email TEXT, action TEXT, entity_type TEXT, entity_id TEXT,
      details TEXT, created_at TEXT
    );
    CREATE TABLE billing_schedule (
      id TEXT PRIMARY KEY, job_id TEXT, billing_model TEXT, sequence INTEGER, label TEXT,
      trigger_type TEXT, trigger_ref TEXT, percentage REAL, amount REAL, status TEXT
    );
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY, job_id TEXT, invoice_type TEXT, milestone_number INTEGER,
      trade_line_item_id TEXT, amount REAL, status TEXT, notes TEXT
    );
    CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE job_documents (
      id TEXT PRIMARY KEY, job_id TEXT, template_type TEXT, filename TEXT, r2_key TEXT,
      generated_at TEXT, generated_by TEXT, review_status TEXT, auto_generated INTEGER,
      trigger_event TEXT, related_record_id TEXT, signature_status TEXT, signature_completed_at TEXT
    );
    CREATE TABLE dead_letter_queue (
      id TEXT PRIMARY KEY, operation TEXT, payload TEXT, error_message TEXT, retry_count INTEGER,
      max_retries INTEGER, status TEXT, created_at TEXT
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT, file_type TEXT, document_category TEXT, is_signed INTEGER,
      signed_date TEXT, created_at TEXT, is_active INTEGER, job_id TEXT, estimate_id TEXT,
      signature_data TEXT
    );
    CREATE TABLE notification_logs (id TEXT PRIMARY KEY);
    CREATE TABLE communications (id TEXT PRIMARY KEY);
  `);
}

function harness(billing: string, amount = 500) {
  const db = new DatabaseSync(":memory:");
  schema(db);
  const files = memR2();
  db.prepare(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES
      ('u-owner', 'tony@homesolutionsar.com', 'Tony', 'Columbus', 'owner', 1),
      ('u-pm', 'pm@example.com', 'Pat', 'Pm', 'project_manager', 1),
      ('u-office', 'office@example.com', 'Olivia', 'Office', 'office_admin', 1),
      ('u-crew', 'crew@example.com', 'Casey', 'Crew', 'field_crew', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO clients (id, first_name, last_name, name, email) VALUES ('c1', 'Ada', 'Lane', 'Ada Lane', 'ada@example.com')`,
  ).run();
  db.prepare(
    `INSERT INTO jobs (
      id, job_number, title, client_id, billing_model, target_end_date, conversion_reversed,
      contract_total, source, portal_token, property_address, property_city, property_state, property_zip, status
    ) VALUES ('job-1', 900, 'ZZTEST kitchen', 'c1', ?, '2026-09-04', 0, 3300, 'estimate', 'zz-token',
      '10 Oak', 'Conway', 'AR', '72032', 'in_progress')`,
  ).run(billing);
  db.prepare(
    `INSERT INTO change_orders (
      id, job_id, change_order_number, title, description, amount, status, requested_date, created_at, end_date_extension_days
    ) VALUES ('co-1', 'job-1', 1, 'Extra Countertops', 'Add a run of countertop', ?, 'sent', datetime('now'), datetime('now'), 0)`,
  ).run(amount);
  files.store.set("documents/templates/change-order.docx", {
    body: new Uint8Array(TEMPLATE),
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const env = { DB: asDb(db), FILES: files } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(Promise.resolve(p)); } } as ExecutionContext;
  return { db, env, ctx, files, flush: () => Promise.all(pending) };
}

function ownerBody(extra: Record<string, unknown> = {}) {
  return {
    method: "phone",
    approved_at: APPROVED_AT,
    note: "ZZNOTE customer said yes by phone at 3:15",
    confirm: true,
    ...extra,
  };
}

function postManual(email: string, body: unknown) {
  return new Request("http://local/api/change-orders/co-1/approve-manual", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Cf-Access-Authenticated-User-Email": email,
      "CF-Connecting-IP": "203.0.113.8",
    },
    body: JSON.stringify(body),
  });
}

function docText(bytes: Uint8Array): string {
  const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
  return xml
    .replace(/<w:p[ >]/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("approve change order on behalf", () => {
  it("renders the live template stamp, client name, and Central date", async () => {
    const h = await harness("fixed_price");
    const res = await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), h.env, "co-1", h.ctx);
    expect(res.status).toBe(200);
    await h.flush();
    const doc = h.db.prepare(
      "SELECT review_status, r2_key, signature_status FROM job_documents WHERE related_record_id = 'co-1'",
    ).get() as { review_status: string; r2_key: string; signature_status: string };
    expect(doc.review_status).toBe("pending_review");
    expect(doc.signature_status).toBe("none");
    const bytes = h.files.store.get(doc.r2_key)!.body;
    const text = docText(bytes);
    expect(text).toContain(STAMP);
    expect(text).toContain("Ada Lane");
    expect(text.split("October 12, 2026").length - 1).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain("2026-10-12T20:15");
    expect(text).not.toContain("{{");
    expect(STAMP).toBe(
      "Approved by customer via phone on October 12, 2026 — recorded by Columbus Home Solutions",
    );
  });

  it("records a sent change order without signature fields and skips the client email", async () => {
    const h = await harness("fixed_price");
    const res = await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), h.env, "co-1", h.ctx);
    expect(res.status).toBe(200);
    const row = h.db.prepare("SELECT * FROM change_orders WHERE id = 'co-1'").get() as Record<string, unknown>;
    expect(row.status).toBe("approved");
    expect(row.client_signature).toBeNull();
    expect(row.signed_name).toBeNull();
    expect(row.signed_ip).toBeNull();
    expect(row.approval_source).toBe("manual_owner");
    expect(row.manual_approval_method).toBe("phone");
    expect(row.manual_approved_at).toBe(APPROVED_AT);
    expect(row.approved_date).toBe(APPROVED_AT);
    expect(String(row.manual_approval_note)).toContain("ZZNOTE");
    expect(row.manual_approved_by).toBe("tony@homesolutionsar.com");
    expect(row.manual_recorded_at).toBeTruthy();
    expect(row.applied_at).toBeTruthy();
    expect(notify.triggerChangeOrderApproved).not.toHaveBeenCalled();
    expect(notify.triggerChangeOrderSent).not.toHaveBeenCalled();
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM notification_logs").get() as { n: number }).n).toBe(0);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM communications").get() as { n: number }).n).toBe(0);
  });

  it("approves a draft without firing change_order_sent", async () => {
    const h = await harness("fixed_price");
    h.db.prepare("UPDATE change_orders SET status = 'draft' WHERE id = 'co-1'").run();
    const res = await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), h.env, "co-1", h.ctx);
    expect(res.status).toBe(200);
    expect((h.db.prepare("SELECT status FROM change_orders WHERE id = 'co-1'").get() as { status: string }).status).toBe("approved");
    expect(notify.triggerChangeOrderSent).not.toHaveBeenCalled();
    expect(notify.triggerChangeOrderApproved).not.toHaveBeenCalled();
  });

  it("fires change_order_approved on the portal path and not when the flag is set", async () => {
    const portal = await harness("fixed_price");
    portal.db.prepare(
      "UPDATE change_orders SET client_signature = 'Ada Lane', signed_name = 'Ada Lane' WHERE id = 'co-1'",
    ).run();
    await applyChangeOrder(portal.env, "co-1", portal.ctx);
    expect(notify.triggerChangeOrderApproved).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const manual = await harness("fixed_price");
    await applyChangeOrder(manual.env, "co-1", manual.ctx, {
      suppressCustomerNotice: true,
      manual: {
        method: "phone",
        approvedAt: APPROVED_AT,
        note: "ZZNOTE customer said yes by phone at 3:15",
        approvedBy: "tony@homesolutionsar.com",
        recordedAt: new Date().toISOString(),
        proofKey: null,
      },
    });
    expect(notify.triggerChangeOrderApproved).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const unflagged = await harness("trade_by_trade");
    await applyChangeOrder(unflagged.env, "co-1", unflagged.ctx, {
      manual: {
        method: "text",
        approvedAt: APPROVED_AT,
        note: "ZZNOTE customer said yes by phone at 3:15",
        approvedBy: "tony@homesolutionsar.com",
        recordedAt: new Date().toISOString(),
        proofKey: null,
      },
    });
    expect(notify.triggerChangeOrderApproved).toHaveBeenCalledTimes(1);
  });

  it("applies exactly once across a retry and a later portal visit", async () => {
    const h = await harness("fixed_price");
    const first = await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), h.env, "co-1", h.ctx);
    expect(first.status).toBe(200);
    const second = await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), h.env, "co-1", h.ctx);
    expect(second.status).toBe(409);
    const portal = await handlePortalApi(
      new Request("http://local/api/portal/zz-token/change-orders/co-1/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature: "Ada Lane", signed_name: "Ada Lane" }),
      }),
      h.env,
      new URL("http://local/api/portal/zz-token/change-orders/co-1/sign"),
      h.ctx,
    );
    expect(portal!.status).toBe(200);
    const body = await portal!.json() as { already_applied: boolean };
    expect(body.already_applied).toBe(true);
    expect((h.db.prepare("SELECT contract_total FROM jobs WHERE id = 'job-1'").get() as { contract_total: number }).contract_total).toBe(3800);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE job_id = 'job-1'").get() as { n: number }).n).toBe(1);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'change_order_approved_manual'").get() as { n: number }).n).toBe(1);
    const signed = h.db.prepare("SELECT client_signature, signed_name FROM change_orders WHERE id = 'co-1'").get() as {
      client_signature: string | null;
      signed_name: string | null;
    };
    expect(signed.client_signature).toBeNull();
    expect(signed.signed_name).toBeNull();
  });

  it("rejects other roles and bad input", async () => {
    for (const email of ["pm@example.com", "office@example.com", "crew@example.com"]) {
      const h = await harness("fixed_price");
      const res = await handleChangeOrderApproveManual(postManual(email, ownerBody()), h.env, "co-1", h.ctx);
      expect(res.status).toBe(403);
      expect((h.db.prepare("SELECT status FROM change_orders WHERE id = 'co-1'").get() as { status: string }).status).toBe("sent");
    }
    const cases: Record<string, unknown>[] = [
      ownerBody({ note: "short" }),
      ownerBody({ note: "   tiny   " }),
      ownerBody({ method: "" }),
      ownerBody({ approved_at: "2099-01-01T00:00:00.000Z" }),
      ownerBody({ confirm: false }),
    ];
    for (const body of cases) {
      const h = await harness("fixed_price");
      const res = await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", body), h.env, "co-1", h.ctx);
      expect(res.status).toBe(400);
    }
  });

  it("returns 409 for approved and rejected rows", async () => {
    const approved = await harness("fixed_price");
    await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), approved.env, "co-1", approved.ctx);
    const total = (approved.db.prepare("SELECT contract_total FROM jobs WHERE id = 'job-1'").get() as { contract_total: number }).contract_total;
    const again = await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), approved.env, "co-1", approved.ctx);
    expect(again.status).toBe(409);
    expect((approved.db.prepare("SELECT contract_total FROM jobs WHERE id = 'job-1'").get() as { contract_total: number }).contract_total).toBe(total);

    const rejected = await harness("fixed_price");
    rejected.db.prepare("UPDATE change_orders SET status = 'rejected' WHERE id = 'co-1'").run();
    const res = await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), rejected.env, "co-1", rejected.ctx);
    expect(res.status).toBe(409);
    expect((rejected.db.prepare("SELECT contract_total FROM jobs WHERE id = 'job-1'").get() as { contract_total: number }).contract_total).toBe(3300);
  });

  it("suggests a change-order invoice on fixed price, none on cost-plus, and none for a credit", async () => {
    const fixed = await harness("fixed_price", 500);
    await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), fixed.env, "co-1", fixed.ctx);
    const fixedSug = await computeSuggestions(fixed.env, "job-1", "fixed_price", 3800);
    expect(fixedSug.change_orders.map((c) => c.amount)).toEqual([500]);

    const plus = await harness("cost_plus", 500);
    await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), plus.env, "co-1", plus.ctx);
    const plusSug = await computeSuggestions(plus.env, "job-1", "cost_plus", 3800);
    expect(plusSug.change_orders).toEqual([]);
    expect((plus.db.prepare("SELECT contract_total FROM jobs WHERE id = 'job-1'").get() as { contract_total: number }).contract_total).toBe(3800);

    const credit = await harness("fixed_price", -200);
    await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), credit.env, "co-1", credit.ctx);
    expect((credit.db.prepare("SELECT contract_total FROM jobs WHERE id = 'job-1'").get() as { contract_total: number }).contract_total).toBe(3100);
    const creditSug = await computeSuggestions(credit.env, "job-1", "fixed_price", 3100);
    expect(creditSug.change_orders).toEqual([]);
  });

  it("shows a manual approval on the portal without the note, proof key, or owner email", async () => {
    const h = await harness("fifty_fifty");
    const file = new File([Uint8Array.from([9, 9, 9])], "proof.png", { type: "image/png" });
    const fd = new FormData();
    fd.set("method", "phone");
    fd.set("approved_at", APPROVED_AT);
    fd.set("note", "ZZNOTE customer said yes by phone at 3:15");
    fd.set("confirm", "true");
    fd.set("proof", file);
    const approved = await handleChangeOrderApproveManual(
      new Request("http://local/api/change-orders/co-1/approve-manual", {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "tony@homesolutionsar.com" },
        body: fd,
      }),
      h.env,
      "co-1",
      h.ctx,
    );
    expect(approved.status).toBe(200);
    const stored = h.db.prepare(
      "SELECT manual_proof_r2_key AS proof_key, manual_approval_note AS note, manual_approved_by AS owner_email FROM change_orders WHERE id = 'co-1'",
    ).get() as { proof_key: string; note: string; owner_email: string };
    expect(stored.proof_key).toContain("proof-");
    expect(stored.note).toContain("ZZNOTE");
    expect(stored.owner_email).toBe("tony@homesolutionsar.com");
    const res = await handlePortalApi(
      new Request("http://local/api/portal/zz-token/change-orders"),
      h.env,
      new URL("http://local/api/portal/zz-token/change-orders"),
      h.ctx,
    );
    const body = await res!.json() as { change_orders: Array<Record<string, unknown>> };
    const co = body.change_orders[0];
    expect(co.status).toBe("approved");
    expect(co.can_sign).toBe(false);
    expect(co.signed_name).toBeNull();
    expect(co.approval_label).toBe("Approved by phone on October 12, 2026.");
    for (const key of ["manual_approval_note", "manual_proof_r2_key", "manual_approved_by", "note", "proof"]) {
      expect(Object.prototype.hasOwnProperty.call(co, key)).toBe(false);
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(stored.note);
    expect(raw).not.toContain(stored.proof_key);
    expect(raw).not.toContain(stored.owner_email);
    expect(raw).not.toContain("manual_approval_note");
    expect(raw).not.toContain("manual_proof_r2_key");
    expect(raw).not.toContain("manual_approved_by");
  });

  it("keeps the portal typed-name approval idempotent", async () => {
    const h = await harness("fixed_price");
    const sign = () =>
      handlePortalApi(
        new Request("http://local/api/portal/zz-token/change-orders/co-1/sign", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "CF-Connecting-IP": "198.51.100.4",
          },
          body: JSON.stringify({ signature: "Ada Lane", signed_name: "Ada Lane" }),
        }),
        h.env,
        new URL("http://local/api/portal/zz-token/change-orders/co-1/sign"),
        h.ctx,
      );
    const first = await sign();
    expect(first!.status).toBe(200);
    const second = await sign();
    const again = await second!.json() as { already_applied: boolean };
    expect(again.already_applied).toBe(true);
    const row = h.db.prepare("SELECT signed_name, signed_ip, client_signature, contract_total FROM change_orders co JOIN jobs j ON j.id = co.job_id WHERE co.id = 'co-1'").get() as {
      signed_name: string;
      signed_ip: string;
      client_signature: string;
      contract_total: number;
    };
    expect(row.signed_name).toBe("Ada Lane");
    expect(row.signed_ip).toBe("198.51.100.4");
    expect(row.client_signature).toBe("Ada Lane");
    expect(row.contract_total).toBe(3800);
    expect(notify.triggerChangeOrderApproved).toHaveBeenCalledTimes(1);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(1);
  });

  it("stores proof in R2 only, and only an owner can read it", async () => {
    const h = await harness("fixed_price");
    const file = new File([Uint8Array.from([1, 2, 3, 4])], "ok.png", { type: "image/png" });
    const fd = new FormData();
    fd.set("method", "text");
    fd.set("approved_at", APPROVED_AT);
    fd.set("note", "ZZNOTE customer texted yes, screenshot attached");
    fd.set("confirm", "true");
    fd.set("proof", file);
    const req = new Request("http://local/api/change-orders/co-1/approve-manual", {
      method: "POST",
      headers: { "Cf-Access-Authenticated-User-Email": "tony@homesolutionsar.com" },
      body: fd,
    });
    const res = await handleChangeOrderApproveManual(req, h.env, "co-1", h.ctx);
    expect(res.status).toBe(200);
    const key = (h.db.prepare("SELECT manual_proof_r2_key AS k FROM change_orders WHERE id = 'co-1'").get() as { k: string }).k;
    expect(key.startsWith("change-orders/job-1/co-1/proof-")).toBe(true);
    expect(h.files.store.has(key)).toBe(true);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(0);
    const docs = h.db.prepare("SELECT r2_key FROM job_documents").all() as { r2_key: string }[];
    expect(docs.every((d) => !d.r2_key.includes("proof-"))).toBe(true);

    const owner = await handleChangeOrderApprovalProof(
      new Request("http://local/api/change-orders/co-1/approval-proof", {
        headers: { "Cf-Access-Authenticated-User-Email": "tony@homesolutionsar.com" },
      }),
      h.env,
      "co-1",
    );
    expect(owner.status).toBe(200);
    expect(new Uint8Array(await owner.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3, 4]));

    const pm = await handleChangeOrderApprovalProof(
      new Request("http://local/api/change-orders/co-1/approval-proof", {
        headers: { "Cf-Access-Authenticated-User-Email": "pm@example.com" },
      }),
      h.env,
      "co-1",
    );
    expect(pm.status).toBe(403);

    const anon = await handleChangeOrderApprovalProof(
      new Request("http://local/api/change-orders/co-1/approval-proof"),
      h.env,
      "co-1",
    );
    expect(anon.status).toBe(401);

    const portal = await handlePortalApi(
      new Request("http://local/api/portal/zz-token/documents"),
      h.env,
      new URL("http://local/api/portal/zz-token/documents"),
      h.ctx,
    );
    const listed = await portal!.text();
    expect(listed).not.toContain("proof-");
  });

  it("does not suggest the $500 twice on a fifty_fifty ZZTEST job", async () => {
    const h = await harness("fifty_fifty", 500);
    h.db.prepare(
      `INSERT INTO billing_schedule (id, job_id, billing_model, sequence, label, trigger_type, percentage, amount, status) VALUES
        ('b0', 'job-1', 'fifty_fifty', 0, 'Deposit (due before work begins)', 'milestone', 50, 1650, 'paid'),
        ('b1', 'job-1', 'fifty_fifty', 1, 'Final Payment (due upon completion)', 'milestone', 50, 1650, 'draft')`,
    ).run();
    await handleChangeOrderApproveManual(postManual("tony@homesolutionsar.com", ownerBody()), h.env, "co-1", h.ctx);
    const job = h.db.prepare("SELECT contract_total FROM jobs WHERE id = 'job-1'").get() as { contract_total: number };
    expect(job.contract_total).toBe(3800);
    const sug = await computeSuggestions(h.env, "job-1", "fifty_fifty", job.contract_total);
    expect(sug.change_orders).toEqual([]);
    expect(sug.final).toBeNull();
    expect(sug.milestones).toEqual([]);
    const list = await handleJobChangeOrders(h.env, "job-1");
    const listed = await list.json() as { change_orders: Array<{ manual_approval_badge: string }> };
    expect(listed.change_orders[0].manual_approval_badge).toBe("Approved by phone — recorded by Tony");
  });
});
