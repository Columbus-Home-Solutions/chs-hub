/**
 * Jobber GraphQL queries. Mirrors the shape of the existing Python sync in
 * chs-dashboard/jobber_sync.py, tuned for the cost budget at 25 jobs/page.
 */

/**
 * Per-job expenses pull. Jobber's expenses connection isn't great at the
 * top level (no great job-linked filtering), so we mirror the Python sync
 * and issue one query per current-year job. At ~20 YTD jobs this stays
 * well under any subrequest / throttle budget.
 *
 * Fields:
 *   total       — dollar amount (maps to expenses.amount in D1)
 *   title       — short label (maps to expenses.description)
 *   description — longer detail (folded into description when title is blank)
 *   date        — when the expense was incurred
 */
export function buildJobExpensesQuery(jobId: string): string {
  // Inline the id (quoted) to match the Python sync's pattern — avoids
  // having to guess whether Jobber's schema exposes the id type as
  // `ID!`, `EncodedId!`, or `String!`.
  const safe = jobId.replace(/"/g, '\\"');
  return `
    {
      job(id: "${safe}") {
        id
        expenses(first: 50) {
          nodes {
            id
            title
            description
            total
            date
          }
        }
      }
    }
  `;
}

/**
 * Standalone invoices pull. We run this *after* the per-job pass so that
 * every invoice is captured, not just the "primary" one attached to each
 * job. Jobber's per-job `invoices(first: 1)` misses change orders, re-issued
 * invoices, and any invoice where the ordering happens to surface a
 * different record — which is how we ended up missing ~$48k of YTD
 * collections in the initial backfill.
 *
 * We also pull paymentRecords (for collected_at + per-payment detail) and
 * job.id so we can attach each invoice to the right job in D1.
 */
export const INVOICES_PAGE_QUERY = /* GraphQL */ `
  query InvoicesPage($first: Int!, $after: String) {
    invoices(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        invoiceStatus
        total
        paymentsTotal
        issuedDate
        dueDate
        amounts { depositAmount }
        jobs(first: 1) {
          nodes { id }
        }
        paymentRecords(first: 20) {
          nodes { id amount }
        }
      }
    }
  }
`;

export const JOBS_PAGE_QUERY = /* GraphQL */ `
  query JobsPage($first: Int!, $after: String) {
    jobs(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      totalCount
      nodes {
        id
        jobNumber
        title
        jobStatus
        source
        total
        createdAt
        startAt
        completedAt
        client {
          id
          name
          phones { number }
          emails { address }
          customFields {
            ... on CustomFieldText { label valueText }
            ... on CustomFieldDropdown { label valueDropdown }
          }
        }
        property {
          address { street city province postalCode }
        }
        quote {
          id
          quoteNumber
          quoteStatus
          createdAt
          transitionedAt
          amounts { subtotal }
        }
        lineItems(first: 20) {
          nodes { id name quantity unitPrice unitCost }
        }
        paymentRecords(first: 10) {
          nodes { id amount }
        }
        invoices(first: 1) {
          nodes {
            id
            invoiceStatus
            total
            paymentsTotal
            issuedDate
            dueDate
            amounts { depositAmount }
          }
        }
      }
    }
  }
`;
