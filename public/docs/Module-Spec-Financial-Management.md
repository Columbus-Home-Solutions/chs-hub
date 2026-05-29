# Module Spec: Financial Management
## CHS Construction Management Platform
### Version 1.1 — May 26, 2026

---

## 1. Purpose

Financial Management handles every dollar in and out of Columbus Home Solutions — invoicing, payment collection, job costing, expense tracking, labor costing, bookkeeping integration, and reporting. It supports three distinct billing models from the same underlying architecture, auto-feeds the Wealthy Contractor spreadsheet, syncs with QuickBooks Online for formal accounting, and produces CPA-ready tax exports. This module works hand-in-glove with Job Management; most financial actions are triggered by job status changes.

---

## 2. Financial Architecture Overview

```
Estimate (Estimating Module)
    │
    ▼
Job Created with Budget Baseline
    │
    ├── Billing Model Selected ──► Determines invoice schedule
    │
    ├── Expenses Logged ──► Materials, subs, labor, receipts
    │                        (from Photo Capture + manual entry)
    │
    ├── Time Tracked ──► Labor costs at $90/hr or $105/hr
    │
    ├── Invoices Generated ──► Based on billing model triggers
    │
    ├── Payments Collected ──► Stripe (CC + ACH)
    │
    ├── Job Costing ──► Budget vs. Actual per line item
    │
    └── Profit Calculated ──► Revenue - Expenses = Profit
         │
         ├──► WC Spreadsheet (auto-sync every 30 min)
         ├──► QuickBooks Online (two-way sync)
         ├──► Financial Dashboards
         └──► CPA Export (annual)
```

---

## 3. The Three Billing Models

Each job is assigned one billing model at creation. The model determines how invoices are generated, what the client sees in their portal, and how job costing is tracked.

### 3.1 Fixed Price — Milestone Draws

Used for: Remodels, garage conversions, smaller projects with a defined scope.

**How it works:**
- Total contract price is set from the approved estimate.
- Payment is split into milestone draws — default is 33% / 33% / 34% (configurable per job).
- Invoices are generated at each milestone (materials deposit, 50% completion, upon completion).
- Client pays a fixed amount at each stage regardless of actual costs incurred.
- Contractor tracks actual costs internally for profitability analysis.

**Invoice schedule example ($31,119 garage conversion):**
```
Draw 1: Materials Deposit (33.30%)     $10,362.63  — Due at contract signing
Draw 2: 50% Completion (33.30%)        $10,362.63  — Due at midpoint
Draw 3: Upon Completion (33.40%)       $10,393.74  — Due at final walkthrough
```

**Deposit rule:** Deposit = first milestone amount.

### 3.2 Trade-by-Trade Billing

Used for: Larger projects (additions, new builds) broken out by trade in the estimate.

**How it works:**
- Estimate is structured with separate line items per trade (concrete, framing, electrical, plumbing, etc.).
- As each trade/phase completes, an invoice is generated for that line item amount.
- Client pays per completed phase.
- Provides natural cash flow alignment — you invoice as value is delivered.

**Invoice schedule example ($125,600 addition):**
```
Invoice 1: Deposit                      $50,000.00  — Due at contract signing
Invoice 2: Concrete slab complete        $8,856.00  — When slab is poured
Invoice 3: Framing complete             $13,904.35  — When framing passes inspection
Invoice 4: Roofing complete              $4,300.00  — When roof is on
... (continues per trade completion)
Invoice N: Final — remaining balance     $X,XXX.XX  — At completion
```

**Deposit rule:** Custom amount set per job (e.g., $50,000 for the addition).

### 3.3 Cost-Plus — Bi-Weekly Billing Cycles

Used for: Larger projects where scope may evolve, or where the client wants full cost transparency.

**How it works (from the CHS Cost+ Billing Agreement):**

Pricing structure:
- Materials: pass-through at cost, no markup.
- Subcontractors: pass-through at cost, no markup. (HVAC, electrical, plumbing, cabinetry, tile, stone.)
- Labor: $90/hr for general work, $105/hr for PM/skilled carpenter.
- Project management & scheduling fee: 10% of total costs.
- Contractor fee: 20% of total costs.

