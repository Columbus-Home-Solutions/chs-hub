# Seed Data Reference
## CHS Construction Management Platform
### Version 1.0 — May 28, 2026

This document contains all seed data for migration 0022_seed_data.sql. Cursor should generate the actual SQL INSERT statements from these definitions.

---

## 1. System Settings

### Financial Settings

| Key | Value | Type | Label |
|-----|-------|------|-------|
| labor_rate_general | 90.00 | number | General Labor Rate ($/hr) |
| labor_rate_pm_skilled | 105.00 | number | PM / Skilled Carpenter Rate ($/hr) |
| pm_fee_rate | 0.10 | number | Project Management Fee (cost-plus) |
| contractor_fee_rate | 0.20 | number | Contractor Fee (cost-plus) |
| late_fee_daily | 50.00 | number | Late Fee ($/day) |
| late_fee_grace_days | 7 | number | Late Fee Grace Period (days) |
| convenience_fee_rate | 0.035 | number | Electronic Payment Convenience Fee |
| default_deposit_percentage | 33.30 | number | Default First Milestone (fixed price) |
| cost_plus_deposit | 1000.00 | number | Cost-Plus Default Deposit ($) |
| irs_mileage_rate | 0.70 | number | IRS Standard Mileage Rate (2026) |
| default_quote_validity_days | 7 | number | Quote Validity Period (days) |
| billing_cycle_duration_days | 14 | number | Cost-Plus Billing Cycle Length |
| cost_plus_final_cycle_upfront | 0.50 | number | Final Cycle Upfront Percentage |

### Company Settings

| Key | Value | Type | Label |
|-----|-------|------|-------|
| company_name | Columbus Home Solutions, LLC | string | Company Name |
| company_address | 4414 North Olive Street, North Little Rock, AR 72116 | string | Company Address |
| company_phone | (501) 551-1814 | string | Company Phone |
| company_email | tony@homesolutionsar.com | string | Company Email |
| company_website | www.homesolutionsar.com | string | Company Website |
| company_primary_color | #F59E0B | string | Brand Primary Color |
| default_state | Arkansas | string | Default State for Forms |
| warranty_duration_days | 365 | number | Standard Warranty Duration |
| warranty_reminder_days | 335 | number | Warranty Reminder (days after completion) |
| thirty_day_followup_days | 30 | number | Post-Job Follow-Up (days after completion) |

---

## 2. Owner User Record

```sql
INSERT INTO users (id, email, first_name, last_name, phone, role, is_active, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'tony@homesolutionsar.com',
  'Tony',
  'Columbus',
  '5015511814',
  'owner',
  1,
  datetime('now'),
  datetime('now')
);
```

---

## 3. Notification Templates

### Estimating Pipeline

| Trigger Event | Name | Recipient | Channel | Delay | Body Template |
|--------------|------|-----------|---------|-------|---------------|
| lead_created | Lead Acknowledgment | client | sms | 0 | Thank you for reaching out to Columbus Home Solutions! We've received your request and will be in touch within 24 hours. |
| lead_created | Lead Acknowledgment Email | client | email | 0 | Subject: "We received your request — Columbus Home Solutions". Body: same as SMS with additional company info |
| appointment_confirmed | Appointment Confirmation | client | sms | 0 | Your estimate appointment is confirmed for {{appointment_date}} at {{appointment_time}}. We'll see you at {{property_address}}. |
| appointment_confirmed | Appointment Confirmation Email | client | email | 0 | Subject: "Estimate Appointment Confirmed". Body: expanded with company contact info |
| appointment_reminder | Appointment Reminder | client | sms | -1440 (24hr before) | Reminder: Your estimate appointment with Columbus Home Solutions is tomorrow at {{appointment_time}} at {{property_address}}. |
| estimate_sent | Estimate Ready | client | sms | 0 | Your estimate for {{job_title}} is ready for review. View and approve here: {{estimate_link}} |
| estimate_sent | Estimate Ready Email | client | email | 0 | Subject: "Your Estimate is Ready — {{job_title}}". Body: estimate summary with link |
| quote_follow_up_1 | Quote Follow-Up Day 3 | client | sms | 4320 (3 days) | Just checking in on your estimate for {{job_title}}. Your quote is valid until {{expiration_date}}. View here: {{estimate_link}} |
| quote_follow_up_2 | Quote Follow-Up Day 5 | client | sms | 7200 (5 days) | Hi {{client_first_name}}, wanted to follow up on your estimate. Let me know if you have any questions. {{estimate_link}} |
| quote_expiring | Quote Expiration Warning | client | sms | 10080 (7 days) | Your estimate for {{job_title}} expires today. If you'd like to move forward, approve and pay your deposit here: {{estimate_link}} |

