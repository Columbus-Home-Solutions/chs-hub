import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import type { LateFeeCandidate } from "../src/lib/late-fee.js";
import { runLateFeeProposals } from "../src/lib/late-fee.js";
import {
  calendarDecisionItems,
  calendarDecisionTitle,
  lateFeeAddConfirm,
  lateFeeDecisionItems,
  loadOwnerDecisionItems,
  type CalendarDecisionRow,
} from "../src/lib/owner-decisions.js";
import { handleDashboardActionItems } from "../src/routes/dashboard.js";

const TODAY = "2026-10-20";

function fee(over: Partial<LateFeeCandidate> = {}): LateFeeCandidate {
  return {
    id: "inv-1",
    invoice_number: 12,
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
    client_name: "Karen Perry",
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

function moved(): CalendarDecisionRow {
  return {
    id: "pend-1",
    source_type: "estimate_request",
    change_kind: "moved",
    summary_label: "Estimate for Karen Perry",
    when_label: "Tue 12:00 PM",
    updated_at: "2026-10-20 12:00:00",
  };
}

describe("calendar decision rows", () => {
  it("uses a plain sentence and the same three move buttons", () => {
    const [item] = calendarDecisionItems([moved()]);
    expect(calendarDecisionTitle(moved())).toBe(
      "Karen Perry's estimate was moved on Google to Tue 12:00 PM.",
    );
    expect(item.title).toBe("Karen Perry's estimate was moved on Google to Tue 12:00 PM.");
    expect(item.link).toBe("/");
    expect(item.actions.map((action) => action.label)).toEqual([
      "Apply",
      "Apply without texting the customer",
      "Ignore (keep CHS time)",
    ]);
    expect(item.actions.every((action) => action.path === "/api/google-calendar/changes/pend-1")).toBe(true);
  });

  it("offers cancel and ignore when Google deleted the event", () => {
    const [item] = calendarDecisionItems([{ ...moved(), change_kind: "deleted" }]);
    expect(item.title).toBe("Karen Perry's estimate was removed on Google.");
    expect(item.actions.map((action) => action.body.action)).toEqual(["cancel", "ignore"]);
  });
});

function proposed(over: Partial<LateFeeCandidate> = {}): LateFeeCandidate {
  return fee({ late_fee_state: "proposed", late_fee_proposed_amount: 50, ...over });
}

describe("late-fee decision rows", () => {
  it("shows no row while the switch is off, even when an invoice would be proposed", async () => {
    const { env } = dashboardEnv({
      proposalsEnabled: false,
      invoices: [fee()],
    });
    const items = await loadOwnerDecisionItems(env, new Date("2026-10-20T15:00:00.000Z"));
    expect(items.filter((item) => item.type === "late_fee_proposed")).toEqual([]);
    expect(lateFeeDecisionItems([fee()], TODAY)).toEqual([]);
  });

  it("shows Add, Waive, Snooze, and Hold once the nightly job has proposed it", () => {
    const [item] = lateFeeDecisionItems([proposed()], TODAY);
    expect(item.id).toBe("late_fee_inv-1");
    expect(item.title).toContain("Karen Perry");
    expect(item.title).toContain("INV-012");
    expect(item.title).toContain("$50.00");
    expect(item.actions.map((action) => action.label)).toEqual([
      "Add fee",
      "Waive",
      "Snooze 3 days",
      "Snooze 7 days",
      "Hold",
    ]);
    const add = item.actions[0];
    expect(add.confirm).toBe(lateFeeAddConfirm("INV-012", "$50.00"));
    expect(add.confirm).toContain("INV-012");
    expect(add.confirm).toContain("$50.00");
    expect(add.confirm?.toLowerCase()).toContain("this sends the customer one text");
    expect(item.actions.filter((action) => action.id !== "add").every((action) => !action.confirm)).toBe(true);
    expect(item.actions.find((action) => action.id === "hold")?.needsReason).toBe(true);
  });

  it("drops the row after waive, snooze, hold, or add", () => {
    expect(lateFeeDecisionItems([proposed()], TODAY)).toHaveLength(1);
    expect(lateFeeDecisionItems([proposed({ late_fee_state: "waived" })], TODAY)).toEqual([]);
    expect(lateFeeDecisionItems([proposed({ late_fee_state: "none", late_fee_snooze_until: "2026-10-25" })], TODAY)).toEqual([]);
    expect(lateFeeDecisionItems([proposed({ late_fee_state: "none", late_fee_hold: 1 })], TODAY)).toEqual([]);
    expect(lateFeeDecisionItems([proposed({ late_fee_state: "applied", late_fee_amount: 50 })], TODAY)).toEqual([]);
  });

  it("keeps a job-less invoice on Home with a real link", () => {
    const [item] = lateFeeDecisionItems([
      proposed({ id: "inv-loose", job_id: null, invoice_number: 7 }),
    ], TODAY);
    expect(item.link).toBe("/");
    expect(item.link).not.toContain("null");
    expect(item.link).not.toContain("undefined");
    expect(JSON.stringify(item)).not.toContain("/jobs/null");
    expect(JSON.stringify(item)).not.toContain("/jobs/undefined");
    expect(item.actions[0].path).toBe("/api/invoices/inv-loose/late-fee");
    expect(item.actions[0].confirm).toContain("INV-007");
  });
});

describe("home action items", () => {
  it("keeps the decision when the list is full and when it was dismissed", async () => {
    const { env, sql } = dashboardEnv({
      calendar: [moved()],
      invoices: [proposed()],
      pastDue: Array.from({ length: 9 }, (_, i) => ({
        id: `pd-${i}`,
        job_id: `job-${i}`,
        due_date: "2026-10-01",
        balance: 10,
        first_name: "Ada",
        last_name: "Lane",
      })),
      followUps: [
        { id: "er-1", created_at: "2026-10-01", first_name: "Ada", last_name: "Lane", contact_name: null },
      ],
      changeOrders: [
        { id: "co-1", title: "Add a window", job_id: "job-9", created_at: "2026-10-01", job_title: "Kitchen" },
      ],
      dismissed: ["gcal_pend-1", "late_fee_inv-1"],
    });
    const res = await handleDashboardActionItems(env);
    const body = (await res.json()) as {
      items: { id: string; type: string; link: string; actions?: { confirm?: string }[] }[];
    };
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain("gcal_pend-1");
    expect(ids).toContain("late_fee_inv-1");
    expect(body.items.filter((item) => item.type === "invoice_past_due")).toHaveLength(8);
    expect(sql.some((query) => query.includes("status = 'pending'"))).toBe(true);
    expect(sql.some((query) => query.includes("UPDATE google_calendar_pending_changes"))).toBe(false);

    const open = dashboardEnv({
      followUps: [
        { id: "er-1", created_at: "2026-10-01", first_name: "Ada", last_name: "Lane", contact_name: null },
      ],
      changeOrders: [
        { id: "co-1", title: "Add a window", job_id: "job-9", created_at: "2026-10-01", job_title: "Kitchen" },
      ],
    });
    const openRes = await handleDashboardActionItems(open.env);
    const openBody = (await openRes.json()) as {
      items: { type: string; link: string; actions?: unknown[] }[];
    };
    const follow = openBody.items.find((item) => item.type === "follow_up_due");
    expect(follow?.link).toBe("/estimating?status=follow_up");
    expect(follow?.actions).toBeUndefined();
    const change = openBody.items.find((item) => item.type === "change_order_pending");
    expect(change?.link).toBe("/jobs/job-9?tab=change_orders");
  });

  it("omits a calendar row that is no longer pending", async () => {
    const { env } = dashboardEnv({ calendar: [] });
    const items = await loadOwnerDecisionItems(env, new Date("2026-10-20T15:00:00.000Z"));
    expect(items.some((item) => item.type === "google_calendar_change")).toBe(false);
  });
});

describe("late-fee proposal bell", () => {
  it("links a job-less invoice to Home", async () => {
    const links: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          let args: unknown[] = [];
          const bound = {
            bind(...next: unknown[]) {
              args = next;
              return bound;
            },
            async all() {
              if (sql.includes("late_fee_state")) return { results: [fee({ job_id: null })] };
              return { results: [] };
            },
            async first() {
              if (sql.includes("system_settings")) return { value: "true" };
              if (sql.includes("FROM users")) {
                return { id: "owner-1", email: "tony@homesolutionsar.com", first_name: "Tony", last_name: "Columbus", phone: null };
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT") && sql.includes("notification_logs")) links.push(String(args[7] ?? ""));
              return { success: true };
            },
          };
          return bound;
        },
      },
    } as unknown as Env;
    const result = await runLateFeeProposals(env, new Date("2026-10-20T15:00:00.000Z"));
    expect(result.enabled).toBe(true);
    expect(result.proposed).toBe(1);
    expect(links).toEqual(["/app/"]);
    expect(links[0]).not.toContain("null");
  });
});