Billing cycle:
1. **Mini-budget created:** Before each two-week period, contractor builds a mini-budget — a breakdown of anticipated materials, subs, labor, PM fee (10%), and contractor fee (20%) for the upcoming two weeks.
2. **Upfront invoice sent:** Client is billed in advance based on the mini-budget. Payment due within 24 hours.
3. **Work performed:** Two weeks of construction. All expenses, time entries, and sub costs are tracked against the mini-budget.
4. **Reconciliation:** At the end of the cycle, actual costs are compared to the mini-budget.
   - Over budget → Client pays the difference on the next invoice.
   - Under budget → Surplus is credited toward the next invoice.
5. **Next cycle begins:** Updated mini-budget is generated incorporating any carry-forward credits or overages.
6. **Final period:** 50% of the final expected two-week period is due upfront. Remaining 50% is due at project completion.

**Deposit rule:** $1,000 deposit to schedule the project, applied toward total costs.

**Client portal view:** Full transparency — mini-budget breakdowns, itemized expense reports, cycle reconciliation, running actual vs. projected totals.

---

## 4. Data Model

### Invoice Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| invoice_number | integer | auto | Auto-incrementing (INV-001, INV-002, etc.) |
| job_id | UUID | yes | FK to jobs table |
| client_id | UUID | yes | FK to clients table |
| billing_model | enum | yes | "fixed_price", "trade_by_trade", "cost_plus" |
| invoice_type | enum | yes | "deposit", "milestone", "trade_completion", "cost_plus_cycle", "final", "change_order", "manual" |
| title | text | yes | e.g., "Materials Deposit", "Framing Complete", "Cycle 3 — May 12-25" |
| description | text | no | Detailed description or line items |
| amount | decimal | yes | Total invoice amount |
| tax_amount | decimal | no | If applicable |
| late_fee_amount | decimal | computed | $50/day after due date |
| total_due | decimal | computed | amount + tax_amount + late_fee_amount - credits_applied |
| credits_applied | decimal | no | Credits from cost-plus over/under adjustments |
| status | enum | yes | "draft", "sent", "viewed", "paid", "partial", "past_due", "void" |
| sent_date | datetime | no | When invoice was emailed/texted to client |
| due_date | date | yes | When payment is expected |
| paid_date | datetime | no | When payment was received |
| paid_amount | decimal | no | Amount actually received (may differ from total_due for partial) |
| payment_method | text | no | "credit_card", "ach", "check", "cash" |
| stripe_payment_id | text | no | Stripe transaction reference |
| portal_link | text | auto | Secure link for client to view and pay |
| cost_plus_cycle_id | UUID | no | FK to billing_cycles table (cost-plus only) |
| milestone_number | integer | no | Which milestone (1, 2, 3) for fixed price |
| trade_line_item_id | UUID | no | FK to estimate line item for trade-by-trade |
| notes | text | no | Internal notes |
| created_at | datetime | auto | |
| created_by | text | auto | |

### Payment Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| invoice_id | UUID | yes | FK to invoices table |
| job_id | UUID | yes | FK to jobs table |
| client_id | UUID | yes | FK to clients table |
| amount | decimal | yes | Amount of this payment |
| payment_method | enum | yes | "credit_card", "ach", "check", "cash" |
| stripe_payment_id | text | no | Stripe transaction ID |
| stripe_fee | decimal | no | Processing fee (2.9% + $0.30 for CC, 1% for ACH) |
| convenience_fee | decimal | no | 3.5% convenience fee charged to client for electronic payments |
| net_amount | decimal | computed | amount - stripe_fee (convenience fee is revenue, not cost) |
| received_date | datetime | yes | When payment was received |
| deposited_date | date | no | When funds hit the bank account |
| notes | text | no | |
| created_at | datetime | auto | |

