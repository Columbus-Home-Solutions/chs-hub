# Module Spec: WC Spreadsheet Auto-Sync
## CHS Construction Management Platform
### Version 1.0 — May 29, 2026

---

## 1. Purpose

The Wealthy Contractor (WC) Spreadsheet is the accountability tool used by Tony's business coaching company to track weekly and monthly business performance. It is a Google Sheets workbook that the coaching team reviews regularly to measure lead flow, close rates, revenue, expenses, profit, and marketing ROI. The spreadsheet stays — it is not replaced by the CHS platform. The platform feeds it.

Today, every data point in the spreadsheet is entered by hand. This module eliminates that entirely. The CHS platform pushes data to the spreadsheet automatically on a 30-minute sync cycle, writing to specific cell ranges without ever touching the spreadsheet's formulas, formatting, conditional formatting, or structure. The coaching team sees fresh numbers without Tony lifting a finger.

**Design principle:** CHS is the source of truth. The spreadsheet is a downstream consumer. Data flows one direction: CHS → Google Sheets. The spreadsheet is treated as read-only by the software — we write to designated value cells and nothing else.

---

## 2. Architecture

### Carry forward from chs-hub:

The existing chs-hub already has a working WC Spreadsheet sync. This module carries forward the proven pattern and expands it to cover all data points now that the platform is the system of record (instead of Jobber).

- **Sync engine:** Cloudflare Workers cron trigger, runs every 30 minutes.
- **API:** Google Sheets API v4 via service account authentication.
- **Direction:** One-way push. CHS → Spreadsheet only.
- **Sheet ID:** Stored in system settings (`google_sheets_spreadsheet_id`). Currently `1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo`.
- **Service account:** Shared with the spreadsheet for edit access. Credentials stored securely in Worker environment.
- **Write method:** `spreadsheets.values.update` with `valueInputOption: 'RAW'` for numbers, `'USER_ENTERED'` for formatted values. Batch writes via `spreadsheets.values.batchUpdate` to minimize API calls.
- **Error handling:** Sync failures log to the dead-letter queue (DLQ) and retry on the next cycle. Three consecutive failures trigger a heartbeat alert.

### What changes from chs-hub:

- Data source switches from Jobber D1 imports to native CHS data (jobs, estimates, payments, expenses, leads).
- More data points are available natively (lead source tracking, appointment counts, quote values are all first-class data now).
- The sync covers all six spreadsheet tabs instead of a partial subset.
- Cell range mappings are configurable in system settings (not hardcoded) so the spreadsheet structure can evolve without code changes.

---

## 3. Spreadsheet Structure

The WC Spreadsheet has four tabs (visible at the bottom of the sheet). Three contain data that CHS auto-populates. The fourth is a coaching goal-setting tab that the platform does not write to.

### Tabs CHS Writes To:

| Tab Name | Purpose | Row Structure | Sync Frequency |
|----------|---------|---------------|----------------|
| Monthly Net Profits | Monthly income, expenses, and net profit by year | One row per month, side-by-side year sections | Every 30 minutes |
| Key Business Performance Indicators | Weekly sales pipeline and conversion metrics | One row per week (start/end date pairs) | Every 30 minutes |
| Weekly Marketing Tallies | Weekly lead sources by channel, ad spend, AR, conversions, and sales process metrics | One row per week | Every 30 minutes |

### Tabs CHS Does NOT Write To:

| Tab Name | Purpose | Notes |
|----------|---------|-------|
| Month KPI's | 4/8/12-month growth goal benchmarks (revenue goal, conversion rate, closing rate, profit targets, total leads, estimates given, jobs completed, avg ticket, weekly/monthly breakdowns) | Coaching team (Redmond Growth Consulting) maintains manually. These are aspirational targets, not actuals. |

---

## 4. Data Points by Tab

### 4.1 Key Business Performance Indicators (Weekly)

Each row represents one week. The weekly period is defined by two date columns (start and end). Rows are pre-populated for the entire year by the coaching team.

