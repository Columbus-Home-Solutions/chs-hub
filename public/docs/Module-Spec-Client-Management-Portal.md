# Module Spec: Client Management & Portal
## CHS Construction Management Platform
### Version 1.0 — May 26, 2026

---

## 1. Purpose

Client Management & Portal handles every client-facing aspect of the CHS platform — the client database, the project portal that clients access via secure link, digital document signing, communication tracking, review management, and the High Level CRM integration. This module is the client's window into their project and the contractor's single source of truth for all client information and communication history.

**Key design principle:** The client experience should feel polished and professional — on par with or better than what Jobber provides today. The portal is accessed via a unique secure link (no account creation, no passwords). The portal automatically adapts what it shows based on the job's billing model.

---

## 2. Client Database

### Client Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| first_name | text | yes | |
| last_name | text | yes | |
| email | text | yes | Primary email for notifications, invoices, portal links |
| phone | text | yes | Primary phone number |
| phone_secondary | text | no | Alternate phone |
| mailing_address | text | no | May differ from property address |
| mailing_city | text | no | |
| mailing_state | text | no | |
| mailing_zip | text | no | |
| lead_source | text | no | How this client originally came in: direct_call, google_lsa, thumbtack, website, referral, repeat |
| high_level_contact_id | text | no | FK to High Level contact record for sync |
| is_repeat_client | boolean | no | Flagged if they have more than one job |
| total_jobs | integer | computed | Count of all jobs for this client |
| total_revenue | decimal | computed | Sum of all payments received across all jobs |
| last_interaction_date | datetime | no | Date of most recent communication or job activity |
| review_requested | boolean | no | Whether a Google review has been requested for the most recent job |
| google_review_left | boolean | no | Whether the client has left a Google review |
| notes | text | no | General notes about this client |
| created_at | datetime | auto | |
| updated_at | datetime | auto | |
| created_by | text | auto | |

### Property Record

A client can have multiple properties (e.g., repeat client with different job sites).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| client_id | UUID | yes | FK to clients table |
| address | text | yes | |
| city | text | yes | |
| state | text | yes | Default: "Arkansas" |
| zip | text | yes | |
| property_type | text | no | "residential", "commercial", "rental" |
| notes | text | no | Gate codes, dog warnings, parking instructions, etc. |
| created_at | datetime | auto | |

---

## 3. Client Portal

### 3.1 Portal Architecture

- Each job generates a unique secure token (`portal_token` on the job record).
- The portal URL is `https://portal.homesolutionsar.com/p/{portal_token}`.
- No login required — the token IS the authentication. Link is sent via email/text.
- Token is long, random, and unguessable (UUID v4 or similar).
- Each client may have multiple portal links (one per job).
- Portal is mobile-responsive — most clients will access it on their phone from a text or email link.

### 3.2 Portal Landing Page

When a client clicks their portal link, they see a branded page with the CHS logo, company info, and their project overview:

**Header:**
- Columbus Home Solutions logo and branding
- Client name and property address
- Job title and current status (e.g., "Scheduled — Work begins June 2")

**Quick stats bar:**
- Contract total
- Total paid
- Remaining balance
- Next payment due (amount and date)

**Navigation tabs** (content varies by portal type):
- Photos
- Schedule
- Invoices & Payments
- Change Orders
- Documents
- Messages

### 3.3 Standard Portal View

For fixed-price and trade-by-trade jobs. Clean and simple.

**Photos tab:**
- Chronological photo timeline pulled from the Photo Capture system.
- Photos grouped by date with captions if provided.
- Tap to enlarge. Swipe through gallery.
- Before/after comparison view when applicable.

**Schedule tab:**
- Upcoming scheduled work with dates and descriptions.
- What's been completed (checked off).
- Next milestone or expected completion date.

**Invoices & Payments tab:**
- All invoices for this job with status badges (sent, paid, past due).
- Payment history with dates and amounts.
- "Pay Now" button on any unpaid invoice → opens payment page.
- Payment page shows:
  - Invoice amount
  - Payment method options: Check (no fee) or Credit Card/ACH (+ 3.5% convenience fee)
  - Fee clearly disclosed before confirmation
  - Stripe-powered payment form for electronic payments
- Payment schedule showing all milestones or trade draws and their status.
- Receipts for completed payments (viewable/downloadable).

**Change Orders tab:**
- List of any change orders with status (pending signature, approved).
- Tap to view full change order details.
- Digital signature capability for approving change orders.
- Cost impact clearly shown.