### Expense Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table (or "general" for non-job expenses) |
| expense_type | enum | yes | "material", "subcontractor", "labor", "permit", "equipment_rental", "vehicle", "office", "insurance", "other" |
| vendor | text | no | Supplier/vendor name |
| description | text | yes | What was purchased/paid for |
| amount | decimal | yes | Total cost |
| incurred_date | date | yes | When the expense occurred |
| estimate_line_item_id | UUID | no | FK to estimate sub-item for job costing alignment |
| receipt_photo_id | UUID | no | FK to photos table (receipt image) |
| receipt_r2_key | text | no | R2 storage key for receipt image |
| tax_category | text | no | IRS category for CPA export (materials, contractor_services, vehicle, etc.) |
| is_1099_reportable | boolean | no | Whether this payment to a sub needs 1099 reporting |
| sub_id | UUID | no | FK to subcontractors table if paying a sub |
| entered_via | enum | yes | "web", "mobile", "pwa", "receipt_capture", "auto" |
| pushed_to_qbo | boolean | no | Whether synced to QuickBooks Online |
| qbo_transaction_id | text | no | QuickBooks transaction reference |
| created_at | datetime | auto | |
| created_by | text | auto | |

### Time Entry Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| worker | text | yes | Who worked (user name or "Tony", crew member name) |
| role | enum | yes | "general" ($90/hr) or "pm_skilled" ($105/hr) |
| clock_in | datetime | yes | Start time |
| clock_out | datetime | no | End time (null = still clocked in) |
| hours | decimal | computed | Calculated from clock_in/clock_out, rounded to nearest 0.25 |
| hourly_rate | decimal | auto | Set from role: 90.00 or 105.00 |
| labor_cost | decimal | computed | hours × hourly_rate |
| notes | text | no | What work was performed |
| entered_via | enum | yes | "web", "mobile", "auto" |
| created_at | datetime | auto | |

### Cost-Plus Billing Cycle Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| cycle_number | integer | auto | Sequential per job (1, 2, 3, ...) |
| period_start | date | yes | First day of the two-week period |
| period_end | date | yes | Last day of the two-week period |
| is_final_cycle | boolean | no | Whether this is the last billing period |
| status | enum | yes | "planning", "active", "reconciling", "closed" |
| projected_materials | decimal | no | Estimated material costs for this period |
| projected_labor | decimal | no | Estimated labor costs |
| projected_subs | decimal | no | Estimated sub costs |
| projected_subtotal | decimal | computed | Sum of projected costs |
| pm_fee_rate | decimal | yes | Default 0.10 (10%) |
| contractor_fee_rate | decimal | yes | Default 0.20 (20%) |
| projected_pm_fee | decimal | computed | projected_subtotal × pm_fee_rate |
| projected_contractor_fee | decimal | computed | projected_subtotal × contractor_fee_rate |
| projected_total | decimal | computed | projected_subtotal + projected_pm_fee + projected_contractor_fee |
| actual_materials | decimal | computed | Sum of material expenses in this period |
| actual_labor | decimal | computed | Sum of time entry costs in this period |
| actual_subs | decimal | computed | Sum of sub expenses in this period |
| actual_subtotal | decimal | computed | Sum of actual costs |
| actual_pm_fee | decimal | computed | actual_subtotal × pm_fee_rate |
| actual_contractor_fee | decimal | computed | actual_subtotal × contractor_fee_rate |
| actual_total | decimal | computed | actual_subtotal + actual_pm_fee + actual_contractor_fee |
| delta | decimal | computed | projected_total - actual_total (positive = under, negative = over) |
| credit_from_prior | decimal | no | Credit carried forward from previous cycle |
| credit_to_next | decimal | no | Credit carrying forward to next cycle |
| invoice_id | UUID | no | FK to the upfront invoice for this cycle |
| reconciliation_invoice_id | UUID | no | FK to any reconciliation invoice (if over budget) |
| reconciliation_date | datetime | no | When the reconciliation was completed |
| notes | text | no | |
| created_at | datetime | auto | |

### Mileage Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | no | FK to jobs table (null for non-job trips) |
| trip_purpose | text | yes | "job_site", "supply_run", "estimate_appointment", "office", "other" |
| start_location | text | no | Starting address or GPS coordinates |
| end_location | text | no | Ending address or GPS coordinates |
| distance_miles | decimal | yes | Total miles driven |
| trip_date | date | yes | |
| irs_rate | decimal | auto | Current IRS mileage rate (2026 rate) |
| deduction_amount | decimal | computed | distance_miles × irs_rate |
| notes | text | no | |
| created_at | datetime | auto | |

