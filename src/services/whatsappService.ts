import { supabase } from '@/utils/supabase';
import { SocialAccount } from '../types';
import { launchWhatsAppEmbeddedSignup } from './metaSdk';

export interface WhatsAppConnectParams {
  phoneNumberId: string;
  accountName: string;
  accessToken: string;
}

export interface WhatsAppSignupAccount {
  id: string | null;
  external_account_id: string;
  name: string | null;
}

interface SignupEdgeResult {
  ok?: boolean;
  error?: string;
  account?: WhatsAppSignupAccount;
}

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
      throw new Error(
        'WhatsApp was connected but the account could not be read back. Check the Edge Function logs.',
      );
    }
    return account;
  },

  /**
   * Fetch connected WhatsApp account for current user
   */
  async getConnectedAccount(): Promise<SocialAccount | null> {
    const { data, error } = await supabase
      .from('social_accounts')
      .select('id, organization_id, platform, external_account_id, account_name')
      .eq('platform', 'whatsapp')
      .maybeSingle();

    if (error) throw new Error(error.message);
    return (data as SocialAccount) ?? null;
  },

  /**
   * Connect / link WhatsApp account by Phone Number ID and Access Token
   */
  async connectAccount(params: WhatsAppConnectParams): Promise<SocialAccount> {
    // 1. Get current user
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      throw new Error('Not authenticated.');
    }

    // 2. Resolve organization ID from organization_members
    const { data: member, error: memberError } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    if (memberError || !member?.organization_id) {
      throw new Error('No organization found for this user.');
    }

    const organizationId = member.organization_id;

    // 3. Upsert into social_accounts
    const payload: Record<string, unknown> = {
      organization_id: organizationId,
      platform: 'whatsapp',
      external_account_id: params.phoneNumberId.trim(),
      account_name: params.accountName.trim() || 'WhatsApp Business',
      access_token: params.accessToken.trim(),
    };

    const { data, error } = await supabase
      .from('social_accounts')
      .upsert(payload, {
        onConflict: 'organization_id,platform,external_account_id',
      })
      .select('id, organization_id, platform, external_account_id, account_name')
      .single();

    if (error) {
      throw new Error(error.message);
    }

    return data as SocialAccount;
  },

  /**
   * Disconnect WhatsApp account
   */
  async disconnect(accountId: string): Promise<void> {
    const { error } = await supabase
      .from('social_accounts')
      .delete()
      .eq('id', accountId)
      .eq('platform', 'whatsapp');

    if (error) throw new Error(error.message);
  },
};