function dashboardEnv(opts: {
  calendar?: CalendarDecisionRow[];
  invoices?: LateFeeCandidate[];
  pastDue?: unknown[];
  followUps?: unknown[];
  changeOrders?: unknown[];
  dismissed?: string[];
  proposalsEnabled?: boolean;
}): { env: Env; sql: string[] } {
  const sql: string[] = [];
  const env = {
    DB: {
      prepare(query: string) {
        sql.push(query);
        let args: unknown[] = [];
        const bound = {
          bind(...next: unknown[]) {
            args = next;
            return bound;
          },
          async all() {
            if (query.includes("google_calendar_pending_changes")) return { results: opts.calendar ?? [] };
            if (query.includes("late_fee_state")) return { results: opts.invoices ?? [] };
            if (query.includes("status = 'past_due'")) return { results: opts.pastDue ?? [] };
            if (query.includes("status = 'follow_up'")) return { results: opts.followUps ?? [] };
            if (query.includes("FROM change_orders")) return { results: opts.changeOrders ?? [] };
            return { results: [] };
          },
          async first() {
            if (query.includes("system_settings") && String(args[0] ?? "").includes("dismissed")) {
              return opts.dismissed ? { value: JSON.stringify(opts.dismissed) } : null;
            }
            if (query.includes("COUNT(*)")) return { n: 0, cnt: 0 };
            return null;
          },
          async run() {
            return { success: true };
          },
        };
        return bound;
      },
    },
  };
  return { env: env as Env, sql };
}
