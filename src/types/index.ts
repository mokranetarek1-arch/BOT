export interface Organization {
  id: string;
  name: string;
  created_at: string;
}

export interface Profile {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  /**
   * NOTE: this field exists only in the mock authService. The real `profiles`
   * table (see Register.tsx) has NO organization_id column — the user↔org link
   * lives in the `organization_members` join table.
   */
  organization_id: string;
  created_at: string;
}

export interface OrganizationMember {
  organization_id: string;
  user_id: string;
  role: string;
}

export interface Customer {
  id: string;
  organization_id: string;
  name: string;
  city: string;
  wilaya: string;
  status: 'active' | 'inactive';
  created_at: string;
}

export interface Lead {
  id: string;
  organization_id: string;
  name: string;
  source: 'instagram' | 'facebook' | 'whatsapp';
  status: 'new' | 'contacted' | 'converted' | 'lost';
  value?: number;
  created_at: string;
}

export interface SocialAccount {
  id: string;
  organization_id: string;
  platform: 'instagram' | 'facebook' | 'whatsapp';
  external_account_id: string;
  account_name: string | null;
  /** Aggregate status derived from the row; token columns may not be selected. */
  connected_at?: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_type: 'customer' | 'agent' | 'ai';
  content: string;
  created_at: string;
}

/** Allowed values of contacts.lead_status (mirrors the DB CHECK constraint). */
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'won' | 'lost';

/** Allowed values of contacts.customer_status (mirrors the DB CHECK constraint). */
export type CustomerStatus = 'prospect' | 'active' | 'inactive' | 'blocked';

/**
 * CRM contact — a row of public.contacts.
 *
 * Identity fields (phone/email/company/city/wilaya/country/source) hold
 * confirmed data only. Channel-scoped identity is intentionally NOT here:
 * the Instagram username lives in contact_channels.username and the technical
 * IGSID in contact_channels.external_user_id.
 *
 * AI-enriched fields (intent/interests/needs/sentiment/summary) are not part
 * of this type — they will live in a separate table in a later phase so that
 * inferred data is never mixed with confirmed data.
 */
export interface Contact {
  id: string;
  organization_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  city: string | null;
  wilaya: string | null;
  country: string | null;
  source: string | null;
  lead_status: LeadStatus;
  customer_status: CustomerStatus;
  tags: string[];
  notes: string | null;
  last_contact_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A channel-scoped identity of a contact — a row of public.contact_channels.
 *
 * `external_user_id` is a technical identifier only (the IGSID for Instagram):
 * it is never a display name and never a CRM identifier.
 * `profile_data` is jsonb written by the ingestion function and its shape is
 * NOT guaranteed, so it is typed as unknown and must be validated before use.
 */
export interface ContactChannel {
  id: string;
  channel: string;
  external_user_id: string;
  username: string | null;
  profile_data: unknown;
  created_at: string;
}

/**
 * Allowed values of contact_ai_insights.insight_type (mirrors the DB CHECK).
 */
export type InsightType =
  | 'intent'
  | 'interests'
  | 'needs'
  | 'buying_timeframe'
  | 'sentiment'
  | 'summary';

/**
 * One AI inference row — public.contact_ai_insights.
 *
 * This is NEVER a confirmed fact: it carries its own provenance (model,
 * prompt_version, source_message_ids) and confidence, and the UI must render
 * it outside the Contact Information block.
 */
export interface ContactInsight {
  id: string;
  organization_id: string;
  contact_id: string;
  conversation_id: string | null;
  insight_type: InsightType;
  /** JSON payload — shape depends on insight_type; never assumed to be a string. */
  value: unknown;
  /** Postgres numeric arrives as a JSON number; null when the writer has none. */
  confidence: number | null;
  model: string;
  prompt_version: string;
  source_message_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  organization_id: string;
  social_account_id: string;
  contact_id: string;
  channel: 'instagram' | 'facebook' | 'whatsapp';
  external_conversation_id: string | null;
  status: 'open' | 'closed' | 'snoozed';
  last_message_at: string | null;
  created_at: string;
  /** Joined data (not columns of the table itself). */
  contact?: { id: string; name: string } | null;
  messages?: Message[];
}

export interface Message {
  id: string;
  organization_id: string;
  conversation_id: string;
  /** Meta message id — used for idempotency (one row per Meta delivery). */
  external_message_id: string;
  /** The external user id of the sender (IGSID for inbound DMs). */
  sender_external_id: string;
  /** 'text' | 'image' | 'video' | 'audio' | 'story_mention' | 'unsupported' */
  message_type: string;
  message_text: string | null;
  /** 'inbound' | 'outbound' — the migration column of the same name. */
  direction?: string | null;
  /** Channel the message travelled over (instagram / facebook / whatsapp). */
  channel?: string | null;
  /**
   * Attachment metadata exactly as Meta provides it (type + payload URL).
   * Never analyzed: it is displayed as-is and must be validated at runtime.
   */
  attachments?: unknown;
  /**
   * Full raw webhook payload. Intentionally NOT selected by the CRM views —
   * it is only requested where it is genuinely needed (debugging).
   */
  raw_data?: unknown;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Dynamic Custom CRM Engine — public.crm_custom_fields / contact_custom_values
// ---------------------------------------------------------------------------

/** Allowed values of crm_custom_fields.field_type (mirrors the DB CHECK). */
export type CustomFieldType = 'text' | 'number' | 'select' | 'phone' | 'date';

/**
 * One custom CRM column definition — a row of public.crm_custom_fields.
 * `field_name` is the JSONB key inside contact_custom_values.values and must
 * be a lowercase identifier; `field_label` is the human-facing column title;
 * `description_for_ai` tells the extractor what the field means.
 */
export interface CrmCustomField {
  id: string;
  organization_id: string;
  field_name: string;
  field_label: string;
  field_type: CustomFieldType;
  /** Choices for 'select' fields; null for every other type (DB CHECK). */
  options: string[] | null;
  description_for_ai: string | null;
  created_at: string;
  updated_at: string;
}

/** Dynamic values object stored in contact_custom_values.values (JSONB). */
export type ContactCustomValues = Record<string, string | number | null>;

/** One row of public.contact_custom_values — unique per contact (DB UNIQUE). */
export interface ContactCustomValuesRow {
  id: string;
  contact_id: string;
  organization_id: string;
  values: ContactCustomValues;
  created_at: string;
  updated_at: string;
}