### Lien Waiver Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| sub_id | UUID | yes | FK to subcontractors table |
| waiver_type | enum | yes | "conditional", "unconditional", "partial", "final" |
| payment_amount | decimal | yes | Amount the waiver covers |
| status | enum | yes | "requested", "received", "filed" |
| requested_date | date | auto | When the request was sent |
| received_date | date | no | When the signed waiver was returned |
| document_id | UUID | no | FK to stored waiver document |
| notes | text | no | |
| created_at | datetime | auto | |

### Vendor/Material Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| vendor_name | text | yes | e.g., "Lowe's", "Home Depot", "ABC Supply" |
| material_name | text | yes | e.g., "2x4 Stud 8ft", "7/16 OSB 4x8" |
| category | text | yes | "lumber", "concrete", "electrical", "plumbing", "roofing", "drywall", "paint", "hardware", etc. |
| unit | text | yes | "each", "sqft", "linear_ft", "board", "sheet", "bag", "gallon", "box" |
| last_price | decimal | yes | Most recent price paid |
| last_purchased_date | date | no | When last purchased |
| average_price | decimal | computed | Rolling average across all purchases |
| price_history | JSON | no | Array of {date, price, vendor} for trend tracking |
| notes | text | no | Preferred brands, sizes, alternatives |
| created_at | datetime | auto | |
| updated_at | datetime | auto | |

---

## 5. Core Workflows

### 5.1 Invoice Generation

**Fixed price invoices:**
1. At job creation, the milestone schedule is defined (default 33/33/34 or custom).
2. Deposit invoice (Draw 1) is auto-generated when estimate is sent.
3. Subsequent milestone invoices are manually triggered by the user when milestones are reached.
4. Each invoice references the milestone number and description.

**Trade-by-trade invoices:**
1. When a task group (matching an estimate line item) is marked complete, the system suggests generating an invoice for that trade.
2. User confirms and sends the invoice for that line item amount.
3. Final invoice captures any remaining balance.

**Cost-plus invoices:**
1. User creates a new billing cycle with projected costs for the upcoming two weeks.
2. System calculates PM fee (10%) and contractor fee (20%) on top of projected costs.
3. Upfront invoice is auto-generated for the projected total (minus any credit from prior cycle).
4. At end of cycle, reconciliation runs automatically.
5. If over budget: a supplemental invoice is generated for the difference.
6. If under budget: credit is recorded and applied to next cycle's invoice.
7. Final cycle: 50% due upfront, 50% at completion.

**Change order invoices:**
- When a change order is approved, its amount is added to the contract total.
- For fixed price: amount is added to the final milestone.
- For trade-by-trade: a new line item invoice is created.
- For cost-plus: amount is folded into the next billing cycle's mini-budget.

### 5.2 Payment Collection

**Stripe integration:**
- Every invoice includes a secure payment link.
- Client clicks link → lands on branded payment page.
- Payment page presents two options:
  - **Pay by check:** No additional fee. Instructions to mail check with invoice number reference.
  - **Pay by credit card / ACH:** A 3.5% convenience fee is added to the transaction total. Fee is clearly disclosed before payment confirmation (e.g., "Invoice: $10,362.63 + Convenience Fee: $362.69 = Total: $10,725.32").
- The convenience fee encourages clients to pay by check, reducing payment processing costs for the business.
- Credit card processing: Stripe charges 2.9% + $0.30. The 3.5% convenience fee covers the processing cost with a small margin.
- ACH processing: Stripe charges 1%. The 3.5% convenience fee applies uniformly to all electronic payments for simplicity.
- Check/cash: manually recorded by user — no convenience fee.

**Payment processing flow:**
1. Client clicks payment link from invoice email or portal.
2. Payment page shows invoice amount, convenience fee (3.5% for electronic payment), and total. Check payment option shown as "no fee."
3. Client selects payment method and submits.
4. Stripe processes the payment (invoice amount + convenience fee).
5. Webhook fires back to the Worker.
6. Payment record is created in D1 with convenience_fee and stripe_fee tracked separately.
7. Invoice status updates to "paid" (or "partial" if less than full amount).
8. Payment receipt notification is sent to client (showing invoice amount and convenience fee separately).
9. If all invoices on a job are paid and job is Complete, status moves to Closed.
10. Payment data syncs to WC Spreadsheet on next cycle.
11. Transaction pushes to QuickBooks Online (convenience fee recorded as income, stripe fee as expense).

