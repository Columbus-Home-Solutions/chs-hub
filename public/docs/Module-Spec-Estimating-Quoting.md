# Module Spec: Estimating & Quoting
## CHS Construction Management Platform
### Version 1.0 — May 26, 2026

---

## 1. Purpose

Estimating & Quoting owns the entire pre-job pipeline — from the moment a lead enters the system through quote approval and deposit payment. This module handles lead intake from all sources, estimate appointment scheduling, the estimate builder with its parent/sub-item cost structure, quote delivery with integrated contracts and reviews, payment schedule configuration, quote follow-ups, and the quote-to-job conversion that creates jobs in the Job Management module.

**Key boundary:** Nothing in this module is a "job" yet. Everything here is a potential project — a request, an opportunity, a quote. A job is only created when the client signs the contract and pays the deposit, at which point the quote-to-job conversion fires and hands off to Job Management.

**WC Spreadsheet responsibility:** This module triggers the lead count, appointment count, and quotes sent data points for the Wealthy Contractor spreadsheet. Job Management takes over for closed deals, revenue, and profitability.

---

## 2. Pre-Job Pipeline

### Pipeline Stages

```
New Request → Appointment Set → Estimate Visit Done → Estimate Building → Estimate Sent → Follow-Up → Won / Lost
```

**New Request**
A lead has come in from any source. Client info exists but no appointment has been set yet.
- Sources: Direct call, Google LSA (via High Level), Thumbtack, website form, referral, repeat client.
- WC Spreadsheet: Lead count increments. Lead source logged (Organic Google, Google Adwords, Google LSA, Facebook, Referral, Repeat, Other).
- Notification: Lead acknowledgment sent to client ("Thank you for reaching out — we'll be in touch within 24 hours").
- Auto: Repeat client detection runs — system checks if this client already exists.

**Appointment Set**
An on-site estimate visit has been scheduled with the client.
- Trigger: User sets appointment date/time on the estimate request.
- WC Spreadsheet: Appointment count increments.
- Notification: Appointment confirmation sent to client with date, time, and address. Reminder sent at configured interval (default: 24 hours before).

**Estimate Visit Done**
The on-site visit has happened. User has the information needed to build the estimate.
- Trigger: User marks appointment as completed, or appointment date passes.
- Auto: Photos taken during the visit (via CHS Capture) can be linked to this request.

**Estimate Building**
The estimate is being constructed in the estimate builder. Work in progress — not yet sent to client.
- Trigger: User begins building the estimate.
- No external notifications at this stage.

**Estimate Sent**
The estimate has been delivered to the client for review via secure link.
- Trigger: User clicks "Send Estimate."
- WC Spreadsheet: Quotes sent count increments. Quote dollar value logged.
- Notification: "Your estimate is ready for review" with secure link to view, sign, and pay deposit.
- Auto: Quote follow-up reminders begin at configured intervals. 7-day validity timer starts.

**Follow-Up**
The estimate has been sent but the client hasn't responded. Active follow-up is happening.
- Trigger: Configurable time after estimate sent (default: 3 days).
- Notification: Automated follow-up reminders ("Just checking in on your estimate").
- Auto: Can be manually moved here if the user is actively working the lead.

**Won**
The client has signed the contract and paid the deposit.
- Trigger: Deposit payment received via Stripe or manually recorded.
- Auto: Quote-to-job conversion fires → job created in Job Management module at "Deposit Paid" status.
- WC Spreadsheet: Closed deal count increments. New Sales dollar value logged. Closed % recalculated.
- This request is now archived — the job record in Job Management takes over.

**Lost**
The client declined, went with a competitor, or stopped responding.
- Trigger: User manually marks as lost.
- Lost reason captured: price_too_high, went_with_competitor, project_cancelled, no_response, timing, other.
- Auto: Feeds into lost job tracking for pattern analysis over time.
- WC Spreadsheet: Does not increment closed count (affects Closed % calculation).

