import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LIVE_JOBBER_STATUSES,
  QUIET_JOBBER_STATUSES,
  JOBBER_QUIET_SEND_MESSAGE,
  boardJobWhere,
  isJobberImportQuiet,
} from "../src/lib/jobber-board.js";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("jobber board visibility", () => {
  it("keeps native jobs and only the live imported statuses", () => {
    const sql = boardJobWhere("j");
    expect(sql).toContain("j.source IN ('estimate', 'quick_job')");
    expect(sql).toContain("j.data_source = 'jobber_import'");
    for (const status of LIVE_JOBBER_STATUSES) expect(sql).toContain(`'${status}'`);
    for (const hidden of ["archived", "late", "cancelled", "closed", "complete"]) {
      expect(sql).not.toContain(`'${hidden}'`);
    }
  });

  it("lists the six live jobs and hides the rest", () => {
    expect([...LIVE_JOBBER_STATUSES]).toEqual([
      "in_progress",
      "unscheduled",
      "scheduled",
      "punch_list",
      "deposit_paid",
      "action_required",
    ]);
  });
});

describe("quiet Jobber sends", () => {
  it("skips archived, closed, and cancelled imports only", () => {
    expect(isJobberImportQuiet({ data_source: "jobber_import", status: "archived" })).toBe(true);
    expect(isJobberImportQuiet({ data_source: "jobber_import", status: "closed" })).toBe(true);
    expect(isJobberImportQuiet({ data_source: "jobber_import", status: "cancelled" })).toBe(true);
    for (const status of ["in_progress", "unscheduled", "scheduled", "punch_list", "deposit_paid", "action_required", "late", "complete"]) {
      expect(isJobberImportQuiet({ data_source: "jobber_import", status })).toBe(false);
    }
    expect(isJobberImportQuiet({ data_source: null, status: "archived" })).toBe(false);
    expect(isJobberImportQuiet(null)).toBe(false);
    expect(QUIET_JOBBER_STATUSES).toEqual(["archived", "closed", "cancelled"]);
  });

  it("guards every send the job page can fire", () => {
    const files = {
      recap: read("../src/routes/jobs-api.ts"),
      invoice: read("../src/routes/invoices.ts"),
      payment: read("../src/routes/payments.ts"),
      completion: read("../src/routes/completion-package.ts"),
      changeOrder: read("../src/routes/change-orders.ts"),
      signature: read("../src/routes/job-documents.ts"),
      punch: read("../src/routes/punch-lists.ts"),
    };
    expect(files.recap).toContain("jobberQuietSendBlock");
    expect(files.invoice.slice(files.invoice.indexOf("handleInvoiceSend"))).toContain("jobberQuietSendBlock");
    expect(files.payment).toContain("isJobberImportQuiet");
    expect(files.payment).toContain("skipNotifications: quiet");
    expect(files.payment).toContain("receipt_skipped: quiet");
    expect(files.completion).toContain("jobberQuietSendBlock");
    expect(files.changeOrder).toContain("jobberQuietSendBlock");
    expect(files.signature).toContain("jobberQuietSendBlock");
    const send = files.punch.slice(files.punch.indexOf("export async function handlePunchListSend"));
    const renotify = files.punch.slice(files.punch.indexOf("export async function handlePunchListRenotify"));
    expect(send.slice(0, renotify.length ? send.indexOf("export async function handlePunchListRenotify") : undefined)).toContain("jobberQuietSendBlock");
    expect(renotify).toContain("jobberQuietSendBlock");
    expect(JOBBER_QUIET_SEND_MESSAGE).toContain("Send skipped");
  });
});