### 5.3 Cost-Plus Billing Engine (Detailed)

This is the most complex billing workflow. Step-by-step:

**Cycle setup (start of each two-week period):**
```
1. User opens the job's Financial tab → "New Billing Cycle"
2. System pre-fills:
   - Cycle number (auto-incrementing)
   - Period start/end dates (defaults to next two weeks)
   - Any credit carried from prior cycle
3. User enters projected costs:
   - Projected materials (e.g., $3,200 for lumber and drywall)
   - Projected labor (e.g., 80 hours × $90/hr = $7,200)
   - Projected subs (e.g., $2,500 for electrician)
   - System auto-calculates:
     → Subtotal: $12,900
     → PM fee (10%): $1,290
     → Contractor fee (20%): $2,580
     → Cycle total: $16,770
     → Less prior credit: -$450
     → Invoice amount: $16,320
4. User reviews and clicks "Generate Invoice"
5. Invoice is created and sent to client
6. Cycle status moves to "active"
```

**During the cycle (two weeks of work):**
```
- Expenses are logged against the job (receipt capture, manual entry)
- Time entries are recorded (clock in/out)
- Sub invoices are received and logged
- All costs are tagged to this billing cycle by date range
- Real-time budget vs. actual is visible in the job's Financial tab
```

**Reconciliation (end of cycle):**
```
1. System computes actual costs:
   - Actual materials: $2,800
   - Actual labor: 72 hours × $90/hr = $6,480
   - Actual subs: $2,500
   - Subtotal: $11,780
   - PM fee (10%): $1,178
   - Contractor fee (20%): $2,356
   - Actual total: $15,314
2. Delta calculated: $16,770 projected - $15,314 actual = $1,456 under budget
3. Credit of $1,456 carries to next cycle
4. Reconciliation report generated (client-facing):
   - Projected vs. actual by category
   - Line-item expense detail
   - Credit/overage explanation
5. Report is sent to client via portal notification
6. Cycle status moves to "closed"
7. Next cycle setup begins
```

**Final cycle handling:**
```
1. Mark cycle as "is_final_cycle = true"
2. 50% of projected total is invoiced upfront
3. Remaining 50% is invoiced at project completion
4. Final reconciliation runs against all actual costs
5. Any remaining credit is applied to the final invoice
6. Any remaining overage is added to the final invoice
```

### 5.4 Job Costing (Budget vs. Actual)

**How it works:**

The estimate sets the budget baseline. Every expense, time entry, and sub payment logged against the job updates the "actual" side. The system shows a real-time comparison.

**Budget structure (mirrors estimate parent/sub-item structure):**
```
Framing — Budget: $13,904 | Actual: $11,200 | Variance: +$2,704 ✅
  ├── Lumber         Budget: $5,200 | Actual: $4,800 | +$400
  ├── OSB/Sheathing  Budget: $1,800 | Actual: $1,900 | -$100
  ├── House wrap     Budget: $400   | Actual: $350   | +$50
  ├── Labor          Budget: $5,504 | Actual: $3,600 | +$1,904
  └── Fasteners/misc Budget: $1,000 | Actual: $550   | +$450

Electrical — Budget: $8,635 | Actual: $8,635 | Variance: $0 ⚪
  └── (Sub — flat rate, no breakdown needed)
```

**For fixed price jobs:** Budget is the internal cost estimate (sub-items). Revenue is the client price (parent items). Difference is your margin.

**For cost-plus jobs:** Budget is the mini-budget projections per cycle. Actuals are tracked in real time. The client sees the actuals.

### 5.5 Expense Tracking & Receipt Capture

**Entry methods:**
1. **Receipt capture (mobile):** KEEP from chs-hub. Snap photo → AI reads vendor, amount → auto-categorizes → links to job. User confirms or edits.
2. **Manual entry (web/mobile):** Enter vendor, amount, description, date, category. Optionally attach receipt photo.
3. **Smart Notes routing:** A voice note like "picked up drywall screws at Lowe's, $47" triggers an expense suggestion pre-filled with vendor, amount, and job link.