| Column | Header | Data Point | Source Module | How Calculated | Auto-Sync? |
|--------|--------|-----------|---------------|----------------|------------|
| A | Weekly Period (start) | Week start date | — | Pre-filled by coaching team (e.g., "5/24") | No — read-only for row matching |
| B | Weekly Period (end) | Week end date | — | Pre-filled by coaching team (e.g., "5/30") | No — read-only for row matching |
| C | New Sales | Dollar value of new contracts | Estimating → Job Mgmt | Sum of `contract_total` for jobs created this week via quote-to-job conversion. | Yes |
| D | Weekly Collections | Payments received | Financial | Sum of `payment.amount` where `received_date` falls in the current week. Includes convenience fees. | Yes |
| E | Leads | Lead count | Estimating | Count of new estimate requests created this week. | Yes |
| F | Appointments / Estimates provided | Appointment count | Estimating | Count of estimate requests where `appointment_date` was set this week. | Yes |
| G | Closed | Deals won | Estimating → Job Mgmt | Count of jobs created this week via quote-to-job conversion. | Yes |
| H | Closed % | Conversion rate | Computed | `Closed / Leads × 100`. Spreadsheet formula — CHS does NOT write this cell. | No — spreadsheet formula |
| I | Number of Google Reviews | Reviews received | Manual / Future | Currently not auto-populated. Tony enters manually after receiving Google reviews. Future: could pull from Google Business Profile API. | No (Phase 1) |

**Row matching logic:** The sync reads columns A and B to find the row where the current date falls between the start and end dates. The dates in the spreadsheet use short format (e.g., "5/24", "5/30") without year — the sync assumes the current year when parsing. If no matching row is found, the sync skips and logs a warning to the DLQ.

**Important:** Column H (Closed %) is a spreadsheet formula (`=G/E`), not a CHS-written value. The sync writes columns C, D, E, F, and G only. Column I (Google Reviews) remains manual in Phase 1.

### 4.2 Weekly Marketing Tallies

Same weekly row structure. This tab has three logical sections separated by black spacer columns: financial performance, marketing channel breakdown (with paired lead/spend columns), and sales process effectiveness.

| Column | Header | Data Point | Source | Auto-Sync? |
|--------|--------|-----------|--------|------------|
| A | Weekly Period | Week date range | — | No — read-only for row matching |
| B | New Sales | Dollar value of new contracts | Estimating → Job Mgmt | Yes |
| C | $ That Hit The Bank | Payments deposited | Financial | Yes |
| D | Accounts Receivable | Outstanding invoice balance | Financial | Yes |
| E | *(spacer)* | Black divider column | — | No |
| F | Organic Google Leads | Lead count from organic search | Estimating | Yes |
| G | Google Adwords Leads | Lead count from paid search | Estimating | Yes |
| H | Google Adwords Spend | Ad spend on Google Ads | Manual / Future | No (Phase 1) |
| I | Google Local Services Leads | Lead count from Google LSA | Estimating | Yes |
| J | Google Local Services Ad Spend | Ad spend on Google LSA | Manual / Future | No (Phase 1) |
| K | Facebook Leads | Lead count from Facebook | Estimating | Yes |
| L | Facebook Spend | Ad spend on Facebook/Instagram | Manual / Future | No (Phase 1) |
| M | Referral | Lead count from referrals | Estimating | Yes |
| N | Repeat | Lead count from repeat clients | Estimating | Yes |
| O | Other | Lead count from other sources | Estimating | Yes |
| P | *(spacer)* | Black divider column | — | No |
| Q | Converted | Deals converted this week | Estimating → Job Mgmt | Yes |
| R | Converted % | Conversion rate | Computed | No — spreadsheet formula |
| S | Not Soon Enough Calls | Leads that weren't ready | Manual | No (Phase 1) |
| T | Number of Google Reviews | Reviews received this week | Manual / Future | No (Phase 1) |
| U | *(spacer)* | — | — | No |
| V | Solvable/Unsolvable Objections | Sales objection tracking | Manual | No — coaching exercise |

**CHS auto-populates these columns:** B, C, D, F, G, I, K, M, N, O, Q.

**Manual columns (Phase 1):** H (Adwords Spend), J (LSA Spend), L (Facebook Spend), S (Not Soon Enough Calls), T (Google Reviews), V (Objections). Ad spend columns could be automated in Phase 2 via Google Ads and Facebook Ads APIs.

**Column R (Converted %)** is a spreadsheet formula — CHS does not write it.

**Lead source mapping:**

