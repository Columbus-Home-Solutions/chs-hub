export interface Conversation {
  client_id: string;
  client_name: string;
  client_phone: string | null;
  sms_opt_out: boolean;
  last_message_body: string;
  last_message_at: string;
  last_message_direction: "inbound" | "outbound";
  unread_count: number;
  lead_request_id: string | null;
  lead_request_number: number | null;
  lead_status: string | null;
  archived_at: string | null;
  flagged_at: string | null;
  pinned_at: string | null;
  unread_override: boolean;
}

export interface ConversationsResponse {
  conversations: Conversation[];
  unread_total: number;
  archived_count: number;
}

export interface SmsMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  created_at: string;
  sent_via: string | null;
  job_id: string | null;
  job_title: string | null;
  simulated: boolean;
}

export interface SmsThread {
  client_id: string;
  client_name: string;
  client_phone: string | null;
  sms_opt_out: boolean;
  messages: SmsMessage[];
  archived_at: string | null;
  flagged_at: string | null;
  pinned_at: string | null;
  unread_override: boolean;
}

export type InboxTab = "clients" | "unassigned";
