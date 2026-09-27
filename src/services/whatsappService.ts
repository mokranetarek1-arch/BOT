import { supabase } from '@/utils/supabase';
import { SocialAccount } from '../types';
import { launchWhatsAppEmbeddedSignup } from './metaSdk';

export interface WhatsAppSignupAccount {
  id: string | null;
  external_account_id: string;
  name: string | null;
  whatsapp_business_id?: string | null;
  phone_number_id?: string | null;
  display_phone_number?: string | null;
  display_name?: string | null;
}

interface SignupEdgeResult {
  ok?: boolean;
  error?: string;
  account?: WhatsAppSignupAccount;
}

/** Columns safe to read from the browser. The token column is never selected. */
const ACCOUNT_COLUMNS =
  'id, organization_id, platform, external_account_id, account_name, is_active, waba_id, phone_number, display_name';

export const whatsappService = {
  /**
   * Connect WhatsApp through Meta Embedded Signup (no IDs, no tokens to paste).
   *
   * Opens the Meta dialog, then immediately forwards the exchangeable code to
   * the `facebook-oauth` Edge Function. The code has a ~30 second TTL, so the
   * request must not be delayed, retried or queued.
   */
  async connectWithEmbeddedSignup(): Promise<SocialAccount> {
    const { data: sessionData } = await supabase.auth.getSession();
    const jwt = sessionData.session?.access_token;
    if (!jwt) throw new Error('You must be signed in to connect WhatsApp.');

    const { code, whatsappBusinessId, phoneNumberId } =
      await launchWhatsAppEmbeddedSignup();

    const { data, error } = await supabase.functions.invoke('facebook-oauth', {
      body: {
        action: 'whatsapp_signup',
        code,
        whatsapp_business_id: whatsappBusinessId,
        phone_number_id: phoneNumberId,
      },
      headers: { Authorization: `Bearer ${jwt}` },
    });

    if (error) {
      const fnError = error as { message: string; name?: string; context?: Response };
      let detail = '';
      if (fnError.context) {
        try {
          const body = await fnError.context.clone().json();
          detail = body?.error ? `: ${body.error}` : '';
        } catch {
          detail = '';
        }
      }
      throw new Error(
        `${fnError.message || 'The WhatsApp sign-up could not be completed.'}${detail}`,
      );
    }

    const result = (data ?? {}) as SignupEdgeResult;
    if (result.error) throw new Error(result.error);
    if (!result.ok) throw new Error('Meta did not confirm the WhatsApp sign-up.');

    const account = await this.getConnectedAccount();
    if (!account) {
      // "Connected" is only reported when the row can actually be read back
      // under the caller's RLS scope. If the read fails (most often because the
      // social_accounts migration has not been applied yet, so is_active does
      // not exist) the real reason is surfaced instead of a false success.
      throw new Error(
        'The backend stored the WhatsApp account, but it could not be read back. ' +
          'Check that the social_accounts WhatsApp migration has been applied to the database.',
      );
    }
    return account;
  },

  /**
   * Fetch the connected WhatsApp account for the current user.
   *
   * Only ACTIVE accounts count as connected: a disconnected account keeps its
   * row (and all of its history) but must not be shown as connected.
   * RLS scopes the result to the caller's organization, and the access token
   * column is deliberately not selected.
   */
  async getConnectedAccount(): Promise<SocialAccount | null> {
    const { data, error } = await supabase
      .from('social_accounts')
      .select(ACCOUNT_COLUMNS)
      .eq('platform', 'whatsapp')
      .eq('is_active', true)
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return (data as SocialAccount) ?? null;
  },

  /**
   * Disconnect WhatsApp — a SOFT disconnect, never a delete.
   *
   * `conversations.social_account_id` references this row, so deleting it could
   * cascade onto conversations and their messages and destroy the historical
   * CRM data. Marking the account inactive stops new inbound attribution while
   * contacts, conversations, messages and every AI-extracted CRM field remain
   * exactly as they are. Reconnecting flips the flag back on.
   */
  async disconnect(accountId: string): Promise<void> {
    const { error } = await supabase
      .from('social_accounts')
      .update({ is_active: false })
      .eq('id', accountId)
      .eq('platform', 'whatsapp');

    if (error) throw new Error(error.message);
  },
};