### Job Pipeline

| Trigger Event | Name | Recipient | Channel | Delay | Body Template |
|--------------|------|-----------|---------|-------|---------------|
| deposit_received | Payment Receipt (Deposit) | client | email | 0 | Subject: "Payment Received — {{job_title}}". Body: Payment of {{deposit_amount}} received. Welcome aboard! |
| welcome_portal | Welcome & Portal Link | client | email | 0 | Subject: "Welcome to Your Project Portal — {{job_title}}". Body: Portal link, what to expect |
| work_starting | Work Starts Tomorrow | client | sms | send_time: 18:00, night before | Work begins tomorrow at {{property_address}}! Our crew will arrive between 7-8 AM. Contact us with any questions. |
| weekly_photo_summary | Weekly Photo Summary | client | email | cron: weekly Sunday | Subject: "This Week on Your Project — {{job_title}}". Body: photo summary link |
| cost_plus_cycle_report | Bi-Weekly Cycle Report | client | email | 0 | Subject: "Project Report — {{job_title}} — Cycle {{cycle_number}}". Body: cycle breakdown link |
| job_completion_package | Completion Package | client | email | 0 | Subject: "Your Project is Complete! — {{job_title}}". Body: completion package link |

### Financial

| Trigger Event | Name | Recipient | Channel | Delay | Body Template |
|--------------|------|-----------|---------|-------|---------------|
| payment_received | Payment Receipt | client | email | 0 | Subject: "Payment Received — Invoice #{{invoice_number}}". Body: amount applied, remaining balance |
| invoice_due_reminder | Invoice Due Reminder SMS | client | sms | -2880 (2 days before due) | Friendly reminder: Invoice #{{invoice_number}} for {{invoice_amount}} is due on {{due_date}}. Pay here: {{payment_link}} |
| invoice_due_reminder | Invoice Due Reminder Email | client | email | -2880 | Subject: "Upcoming Payment Due — Invoice #{{invoice_number}}". Body: amount, due date, link |
| invoice_past_due | Past Due Notice | client | sms | daily after grace | Invoice #{{invoice_number}} for {{invoice_amount}} is past due. A late fee of $50/day is accruing per contract terms. Pay here: {{payment_link}} |

### Post-Job

| Trigger Event | Name | Recipient | Channel | Delay | Body Template |
|--------------|------|-----------|---------|-------|---------------|
| review_request | Google Review Request | client | sms | 0 | We hope you're enjoying your new {{job_type}}! If you're happy with our work, a Google review helps other homeowners find us: {{review_link}} |
| thirty_day_followup | 30-Day Follow-Up | client | sms | 2592000 (30 days) | Hi {{client_first_name}}, how's everything holding up with {{job_title}}? Let us know if you need anything! |
| warranty_reminder | 11-Month Warranty Reminder | client | email | 28944000 (335 days) | Subject: "Your Warranty is Approaching Its End — {{job_title}}". Body: warranty details, contact info |

### Subcontractor

| Trigger Event | Name | Recipient | Channel | Delay | Body Template |
|--------------|------|-----------|---------|-------|---------------|
| sub_scheduled | Sub Scheduling | subcontractor | sms | 0 | You've been scheduled for {{trade_or_work}} at {{property_address}} on {{scheduled_date}} from {{start_time}} to {{end_time}}. Notes: {{notes}} |
| sub_schedule_change | Sub Schedule Change | subcontractor | sms | 0 | Schedule update: Your work at {{property_address}} has been changed to {{new_date}} {{new_time}}. Notes: {{notes}} |
| sub_schedule_cancelled | Sub Schedule Cancelled | subcontractor | sms | 0 | Schedule cancelled: Your work at {{property_address}} on {{scheduled_date}} has been cancelled. {{reason}} |

---

## 4. Estimate Templates

### Template: Bathroom Remodel

