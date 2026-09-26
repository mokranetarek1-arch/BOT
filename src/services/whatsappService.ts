import { supabase } from '@/utils/supabase';
import { SocialAccount } from '../types';

export interface WhatsAppConnectParams {
  phoneNumberId: string;
  accountName: string;
  accessToken: string;
}

export const whatsappService = {
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