| CHS Lead Source Value | Spreadsheet Column |
|----------------------|-------------------|
| `organic_google` | F — Organic Google Leads |
| `google_adwords` | G — Google Adwords Leads |
| `google_lsa` | I — Google Local Services Leads |
| `facebook` | K — Facebook Leads |
| `referral` | M — Referral |
| `repeat_client` | N — Repeat |
| `thumbtack` | O — Other |
| `website` | O — Other |
| `direct_call` | O — Other |
| `other` / null / unknown | O — Other |

**Financial calculations:**

- **$ That Hit The Bank (C):** Sum of `payment.amount` where `deposited_date` falls in the current week. If `deposited_date` is null, uses `received_date` as fallback.
- **Accounts Receivable (D):** Snapshot total of all unpaid invoices. Sum of `invoice.total_due - invoice.paid_amount` for invoices with status "sent", "viewed", "partial", or "past_due".

### 4.3 Monthly Net Profits

This tab has a side-by-side layout — the current year on the left (columns A–D) and the prior year on the right (columns F–I) for easy comparison. Each section has 12 month rows (Jan–Dec), a Totals row, and a "% of NI to Total" summary row.

**Current year section (left side):**

| Column | Header | Data Point | Source | Auto-Sync? |
|--------|--------|-----------|--------|------------|
| A | Month | Month label (Jan, Feb, etc.) | — | No — pre-filled |
| B | Total Income | Revenue collected | Financial | Yes |
| C | Net Profits | Income minus expenses | Computed by CHS | Yes |
| D | NI% | Net income percentage | Computed | No — spreadsheet formula |

**Prior year section (right side, columns F–I):** Same structure. CHS writes to this section for the prior year's data if it exists in the system. Otherwise it's historical data entered manually.

**Row 16 (Totals)** and **Row 17 (% of NI to Total)** are spreadsheet formulas — CHS does not write to these rows.

**Calculations:**

- **Total Income (B):** Sum of `payment.amount` where `received_date` falls in the calendar month. Includes convenience fee revenue.
- **Net Profits (C):** Total Income minus Total Expenses for the month. Total Expenses = sum of `expense.amount` where `incurred_date` falls in the month, plus Stripe processing fees from `payment.stripe_fee` for payments received that month.
- **NI% (D):** Spreadsheet formula (`=C/B`). CHS does not write this — it calculates automatically when B and C are populated.

**Row matching:** Months are in rows 4–15 (Jan=4, Feb=5, ... Dec=15) based on the screenshot. The sync matches by the month label in column A. The header is in row 3, the logo in row 1, and the year title in row 2.

**Multi-year handling:** The sync writes the current year's data to columns B–C (left section). If the system has prior year data, it writes to columns G–H (right section). The year labels in row 2 ("Monthly Net Profits 2026 YTD" and "Monthly Net Profits 2025") determine which section maps to which year.

---

## 5. Sync Engine Workflow

### 5.1 Cron Trigger

The sync runs on the existing Cloudflare Workers cron schedule (every 30 minutes). It executes as part of the broader cron handler alongside other scheduled tasks (heartbeat, nightly backup, etc.).

```
Cron fires (every 30 min)
  │
  ├── Determine current week (Sun-Sat, Central Time)
  ├── Determine current month
  │
  ├── Query CHS data:
  │   ├── Estimate requests created this week (leads, by source)
  │   ├── Appointments set this week
  │   ├── Jobs created this week via quote-to-job (closed deals, contract values)
  │   ├── Payments received this week (weekly collections)
  │   ├── Payments deposited this week ($ that hit the bank)
  │   ├── Total unpaid invoices (AR snapshot)
  │   ├── Payments received this month (total income)
  │   └── Expenses incurred this month + Stripe fees (total expenses)
  │
  ├── Compute derived values:
  │   ├── Net Profit = income - expenses
  │   └── (Closed %, Converted %, NI% are spreadsheet formulas — not written by CHS)
  │
  ├── Build batch update payload:
  │   ├── KPI tab: find current week row, write columns C, D, E, F, G
  │   ├── Marketing Tallies tab: find current week row, write columns B, C, D, F, G, I, K, M, N, O, Q
  │   └── Monthly Net Profits tab: find current month row, write columns B, C
  │
  ├── Execute Google Sheets API batchUpdate
  │
  ├── On success: log sync completion with timestamp and row count
  └── On failure: log to DLQ, increment failure counter
      └── 3 consecutive failures → heartbeat alert
```