**Categorization:**
- Every expense is categorized for both job costing (which estimate line item does this apply to?) and tax reporting (IRS category).
- AI suggests both categories based on vendor and description. User confirms.

### 5.6 Time Tracking

**Clock in/out flow:**
1. User opens the app → taps "Clock In" on a specific job.
2. System records clock_in timestamp and the job.
3. Timer runs visibly on screen.
4. User taps "Clock Out" when done.
5. System calculates hours (rounded to nearest 15 minutes).
6. Labor cost is auto-calculated: hours × rate ($90 or $105 based on role).
7. For cost-plus jobs: labor cost immediately updates the current billing cycle actuals.

**Multiple jobs in a day:** User can clock out of one job and clock into another. Each time entry is per-job.

### 5.7 Late Fee Automation

Per the CHS Service Agreement:
- All invoices are due within 7 days of receipt.
- A late fee of $50 per day is added for any invoice not paid within 7 days.
- System auto-calculates late fees daily and adds to the invoice total.
- Past due notifications are sent automatically.
- Late fee amount is shown separately on the invoice so the client sees the original amount plus the accrued fees.

---

## 6. QuickBooks Online Integration

### Sync architecture:
- **Direction:** Primarily push from CHS → QBO. Pull from QBO only for reconciliation.
- **Connection:** OAuth 2.0 flow to authorize the CHS app with the user's QBO account.
- **Frequency:** Real-time push on transaction creation, or batch sync on a schedule.

### What syncs to QBO:
| CHS Data | QBO Object | Notes |
|----------|-----------|-------|
| Client | Customer | Create/update customer records |
| Invoice | Invoice | Full invoice with line items |
| Payment | Payment | Linked to the correct invoice |
| Expense (materials) | Expense/Bill | Categorized by vendor and account |
| Expense (subs) | Expense/Bill | Flagged as contractor payment |
| Labor cost | Time Activity or Journal Entry | Depends on QBO setup |
| Mileage | Mileage entry | If QBO supports it, or as expense |

### Category mapping:
- User configures which QBO accounts/categories map to which CHS expense types during setup.
- Default mappings provided for common categories (materials → "Cost of Goods Sold: Materials", subs → "Cost of Goods Sold: Subcontractors", etc.).

### What CHS provides that QBO alone can't:
- Job-level profitability (QBO has no concept of a "job" with budget vs. actual).
- Cost-plus billing cycle management.
- Real-time job costing during active construction.
- Receipt photo attachment linked to specific jobs and estimate line items.

---

## 7. WC Spreadsheet Auto-Sync

### Architecture (carry forward from chs-hub):
- Sync runs every 30 minutes via Cloudflare Workers cron.
- Google Sheets API v4 via service account authentication.
- One-way push: CHS → Spreadsheet. The spreadsheet is read-only from the software's perspective.

### Data points synced:

**Monthly Net Profits tab:**
- Total Income per month
- Net Profits per month
- Net Income percentage

**Key Business Performance Indicators tab (weekly rows):**
- New Sales (dollar value of new contracts signed that week)
- Weekly Collections (payments received that week)
- Leads (count of new leads that week)
- Appointments / Estimates provided (count)
- Closed (count of jobs won that week)
- Closed % (conversion rate)

**Weekly Marketing Tallies tab:**
- New Sales
- $ That Hit The Bank
- Accounts Receivable
- Lead counts by source (Organic Google, Google Adwords, Google LSA, Facebook, Referral, Repeat, Other)
- Marketing spend by channel
- Converted count and percentage

### What changes from chs-hub:
- Data source changes from Jobber D1 imports to native CHS data.
- More data points available (lead source tracking is native now, not inferred from Jobber).
- Same Google Sheets API pattern, same service account, same sheet ID.

---

## 8. CPA-Ready Tax Export

Annual export that gives the CPA everything needed for tax filing:

