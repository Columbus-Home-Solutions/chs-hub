export interface Client {
  id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  phone_secondary: string | null;
  mailing_address: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  lead_source: string | null;
  high_level_contact_id: string | null;
  is_repeat_client: boolean;
  review_requested: boolean;
  google_review_left: boolean;
  notes: string | null;
  last_interaction_date: string | null;
  total_jobs: number;
  total_revenue: number;
  active_jobs: number;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
}

export interface Property {
  id: string;
  client_id: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  property_type: string | null;
  notes: string | null;
  created_at: string;
}

export interface Communication {
  id: string;
  client_id: string;
  job_id: string | null;
  channel: string;
  direction: string;
  summary: string;
  body: string | null;
  duration_seconds: number | null;
  sent_via: string | null;
  logged_by: string | null;
  created_at: string;
}

export interface JobLite {
  id: string;
  job_number: number | null;
  title: string | null;
  status: string | null;
  contract_total: number | null;
  start_date: string | null;
  created_at: string | null;
}

export interface Subcontractor {
  id: string;
  company_name: string | null;
  contact_name: string | null;
  trade: string | null;
  phone: string | null;
  email: string | null;
  license_number: string | null;
  insurance_on_file: boolean;
  w9_on_file: boolean;
  hourly_rate: number | null;
  flat_rate_notes: string | null;
  rating: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface DuplicateMatch {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  total_jobs: number;
  total_revenue: number;
  last_interaction_date: string | null;
  match_reason: string;
}

export const LEAD_SOURCES = [
  "direct_call",
  "google_lsa",
  "thumbtack",
  "website",
  "referral",
  "repeat",
];

export const TRADES = [
  "electrical",
  "plumbing",
  "hvac",
  "concrete",
  "roofing",
  "drywall",
  "painting",
  "flooring",
  "cabinetry",
  "tile",
  "stone",
  "insulation",
  "framing",
  "general",
];

export const COMM_CHANNELS = [
  "phone_call",
  "text_sms",
  "email",
  "portal_message",
  "in_person",
  "other",
];

// ─── Estimating pipeline (Sprint 3) ─────────────────────────────────────────

export type EstimateRequestStatus =
  | "new_request"
  | "appointment_set"
  | "visit_done"
  | "building"
  | "sent"
  | "follow_up"
  | "won"
  | "lost";

export interface EstimateRequest {
  id: string;
  request_number: number;
  status: EstimateRequestStatus;
  client_id: string;
  client_name: string;
  client_phone: string | null;
  client_email: string | null;
  is_repeat_client: boolean;
  property_address: string;
  property_city: string;
  property_state: string | null;
  property_zip: string;
  job_type: string;
  lead_source: string;
  lead_source_detail: string | null;
  high_level_opportunity_id: string | null;
  appointment_date: string | null;
  appointment_completed: boolean;
  visit_notes: string | null;
  visit_photo_ids: string | null;
  estimate_id: string | null;
  estimate_status: EstimateStatus | null;
  estimate_sent: boolean;
  estimate_deposit: number | null;
  sent_date: string | null;
  follow_up_count: number;
  last_follow_up_date: string | null;
  lost_reason: string | null;
  lost_notes: string | null;
  converted_job_id: string | null;
  days_in_stage: number;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
}

export interface ActivityEntry {
  id: string;
  user_email: string;
  action: string;
  details: string | null;
  created_at: string;
}

// Manual deposit payment methods for "Mark as Won" (Module-Spec §4.10).
// Stripe is intentionally excluded — Stripe deposits auto-convert without the modal.
export const WON_PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "venmo", label: "Venmo" },
  { value: "zelle", label: "Zelle" },
  { value: "other", label: "Other" },
];

export const ESTIMATE_SENT_TOOLTIP =
  "Estimate must be sent to the client before marking as won.";

