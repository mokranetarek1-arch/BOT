import { supabase } from '@/utils/supabase';
import { Conversation, Message } from '@/types';

/**
 * Real database access for the Instagram messaging pipeline (Phase 1).
 * All reads are scoped by RLS to the signed-in user's organization —
 * a company can only ever see its own conversations and messages.
 */

export const conversationService = {
  /**
   * List the current organization's conversations, newest activity first.
   * The contact name is joined via the conversations.contact_id FK.
   */
  async getConversations(): Promise<Conversation[]> {
    const { data, error } = await supabase
      .from('conversations')
      .select(
        'id, organization_id, social_account_id, contact_id, channel, external_conversation_id, status, last_message_at, created_at, contact:contacts(id, name)'
      )
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Conversation[];
  },

  /** All messages of one conversation, oldest first. */
  async getMessages(conversationId: string): Promise<Message[]> {
    const { data, error } = await supabase
      .from('messages')
      .select(
        'id, organization_id, conversation_id, external_message_id, sender_external_id, message_type, message_text, raw_data, created_at'
      )
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Message[];
  },
};