### Export contents:
1. **Income summary:** Total revenue by month, by job, by job type.
2. **Expense summary:** All expenses categorized by IRS category, with subtotals.
3. **Receipt attachments:** Every expense has its receipt photo linked or embedded.
4. **Job profitability report:** Revenue, expenses, and profit per completed job.
5. **Subcontractor payments:** All payments to subs, per sub, with their tax ID/SSN — flagged for 1099 reporting. Any sub paid $600+ in the calendar year gets a 1099-NEC flag.
6. **Mileage log:** Every trip with date, destination, purpose, and miles. Total miles and deduction amount at current IRS rate.
7. **Vehicle expenses:** Gas, maintenance, insurance — if tracked.
8. **Asset depreciation inputs:** Major equipment purchases flagged for potential Section 179 deduction.

### Export format:
- PDF report with summary sections.
- CSV/Excel attachment with raw data for CPA's working papers.
- Zip archive with all receipt images organized by month.

---

## 9. Financial Dashboards & KPIs

### Dashboard tiles (desktop home screen):
- **YTD Revenue:** Total invoiced and collected this year.
- **YTD Profit:** Revenue minus all expenses.
- **Profit Margin %:** Overall and per-job average.
- **Unpaid Invoices:** Total outstanding with aging (0-7, 8-14, 15-30, 30+ days).
- **Cash Collected This Week/Month:** Payments received in the current period.
- **Active Job Costing Alerts:** Jobs where actuals are exceeding budget by >10%.
- **Upcoming Invoices:** Milestone draws or cost-plus cycle invoices coming due.

### Profitability insights:
- Profit margin by job type (which work is most profitable?).
- Revenue per lead source (which marketing channels pay off?).
- Average ticket size trend over time.
- Client lifetime value (repeat clients vs. one-time).
- Seasonal revenue patterns.

### Annual business snapshot:
- Total revenue, total expenses, net profit.
- Jobs completed count and average job size.
- Top 5 most profitable jobs.
- Bottom 5 least profitable jobs.
- Profitability by job type (remodel vs. addition vs. new build, etc.).
- Client acquisition cost by marketing channel.
- Year-over-year growth comparison (when 2+ years of data exist).

---

## 10. Screen Descriptions

### 10.1 Job Financial Tab

Accessed from the Job Detail View → Financial tab. Shows:
- **Summary bar:** Contract total, total invoiced, total paid, total expenses, current profit, margin %.
- **Budget vs. Actual table:** One row per estimate line item (parent level), expandable to show sub-items. Color-coded: green (under budget), yellow (close), red (over budget).
- **Invoices list:** All invoices for this job with status badges (draft, sent, paid, past due).
- **Payments list:** All payments received with date, amount, method.
- **Expenses list:** All expenses with vendor, amount, receipt thumbnail, category.
- **Time entries:** Clock in/out history with hours and labor cost.
- **Cost-plus cycles** (if applicable): Cycle-by-cycle breakdown with projections, actuals, and delta.

### 10.2 Invoice Builder

- Select invoice type (milestone, trade completion, cost-plus cycle, manual).
- Line items auto-populate based on type, or manually entered.
- Preview shows exactly what the client will see.
- Attach payment schedule reference.
- "Send" button generates secure payment link and emails the client.

### 10.3 Cost-Plus Cycle Manager

- List of all billing cycles for the job in chronological order.
- Current cycle highlighted with real-time budget tracker.
- "New Cycle" button to start the next two-week period.
- Reconciliation view with projected vs. actual side by side.
- "Generate Report" to create client-facing reconciliation document.

### 10.4 Expense Entry (Mobile)

- Quick-tap category selection (material, sub, labor, permit, vehicle, other).
- Camera button for receipt capture.
- Amount, vendor, description fields.
- Job selector (defaults to current active job if accessed from job view).
- AI auto-fill from receipt photo (vendor name, amount, date).

### 10.5 Time Tracker

- Big "Clock In" / "Clock Out" button.
- Active timer display.
- Job selector.
- Role selector (General / PM-Skilled).
- History view showing recent time entries.

### 10.6 Financial Dashboard

- KPI tiles across the top.
- Revenue chart (monthly trend).
- Unpaid invoices aging chart.
- Job costing alerts list.
- Quick links to invoice builder, expense entry, time tracker.

---

## 11. Business Rules

