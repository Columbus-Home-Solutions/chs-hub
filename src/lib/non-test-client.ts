/**
 * SQL helpers to exclude fixture clients (`clients.is_test = 1`) from
 * dashboards, KPIs, pipelines, and reports — while leaving detail-by-id
 * and search reachable for deliberate testing.
 *
 * Prefer {@link NON_TEST_CLIENT} when alias `c` is already joined.
 * Prefer {@link notTestClientExists} for bare aggregates on jobs/estimates/etc.
 */

/** When `clients` is joined as `c`. */
export const NON_TEST_CLIENT = "COALESCE(c.is_test, 0) = 0";

/**
 * For estimate_requests LEFT JOINed to clients — keep orphan leads
 * (no client yet) but drop linked test clients.
 */
export const NON_TEST_OR_ORPHAN_CLIENT =
  "(er.client_id IS NULL OR COALESCE(c.is_test, 0) = 0)";

/** Bare table filter via NOT EXISTS (expr is e.g. `j.client_id` or `e.client_id`). */
export function notTestClientExists(clientIdExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM clients _ntc
    WHERE _ntc.id = ${clientIdExpr} AND COALESCE(_ntc.is_test, 0) = 1
  )`;
}