---

## 3. Data Model

### Estimate Request Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| request_number | integer | auto | Auto-incrementing (REQ-001, REQ-002, etc.) |
| status | enum | yes | "new_request", "appointment_set", "visit_done", "building", "sent", "follow_up", "won", "lost" |
| client_id | UUID | yes | FK to clients table |
| property_address | text | yes | Where the work would happen |
| property_city | text | yes | |
| property_state | text | yes | Default: "Arkansas" |
| property_zip | text | yes | |
| job_type | text | yes | new_build, addition, remodel, garage_conversion, deck, handyman, roofing, etc. |
| lead_source | text | yes | direct_call, google_lsa, thumbtack, website, referral, repeat_client |
| lead_source_detail | text | no | More specific: "Google LSA — kitchen remodel", "Referral from Tom Scott" |
| high_level_opportunity_id | text | no | FK to HL opportunity if lead came from HL |
| appointment_date | datetime | no | When the on-site estimate visit is scheduled |
| appointment_completed | boolean | no | Whether the visit happened |
| visit_notes | text | no | Notes from the on-site visit |
| visit_photo_ids | text | no | Photos taken during the visit |
| estimate_id | UUID | no | FK to estimates table (linked when estimate is created) |
| sent_date | datetime | no | When the estimate was sent to the client |
| follow_up_count | integer | auto | How many follow-up reminders have been sent |
| last_follow_up_date | datetime | no | When the last follow-up was sent |
| lost_reason | text | no | Why the job was lost (if status = "lost") |
| lost_notes | text | no | Additional context on why it was lost |
| converted_job_id | UUID | no | FK to jobs table (if status = "won") |
| created_at | datetime | auto | |
| updated_at | datetime | auto | |
| created_by | text | auto | |

### Estimate Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| estimate_number | integer | auto | Auto-incrementing (EST-001, EST-002, etc.) |
| request_id | UUID | yes | FK to estimate_requests table |
| client_id | UUID | yes | FK to clients table |
| title | text | yes | Job description (e.g., "Garage Conversion — 3 Mattie Lene Drive") |
| estimate_mode | enum | yes | "lump_sum" or "trade_by_trade" |
| billing_model | enum | yes | "fixed_price", "trade_by_trade", "cost_plus" |
| status | enum | yes | "draft", "sent", "viewed", "approved", "expired", "revised" |
| subtotal | decimal | computed | Sum of all parent line items |
| tax_amount | decimal | no | If applicable |
| total | decimal | computed | subtotal + tax_amount |
| deposit_amount | decimal | yes | Required deposit to begin work |
| deposit_type | text | yes | "percentage" or "fixed" |
| deposit_percentage | decimal | no | If deposit_type = "percentage" (e.g., 33.30) |
| valid_days | integer | yes | Default: 7. Quote validity period in days. |
| expiration_date | date | computed | sent_date + valid_days |
| portal_token | text | auto | Secure link token for client to view the estimate |
| include_reviews | boolean | yes | Default: true. Whether to show customer reviews on the quote. |
| review_ids | text | no | Comma-separated IDs of specific reviews to display (null = use defaults) |
| include_contract | boolean | yes | Default: true. Whether to attach the service agreement. |
| contract_template_id | UUID | no | FK to document templates. Default: standard service agreement. Cost-plus jobs use the cost-plus billing agreement. |
| client_signature | text | no | Digital signature data |
| signed_date | datetime | no | When the client signed |
| notes | text | no | Internal notes about this estimate |
| created_at | datetime | auto | |
| updated_at | datetime | auto | |
| created_by | text | auto | |

### Estimate Line Item (Parent) Record

