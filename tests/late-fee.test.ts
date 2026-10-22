import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { renderContract } from "../src/lib/contracts.js";
import {
  addDays,
  convenienceFee,
  defaultInvoiceDueDate,
  isPastDueReminderDay,
  pastDueReminderApplies,
  runLateFeeCalculator,
  SHORT_DUE_WARNING,
  shortDueDateWarning,
} from "../src/lib/invoicing.js";
import { centralDate } from "../shared/labor-week.js";
import {
  addRefusal,
  exclusionReason,
  handleLateFeeAction,
  isPastGrace,
  lateFeeAmount,
  planLateFees,
  type LateFeeCandidate,
} from "../src/lib/late-fee.js";

const TODAY = "2026-10-14";

function row(over: Partial<LateFeeCandidate> = {}): LateFeeCandidate {
  return {
    id: "inv-1",
    invoice_number: 1001,
    status: "past_due",
    amount: 1000,
    tax_amount: 0,
    credits_applied: 0,
    late_fee_amount: 0,
    total_due: 1000,
    due_date: "2026-10-06",
    billing_model: "fifty_fifty",
    invoice_type: "final",
    job_id: "job-1",
    client_id: "client-1",
    client_name: "Ada Client",
    payment_token: "tok",
    late_fee_state: "none",
    late_fee_hold: 0,
    late_fee_hold_reason: null,
    late_fee_snooze_until: null,
    late_fee_proposed_amount: null,
    late_fee_waived_amount: null,
    invoice_data_source: null,
    job_data_source: null,
    job_billing_model: "fifty_fifty",
    billing_hold: 0,
    collected: 0,
    ...over,
  };
}

describe("late fee eligibility and amount", () => {
  it("is not eligible on day 7 after the due date and is eligible on day 8", () => {
    expect(isPastGrace("2026-10-07", TODAY)).toBe(false);
    expect(isPastGrace("2026-10-06", TODAY)).toBe(true);
    expect(exclusionReason(row({ due_date: "2026-10-07" }), TODAY)).toBe("grace");
    expect(exclusionReason(row({ due_date: "2026-10-06" }), TODAY)).toBeNull();
  });

  it("rounds 5% to the cent and uses the unpaid principal, not a prior fee", () => {
    expect(lateFeeAmount(10.01)).toBe(0.5);
    expect(lateFeeAmount(10.1)).toBe(0.51);
    expect(lateFeeAmount(2150)).toBe(107.5);
    const partial = row({ amount: 1000, collected: 400, total_due: 1000, late_fee_amount: 0 });
    expect(lateFeeAmount(600)).toBe(30);
    const plan = planLateFees([partial], TODAY, true);
    expect(plan).toEqual([
      expect.objectContaining({ kind: "propose", amount: 30, balance: 600 }),
    ]);
  });

  it("excludes cost-plus, hold, snooze, waived, and an already applied fee", () => {
    expect(exclusionReason(row({ billing_model: "cost_plus" }), TODAY)).toBe("cost_plus");
    expect(exclusionReason(row({ invoice_type: "cost_plus_cycle" }), TODAY)).toBe("cost_plus");
    expect(exclusionReason(row({ late_fee_hold: 1 }), TODAY)).toBe("hold");
    expect(exclusionReason(row({ late_fee_snooze_until: TODAY }), TODAY)).toBe("snooze");
    expect(exclusionReason(row({ late_fee_snooze_until: "2026-10-13" }), TODAY)).toBeNull();
    expect(exclusionReason(row({ late_fee_state: "waived", late_fee_amount: 0 }), TODAY)).toBe("decided");
    expect(exclusionReason(row({ late_fee_state: "applied", late_fee_amount: 50 }), TODAY)).toBe("decided");
    expect(exclusionReason(row({ late_fee_amount: 50 }), TODAY)).toBe("decided");
  });

  it("cancels a proposal once the invoice is paid and does not propose twice", () => {
    const proposed = row({ late_fee_state: "proposed", late_fee_proposed_amount: 50 });
    expect(planLateFees([proposed], TODAY, true)).toEqual([]);
    expect(planLateFees([{ ...proposed, status: "paid", collected: 1000 }], TODAY, true)).toEqual([
      { kind: "cancel", row: { ...proposed, status: "paid", collected: 1000 } },
    ]);
  });

  it("counts only while the switch is off", () => {
    const plan = planLateFees([row()], TODAY, false);
    expect(plan.map((item) => item.kind)).toEqual(["count"]);
  });

  it("keeps the 3.5% convenience fee on the remaining balance, including an applied late fee", () => {
    const balance = 1000 + 50;
    expect(convenienceFee(balance)).toBe(36.75);
  });
});