### 5.2 Row Discovery

The sync must find the correct row for the current week/month without assuming fixed row numbers (the coaching team adds rows as weeks/months pass).

**KPI tab (two-column dates):** Read columns A and B. Column A has the week start date (e.g., "5/24"), column B has the week end date (e.g., "5/30"). Parse both as dates (assume current year), find the row where today's date falls between start and end inclusive.

**Marketing Tallies tab (single column):** Read column A. The weekly period label may be a date range or single date. Parse the first date-like value and match to the current week.

**Monthly Net Profits tab (month labels):** Read column A. Match by month name (e.g., "Jan", "Feb", "Mar"). Rows are fixed at 4–15 (Jan=row 4 through Dec=row 15) based on the spreadsheet structure, but the sync should still match by label for resilience.

```
1. KPI tab: Read columns A:B → find row where today falls between A and B dates
2. Marketing Tallies tab: Read column A → find row matching current week
3. Monthly Net Profits tab: Read column A → find row matching current month name
4. If any row not found → log warning to DLQ, skip that tab
5. Never insert rows — the coaching team maintains the spreadsheet structure
```

**Date parsing notes:**
- KPI tab dates use short format without year: "1/4", "5/24", "12/28". Always assume the current year.
- Handle year-boundary weeks (e.g., "12/28" start to "1/3" end) by checking if end date < start date and adjusting the year accordingly.
- Marketing Tallies dates may vary in format. Extract the first recognizable date and match to the Sunday of that week.

### 5.3 Timezone Handling

All date boundaries use Central Time (America/Chicago). The Worker runs in UTC. Every date comparison must convert UTC to CT before determining which week or month a record belongs to.

```javascript
// Example: Convert UTC timestamp to CT date
const ctDate = new Date(utcTimestamp).toLocaleDateString('en-US', {
  timeZone: 'America/Chicago'
});
```

### 5.4 Batch Write Strategy

Use `spreadsheets.values.batchUpdate` to write all three tabs in a single API call. This minimizes quota usage and ensures all tabs update atomically within the same sync cycle.

Note: Because the Marketing Tallies columns are non-contiguous (skip spacer columns E and P), use individual cell range writes rather than a single row range.

```
batchUpdate payload:
  data: [
    // KPI tab — columns C, D, E, F, G (contiguous)
    { range: "'Key Business Performance Indicators'!C{row}:G{row}",
      values: [[new_sales, weekly_collections, leads, appointments, closed]] },

    // Marketing Tallies — financial section (B, C, D)
    { range: "'Weekly Marketing Tallies'!B{row}:D{row}",
      values: [[new_sales, bank_deposits, ar_balance]] },

    // Marketing Tallies — lead sources (F, G skip H, I skip J, K skip L, M, N, O)
    { range: "'Weekly Marketing Tallies'!F{row}:G{row}",
      values: [[organic_google, google_adwords]] },
    { range: "'Weekly Marketing Tallies'!I{row}",
      values: [[google_lsa]] },
    { range: "'Weekly Marketing Tallies'!K{row}",
      values: [[facebook]] },
    { range: "'Weekly Marketing Tallies'!M{row}:O{row}",
      values: [[referral, repeat, other]] },

    // Marketing Tallies — converted count (Q)
    { range: "'Weekly Marketing Tallies'!Q{row}",
      values: [[converted]] },

    // Monthly Net Profits — income and net profit (B, C)
    { range: "'Monthly Net Profits'!B{row}:C{row}",
      values: [[total_income, net_profit]] }
  ]
  valueInputOption: "RAW"
```

---

## 6. Data Queries

The sync needs to run these D1 queries on each cycle. All queries filter by the current week or month in Central Time.

### Weekly Queries (for KPI + Marketing Tallies tabs)

**Leads this week:**
```sql
SELECT COUNT(*) as lead_count,
       lead_source,
       COUNT(*) FILTER (WHERE lead_source = 'organic_google') as organic_google,
       COUNT(*) FILTER (WHERE lead_source = 'google_adwords') as google_adwords,
       COUNT(*) FILTER (WHERE lead_source = 'google_lsa') as google_lsa,
       COUNT(*) FILTER (WHERE lead_source = 'facebook') as facebook,
       COUNT(*) FILTER (WHERE lead_source = 'referral') as referral,
       COUNT(*) FILTER (WHERE lead_source = 'repeat_client') as repeat_client
FROM estimate_requests
WHERE created_at >= :week_start AND created_at < :week_end
```