What the client sees on the quote.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| estimate_id | UUID | yes | FK to estimates table |
| sort_order | integer | yes | Display order on the estimate |
| product_service | text | yes | Category name (e.g., "Framing", "Concrete slab", "Garage Conversion") |
| description | text | yes | Detailed scope of work for this line item |
| quantity | decimal | yes | Default: 1. Can be sqft, units, etc. |
| unit | text | no | "each", "sqft", "linear_ft", etc. Null for lump sum items. |
| unit_price | decimal | yes | Price per unit (or total if qty=1) |
| total | decimal | computed | quantity × unit_price |
| includes_note | text | no | e.g., "Price includes labor and materials" |
| created_at | datetime | auto | |

### Estimate Line Item (Sub-Item) Record

Internal cost breakdown — NOT visible to the client. Used for job costing.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| parent_line_item_id | UUID | yes | FK to parent estimate line items |
| sort_order | integer | yes | Display order within the parent |
| description | text | yes | What this cost is (e.g., "2x4 studs", "OSB sheathing", "Labor — 40hrs") |
| category | text | yes | "material", "labor", "subcontractor", "permit", "equipment", "other" |
| vendor | text | no | Supplier name if known |
| quantity | decimal | no | Amount needed |
| unit | text | no | "each", "sqft", "board", "hour", etc. |
| unit_cost | decimal | yes | Your cost per unit |
| total_cost | decimal | computed | quantity × unit_cost |
| material_id | UUID | no | FK to vendor/material database if pulling from saved prices |
| notes | text | no | |
| created_at | datetime | auto | |

### Payment Schedule Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| estimate_id | UUID | yes | FK to estimates table |
| sort_order | integer | yes | Payment sequence (1, 2, 3, ...) |
| description | text | yes | e.g., "Materials Deposit", "50% Completion", "Upon Completion" |
| percentage | decimal | no | Percentage of total (e.g., 33.30) |
| fixed_amount | decimal | no | Fixed dollar amount (used instead of percentage when needed) |
| amount | decimal | computed | Either (percentage × estimate total) or fixed_amount |
| is_deposit | boolean | no | Whether this is the required deposit payment |
| trigger | text | no | What triggers this payment: "contract_signing", "milestone", "trade_completion", "bi_weekly_cycle", "completion" |
| notes | text | no | |
| created_at | datetime | auto | |

### Estimate Template Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| name | text | yes | Template name (e.g., "Bathroom Remodel", "Deck Build", "Garage Conversion") |
| job_type | text | yes | Matching job type tag |
| description | text | no | What this template covers |
| default_billing_model | enum | no | Suggested billing model for this job type |
| line_items | JSON | yes | Array of template line items with default descriptions, sub-items, and pricing |
| default_payment_schedule | JSON | no | Default milestone/draw schedule |
| is_active | boolean | yes | Whether this template is available for use |
| created_at | datetime | auto | |
| updated_at | datetime | auto | |

### Saved Review Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| reviewer_name | text | yes | Customer name |
| review_date | date | no | When the review was left |
| rating | integer | yes | 1-5 stars |
| review_text | text | yes | Full review content |
| source | text | yes | "google", "facebook", "manual" |
| is_active | boolean | yes | Whether to include in the default display set |
| sort_order | integer | no | Display priority |
| created_at | datetime | auto | |

---

## 4. Core Workflows

### 4.1 Lead Intake

**From direct call:**
1. User taps "New Request" from dashboard or mobile.
2. Client lookup — search by name, phone, or address. Repeat client detection runs.
3. If existing client found: select and link. If new: create client inline.
4. Enter property address, job type, lead source ("direct_call").
5. Add brief project description in notes.
6. Request created in "New Request" status.
7. WC Spreadsheet: Lead count increments on next sync.
8. Notification: Lead acknowledgment sent to client.

**From High Level (Google LSA, website, consulting company):**
1. Lead appears on the HL Kanban board in CHS via API sync.
2. User clicks the lead card → "Create Estimate Request."
3. Client info pre-filled from HL contact data. Repeat client detection runs.
4. Lead source auto-set from HL data (google_lsa, website, etc.).
5. Request created in "New Request" status.
6. HL opportunity ID linked for ongoing sync.