describe("late fee writes", () => {
  it("the old calculator adds nothing and does not touch the database", async () => {
    let calls = 0;
    const env = {
      DB: {
        prepare() {
          calls++;
          throw new Error("calculator must not query");
        },
      },
    } as unknown as Env;
    await expect(runLateFeeCalculator(env)).resolves.toEqual({
      scanned: 0,
      updated: 0,
      marked_past_due: 0,
    });
    expect(calls).toBe(0);
  });

  it("rejects a non-owner and lets the owner add one fee", async () => {
    const updates: string[] = [];
    const users = new Map([
      ["pm@example.com", { id: "u-pm", email: "pm@example.com", first_name: "Pat", last_name: "Pm", role: "project_manager", is_active: 1 }],
      ["owner@example.com", { id: "u-own", email: "owner@example.com", first_name: "Ada", last_name: "Owner", role: "owner", is_active: 1 }],
    ]);
    const invoice = row();
    const env = {
      DB: {
        prepare(sql: string) {
          const bound: unknown[] = [];
          return {
            bind(...args: unknown[]) {
              bound.splice(0, bound.length, ...args);
              return this;
            },
            async first() {
              if (sql.includes("FROM users")) return users.get(String(bound[0])) ?? null;
              if (sql.includes("FROM invoices")) return invoice;
              if (sql.includes("system_settings")) return { value: "false" };
              return null;
            },
            async all() {
              if (sql.includes("notification_templates")) return { results: [] };
              if (sql.includes("FROM users")) return { results: [] };
              return { results: [] };
            },
            async run() {
              updates.push(sql);
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      },
    } as unknown as Env;

    const anon = await handleLateFeeAction(
      new Request("https://app.example/api/invoices/inv-1/late-fee", {
        method: "POST",
        body: JSON.stringify({ action: "add" }),
      }),
      env,
      "inv-1",
    );
    expect(anon.status).toBe(401);

    const pm = await handleLateFeeAction(
      new Request("https://app.example/api/invoices/inv-1/late-fee", {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "pm@example.com" },
        body: JSON.stringify({ action: "add" }),
      }),
      env,
      "inv-1",
    );
    expect(pm.status).toBe(403);
    expect(updates).toEqual([]);

    const owner = await handleLateFeeAction(
      new Request("https://app.example/api/invoices/inv-1/late-fee", {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
        body: JSON.stringify({ action: "add" }),
      }),
      env,
      "inv-1",
    );
    expect(owner.status).toBe(200);
    const body = (await owner.json()) as { late_fee_amount: number; total_due: number };
    expect(body.late_fee_amount).toBe(50);
    expect(body.total_due).toBe(1050);
    expect(updates.some((sql) => sql.includes("late_fee_state = 'applied'"))).toBe(true);
  });

  it("refuses Add on an ineligible invoice and still allows waive, snooze, and hold", async () => {
    const today = centralDate();
    const early = row({ due_date: today });
    expect(addRefusal(early, today)?.details).toBe("This invoice isn't 7 days past due yet");
    expect(addRefusal(row({ due_date: addDays(today, -7) }), today)?.error).toBe("grace");
    expect(addRefusal(row({ due_date: addDays(today, -8) }), today)).toBeNull();
    expect(addRefusal(row({ late_fee_hold: 1 }), today)?.details).toBe("This invoice is on hold.");
    expect(addRefusal(row({ billing_model: "cost_plus" }), today)?.error).toBe("cost_plus");
    expect(addRefusal(row({ collected: 1000 }), today)?.details).toBe("There is no unpaid balance to assess.");
    expect(addRefusal(row({ late_fee_state: "applied", late_fee_amount: 50 }), today)?.error).toBe("already_decided");

    const { env, updates } = ownerEnv(early, "false");
    const add = await postLateFee(env, "add");
    expect(add.status).toBe(409);
    expect(((await add.json()) as { details: string }).details).toBe("This invoice isn't 7 days past due yet");
    expect(updates.some((sql) => sql.includes("late_fee_state = 'applied'"))).toBe(false);

    const waive = await postLateFee(env, "waive");
    const snooze = await postLateFee(env, "snooze", { days: 3 });
    const hold = await postLateFee(env, "hold", { reason: "Waiting on a dispute" });
    expect(waive.status).toBe(200);
    expect(snooze.status).toBe(200);
    expect(hold.status).toBe(200);
  });

  it("lets the owner add an eligible fee by hand while the switch is off", async () => {
    const today = centralDate();
    const eligible = row({ due_date: addDays(today, -8) });
    expect(addRefusal(eligible, today)).toBeNull();
    const { env, updates } = ownerEnv(eligible, "false");
    const add = await postLateFee(env, "add");
    expect(add.status).toBe(200);
    const body = (await add.json()) as { late_fee_amount: number };
    expect(body.late_fee_amount).toBe(50);
    expect(updates.some((sql) => sql.includes("late_fee_state = 'applied'"))).toBe(true);
  });

  it("refuses Add on a Jobber import and does not write the fee", async () => {
    const today = centralDate();
    const imported = row({
      job_data_source: "jobber_import",
      due_date: addDays(today, -8),
    });
    const invoiceOnly = row({
      invoice_data_source: "jobber_import",
      job_data_source: null,
      due_date: addDays(today, -8),
    });
    expect(exclusionReason(imported, today)).toBe("jobber");
    expect(addRefusal(imported, today)?.details).toBe("Old Jobber invoices don't get a late fee.");
    expect(addRefusal(invoiceOnly, today)?.error).toBe("jobber");
    const { env, updates } = ownerEnv(imported, "true");
    const add = await postLateFee(env, "add");
    expect(add.status).toBe(409);
    expect(updates.some((sql) => sql.includes("late_fee_state = 'applied'"))).toBe(false);
  });
});

function ownerEnv(invoice: LateFeeCandidate, setting: string): { env: Env; updates: string[] } {
  const updates: string[] = [];
  const users = new Map([
    ["owner@example.com", { id: "u-own", email: "owner@example.com", first_name: "Ada", last_name: "Owner", role: "owner", is_active: 1 }],
  ]);
  const env = {
    DB: {
      prepare(sql: string) {
        const bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound.splice(0, bound.length, ...args);
            return this;
          },
          async first() {
            if (sql.includes("FROM users")) return users.get(String(bound[0])) ?? null;
            if (sql.includes("FROM invoices")) return invoice;
            if (sql.includes("system_settings")) return { value: setting };
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            updates.push(sql);
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, updates };
}

function postLateFee(env: Env, action: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return handleLateFeeAction(
    new Request("https://app.example/api/invoices/inv-1/late-fee", {
      method: "POST",
      headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
      body: JSON.stringify({ action, ...extra }),
    }),
    env,
    "inv-1",
  );
}

describe("due date and past-due cadence", () => {
  it("sets a blank due date to 7 days after the Central send date, including late evening", () => {
    const noon = new Date("2026-10-13T17:00:42.730Z");
    const lateEvening = new Date("2026-10-14T04:30:00.000Z");
    const afterMidnightCentral = new Date("2026-10-14T05:30:00.000Z");
    expect(defaultInvoiceDueDate(noon)).toBe("2026-10-20");
    expect(defaultInvoiceDueDate(lateEvening)).toBe("2026-10-20");
    expect(defaultInvoiceDueDate(afterMidnightCentral)).toBe("2026-10-21");
    expect(shortDueDateWarning(null, lateEvening)).toBeNull();
    expect(shortDueDateWarning("", lateEvening)).toBeNull();
  });

  it("keeps an explicit due date and warns when it is under 7 days after send", () => {
    const sentAt = new Date("2026-10-13T17:00:42.730Z");
    expect(shortDueDateWarning("2026-10-20", sentAt)).toBeNull();
    expect(shortDueDateWarning("2026-10-15", sentAt)).toBe(SHORT_DUE_WARNING);
    expect(shortDueDateWarning("2026-10-13", sentAt)).toBe(SHORT_DUE_WARNING);
    const form = readFileSync(new URL("../frontend/src/views/jobs/FinancialTab.tsx", import.meta.url), "utf8");
    expect(form).toContain('const [dueDate, setDueDate] = useState("");');
    expect(form).toContain("Defaults to 7 days after you send.");
    expect(form).toContain("shortDueDateWarning(dueDate)");
    expect(form).toContain("shortDueDateWarning(inv.due_date)");
    expect(form).toContain("{SHORT_DUE_WARNING}");
    const dueHelper = readFileSync(new URL("../shared/invoice-due.ts", import.meta.url), "utf8");
    expect(dueHelper).toContain(SHORT_DUE_WARNING);
    const send = readFileSync(new URL("../src/routes/invoices.ts", import.meta.url), "utf8");
    expect(send).toContain("defaultInvoiceDueDate(new Date(nowIso))");
    expect(send).not.toContain("Date.now() + 7");
  });

  it("reminds on day 1, day 4, and day 8, then weekly, and never when held, paid, or void", () => {
    const due = "2026-10-13";
    for (const n of [1, 4, 8, 15, 22, 29]) {
      expect(isPastDueReminderDay(due, addDays(due, n))).toBe(true);
    }
    for (const n of [0, 2, 3, 5, 6, 7, 9, 14, 16]) {
      expect(isPastDueReminderDay(due, addDays(due, n))).toBe(false);
    }
    const today = addDays(due, 1);
    expect(pastDueReminderApplies({ dueDate: due, today, status: "past_due" })).toBe(true);
    expect(pastDueReminderApplies({ dueDate: due, today, status: "past_due", billingHold: 1 })).toBe(false);
    expect(pastDueReminderApplies({ dueDate: due, today, status: "past_due", lateFeeHold: 1 })).toBe(false);
    expect(pastDueReminderApplies({ dueDate: due, today, status: "paid" })).toBe(false);
    expect(pastDueReminderApplies({ dueDate: due, today, status: "void" })).toBe(false);
  });
});

describe("agreement late-fee wording", () => {
  function settingsEnv(): Env {
    return {
      DB: {
        prepare: () => ({
          all: async () => ({ results: [] }),
        }),
      },
    } as unknown as Env;
  }

  const ctx = {
    client_name: "ZZTEST",
    property_address: "1 Test St",
    job_title: "Test project",
    total: 1000,
    deposit_amount: 100,
    billing_model: "fifty_fifty",
    payment_schedule_lines: ["Deposit"],
  };

  it("states a one-time 5% fee on a new service agreement", async () => {
    const text = await renderContract(settingsEnv(), ctx);
    expect(text).toContain("due within seven (7) days of the date the invoice is sent to Client");
    expect(text).toContain("one-time late fee of five percent (5%) of the unpaid balance");
    expect(text).toContain("Contractor may waive or delay this fee at its sole discretion");
    expect(text).not.toContain("$50.00 per day");
    expect(text).not.toContain("days of receipt");
  });

  it("keeps cost-plus free of a late fee and carves it out of the service agreement", async () => {
    const text = await renderContract(settingsEnv(), { ...ctx, billing_model: "cost_plus" });
    expect(text).toContain("due within twenty-four (24) hours");
    expect(text).toContain("No late fee applies to Cost-Plus invoices");
    expect(text).toContain("The Late Payment Fee in the Service Agreement does not apply to this Cost-Plus Billing Agreement");
    expect(text).not.toContain("$50.00 per day");
    expect(text).not.toContain("five percent (5%)");
  });

  it("uses the same 5% sentence in the working-agreement template source", () => {
    const source = readFileSync(
      new URL("../scripts/generate-working-agreement-template.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      "All invoices are due within seven (7) days of the date the invoice is sent. If an invoice is not paid within seven (7) days after its due date, Columbus Home Solutions may, at its discretion, add a one-time late fee of five percent (5%) of the unpaid balance, and may waive or delay it.",
    );
    expect(source).toContain("work will pause until the outstanding balance is received");
    expect(source).not.toContain("$50.00 per day");
  });

  it("keeps the live five-year warranty and states the 5% fee in the service-agreement files", () => {
    const payment =
      "A convenience fee of 3.5% will be added to credit/debit card payments. No fee is charged for check or ACH payments. All invoices are due within seven (7) days of the date the invoice is sent to Client. If an invoice is not paid in full within seven (7) days after its due date, Contractor may, at its discretion, add a one-time late fee of five percent (5%) of the unpaid balance. Contractor may waive or delay this fee at its sole discretion. Contractor reserves the right to suspend work if payment is more than fourteen (14) days past due. Work will resume once all outstanding balances and any late fee are paid in full.";
    const warranty =
      "Contractor warrants all workmanship for a period of five (5) years from the date of substantial completion. This warranty covers defects in workmanship only; the full list of exclusions and the limitation of liability are set forth in the Warranty Certificate issued at project completion. Manufacturer warranties apply separately to materials and products. Warranty claims must be submitted in writing within the warranty period.";
    for (const rel of [
      "../src/templates/prepped/service-agreement.docx",
      "../src/templates/CHS-Service-Agreement-Template.docx",
    ]) {
      const paras = docxParagraphs(rel);
      expect(paras.filter((p) => p === payment)).toEqual([payment]);
      expect(paras.filter((p) => p === warranty)).toEqual([warranty]);
      expect(paras.join("\n")).not.toContain("1.5% monthly");
      expect(paras.join("\n")).not.toContain("one (1) year");
    }
    const prepped = unzipSync(
      new Uint8Array(readFileSync(new URL("../src/templates/prepped/service-agreement.docx", import.meta.url))),
    );
    expect(strFromU8(prepped["word/document.xml"])).toContain("{{sign|1|*| |client_sig}}");
    expect(strFromU8(prepped["word/document.xml"])).toContain("{{date|1|*| |client_date}}");
    expect(prepped["word/media/contractor-sig.png"]?.length).toBeGreaterThan(1000);
  });
});

function docxParagraphs(rel: string): string[] {
  const xml = strFromU8(
    unzipSync(new Uint8Array(readFileSync(new URL(rel, import.meta.url))))["word/document.xml"],
  );
  return [...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)]
    .map((m) =>
      [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
        .map((t) =>
          t[1]
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"'),
        )
        .join(""),
    )
    .filter((p) => p.trim());
}

describe("late fee migration", () => {
  it("does not put the old daily fee back into customer copy", () => {
    const sql = readFileSync(new URL("../migrations/0138_late_fee_proposals.sql", import.meta.url), "utf8");
    expect(sql).not.toMatch(/\$50/);
    expect(sql).toContain("late_fee_proposals_enabled");
    expect(sql).toContain("one-time late fee");
  });
});