1. An invoice cannot be sent without a valid client email address.
2. Stripe processing fees (2.9% + $0.30 for CC, 1% for ACH) are recorded as expenses and reduce net revenue. The 3.5% convenience fee charged to clients for electronic payments is recorded as income — it offsets but does not eliminate the processing cost.
3. The 3.5% convenience fee rate is stored as a system setting and can be adjusted. It must comply with applicable state and federal surcharge regulations.
3. Cost-plus billing cycles cannot overlap. A new cycle can only begin after the prior cycle is reconciled.
4. The PM fee (10%) and contractor fee (20%) rates are configurable per job but default to the standard rates from the billing agreement.
5. Labor rates ($90/hr general, $105/hr PM/skilled) are stored as system settings and can be updated. Historical time entries retain the rate in effect when they were recorded.
6. Late fees begin accruing on day 8 after invoice sent (7-day grace period per contract terms).
7. A job's billing model cannot be changed after the first invoice has been generated.
8. All expense receipts are stored permanently in R2, even if the expense record is later voided.
9. Mileage deductions use the IRS standard mileage rate for the current tax year, stored as a system setting.
10. Subcontractor payments exceeding $600/year trigger a 1099-NEC flag in the CPA export.
11. QuickBooks sync failures are logged to the dead-letter queue and retried. Financial data in CHS is always the source of truth; QBO is the downstream consumer.
12. Credits from cost-plus over-estimates are applied automatically to the next cycle's invoice. They are never refunded as cash unless the job is complete and a final credit remains.
13. Voided invoices are kept in the system with "void" status for audit trail. They are excluded from all revenue calculations.
14. The WC Spreadsheet sync writes to specific cell ranges — it never modifies formulas or formatting in the sheet.

---

## 12. Inter-Module Connections

### → Job Management
- Financial data is always accessed through a job context.
- Job status changes trigger invoice generation (deposit at signing, final at completion).
- Job costing budget is derived from the estimate attached to the job.
- Billing model is set on the job record and drives all financial behavior.

### → Estimating & Quoting
- Estimate parent items set the client-facing price structure.
- Estimate sub-items set the internal cost budget.
- Payment schedule is defined during estimating and carried into the billing model.
- Material cost database is populated from expense history and used in future estimates.

### → Photo Capture System
- Receipt photos are captured through the CHS Capture PWA.
- Receipt images are stored in R2 and linked to expense records.
- AI processes receipt photos for auto-fill (vendor, amount, date).

### → Client Management & Portal
- Invoices are viewable and payable through the client portal.
- Cost-plus clients see mini-budget and reconciliation detail.
- Payment history is visible per client across all their jobs.

### → Document Management
- Invoices, receipts, and financial reports are stored per job.
- Lien waivers are stored as documents linked to jobs and subs.
- CPA export is generated and stored as a document.

### → Automated Notifications
- Payment receipt notifications on every payment.
- Invoice due reminders (2 days before due date).
- Past due notices (daily after grace period, with late fee amount).
- Cost-plus cycle report delivery.

### → System & Administration
- Stripe connection setup in system settings.
- QuickBooks OAuth connection setup in system settings.
- Labor rates, PM fee, contractor fee configurable in system settings.
- All financial transactions logged in audit trail.

---

## 13. Migration Notes

### What carries forward from chs-hub:
- Expense tracking and receipt capture (PWA + API).
- WC Spreadsheet auto-sync pattern and Google Sheets API integration.
- KPI calculation logic (YTD profit, gross revenue, unpaid, etc.).
- R2 storage for receipt images.

### What's new (net build):
- Native invoice creation (replaces Jobber invoice read).
- Stripe payment integration.
- Cost-plus billing cycle engine (entirely new — no existing tool does this).
- Time tracking with labor cost calculation.
- QuickBooks Online integration.
- Job costing with budget vs. actual per estimate line item.
- Late fee automation.
- CPA-ready tax export.
- Mileage tracking.
- Lien waiver management.
- Material/vendor cost database.
- Financial dashboards beyond current KPI tiles.

### Data migration:
- Historical payment/invoice data from Jobber imports in D1 is preserved for reporting.
- Expense data already in D1 carries forward with new fields added via migration.
- New financial records going forward are created natively.