**Documents tab:**
- Signed contract.
- Permits.
- Plans/drawings if uploaded.
- Any other documents shared by the contractor.

**Messages tab:**
- Threaded messaging between client and contractor.
- Messages are logged in the communication history.
- Client can send text messages or questions.
- Contractor sees messages in the job's communication log.

### 3.4 Cost-Plus Portal View

Everything in the standard view PLUS full financial transparency:

**Budget & Costs tab** (additional tab for cost-plus jobs):
- Current billing cycle mini-budget breakdown:
  - Projected materials, labor, subs
  - PM fee (10%) and contractor fee (20%)
  - Projected total for this cycle
- Real-time actual costs as expenses are logged:
  - Itemized expense list with vendor, description, amount
  - Labor hours and costs
  - Sub costs
- Cycle reconciliation at end of each two-week period:
  - Projected vs. actual side by side
  - Over/under explanation
  - Credit or overage carried to next cycle
- Running project totals:
  - Total spent to date
  - Total projected remaining
  - Cumulative actual vs. projected

**Invoices tab (enhanced for cost-plus):**
- Each bi-weekly invoice linked to its billing cycle.
- Reconciliation documents attached.
- Credit/overage adjustments clearly shown.

### 3.5 Portal Toggle

The portal type is automatically set based on the job's billing model:
- `billing_model = "fixed_price"` or `"trade_by_trade"` → Standard portal
- `billing_model = "cost_plus"` → Cost-plus portal

No manual toggle needed — the system handles it. If a job is cost-plus, the client automatically sees the full transparency view.

---

## 4. Quote & Estimate Delivery (Client View)

When a client receives an estimate via secure link, they see a page similar to the current Jobber format but enhanced:

**Quote page layout:**
- CHS branding and logo at top.
- Estimate number, sent date, status ("Awaiting Response").
- Client name, address, phone.
- Deposit required prominently displayed with amount.
- "Approve & Pay Deposit" button (primary, prominent).
- "Request Changes" button (secondary).

**Scope section:**
- Line items with Product/Service name, description, quantity, and total.
- Lump sum jobs: one or two line items with detailed descriptions.
- Trade-by-trade jobs: separate line items per trade.
- "Price includes labor and materials" notes where applicable.

**Payment schedule:**
- Visual breakdown of payment milestones.
- For fixed price: 33.30% / 33.30% / 33.40% or custom splits.
- For trade-by-trade: deposit amount + per-trade invoicing explained.
- For cost-plus: deposit amount + bi-weekly billing cycle explained.

**Reviews section:**
- 3 customer reviews displayed as social proof (same format as current Jobber quotes).
- Reviews pulled from a curated list of best Google reviews.
- Star ratings displayed.
- Configurable — choose which reviews appear on quotes.

**Service agreement:**
- Full contract text displayed below the quote.
- Scope, timeline, payment terms, late fees, change orders, warranty, insurance, site access, termination, dispute resolution.
- Digital signature field and date.
- Client signs and pays deposit in one flow.

**Quote validity notice:**
- "Due to fluctuating costs of building materials, this quote is valid for the next 7 days" (matching current format).

---

## 5. Invoice Delivery (Client View)

When a client receives an invoice via secure link:

**Invoice page layout:**
- CHS branding at top.
- Invoice number, issued date, due date, status badge (Sent, Past Due, etc.).
- Client name and address.
- "For Services Rendered — X of Y" indicator for milestone billing.
- "Portion of job" percentage and dollar context.

**Line items:**
- Product/Service with description.
- Item total and "Due this Invoice" columns.
- Subtotal, total, paid amount, and invoice balance clearly displayed.

**Payment section (right sidebar on desktop, stacked on mobile):**
- Balance prominently displayed.
- Payment method selection:
  - **Check:** "Pay by check — No additional fee" with mailing instructions and invoice reference number.
  - **Credit/Debit:** Card form powered by Stripe. 3.5% convenience fee clearly disclosed.
  - **Bank (ACH):** Bank transfer option. 3.5% convenience fee clearly disclosed.
- Fee calculation shown before confirmation: "Invoice: $6,877.50 + Convenience Fee: $240.71 = Total: $7,118.21"
- "Pay" button with amount.

**Payment schedule:**
- Shows all milestones/draws for the job with completion status.
- Which payments are done, which are upcoming.

**Receipts section:**
- Previous payments listed with dates, amounts, and "View" links.