**Appointments this week:**
```sql
SELECT COUNT(*) as appointment_count
FROM estimate_requests
WHERE appointment_date >= :week_start AND appointment_date < :week_end
```

**Closed deals this week (jobs created via quote-to-job):**
```sql
SELECT COUNT(*) as closed_count, SUM(contract_total) as new_sales
FROM jobs
WHERE created_at >= :week_start AND created_at < :week_end
  AND status != 'cancelled'
```

**Payments received this week:**
```sql
SELECT SUM(amount) as weekly_collections
FROM payments
WHERE received_date >= :week_start AND received_date < :week_end
```

**Payments deposited this week:**
```sql
SELECT SUM(amount) as bank_deposits
FROM payments
WHERE deposited_date >= :week_start AND deposited_date < :week_end
```

**Accounts receivable (snapshot):**
```sql
SELECT SUM(total_due - COALESCE(paid_amount, 0)) as ar_balance
FROM invoices
WHERE status IN ('sent', 'viewed', 'partial', 'past_due')
```

### Monthly Queries (for Monthly Net Profits tab)

**Total income this month:**
```sql
SELECT SUM(amount) as total_income
FROM payments
WHERE received_date >= :month_start AND received_date < :month_end
```

**Total expenses this month (for net profit calculation):**
```sql
-- Job and business expenses
SELECT SUM(amount) as expense_total
FROM expenses
WHERE incurred_date >= :month_start AND incurred_date < :month_end
```

```sql
-- Stripe processing fees (tracked on payment records, not as separate expenses)
SELECT SUM(stripe_fee) as stripe_fees
FROM payments
WHERE received_date >= :month_start AND received_date < :month_end
  AND stripe_fee > 0
```

**Net Profit = Total Income - (expense_total + stripe_fees)**

The sync writes two values to the Monthly Net Profits tab: Total Income (column B) and Net Profits (column C). The NI% in column D is a spreadsheet formula that calculates automatically.

---

## 7. Cell Range Configuration

Cell range mappings are stored in system settings so the spreadsheet structure can change without code deployment.

### System Settings

| Setting Key | Default Value | Description |
|------------|---------------|-------------|
| `wc_spreadsheet_id` | `1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo` | Google Sheets workbook ID |
| `wc_sync_enabled` | `true` | Master on/off switch for the sync |
| `wc_sync_interval_minutes` | `30` | Cron frequency (informational — actual cron is set in wrangler.toml) |
| `wc_kpi_tab_name` | `Key Business Performance Indicators` | Tab name for weekly KPI data |
| `wc_kpi_week_start_column` | `A` | Column containing week start dates |
| `wc_kpi_week_end_column` | `B` | Column containing week end dates |
| `wc_kpi_data_columns` | `C:G` | Column range for KPI data values (New Sales, Collections, Leads, Appointments, Closed) |
| `wc_kpi_first_data_row` | `3` | First row with data (skip header rows) |
| `wc_marketing_tab_name` | `Weekly Marketing Tallies` | Tab name for weekly marketing data |
| `wc_marketing_week_column` | `A` | Column containing week period labels |
| `wc_marketing_first_data_row` | `4` | First row with data (skip header rows) |
| `wc_monthly_tab_name` | `Monthly Net Profits` | Tab name for monthly profit data |
| `wc_monthly_month_column` | `A` | Column containing month labels |
| `wc_monthly_data_columns` | `B:C` | Column range for monthly data (Total Income, Net Profits) |
| `wc_monthly_first_data_row` | `4` | First data row (Jan) |
| `wc_monthly_last_data_row` | `15` | Last data row (Dec) |
| `wc_monthly_prior_year_income_column` | `G` | Column for prior year Total Income |
| `wc_monthly_prior_year_profit_column` | `H` | Column for prior year Net Profits |

### Why configurable?