```json
{
  "name": "Bathroom Remodel",
  "job_type": "remodel",
  "description": "Standard bathroom remodel — demo, plumbing, electrical, tile, fixtures, paint",
  "default_billing_model": "fixed_price",
  "line_items": [
    {
      "product_service": "Demolition & Prep",
      "description": "Demo existing bathroom including tile, vanity, toilet, and tub/shower. Haul-off of all debris. Prep surfaces for new work.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Demo labor", "category": "labor", "quantity": 16, "unit": "hour", "unit_cost": 90 },
        { "description": "Dumpster rental", "category": "equipment", "unit_cost": 450 },
        { "description": "Haul-off disposal fees", "category": "other", "unit_cost": 150 }
      ]
    },
    {
      "product_service": "Plumbing",
      "description": "Rough-in and finish plumbing for new tub/shower, vanity, and toilet. Includes all supply and drain connections.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Plumber — rough-in", "category": "subcontractor", "unit_cost": 1800 },
        { "description": "Plumber — finish", "category": "subcontractor", "unit_cost": 900 },
        { "description": "Plumbing materials", "category": "material", "unit_cost": 400 }
      ]
    },
    {
      "product_service": "Electrical",
      "description": "Update electrical to code. New GFCI outlets, vanity lighting, exhaust fan. Includes all wiring and fixtures.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Electrician", "category": "subcontractor", "unit_cost": 1200 },
        { "description": "Light fixtures & fan", "category": "material", "unit_cost": 350 }
      ]
    },
    {
      "product_service": "Tile & Flooring",
      "description": "Floor tile and tub surround tile installation including backer board, waterproofing, and all finish work.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Tile installer", "category": "subcontractor", "unit_cost": 2500 },
        { "description": "Tile material", "category": "material", "unit_cost": 1200 },
        { "description": "Backer board & waterproofing", "category": "material", "unit_cost": 300 }
      ]
    },
    {
      "product_service": "Fixtures & Finish",
      "description": "Install vanity, toilet, tub/shower unit, mirror, hardware, paint. Final cleanup and touch-up.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Finish labor", "category": "labor", "quantity": 24, "unit": "hour", "unit_cost": 90 },
        { "description": "Vanity with sink", "category": "material", "unit_cost": 800 },
        { "description": "Toilet", "category": "material", "unit_cost": 300 },
        { "description": "Tub/shower unit or glass enclosure", "category": "material", "unit_cost": 1500 },
        { "description": "Mirror, hardware, accessories", "category": "material", "unit_cost": 400 },
        { "description": "Paint and supplies", "category": "material", "unit_cost": 200 }
      ]
    }
  ],
  "default_payment_schedule": [
    { "description": "Materials Deposit", "percentage": 33.30, "is_deposit": true, "trigger": "contract_signing" },
    { "description": "50% Completion", "percentage": 33.30, "trigger": "milestone" },
    { "description": "Upon Completion", "percentage": 33.40, "trigger": "completion" }
  ]
}
```

### Template: Garage Conversion

```json
{
  "name": "Garage Conversion",
  "job_type": "garage_conversion",
  "description": "Convert attached or detached garage to living space — framing, insulation, electrical, drywall, flooring, HVAC",
  "default_billing_model": "fixed_price",
  "line_items": [
    {
      "product_service": "Framing & Structural",
      "description": "Frame new walls, window openings, and door. Structural modifications as needed. Includes headers and floor leveling.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Framing labor", "category": "labor", "quantity": 40, "unit": "hour", "unit_cost": 90 },
        { "description": "Lumber and framing materials", "category": "material", "unit_cost": 1800 },
        { "description": "Windows", "category": "material", "unit_cost": 1200 }
      ]
    },
    {
      "product_service": "Electrical",
      "description": "Full electrical for converted space — outlets, lighting, dedicated circuits, panel work as needed.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Electrician", "category": "subcontractor", "unit_cost": 3500 }
      ]
    },
    {
      "product_service": "Insulation & Drywall",
      "description": "Insulate all exterior walls and ceiling. Hang, tape, and finish drywall throughout.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Insulation material and install", "category": "material", "unit_cost": 1200 },
        { "description": "Drywall material", "category": "material", "unit_cost": 800 },
        { "description": "Drywall install, tape, finish", "category": "labor", "quantity": 32, "unit": "hour", "unit_cost": 90 }
      ]
    },
    {
      "product_service": "HVAC",
      "description": "Extend existing HVAC to converted space or install mini-split system.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "HVAC subcontractor", "category": "subcontractor", "unit_cost": 3500 }
      ]
    },
    {
      "product_service": "Flooring",
      "description": "Level floor, install underlayment and finished flooring (LVP or tile).",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Floor leveling", "category": "material", "unit_cost": 400 },
        { "description": "LVP flooring material", "category": "material", "unit_cost": 1500 },
        { "description": "Flooring install labor", "category": "labor", "quantity": 16, "unit": "hour", "unit_cost": 90 }
      ]
    },
    {
      "product_service": "Paint & Finish",
      "description": "Prime and paint all walls, ceiling, and trim. Install baseboard, door casing, and final hardware.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Paint and supplies", "category": "material", "unit_cost": 500 },
        { "description": "Baseboard and trim", "category": "material", "unit_cost": 400 },
        { "description": "Paint and trim labor", "category": "labor", "quantity": 24, "unit": "hour", "unit_cost": 90 }
      ]
    }
  ],
  "default_payment_schedule": [
    { "description": "Materials Deposit", "percentage": 33.30, "is_deposit": true, "trigger": "contract_signing" },
    { "description": "50% Completion", "percentage": 33.30, "trigger": "milestone" },
    { "description": "Upon Completion", "percentage": 33.40, "trigger": "completion" }
  ]
}
```

