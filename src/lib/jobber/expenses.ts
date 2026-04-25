/**
 * Jobber GraphQL write-back for PWA-captured expenses.
 *
 * Schema (probed 2026-04-25 against api/graphql 2025-04-16):
 *
 *   mutation expenseCreate(input: ExpenseCreateInput!) -> ExpenseCreatePayload
 *
 *   ExpenseCreateInput:
 *     title*           String           — vendor (or fallback "PWA expense")
 *     description      String
 *     date*            ISO8601DateTime  — incurred_at
 *     total            Float            — amount
 *     linkedJobId      EncodedId        — our job_id (already encoded)
 *     receiptUrl       String           — public URL Jobber can fetch the
 *                                         receipt from. Skipped in v1
 *                                         because /api/expenses/:id/receipt
 *                                         is gated by Cloudflare Access.
 *     receiptSignedBlobId  EncodedId    — ActiveStorage upload; not used.
 *     reimbursableToId, accountingCodeId — not used.
 *
 *   ExpenseCreatePayload:
 *     expense          Expense          — { id, title, total, ... }
 *     userErrors       [Error]!         — non-empty list means partial failure
 *
 * Receipts are intentionally NOT pushed to Jobber yet. To do so we'd need
 * to either (a) expose a public, signed-URL view of `/api/expenses/:id/receipt`
 * that Jobber's fetcher can hit without Cloudflare Access, or (b) implement
 * the ActiveStorage two-step upload (`receiptSignedBlobId`). Neither is hard
 * but neither is in scope for the first cut — for now, receipts stay in
 * R2/Dashboard and the Jobber row carries the metadata only.
 */

import type { Env } from "../../env.js";
import { getAccessToken } from "./auth.js";
import { jobberQuery } from "./client.js";

interface ExpenseCreateResult {
  expenseCreate: {
    expense: { id: string; title: string | null; total: number | null } | null;
    userErrors: Array<{ message: string; path?: string[] | null }>;
  };
}

const EXPENSE_CREATE_MUTATION = /* GraphQL */ `
  mutation ExpenseCreate($input: ExpenseCreateInput!) {
    expenseCreate(input: $input) {
      expense { id title total }
      userErrors { message path }
    }
  }
`;

interface ExpenseRow {
  id: string;
  job_id: string | null;
  amount: number | null;
  vendor: string | null;
  description: string | null;
  incurred_at: string | null;
  entered_via: string;
  pushed_to_jobber_at: string | null;
  jobber_id: string | null;
}

export interface PushResult {
  ok: boolean;
  jobber_id?: string;
  pushed_to_jobber_at?: string;
  user_errors?: string[];
  error?: string;
}

/**
 * Push a single PWA-captured expense to Jobber and update D1 with the
 * returned `jobber_id` + a `pushed_to_jobber_at` timestamp.
 *
 * Idempotent: if the row is already pushed (jobber_id present) we no-op
 * and return ok with the existing values. If the row was inserted by
 * the Jobber sync (entered_via='jobber') we refuse — that row is owned
 * by Jobber, not by us.
 */
export async function pushExpenseToJobber(
  env: Env,
  expenseId: string,
): Promise<PushResult> {
  const row = await env.DB.prepare(
    `SELECT id, job_id, amount, vendor, description, incurred_at,
            entered_via, pushed_to_jobber_at, jobber_id
       FROM expenses WHERE id = ?`,
  )
    .bind(expenseId)
    .first<ExpenseRow>();

  if (!row) return { ok: false, error: "expense_not_found" };
  if (row.entered_via !== "pwa") {
    return { ok: false, error: "not_a_pwa_expense" };
  }
  if (row.jobber_id && row.pushed_to_jobber_at) {
    // Already pushed — be idempotent so the dashboard's retry button is safe.
    return {
      ok: true,
      jobber_id: row.jobber_id,
      pushed_to_jobber_at: row.pushed_to_jobber_at,
    };
  }
  if (!Number.isFinite(Number(row.amount)) || Number(row.amount) <= 0) {
    return { ok: false, error: "amount_invalid" };
  }
  if (!row.incurred_at) {
    return { ok: false, error: "incurred_at_missing" };
  }

  // Jobber requires a non-empty title. Fall back when the PWA was used
  // without a vendor (e.g. quick capture, vendor filled in later).
  const title = (row.vendor && row.vendor.trim()) || "PWA expense";

  const input: Record<string, unknown> = {
    title,
    date: row.incurred_at,
    total: Number(row.amount),
  };
  if (row.description && row.description.trim()) input.description = row.description.trim();
  if (row.job_id) input.linkedJobId = row.job_id;

  let result: ExpenseCreateResult;
  try {
    const token = await getAccessToken(env);
    result = await jobberQuery<ExpenseCreateResult>(
      token,
      EXPENSE_CREATE_MUTATION,
      { variables: { input } },
    );
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const payload = result.expenseCreate;
  if (payload.userErrors && payload.userErrors.length > 0) {
    return {
      ok: false,
      error: "user_errors",
      user_errors: payload.userErrors.map((e) => e.message),
    };
  }
  if (!payload.expense?.id) {
    return { ok: false, error: "no_expense_returned" };
  }

  const pushedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE expenses
        SET jobber_id = ?, pushed_to_jobber_at = ?
      WHERE id = ?`,
  )
    .bind(payload.expense.id, pushedAt, expenseId)
    .run();

  return {
    ok: true,
    jobber_id: payload.expense.id,
    pushed_to_jobber_at: pushedAt,
  };
}