The coaching team occasionally restructures the spreadsheet — adding columns, renaming tabs, or shifting data ranges. Making these configurable means Tony (or the coaching team) can update the mappings in system settings without requiring a code change and redeployment. The sync reads the current mappings on every cycle.

---

## 8. Error Handling & Reliability

### Failure modes and responses:

| Failure | Response |
|---------|----------|
| Google Sheets API returns 401/403 | Service account credentials may be expired or revoked. Log to DLQ with "AUTH_FAILURE" tag. Heartbeat alert after 3 consecutive failures. |
| Google Sheets API returns 429 (rate limit) | Back off and retry on the next 30-minute cycle. Log with "RATE_LIMIT" tag. |
| Google Sheets API returns 404 | Spreadsheet ID may be wrong or spreadsheet was deleted. Log to DLQ with "NOT_FOUND" tag. Immediate heartbeat alert. |
| Row not found for current week/month | The coaching team hasn't added the new week's row yet. Log warning with "ROW_MISSING" tag. Do not create the row — wait for next cycle. |
| D1 query fails | Database may be temporarily unavailable. Log to DLQ and retry next cycle. |
| Partial batch write failure | Some tabs updated, others failed. Log which tabs failed. Retry the failed tabs on the next cycle. |
| Network timeout | Log and retry next cycle. |

### Consecutive failure tracking:

The sync maintains a failure counter in KV cache (`wc_sync_consecutive_failures`). On success, the counter resets to 0. On failure, it increments. At 3 consecutive failures, a heartbeat alert fires (email to Tony via the existing reliability subsystem).

### Sync logging:

Every sync cycle logs a record to the `sync_log` table:

| Field | Value |
|-------|-------|
| sync_type | `wc_spreadsheet` |
| status | `success`, `partial_failure`, `failure`, `skipped` |
| tabs_updated | Array of tab names that were successfully written |
| tabs_failed | Array of tab names that failed |
| rows_matched | Object mapping tab name to matched row number |
| data_snapshot | JSON snapshot of the values written (for debugging) |
| error_message | Error details if failed |
| duration_ms | How long the sync took |
| created_at | Timestamp |

### Dead-letter queue entries:

Failed syncs create entries in the `sync_dead_letters` table with type `wc_spreadsheet`. These are visible in the System Admin DLQ viewer and can be manually retried or dismissed.

---

## 9. Business Rules

1. The sync writes to specific cell ranges only. It never inserts rows, deletes rows, modifies formulas, changes formatting, adds conditional formatting, or alters the spreadsheet structure in any way.
2. The sync never reads data back from the spreadsheet for use in the CHS platform. Data flows one direction only.
3. If a spreadsheet row for the current week/month does not exist, the sync skips that tab and logs a warning. It does not create the row.
4. All monetary values are written as plain numbers (no currency formatting, no dollar signs). The spreadsheet's own formatting handles display.
5. Percentage columns (Closed %, Converted %, NI%) are spreadsheet formulas. CHS does not write to these cells. They calculate automatically when CHS populates the input columns.
6. The sync uses Central Time (America/Chicago) for all week and month boundary calculations.
7. Week boundaries are Sunday 00:00:00 CT through Saturday 23:59:59 CT.
8. Month boundaries are the 1st at 00:00:00 CT through the last day at 23:59:59 CT.
9. Convenience fees collected from clients are included in Total Income (they are revenue). Stripe processing fees are included in Total Expenses (they are costs).
10. The sync is idempotent — running it twice in the same cycle produces the same result. It overwrites the same cells with recalculated values, never appends.
11. Ad spend columns (Google Adwords Spend, Google LSA Ad Spend, Facebook Spend — columns H, J, L on Marketing Tallies) are not auto-populated in Phase 1. They remain manual entry until Google Ads and Facebook Ads API integrations are built.
12. "Not Soon Enough Calls" (column S), "Number of Google Reviews" (columns I on KPI, T on Marketing Tallies), and "Solvable/Unsolvable Objections" (column V) are manual coaching-exercise columns. CHS does not write to them in any phase.
12. The `wc_sync_enabled` setting provides a master kill switch. When false, the cron still fires but the sync immediately returns without querying or writing.

---

## 10. Inter-Module Connections

### ← Estimating & Quoting (data source)
- Lead count and lead source breakdown come from estimate requests.
- Appointment count comes from estimate request appointment dates.
- Quotes sent count and dollar value come from estimate sent events.
- Closed deal count and new sales value come from quote-to-job conversions.

