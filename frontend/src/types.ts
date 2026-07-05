export interface Client {
  id: string;
  name: string;
  company_name: string | null;
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
  referral_source_id: string | null;
  high_level_contact_id: string | null;
  is_repeat_client: boolean;
  review_requested: boolean;
  google_review_left: boolean;
  notes: string | null;
  last_interaction_date: string | null;
  total_jobs: number;
  total_revenue: number;
  active_jobs: number;
  has_reviewed?: boolean;
  can_delete?: boolean;
  referral_source?: { id: string; label: string } | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
}

export interface ClientContact {
  id: string;
  client_id: string;
  label: string;
  contact_type: "phone" | "email";
  value: string;
  created_at: string;
}

export interface TagDefinition {
  id: string;
  tag_text: string;
  archived: number;
  created_at: string;
}

export interface ClientTag {
  id: string;
  tag_text: string;
  archived: number;
  assigned_at: string;
}

export interface ReferralSource {
  id: string;
  label: string;
  archived: number;
  created_at: string;
}

export interface EstimateRequestLite {
  id: string;
  request_number: number;
  status: string;
  property_address: string;
  property_city: string;
  job_type: string;
  created_at: string | null;
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

// ─── Notifications (Sprint 7) ───────────────────────────────────────────────

export interface NotificationTemplate {
  id: string;
  trigger_event: string;
  name: string;
  recipient_type: string;
  channel: string;
  subject: string | null;
  body_template: string;
  merge_fields: string[];
  is_active: boolean;
  delay_minutes: number | null;
  send_time: string | null;
  phase: string | null;
  sort_order: number | null;
}

export interface NotificationLog {
  id: string;
  template_id: string;
  trigger_event: string;
  recipient_type: string;
  recipient_name: string;
  recipient_contact: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  error_message: string | null;
  retry_count: number;
  scheduled_for: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  external_id: string | null;
  job_id: string | null;
  client_id: string | null;
  estimate_request_id: string | null;
  communication_id: string | null;
  created_at: string;
}

export interface InboxNotification {
  id: string;
  trigger_event: string;
  body: string;
  subject: string | null;
  link_path: string | null;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export const NOTIFICATION_PHASES: { key: string; label: string }[] = [
  { key: "estimating", label: "Estimating" },
  { key: "job", label: "Job" },
  { key: "financial", label: "Financial" },
  { key: "post_job", label: "Post-Job" },
];

// Channels the engine wires this sprint vs. seam-only (catalog + TODO).
export const NOTIFICATION_LOG_STATUSES = ["queued", "sent", "delivered", "failed", "bounced"];

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
  tax_id: string | null;
  is_active: boolean;
  coi_expiration_date: string | null;
  license_expiration_date: string | null;
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

export type ScopeDraftStatus = "pending" | "accepted" | "discarded" | "pushed";

export interface ScopeDraftItem {
  id: string;
  product_service: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number | null;
  catalog_match_id: string | null;
  catalog_match_name: string | null;
  status: ScopeDraftStatus;
  generated_at: string;
}

export interface SketchMeta {
  id: string;
  label: string;
  data_key: string;
  thumbnail_key: string;
  created_at: string;
  updated_at: string;
}

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
  scope_draft: ScopeDraftItem[] | null;
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
  source: string;
  last_sms_at: string | null;
  // follow-up sequence fields (Sprint 26)
  follow_up_sequence_active: boolean;
  follow_up_completed_at: string | null;
  last_sms_preview: string | null;
  // Sprint 27 fields
  proposal_review_date: string | null;
  lead_outreach_sequence_active: boolean;
  lead_outreach_count: number;
  last_outreach_date: string | null;
  lead_outreach_completed_at: string | null;
  days_in_stage: number;
  age_days: number;
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
  "restoration",
  "multifamily",
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
export type BillingModel = "fixed_price" | "fifty_fifty" | "trade_by_trade" | "cost_plus" | "per_line_item";
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
  linked_job_id: string | null;
  linked_job_number: number | null;
  notes: string | null;
  version: number;
  revised_from_id: string | null;
  is_current_version: boolean;
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
  { value: "fifty_fifty", label: "50/50" },
  { value: "trade_by_trade", label: "Trade-by-Trade" },
  { value: "cost_plus", label: "Cost-Plus" },
  { value: "per_line_item", label: "Pay-As-Completed" },
];

export const BILLING_MODEL_DESCRIPTIONS: Partial<Record<BillingModel, string>> = {
  per_line_item:
    "Invoice specific line items as work is completed. Ideal for insurance restoration and phased scope work.",
};

export interface Payer {
  id: string;
  company_name: string | null;
  contact_name: string;
  email: string;
  phone: string | null;
  billing_address: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  card_brand: string | null;
  card_last4: string | null;
  has_card_on_file: boolean;
  job_count: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const REVIEW_SOURCES = ["google", "facebook", "manual"];

// ─── Jobs & Tasks (Sprint 6) ─────────────────────────────────────────────────

export type JobStatus =
  | "deposit_paid"
  | "scheduled"
  | "in_progress"
  | "punch_list"
  | "complete"
  | "closed";

// Pipeline columns, left → right (matches the API status order).
export const JOB_STAGES: { key: JobStatus; label: string }[] = [
  { key: "deposit_paid", label: "Deposit Paid" },
  { key: "scheduled", label: "Scheduled" },
  { key: "in_progress", label: "In Progress" },
  { key: "punch_list", label: "Punch List" },
  { key: "complete", label: "Complete" },
  { key: "closed", label: "Closed" },
];

// Forward-only, plus the two allowed backward exceptions (Job Management §2).
export const JOB_BACKWARD_EXCEPTIONS: Record<string, JobStatus> = {
  in_progress: "scheduled",
  complete: "punch_list",
};

export interface JobCard {
  id: string;
  job_number: number | null;
  job_display: string | null;
  title: string | null;
  status: JobStatus;
  client_id: string | null;
  client_name: string | null;
  billing_model: BillingModel | null;
  job_type: string | null;
  lead_source: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
  contract_total: number | null;
  deposit_amount: number | null;
  deposit_paid: boolean;
  start_date: string | null;
  target_end_date: string | null;
  actual_end_date: string | null;
  portal_token: string | null;
  portal_type: string | null;
  portal_path: string | null;
  conversion_complete: boolean;
  estimate_id: string | null;
  payer_id: string | null;
  days_in_status: number;
  photo_count: number;
  overdue: boolean;
  created_at: string | null;
  updated_at: string | null;
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  assigned_to_phone?: string | null;
  assigned_to_email?: string | null;
}

export interface JobPipelineResponse {
  as_of: string;
  statuses: JobStatus[];
  counts: Record<JobStatus, number>;
  pipeline: Record<JobStatus, JobCard[]>;
}

export interface Task {
  id: string;
  job_id: string;
  task_group: string;
  task_group_order: number;
  title: string;
  status: "pending" | "in_progress" | "complete" | "skipped";
  assigned_to: string | null;
  scheduled_date: string | null;
  completed_date: string | null;
  completed_by: string | null;
  notes: string | null;
  sort_order: number;
  is_punch_list: boolean;
  created_at: string | null;
}

export interface TaskGroup {
  group: string;
  group_order: number;
  tasks: Task[];
}

// ─── Punch list (Sprint 33) ───────────────────────────────────────────────

export interface PunchListItem {
  id: string;
  punch_list_id: string;
  job_id: string;
  description: string;
  sub_id: string | null;
  photo_ids: string[];
  status: "open" | "done";
  scheduled_date: string | null;
  completed_at: string | null;
  completed_note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PunchListBySub {
  sub_id: string;
  sub_name: string;
  items: PunchListItem[];
  token: string | null;
}

export interface PunchListResponse {
  punch_list: {
    id: string;
    job_id: string;
    status: "open" | "sent" | "closed";
    scheduled_date: string | null;
    sent_at: string | null;
    closed_at: string | null;
  };
  items: PunchListItem[];
  by_sub: PunchListBySub[];
  unassigned_items: PunchListItem[];
}

export interface BillingScheduleRow {
  id: string;
  billing_model: string;
  sequence: number;
  label: string;
  trigger_type: string;
  trigger_ref: string | null;
  percentage: number | null;
  amount: number | null;
  period_start: string | null;
  period_end: string | null;
  status: string;
}

// ─── Social Media Engine (Sprint 16) ────────────────────────────────────────

export type SocialPostType =
  | "job_completion"
  | "seasonal_tips"
  | "tips_tricks"
  | "promotion"
  | "review_highlight"
  | "manual";

export type SocialPostStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "published"
  | "rejected"
  | "failed";

export type SocialPlatform = "both" | "facebook_only" | "instagram_only";

export interface SocialPhotoRef {
  id: string;
  caption: string | null;
  photo_type: string | null;
  is_before_photo: boolean;
  is_after_photo: boolean;
  thumb_url: string;
  original_url: string;
}

export interface SocialPost {
  id: string;
  post_type: SocialPostType;
  status: SocialPostStatus;
  caption: string;
  hashtags: string[];
  platform: SocialPlatform;
  scheduled_date: string | null;
  published_date: string | null;
  job_id: string | null;
  photo_ids: string[];
  ai_generated_image_url: string | null;
  facebook_post_id: string | null;
  instagram_post_id: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  rejection_reason: string | null;
  generated_by: string;
  approved_by: string | null;
  approved_date: string | null;
  created_at: string;
  has_image: boolean;
  photos?: SocialPhotoRef[];
}

export interface ContentSchedule {
  id: string;
  month: number;
  year: number;
  status: "draft" | "active" | "completed";
  generated_date: string;
  notes: string | null;
  created_at: string;
  total_posts_planned: number;
  job_completion_count: number;
  seasonal_count: number;
  tips_count: number;
}

export const SOCIAL_POST_TYPES: { value: SocialPostType; label: string }[] = [
  { value: "job_completion", label: "Job Completion" },
  { value: "seasonal_tips", label: "Seasonal / Tips" },
  { value: "tips_tricks", label: "Tips & Tricks" },
  { value: "promotion", label: "Promotion" },
  { value: "review_highlight", label: "Review Highlight" },
  { value: "manual", label: "Manual" },
];

export const SOCIAL_PLATFORMS: { value: SocialPlatform; label: string }[] = [
  { value: "both", label: "Facebook + Instagram" },
  { value: "facebook_only", label: "Facebook only" },
  { value: "instagram_only", label: "Instagram only" },
];

export const SOCIAL_STATUSES: SocialPostStatus[] = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "published",
  "rejected",
  "failed",
];

// Calendar colour-coding by content type (spec §5.2).
export const SOCIAL_TYPE_COLORS: Record<SocialPostType, string> = {
  job_completion: "#3b82f6", // blue
  seasonal_tips: "#22c55e", // green
  tips_tricks: "#f97316", // orange
  promotion: "#a855f7",
  review_highlight: "#eab308",
  manual: "#64748b",
};

export interface EligibilityCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string | null;
}

export interface CloseEligibilityResult {
  eligible: boolean;
  checks: EligibilityCheck[];
}

export interface JobDetailResponse {
  job: JobCard & {
    client_phone: string | null;
    client_email: string | null;
    conversion_reversed: boolean;
    reversal_reason: string | null;
    reversed_at: string | null;
    portal_url: string | null;
  };
  financial: {
    contract_total: number | null;
    deposit_amount: number | null;
    deposit_paid_to_date: number;
  };
  task_groups: TaskGroup[];
  billing_schedule: BillingScheduleRow[];
  activity: ActivityEntry[];
}

// ─── Receipt line-item matching (Sprint 30) ─────────────────────────────────

export interface ExtractedItem {
  id: string;
  description: string;
  amount: number;
  quantity: number | null;
  unit_price: number | null;
}

export interface MatchResult {
  item_id: string;
  status: "matched" | "ambiguous" | "unmatched";
  suggested_line_item_id: string | null;
  suggested_line_item_name: string | null;
  confidence: number;
  alternatives: Array<{ line_item_id: string; line_item_name: string; confidence: number }>;
  confirmed_line_item_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

export interface LineItemForMatching {
  id: string;
  description: string;
}

export interface VendorMaterialStub {
  id: string;
  vendor_name: string;
  material_name: string;
  unit: string | null;
  last_price: number | null;
}

export interface ExpenseLineItem {
  id: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  amount: number;
  matched_estimate_sub_item_id: string | null;
  matched_vendor_material_id: string | null;
  match_confidence: number | null;
  expense_id: string | null;
  vendor_material: VendorMaterialStub | null;
  is_new_material_candidate: boolean;
}

export interface MatchData {
  status: "pending" | "processed";
  extracted_items: ExtractedItem[];
  match_results: MatchResult[];
  has_unresolved: boolean;
  expense_line_items: ExpenseLineItem[];
}

export interface ReceiptMatchResponse {
  status: "pending" | "processed" | "failed";
  extracted_items?: ExtractedItem[];
  match_results?: MatchResult[];
  has_unresolved?: boolean;
  expense_line_items?: ExpenseLineItem[];
}