**From Thumbtack / website form:**
1. Inbound notification received.
2. User reviews and clicks "Create Request."
3. Client info pre-filled from the submission.
4. Request created in "New Request" status.

### 4.2 Estimate Appointment Flow

1. User opens the estimate request → sets appointment date/time.
2. Status moves to "Appointment Set."
3. WC Spreadsheet: Appointment count increments.
4. Notification: Appointment confirmation sent to client.
5. Reminder notification sent at configured interval before the visit (default: 24 hours).
6. User goes to the on-site visit.
7. During or after the visit: user can take photos (via CHS Capture, linked to this request), add visit notes, capture voice notes.
8. User marks appointment as completed → status moves to "Estimate Visit Done."

### 4.3 Building an Estimate

**Starting the estimate:**
1. From the estimate request, user clicks "Build Estimate."
2. Status moves to "Building."
3. User selects estimate mode: **Lump Sum** or **Trade-by-Trade**.
4. User selects billing model: **Fixed Price**, **Trade-by-Trade**, or **Cost-Plus**.
5. Optionally: user selects a template to pre-populate line items.

**Lump sum mode:**
- One or a few parent line items with detailed descriptions.
- Example: "Garage Conversion — $28,619" with a full scope description.
- Sub-items track internal costs behind the scenes.
- Client sees simple, clean line items.

**Trade-by-trade mode:**
- Multiple parent line items, one per trade/phase.
- Example: Concrete $8,856, Framing $13,904, Electrical $8,635, etc.
- Each parent has its own detailed description.
- Each parent has sub-items tracking internal costs.
- Client sees the full breakdown by trade.

**Building parent line items:**
1. Enter Product/Service name (e.g., "Framing").
2. Enter detailed description of the scope.
3. Set quantity and unit (default: 1 each for lump items, or sqft/linear_ft for measured items).
4. Set unit price → total auto-calculates.
5. Add "Price includes labor and materials" note if applicable.

**Building sub-items (internal cost tracking):**
1. Under each parent line item, add cost breakdown entries.
2. For each sub-item: description, category (material/labor/sub/permit), vendor if known, quantity, unit, unit cost.
3. Sub-item totals roll up — the difference between parent total (client price) and sub-item total (your cost) is your margin on that line item.
4. Can pull from the material/vendor cost database for known prices.
5. Can calculate labor costs using saved rates ($90/hr, $105/hr).

**From a template:**
1. User selects a template (e.g., "Bathroom Remodel").
2. Template pre-populates parent line items with default descriptions and sub-items.
3. User adjusts quantities, prices, and descriptions to match the specific job.
4. Saves significant time on common job types — 80% pre-populated.

### 4.4 Payment Schedule Configuration

After the estimate is built, the user configures the payment schedule:

**Fixed price — Milestone draws:**
- Default: 33.30% / 33.30% / 33.40% (Materials Deposit, 50% Completion, Upon Completion).
- Configurable: user can add, remove, or adjust milestones.
- Each milestone has a description and trigger condition.
- Deposit = first milestone amount.

**Trade-by-trade billing:**
- User sets a deposit amount (fixed dollar, e.g., $50,000).
- Remaining payments are tied to trade/phase completion — each parent line item becomes an invoiceable milestone.
- Final payment captures any remaining balance.

**Cost-plus — Bi-weekly cycles:**
- Deposit = $1,000 (per billing agreement).
- Payment schedule explains the bi-weekly mini-budget cycle.
- No specific milestones — billing is ongoing throughout the project.

### 4.5 Quote Delivery

1. User reviews the complete estimate: line items, payment schedule, contract attachment, review selection.
2. User clicks "Send Estimate."
3. System generates the estimate portal page (secure link) with:
   - CHS branding and logo.
   - Estimate number, date, "Awaiting Response" status.
   - Client info and property address.
   - Deposit amount prominently displayed.
   - "Approve & Pay Deposit" button.
   - "Request Changes" button.
   - All line items with descriptions.
   - Payment schedule.
   - Customer reviews (if enabled).
   - Service agreement with digital signature field.
   - 7-day validity notice.
