/**
 * Jobber GraphQL queries. Mirrors the shape of the existing Python sync in
 * chs-dashboard/jobber_sync.py, tuned for the cost budget at 25 jobs/page.
 */

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
