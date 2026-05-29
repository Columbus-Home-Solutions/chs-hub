/**
 * Jobber GraphQL queries. Mirrors the shape of the existing Python sync in
 * chs-dashboard/jobber_sync.py, tuned for the cost budget at 25 jobs/page.
 */

/**
 * Standalone expenses connection — captures ALL expenses regardless of
 * whether they're linked to a job. A per-job pass alone misses 70%+
 * of real expenses because categories like Overhead, Vehicle, Office,
 * Apparel, and Tools are typically entered without a job link.
 *
 * Matches Jobber's Expense Report (filtered by expense `date`).
 */
export const EXPENSES_PAGE_QUERY = /* GraphQL */ `
  query ExpensesPage($first: Int!, $after: String) {
    expenses(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        description
        total
        date
        linkedJob {
          id
        }
      }
    }
  }
`;

/**
 * Standalone quotes pull. The per-job pass only gives us quotes that
 * successfully converted to jobs. To compute Pipeline $ (open quotes
 * awaiting response / changes requested / approved-but-not-yet-job),
 * we need every quote, including those never linked to a job.
 */
export const QUOTES_PAGE_QUERY = /* GraphQL */ `
  query QuotesPage($first: Int!, $after: String) {
    quotes(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        quoteNumber
        quoteStatus
        amounts { subtotal }
        createdAt
        transitionedAt
        jobs(first: 1) {
          nodes { id }
        }
        client {
          id
          name
          phones { number }
          emails { address }
        }
      }
    }
  }
`;

/**
 * Standalone invoices pull. We run this *after* the per-job pass so that
 * every invoice is captured, not just the "primary" one attached to each
 * job. Jobber's per-job `invoices(first: 1)` misses change orders, re-issued
 * invoices, and any invoice where the ordering happens to surface a
 * different record — which is how we ended up missing ~$48k of YTD
 * collections in the initial backfill.
 *
 * We also pull paymentRecords (id, amount). Jobber's PaymentRecord type has
 * no payment-date field in GraphQL — we store invoice issuedDate on each
 * payment row as collected_at (see sync.ts). Per-payment dates require a
 * future API field or REST discovery.
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
        noteAttachments(first: 25) {
          nodes {
            id
            fileName
            url
          }
        }
        notes(first: 12) {
          nodes {
            __typename
            ... on JobNote {
              fileAttachments(first: 15) {
                nodes {
                  id
                  fileName
                  url
                }
              }
            }
          }
        }
      }
    }
  }
`;