### ← Job Management (data source)
- Jobs created this week (via quote-to-job conversion) feed closed deal count and new sales.
- Job contract totals feed the New Sales dollar value.

### ← Financial Management (data source)
- Payments received feed Weekly Collections, $ That Hit The Bank, and monthly Total Income.
- Unpaid invoices feed the Accounts Receivable snapshot.
- Expenses feed monthly Total Expenses.
- Stripe fees feed monthly Total Expenses.
- Convenience fees are included in payment amounts (they are income).

### → System & Administration
- Spreadsheet ID and tab names are stored in system settings.
- Service account credentials are managed in system settings.
- Sync failures appear in the DLQ viewer.
- Heartbeat alerts fire on consecutive failures.
- Sync logs are visible in the admin audit trail.

---

## 11. Migration Notes

### What carries forward from chs-hub:
- Google Sheets API v4 integration pattern.
- Service account authentication and credentials.
- 30-minute cron trigger pattern.
- Sync logging to `sync_log` table.
- DLQ integration for failure handling.
- Heartbeat alert pattern for consecutive failures.

### What changes:
- Data source switches from Jobber D1 imports to native CHS tables (estimate_requests, estimates, jobs, payments, invoices, expenses).
- Lead source tracking is native (not inferred from Jobber tags).
- All six automatable data points are now covered (previously partial coverage).
- Cell range mappings move from hardcoded values to system settings.
- Row discovery logic added (match week/month labels in column A).

### What's new:
- Configurable cell range mappings in system settings.
- Row discovery by label matching (handles spreadsheet structure changes gracefully).
- Full lead source breakdown by channel (Organic Google, Adwords, LSA, Facebook, Referral, Repeat, Other).
- Accounts Receivable snapshot on every sync.
- Monthly Net Profits tab sync (income, expenses, net profit, margin %).

---

## 12. Technical Notes for Cursor

### File location:
- Sync logic lives in `src/services/wc-spreadsheet.ts` (carry forward from chs-hub).
- Cron handler calls the sync function on the 30-minute schedule.

### Google Sheets API setup:
- Use `googleapis` npm package or direct REST calls to Sheets API v4.
- Service account JSON credentials stored as Worker secret (`WC_SHEETS_SERVICE_ACCOUNT`).
- JWT token generation for service account auth.
- Batch update endpoint: `POST https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values:batchUpdate`
- Batch read endpoint (for row discovery): `GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}`

### Testing approach:
- Unit test the data aggregation queries independently.
- Unit test the row discovery logic with sample column A data in various formats.
- Integration test the full sync against a test spreadsheet (separate sheet ID in dev environment).
- Never test against the production WC spreadsheet.

### Performance considerations:
- The sync should complete in under 10 seconds. The D1 queries are lightweight (weekly/monthly aggregations on small tables). The Sheets API call is a single batchUpdate.
- Read column A for all three tabs in a single batchGet call to minimize API round trips.
- Cache nothing between sync cycles — always query fresh data. The 30-minute interval means stale cache risk outweighs the performance benefit.

---

## 13. Future Enhancements

### Phase 2 — Marketing Spend Auto-Population
- Integrate Google Ads API to pull weekly ad spend for Google Adwords (column H) and Google LSA (column J) automatically.
- Integrate Facebook Ads API for Facebook/Instagram ad spend (column L).
- Calculate cost-per-lead and cost-per-acquisition by channel.

### Phase 2 — Google Reviews Auto-Population
- Integrate Google Business Profile API to pull review count.
- Auto-populate "Number of Google Reviews" on both the KPI tab (column I) and Marketing Tallies tab (column T).

### Phase 2 — Historical Backfill
- One-time backfill script to populate past weeks/months from historical CHS data.
- Useful when transitioning from manual entry — fills gaps in the historical record.
- Runs as a manual admin action, not on the regular cron.

### Phase 3 — Spreadsheet Health Monitor
- Dashboard widget showing last successful sync time, data freshness, and any DLQ warnings.
- Alert if the coaching team hasn't added next week's row by Sunday morning.
- Visual indicator on the CHS dashboard: "WC Spreadsheet: Synced 12 minutes ago ✓"
