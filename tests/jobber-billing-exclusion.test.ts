import { describe, expect, it } from "vitest";
import {
  BILLING_HOLD_SQL,
  JOBBER_GID_PREFIX,
  JOBBER_HISTORY_INVOICE_SQL,
  isBillingHeld,
  isJobberHistoryInvoice,
  jobberImportHeaderIsProtected,
} from "../src/lib/invoicing.js";

describe("Jobber history is excluded from late fees and reminders", () => {
  it("skips a Jobber GraphQL invoice id even when the job is missing", () => {
    expect(
      isJobberHistoryInvoice({
        invoiceId: `${JOBBER_GID_PREFIX}L0ludm9pY2UvMTU2MjI0NDgw`,
        invoiceDataSource: null,
        jobDataSource: null,
      }),
    ).toBe(true);
  });

  it("skips a UUID invoice on a jobber_import job", () => {
    expect(
      isJobberHistoryInvoice({
        invoiceId: "4d8f1c2a-7b63-4e90-a000-000000000001",
        invoiceDataSource: null,
        jobDataSource: "jobber_import",
      }),
    ).toBe(true);
  });

  it("skips invoices.data_source = jobber_import with a null job", () => {
    expect(
      isJobberHistoryInvoice({
        invoiceId: "4d8f1c2a-7b63-4e90-a000-000000000002",
        invoiceDataSource: "jobber_import",
        jobDataSource: null,
      }),
    ).toBe(true);
  });

  it("leaves a native invoice eligible", () => {
    expect(
      isJobberHistoryInvoice({
        invoiceId: "4d8f1c2a-7b63-4e90-a000-000000000003",
        invoiceDataSource: null,
        jobDataSource: null,
        jobSource: "estimate",
      }),
    ).toBe(false);
    expect(
      isJobberHistoryInvoice({
        invoiceId: "4d8f1c2a-7b63-4e90-a000-000000000005",
        invoiceDataSource: null,
        jobDataSource: null,
        jobSource: "quick_job",
      }),
    ).toBe(false);
  });

  it("skips a source-only import the same way as data_source", () => {
    expect(
      isJobberHistoryInvoice({
        invoiceId: "4d8f1c2a-7b63-4e90-a000-000000000004",
        invoiceDataSource: null,
        jobDataSource: null,
        jobSource: "jobber_import",
      }),
    ).toBe(true);
  });

  it("puts the same checks in the cron SQL, including a left join for null job_id", () => {
    expect(JOBBER_HISTORY_INVOICE_SQL).toContain("i.id NOT LIKE 'Z2lkOi8vSm9iYmVy%'");
    expect(JOBBER_HISTORY_INVOICE_SQL).toContain("i.data_source");
    expect(JOBBER_HISTORY_INVOICE_SQL).toContain("j.data_source");
    expect(JOBBER_HISTORY_INVOICE_SQL).toContain("j.source");
  });

  it("protects only jobber_import estimate headers from recompute", () => {
    expect(jobberImportHeaderIsProtected("jobber_import")).toBe(true);
    expect(jobberImportHeaderIsProtected(null)).toBe(false);
    expect(jobberImportHeaderIsProtected("jobber_accepted_import")).toBe(false);
  });

  it("holds a native invoice when billing_hold is set", () => {
    expect(isBillingHeld(1)).toBe(true);
    expect(isBillingHeld(0)).toBe(false);
    expect(isBillingHeld(null)).toBe(false);
    expect(BILLING_HOLD_SQL).toContain("i.billing_hold");
  });
});