// Pipeline stage columns, left → right (matches the API status order).
export const PIPELINE_STAGES: { key: EstimateRequestStatus; label: string }[] = [
  { key: "new_request", label: "New Request" },
  { key: "appointment_set", label: "Appointment Set" },
  { key: "visit_done", label: "Estimate Visit Done" },
  { key: "building", label: "Estimate Building" },
  { key: "sent", label: "Estimate Sent" },
  { key: "follow_up", label: "Follow-Up" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
];

export const ESTIMATE_JOB_TYPES = [
  "new_build",
  "addition",
  "remodel_kitchen",
  "remodel_bathroom",
  "remodel_other",
  "repair",
  "commercial",
  "other",
];

export const ESTIMATE_LEAD_SOURCES = [
  "direct_call",
  "google_lsa",
  "thumbtack",
  "website_form",
  "referral",
  "repeat_client",
  "other",
];

export const LOST_REASONS = [
  "price_too_high",
  "went_with_competitor",
  "project_cancelled",
  "no_response",
  "timing",
  "other",
];

// ─── Estimate Builder (Sprint 4) ────────────────────────────────────────────

export type EstimateMode = "lump_sum" | "trade_by_trade";
export type BillingModel = "fixed_price" | "trade_by_trade" | "cost_plus";
export type EstimateStatus = "draft" | "sent" | "viewed" | "approved" | "expired" | "revised";

export const SUB_ITEM_CATEGORIES = [
  "material",
  "labor",
  "subcontractor",
  "permit",
  "equipment",
  "other",
];

export const PAYMENT_TRIGGERS = [
  "contract_signing",
  "milestone",
  "trade_completion",
  "bi_weekly_cycle",
  "completion",
];

export interface EstimateSubItem {
  id: string;
  parent_line_item_id: string;
  sort_order: number;
  description: string;
  category: string;
  vendor: string | null;
  quantity: number | null;
  unit: string | null;
  unit_cost: number | null;
  total_cost: number;
  material_id: string | null;
  notes: string | null;
}

export interface EstimateLineItem {
  id: string;
  estimate_id: string;
  sort_order: number;
  product_service: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  total: number;
  internal_cost: number;
  includes_note: string | null;
  sub_items: EstimateSubItem[];
}

export interface PaymentMilestone {
  id: string;
  estimate_id: string;
  sort_order: number;
  description: string;
  percentage: number | null;
  fixed_amount: number | null;
  amount: number;
  is_deposit: boolean;
  trigger: string | null;
  notes: string | null;
}

export interface Estimate {
  id: string;
  estimate_number: number | null;
  request_id: string | null;
  client_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  request_number: number | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  job_type: string | null;
  title: string | null;
  estimate_mode: EstimateMode | null;
  billing_model: BillingModel | null;
  status: EstimateStatus;
  subtotal: number;
  tax_amount: number;
  total: number;
  internal_cost: number;
  margin_percent: number;
  deposit_amount: number | null;
  deposit_type: string | null;
  deposit_percentage: number | null;
  valid_days: number;
  expiration_date: string | null;
  portal_token: string | null;
  include_reviews: boolean;
  review_ids: string | null;
  include_contract: boolean;
  contract_template_id: string | null;
  client_signature: string | null;
  signed: boolean;
  signed_date: string | null;
  viewed_date: string | null;
  approved_date: string | null;
  portal_path: string | null;
  notes: string | null;
  version: number;
  revised_from_id: string | null;
  sent_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  line_items: EstimateLineItem[];
  payment_schedule: PaymentMilestone[];
}

export interface EstimateTemplate {
  id: string;
  name: string;
  job_type: string;
  description: string | null;
  default_billing_model: string | null;
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  line_items?: unknown[];
  default_payment_schedule?: unknown;
}

export interface SavedReview {
  id: string;
  reviewer_name: string;
  review_date: string | null;
  rating: number;
  review_text: string;
  source: string;
  is_active: boolean;
  sort_order: number | null;
  created_at: string | null;
}

export interface VendorMaterial {
  id: string;
  vendor_name: string;
  material_name: string;
  category: string;
  unit: string;
  last_price: number;
  average_price: number | null;
  last_purchased_date: string | null;
}

export const ESTIMATE_MODES: { value: EstimateMode; label: string }[] = [
  { value: "lump_sum", label: "Lump Sum" },
  { value: "trade_by_trade", label: "Trade-by-Trade" },
];

export const BILLING_MODELS: { value: BillingModel; label: string }[] = [
  { value: "fixed_price", label: "Fixed Price" },
  { value: "trade_by_trade", label: "Trade-by-Trade" },
  { value: "cost_plus", label: "Cost-Plus" },
];

export const REVIEW_SOURCES = ["google", "facebook", "manual"];