4. Email/text sent to client with the secure link.
5. Status moves to "Estimate Sent."
6. WC Spreadsheet: Quote count increments. Dollar value logged.
7. Quote follow-up automation begins.

### 4.6 Quote Follow-Up Automation

- Configurable intervals (default: Day 3, Day 5, Day 7).
- Each follow-up sends a notification to the client: "Just checking in on your estimate for [job title]. Your quote is valid until [expiration date]."
- Follow-up count is tracked on the request.
- On Day 7 (or configured validity period): "Your estimate expires today. If you'd like to move forward, please approve and pay your deposit."
- After expiration: status can auto-move to "Follow-Up" for manual action.
- User can stop follow-ups manually at any time.

### 4.7 Quote Approval & Deposit Payment

1. Client clicks the secure link → views the estimate.
2. Client clicks "Approve & Pay Deposit."
3. Contract/service agreement is displayed with digital signature field.
4. Client signs digitally.
5. Payment page appears for the deposit amount:
   - Check option (no fee) with mailing instructions.
   - Credit/debit or ACH option with 3.5% convenience fee disclosed.
6. Client pays deposit via Stripe.
7. **Quote-to-job conversion fires:**
   - Estimate request status moves to "Won."
   - New job record created in Job Management at "Deposit Paid" status.
   - All data carries over: client, property, job type, lead source, estimate link.
   - Task groups auto-generated from parent line items.
   - Budget baseline set from sub-items.
   - Billing schedule configured.
   - Portal activated.
   - WC Spreadsheet: Closed deal count and New Sales value update.

### 4.8 Lost Quote Handling

1. User marks the estimate request as "Lost."
2. User selects a reason: price too high, went with competitor, project cancelled, no response, timing, other.
3. Optional: add notes with more context.
4. Request is archived but remains searchable for pattern analysis.
5. Over time, lost job data feeds into insights: "40% of bathroom remodel quotes are lost on price" or "leads from Thumbtack convert at 15% vs. 35% from Google LSA."

### 4.9 Estimate Revision

If a client requests changes after receiving an estimate:
1. User opens the sent estimate → clicks "Revise."
2. System creates a new version of the estimate (original is preserved for history).
3. User makes changes to line items, pricing, or scope.
4. Revised estimate is re-sent via secure link.
5. Original estimate status changes to "revised."
6. Follow-up timers reset on the new version.

---

## 5. Material Cost Database Integration

### How it connects to estimating:

- When building an estimate sub-item, user can search the material/vendor database.
- "2x4 stud" → pulls last known price, preferred vendor, and average price.
- Price is inserted into the sub-item. User can adjust.
- Every expense logged in the Financial module (receipt capture, manual entry) feeds back into this database — prices stay current automatically.

### Estimating with labor rates:

- Labor sub-items can use saved rates: $90/hr (general) or $105/hr (PM/skilled carpenter).
- User enters estimated hours → system calculates labor cost.
- Sub rates for specific trades can also be stored and referenced.

---

## 6. Screen Descriptions

### 6.1 Estimate Request Pipeline Board (Desktop)

Kanban-style board showing all estimate requests by pipeline stage. Each column is a stage. Request cards show:
- Client name and phone.
- Property address.
- Job type badge.
- Lead source icon.
- Days in current stage.
- Appointment date (if set).
- Estimate total (if built).

Drag-and-drop to move requests between stages.
Filter by: job type, lead source, date range.
Sort by: date created, appointment date, estimate value.

### 6.2 Estimate Request Pipeline Board (Mobile)

Horizontal swipe between pipeline columns. Tap a card to open the request detail. Floating action button for "New Request."

### 6.3 Estimate Request Detail View

