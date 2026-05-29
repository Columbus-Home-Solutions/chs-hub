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