**Google Review section (configurable per job):**
- After the final invoice is paid, a "Leave us a review" section appears.
- Direct link to Columbus Home Solutions Google Business page.
- Brief prompt: "We appreciate your business! If you were happy with our work, a Google review helps other homeowners find us."
- Can be toggled off per job in the job settings (for situations where you don't want to ask — difficult client, warranty issue, etc.).

---

## 6. Project Packet (Sales Presentation)

For bigger jobs, a polished digital packet accessible via secure link that you can present during the sales meeting and the client can review after.

### Packet contents (auto-compiled from system data):

**Company Overview:**
- CHS logo, company description, years in business.
- Licensing and insurance info.
- Service area.

**Past Work Portfolio:**
- Photos from similar completed jobs (user selects which jobs to showcase).
- Before/after comparisons.
- Brief descriptions of each showcased project.

**Scope of Work:**
- Full estimate with all line items and descriptions.
- Matches the trade-by-trade or lump sum format of the estimate.

**Proposed Timeline:**
- Estimated start date and duration.
- Major milestones or phases listed.

**Payment Schedule:**
- Milestone draws, trade-by-trade schedule, or cost-plus billing explanation — based on the selected billing model.

**Customer Reviews:**
- Curated reviews from Google (same reviews shown on quotes).

**Service Agreement:**
- Full contract ready for signature.

**Next Steps:**
- "Ready to get started? Approve your estimate and pay the deposit to secure your spot on our schedule."
- Direct link to the estimate approval page.

### Packet access:
- Generated via a button on the estimate: "Generate Project Packet."
- Creates a unique secure link (same pattern as portal links).
- Link can be shared via email/text.
- Client can review on their phone or computer after the meeting.
- Packet is read-only — no signing or payment from here, that happens on the estimate page.

---

## 7. Job Completion Package

Auto-compiled when a job moves to "Complete" status and emailed to the client as a PDF with a portal link to the digital version.

### Package contents:

**Cover page:**
- CHS branding.
- Job title, address, completion date.
- Client name.

**Before/After Photos:**
- Side-by-side comparisons from the job's photo timeline.
- Best photos selected (user can curate before sending).

**Project Summary:**
- Scope of work completed (from estimate line items).
- Any change orders that were approved during the project.
- Final timeline (actual start and end dates).

**Financial Summary:**
- Total contract value (including change orders).
- All invoices and payment history.
- For cost-plus: total actual costs with fee breakdown.
- Final balance status (paid in full or remaining balance).

**Documentation:**
- Signed contract.
- Signed change orders.
- Permit documentation and inspection results.
- Warranty information (one-year workmanship warranty, expiration date).

**Warranty Card:**
- What's covered.
- Duration (one year from completion date).
- Expiration date.
- How to file a warranty claim (contact info).

**Google Review Request (if enabled for this job):**
- "We'd love to hear about your experience!"
- Direct link to Google Business review page.

---

## 8. Communication History

### 8.1 Unified Communication Timeline

Every interaction with a client is logged in a single chronological timeline, accessible from both the client record and the individual job.

**Communication Record:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| client_id | UUID | yes | FK to clients table |
| job_id | UUID | no | FK to jobs table (null for non-job communications) |
| channel | enum | yes | "phone_call", "text_sms", "email", "portal_message", "in_person", "other" |
| direction | enum | yes | "inbound" or "outbound" |
| summary | text | yes | Brief description or subject line |
| body | text | no | Full message content (for text/email), call notes (for phone) |
| duration_seconds | integer | no | For phone calls — how long the call lasted |
| call_recording_url | text | no | Link to call recording if available (from Google LSA) |
| sent_via | text | no | "twilio", "google_lsa", "high_level", "manual", "system_auto" |
| high_level_message_id | text | no | FK to HL message record if synced |
| attachments | text | no | File IDs of any attached documents or images |
| logged_by | text | auto | User who logged it or "system" for auto-logged |
| created_at | datetime | auto | Timestamp of the communication |

### 8.2 Auto-Logging Sources

**Twilio (SMS — built into CHS):**
- All outbound texts sent through the platform are auto-logged.
- All inbound texts received via Twilio number are auto-logged.
- Full message content captured.
- Linked to client by phone number match, linked to job if sent from a job context.

**High Level (synced):**
- Text messages and emails tracked in HL are pulled via API.
- Polling or webhook-based sync to capture new messages.
- Messages linked to CHS client by HL contact ID match.
- Direction (inbound/outbound) and timestamps preserved.

**Google LSA (call recordings):**
- Calls from Google Local Services generate leads in HL → HL sync captures them.
- If call recordings are available via API, link them to the communication record.
- Call duration captured.

**System-generated (auto-logged):**
- Every automated notification (appointment reminders, quote sent, payment receipt, etc.) is logged.
- Marked as `direction = "outbound"` and `sent_via = "system_auto"`.
- Links to the job that triggered it.

**Portal messages (native):**
- Messages sent by the client through the portal message tab are logged.
- Messages sent by the contractor through the portal are logged.
- Both linked to the job and client.

**Manual entry:**
- User can log a phone call or in-person interaction manually.
- Quick entry: select channel (phone, in-person), add summary, optionally add notes.
- Linked to client and optionally to a specific job.

### 8.3 Communication Views

**Client-level view:**
- Full timeline of ALL communications with this client across all their jobs.
- Filter by channel (phone, text, email, portal).
- Filter by job.
- Search within communications.

**Job-level view:**
- Communications related to this specific job only.
- Accessed from Job Detail View → Messages or Communications tab.
- Includes both manual logs and auto-logged system messages.

---

## 9. High Level Integration

### Architecture (carry forward from chs-hub):
- CHS pulls lead data from HL via API proxy (PIT pattern).
- HL remains the source of truth for leads and the lead pipeline.
- CHS displays the lead pipeline as a Kanban board with drag-to-update write-back.

### What syncs FROM High Level → CHS:
- New leads/opportunities (contact name, phone, email, source, pipeline stage).
- Lead stage changes (when consulting company moves leads in HL).
- Communication history (texts, emails sent through HL).
- Google LSA call data that flows into HL.

### What syncs FROM CHS → High Level:
- Lead stage updates when user drags on the CHS Kanban board (write-back).
- Job status changes (so consulting company can see when a lead converts to a job).

### What does NOT sync:
- CHS does not push client records to HL — HL manages its own contacts.
- Financial data stays in CHS — HL doesn't need invoice or payment details.
- Job details (tasks, schedule, photos) stay in CHS.

### Lead → Estimate → Job flow with HL:
1. Lead arrives in HL from Google LSA, website form, or consulting company outreach.
2. Lead appears on CHS Kanban board via API sync.
3. User contacts the lead, sets estimate appointment.
4. User creates an estimate request in the Estimating module (client record created or matched).
5. Estimate is built, sent, signed, deposit paid → job created.
6. CHS updates HL pipeline stage to reflect conversion.
7. WC Spreadsheet captures the lead source from HL data.

---

## 10. Google Review Management

### Review collection flow:
1. Job moves to "Complete" status.
2. If `review_enabled = true` for this job (default is true):
   - Google review request notification is queued.
   - Sent after job completion package delivery (so the client sees the final product first).
   - Message includes a direct link to the CHS Google Business review page.
3. Review request appears on the final invoice page in the portal.
4. Client clicks link → taken to Google to leave a review.

### Review display:
- A curated set of best reviews is stored in the system.
- These reviews are displayed on quote pages (social proof during sales).
- Reviews can be managed: add new ones, remove old ones, choose which appear on quotes.
- Future: Pull reviews directly from Google Business API for real-time display.

### Review toggle:
- Per-job setting: `review_enabled` (boolean, default true).
- Set to false for jobs where review request is inappropriate (difficult client, warranty situation, small/simple job).
- When disabled: no review request notification, no review section on the final invoice page.

---

## 11. Repeat Client Detection

### How it works:
When any new client record is being created (from the Estimating module, from HL sync, or from manual entry):

1. System searches existing clients by:
   - Phone number (exact match).
   - Email (exact match).
   - Last name + address (fuzzy match).
   - Property address (exact match against all properties).
2. If a match is found, display a match notification:
   - Client name, past jobs, total revenue, last interaction date.
   - Photos from past work.
   - "Use existing client" button → links new estimate/job to their history.
   - "Create new client" button → if it's truly a different person.
3. Repeat clients are flagged (`is_repeat_client = true`) for reporting:
   - Revenue from repeat vs. new clients.
   - Referral tracking (did they refer the new lead?).

---

## 12. Screen Descriptions

### 12.1 Client List (Desktop)

- Searchable, sortable list of all clients.
- Columns: Name, phone, email, total jobs, total revenue, last interaction.
- Click to open client detail view.
- Quick filters: all, active (has in-progress job), past, repeat.
- "New Client" button (though clients are primarily created through the Estimating pipeline).

### 12.2 Client Detail View

- **Header:** Client name, phone, email, address. Edit button.
- **Jobs section:** All jobs for this client with status, dates, contract value. Click to open job.
- **Communication timeline:** All interactions in chronological order. Filter by channel, search.
- **Financial summary:** Total revenue, total paid, any outstanding balances across all jobs.
- **Properties:** List of all property addresses for this client.
- **Notes:** General notes about the client.
- **Documents:** All documents across all of this client's jobs.

### 12.3 Client Portal (as described in Section 3)

Mobile-responsive, secure-link access, tabs for photos, schedule, invoices, change orders, documents, messages. Adapts based on billing model.

### 12.4 Communication Log Entry (Mobile)

Quick entry screen:
- Select channel: Phone Call, In-Person, Text, Email, Other.
- Select client (auto-fills if accessed from a client or job view).
- Select job (optional — defaults to active job for this client).
- Summary field (brief description).
- Notes field (detailed notes, optional).
- "Save" logs the entry with timestamp.

### 12.5 HL Lead Pipeline Board

Carry forward from chs-hub:
- Kanban board showing HL pipeline stages.
- Lead cards with contact info, source, stage, age.
- Drag-and-drop between stages with write-back to HL.
- Click a lead card to view details or create an estimate request.

---

## 13. Business Rules

1. Every client must have at least a first name, last name, email, and phone number.
2. Client portal links are unique per job, not per client. A client with two jobs gets two portal links.
3. Portal tokens never expire — the client can return to their portal at any time, even years after job completion (for warranty reference, photos, documents).
4. The portal type (standard vs. cost-plus) is automatically set by the job's billing model and cannot be manually overridden.
5. All system-generated notifications (quotes, invoices, reminders, etc.) are auto-logged in the communication timeline.
6. Communication records are never deleted — they form a permanent audit trail.
7. High Level remains the source of truth for leads. CHS never overwrites HL contact data — it reads and displays it.
8. Google review requests are only sent for jobs where `review_enabled = true`.
9. Google review requests are sent after the job completion package, not at the same time — the client should see their finished project documentation before being asked for a review.
10. The project packet is optional and manually triggered — it is not auto-generated for every job.
11. The job completion package IS auto-generated for every completed job, but the user can review and curate photos before it's sent.
12. Repeat client detection runs on client creation, not on every page load — it's a one-time check during the creation flow.

---

## 14. Inter-Module Connections

### → Job Management
- Each job links to a client record.
- Portal access is generated per job.
- Job status changes trigger portal updates (photos, schedule, invoices appear as they're created).
- Job completion triggers the completion package generation.

### → Financial Management
- Invoices are viewable and payable through the portal.
- Payment history visible in the portal.
- The 3.5% convenience fee is disclosed and collected through the portal payment page.
- Cost-plus clients see full financial transparency in their portal.

### → Estimating & Quoting
- Quote delivery uses the same secure-link pattern as the portal.
- Estimate pages include reviews as social proof.
- Quote approval and deposit payment create the job and activate the portal.
- Project packets are generated from estimate data.

### → Photo Capture System
- Photos appear in the client portal in real time as they're captured.
- Before/after photos feed the project packet and completion package.
- Weekly photo summaries are sent to the client via notification.

### → Document Management
- All client-facing documents are accessible through the portal.
- Contracts and change orders are signed through the portal.
- The completion package compiles documents from the document system.

### → Automated Notifications
- All notifications sent to clients are logged in the communication timeline.
- Review requests are triggered by job completion (if enabled).
- Portal link is included in the welcome notification after contract signing.

### → Social Media & Marketing
- Google review management feeds into the social media module for reputation monitoring.
- Review count and average rating can be tracked as a KPI.

### → System & Administration
- Client data is included in nightly backups.
- Role-based access: Owner sees all client data, future PM role may see client info but not financial details, Client role (portal) sees only their own project.

---

## 15. Migration Notes

### What carries forward from chs-hub:
- High Level pipeline integration (PIT proxy, Kanban with drag-to-update write-back).
- Basic client data from Jobber imports in D1.

### What's new (net build):
- Native client database (no longer synced from Jobber).
- Client portal with secure link access.
- Standard and cost-plus portal views.
- Digital document signing in the portal.
- Payment collection through the portal with convenience fee.
- Project packet generation.
- Job completion package auto-compilation.
- Unified communication timeline.
- Twilio SMS integration for auto-logged messaging.
- Communication history synced from High Level.
- Google review management with per-job toggle.
- Repeat client detection.
- Portal messaging system.

### Data migration:
- Existing client data from Jobber imports in D1 becomes the seed for the native client database.
- HL contact IDs are matched to existing client records where possible.
- Historical communication data does not need to be migrated — the timeline starts fresh with the new system.