- **Header:** Client name, property address, job type, lead source, status badge.
- **Appointment:** Date/time, completion status. Set/edit appointment button.
- **Visit Notes & Photos:** Notes from the on-site visit, photos taken during the visit.
- **Estimate:** Link to the estimate builder or the completed estimate. "Build Estimate" button if none exists.
- **Follow-Ups:** Count of reminders sent, dates, status.
- **Communication:** Timeline of all interactions related to this request (from the unified communication log).
- **Activity Log:** All actions taken on this request.

### 6.4 Estimate Builder

**Two-panel layout (desktop):**
- Left panel: line item editor. Add/edit/reorder parent line items and sub-items.
- Right panel: live preview showing what the client will see.

**Top bar:**
- Estimate mode selector: Lump Sum / Trade-by-Trade.
- Billing model selector: Fixed Price / Trade-by-Trade / Cost-Plus.
- Template selector: dropdown of saved templates.
- Margin summary: total client price vs. total internal cost, margin percentage.

**Line item editor:**
- Each parent line item is a collapsible card.
- Product/Service name, description (rich text), quantity, unit, unit price, total.
- Expand to see/edit sub-items underneath.
- Sub-items: description, category, vendor, quantity, unit, unit cost, total cost.
- "Add Sub-Item" button under each parent.
- "Search Materials" button to pull from the vendor cost database.
- Drag handle to reorder.

**Bottom section:**
- Subtotal and total.
- Payment schedule builder (add/edit milestones or draws).
- Contract selection (standard service agreement or cost-plus billing agreement).
- Review toggle (on/off) with review selector.
- "Preview" button to see the full client view.
- "Save Draft" and "Send Estimate" buttons.

### 6.5 Estimate Builder (Mobile)

Simplified single-column layout:
- Stacked line item cards. Tap to expand/edit.
- Quick-add buttons for new line items and sub-items.
- Template selection at top.
- Preview accessible via button.
- Designed for reviewing and minor edits on mobile, not full estimate construction (desktop is primary for building estimates).

### 6.6 Client-Facing Estimate Page

(As described in Client Management & Portal spec, Section 4.)

---

## 7. Business Rules

1. Every estimate request must have a client, property address, job type, and lead source.
2. An estimate can only be sent when it has at least one line item and a deposit amount configured.
3. Quote follow-up automation stops when: the estimate is approved, marked lost, or manually paused.
4. The 7-day quote validity period is configurable per estimate (default: 7 days).
5. Estimate revisions create new versions — the original is preserved for audit trail.
6. Sub-items are never visible to the client. They are internal cost tracking only.
7. The billing model selected on the estimate carries through to the job when quote-to-job conversion fires. It cannot be changed after the first invoice.
8. Deposit amount is required before an estimate can be sent. Default calculation depends on billing model.
9. Templates can be created, edited, and deactivated. Deactivated templates are hidden from the selector but preserved in history.
10. Material/vendor prices used in an estimate are snapshot copies — if the database price changes later, existing estimates are not affected.
11. Lost quote reasons are required when marking a request as lost. This data feeds reporting.
12. When a quote is won (deposit paid), the estimate request is archived. All future activity happens on the job record in Job Management.

---

## 8. Inter-Module Connections

### → Job Management
- Quote-to-job conversion is the single entry point for creating jobs.
- Estimate parent line items become job task groups.
- Estimate sub-items become the job costing budget baseline.
- Billing model and payment schedule carry over to the job.
- Historical job cost data feeds back to improve future estimates.

### → Financial Management
- Deposit invoice is generated during quote approval/payment.
- Payment schedule defined here drives invoice generation in Financial Management.
- Material cost database is shared between Estimating and Financial (expense tracking feeds material prices).
- Labor rates defined in system settings are used in both modules.

### → Client Management & Portal
- Estimate delivery uses secure links (same pattern as portal).
- Client-facing quote page includes reviews, contract, payment schedule.
- Client can approve and pay deposit through the estimate page.
- Project packets are generated from estimate data for sales presentations.