### Template: Deck Build

```json
{
  "name": "Deck Build",
  "job_type": "deck",
  "description": "New deck construction — framing, decking, railing, stairs, permit",
  "default_billing_model": "fixed_price",
  "line_items": [
    {
      "product_service": "Permits & Plans",
      "description": "Pull building permit. Site layout and foundation plan.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Building permit fees", "category": "permit", "unit_cost": 250 },
        { "description": "Planning and layout", "category": "labor", "quantity": 4, "unit": "hour", "unit_cost": 105 }
      ]
    },
    {
      "product_service": "Foundation & Framing",
      "description": "Set concrete footings, install posts, beams, and joist structure per code.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Concrete and footings", "category": "material", "unit_cost": 600 },
        { "description": "Posts, beams, joists (PT lumber)", "category": "material", "unit_cost": 2000 },
        { "description": "Hardware (hangers, brackets, bolts)", "category": "material", "unit_cost": 400 },
        { "description": "Framing labor", "category": "labor", "quantity": 32, "unit": "hour", "unit_cost": 90 }
      ]
    },
    {
      "product_service": "Decking & Railing",
      "description": "Install composite or treated decking boards, railing system, and stairs.",
      "quantity": 1,
      "unit_price": 0,
      "sub_items": [
        { "description": "Composite decking material", "category": "material", "unit_cost": 3000 },
        { "description": "Railing system", "category": "material", "unit_cost": 1200 },
        { "description": "Stair stringers and treads", "category": "material", "unit_cost": 500 },
        { "description": "Decking and railing labor", "category": "labor", "quantity": 24, "unit": "hour", "unit_cost": 90 }
      ]
    }
  ],
  "default_payment_schedule": [
    { "description": "Materials Deposit", "percentage": 50, "is_deposit": true, "trigger": "contract_signing" },
    { "description": "Upon Completion", "percentage": 50, "trigger": "completion" }
  ]
}
```

---

## 5. Saved Reviews

Pre-load your best Google reviews for display on estimates. These are examples — replace with your actual reviews.

```sql
INSERT INTO saved_reviews (id, reviewer_name, review_date, rating, review_text, source, is_active, sort_order, created_at) VALUES
('rev-001', 'Sarah M.', '2025-11-15', 5, 'Tony and his team did an incredible job on our garage conversion. Professional from start to finish, always on time, and the quality of work exceeded our expectations. Highly recommend Columbus Home Solutions!', 'google', 1, 1, datetime('now')),
('rev-002', 'James & Linda K.', '2025-09-22', 5, 'We hired CHS for a full bathroom remodel and could not be happier. Tony kept us informed every step of the way with photos and updates. The finished product looks amazing. Fair pricing and honest work.', 'google', 1, 2, datetime('now')),
('rev-003', 'Marcus D.', '2026-01-08', 5, 'Columbus Home Solutions built a beautiful deck for us. The crew was respectful of our property, cleaned up every day, and finished ahead of schedule. Tony is the kind of contractor you can trust. Five stars.', 'google', 1, 3, datetime('now'));
```

*Note: Replace these with your actual best Google reviews before going live.*

---

## 6. Common Subcontractor Trades

Seed the subcontractors table with trade categories. Actual sub names/contacts should be migrated from the existing chs-hub sub list.

Supported trade values:
- electrical
- plumbing
- hvac
- concrete
- roofing
- drywall
- painting
- flooring
- cabinetry
- tile
- stone
- insulation
- framing
- general
- landscaping
- gutters
- siding
- windows_doors
- appliance
- cleaning
