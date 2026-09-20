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

export interface Conversation {
  id: string;
  organization_id: string;
  customer_id?: string;
  platform: 'instagram' | 'facebook' | 'whatsapp';
  status: 'open' | 'closed' | 'snoozed';
  last_message_at: string;
  messages?: Message[];
}

