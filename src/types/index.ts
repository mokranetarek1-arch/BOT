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

export interface Contact {
  id: string;
  organization_id: string;
  name: string;
  created_at: string;
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
  /** Full raw webhook payload, preserved for debugging / future phases. */
  raw_data?: unknown;
  created_at: string;
}