### → Photo Capture System
- Photos taken during the estimate visit are linked to the request.
- Visit photos can inform the estimate build (reference photos of existing conditions).

### → Document Management
- Service agreements and cost-plus billing agreements are pulled from document templates.
- Signed contracts are stored per job/estimate.

### → Automated Notifications
- Lead acknowledgment on new request.
- Appointment confirmation and reminders.
- Quote ready notification when estimate is sent.
- Quote follow-up reminders at configured intervals.
- Quote expiration warning.

### → Social Media & Marketing
- Lost job data feeds into marketing analytics (which lead sources convert best?).
- Lead source tracking aligns with marketing spend tracking in the WC Spreadsheet.

### → System & Administration
- All estimate actions logged in audit trail.
- Material cost database and labor rates managed in system settings.
- Estimate templates managed in system settings.

---

## 9. WC Spreadsheet Data Points (This Module's Responsibility)

| Data Point | Tab in Spreadsheet | When Triggered |
|------------|-------------------|----------------|
| Lead count | Key Business Performance Indicators (weekly) | New request created |
| Lead source breakdown | Weekly Marketing Tallies | New request created (by source) |
| Appointments / Estimates provided | Key Business Performance Indicators (weekly) | Appointment set |
| Quotes sent (count) | Key Business Performance Indicators (weekly) | Estimate sent |
| Quotes sent (dollar value) | Weekly Marketing Tallies (New Sales) | Estimate sent |
| Closed (count) | Key Business Performance Indicators (weekly) | Quote approved / deposit paid |
| Closed % | Key Business Performance Indicators (weekly) | Computed: closed / leads |
| Converted count | Weekly Marketing Tallies | Quote approved / deposit paid |
| Lost count | (derived) | Request marked as lost |

---

## 10. Migration Notes

### What carries forward from chs-hub:
- High Level lead pipeline integration (leads flow from HL into the request pipeline).
- WC Spreadsheet auto-sync pattern (same cron, same Sheets API, same service account).
- Subcontractor reference list (sub rates referenced during estimating).

### What's new (net build):
- Estimate request pipeline (replaces Jobber's quote/request system entirely).
- Native estimate builder with parent/sub-item structure.
- Lump sum and trade-by-trade estimate modes.
- Estimate templates and assemblies.
- Quote delivery with integrated contract, reviews, and payment schedule.
- Digital signature on estimates.
- Quote follow-up automation.
- Quote-to-job conversion engine.
- Lost job tracking with reason capture.
- Estimate revision workflow.
- Material cost database integration in the estimate builder.
- Labor rate modeling in estimates.

### Data migration:
- Existing Jobber quote data in D1 is preserved as historical records.
- New estimates going forward are created natively.
- The chs-estimator-seeder repo (quarterly Jobber pricebook sync) becomes obsolete once the native material cost database is populated.
- Historical pricing data from Jobber can seed the initial vendor/material database.

---

## 11. Future / AI Features

### Historical Cost Analysis
- After enough jobs are completed with cost tracking, the system can analyze: "Your last 5 framing jobs averaged $X per sqft."
- When building a new estimate, AI suggests pricing based on historical actuals.
- Highlights line items where your estimate differs significantly from historical costs.

### AI-Assisted Takeoffs
- Upload PDF blueprints/plans.
- AI detects quantities: wall linear footage, room sqft, outlet counts, window counts.
- Auto-populates estimate line items with detected quantities.
- User sets pricing — AI handles the measurement.
- Premium feature — requires mature cost data and model training.
- Build when: 50+ completed jobs with full cost tracking provide enough training data.

### Real-Time Supplier Pricing
- API integrations with supplier databases (Home Depot Pro, Lowe's Pro, ABC Supply).
- Pull live material prices when building estimates.
- Auto-update the vendor cost database with current pricing.
- Depends on supplier API availability and partnership.
