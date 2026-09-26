import { supabase } from '@/utils/supabase';
import { Conversation, Message } from '@/types';

/**
 * Real database access for the Instagram messaging pipeline (Phase 1).
 * All reads are scoped by RLS to the signed-in user's organization —
 * a company can only ever see its own conversations and messages.
 */

/** Response payload of the `send-message` Edge Function. */
interface SendMessageResponse {
  ok?: boolean;
  error?: string;
  warning?: string;
  recipient_id?: string;
  message?: Message;
}

/**
 * Turns a `supabase.functions.invoke` error into a readable message, preferring
 * the Edge Function's own JSON `error` field.
 *
 * Same approach as instagramService.callEdge — kept local so the Instagram OAuth
 * flow is left untouched.
 */
async function describeSendError(error: unknown): Promise<string> {
  const fnError = error as { message?: string; name?: string; context?: Response };

  // `FunctionsFetchError` = the request never reached a server (network error,
  // CORS, or the function is not deployed). It carries NO response.
  if (fnError.name === 'FunctionsFetchError' || !fnError.context) {
    return (
      'Could not reach the "send-message" Edge Function (network error). ' +
      'Most common causes: (1) the function is not deployed — run ' +
      '`supabase functions deploy send-message`; (2) CORS preflight blocked; ' +
      '(3) the request never left the browser. Check the Network tab.'
    );
  }

  // `FunctionsHttpError` carries a Response with a real status + body.
  const status = fnError.context.status;
  try {
    const body = (await fnError.context.clone().json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // Non-JSON body — fall through to the status-based messages below.
  }

  if (status === 404) {
    return (
      'Edge Function "send-message" was not found — is it deployed? ' +
      'Run: `supabase functions deploy send-message`'
    );
  }
  if (status === 401 || status === 403) {
    return 'The request was rejected (auth). Your session may have expired — try signing in again.';
  }
  return fnError.message ?? `Could not send the message (HTTP ${status}).`;
}

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

  /**
   * Conversations belonging to one contact, most recent activity first.
   *
   * A plain list, never `maybeSingle()`: a contact can have several
   * conversations (there is no unique constraint on
   * conversations(contact_id)), so every one of them must be shown.
   */
  async getConversationsByContact(contactId: string): Promise<Conversation[]> {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, channel, status, social_account_id, last_message_at, created_at')
      .eq('contact_id', contactId)
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Conversation[];
  },

  /**
   * All messages of one conversation, oldest first.
   *
   * `raw_data` (the full webhook payload) is deliberately NOT selected: it is
   * large and sensitive and nothing in the UI displays it.
   */
  async getMessages(conversationId: string): Promise<Message[]> {
    const { data, error } = await supabase
      .from('messages')
      .select(
        'id, organization_id, conversation_id, external_message_id, sender_external_id, message_type, message_text, direction, channel, attachments, created_at'
      )
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Message[];
  },

  /**
   * Send a text reply into an existing conversation (Inbox replies).
   *
   * The Meta call is performed by the `send-message` Edge Function: the stored
   * Instagram access token stays server-side and never reaches this client.
   * Returns the stored outbound message so the thread renders it immediately.
   */
  async sendMessage(conversationId: string, text: string): Promise<Message> {
    const trimmed = text.trim();
    if (!conversationId) throw new Error('Select a conversation first.');
    if (!trimmed) throw new Error('Write a message before sending.');

    const { data: sessionData } = await supabase.auth.getSession();
    const jwt = sessionData.session?.access_token;
    if (!jwt) throw new Error('You must be signed in to reply.');

    const { data, error } = await supabase.functions.invoke('send-message', {
      body: { conversation_id: conversationId, text: trimmed },
      headers: { Authorization: `Bearer ${jwt}` },
    });

    if (error) throw new Error(await describeSendError(error));

    const result = (data ?? {}) as SendMessageResponse;
    if (result.error) throw new Error(result.error);
    if (!result.message) {
      throw new Error('The message was sent but its confirmation was unreadable.');
    }
    if (result.warning) console.warn('[conversationService]', result.warning);

    return result.message;
  },
};

