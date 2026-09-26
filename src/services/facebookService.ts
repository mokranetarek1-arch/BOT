import { supabase } from '@/utils/supabase';
import { SocialAccount } from '@/types';

/**
 * Client-side helper for the Facebook Pages / Messenger OAuth flow.
 * All secret-bearing work happens in the `facebook-oauth` Edge Function.
 */

const STATE_KEY = 'facebook_oauth_state';
const CODE_SENT_KEY_PREFIX = 'facebook_oauth_code_sent_';

/** The redirect URI registered in the Meta dashboard. */
export const FACEBOOK_REDIRECT_URI: string =
  import.meta.env.VITE_FACEBOOK_REDIRECT_URI ??
  `${window.location.origin}/integrations/facebook/callback`;

export interface FacebookPageOption {
  id: string;
  name: string;
}

interface EdgeResult {
  ok?: boolean;
  error?: string;
  authorize_url?: string;
  selection_required?: boolean;
  user_access_token?: string;
  pages?: FacebookPageOption[];
  account?: {
    id: string | null;
    external_account_id: string;
    name: string | null;
  };
}

async function callEdge(payload: Record<string, unknown>): Promise<EdgeResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData.session?.access_token;

  if (!jwt) throw new Error('You must be signed in to connect Facebook.');

  const { data, error } = await supabase.functions.invoke('facebook-oauth', {
    body: payload,
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (error) {
    const fnError = error as { message: string; name?: string; context?: Response };
    if (fnError.name === 'FunctionsFetchError' || !fnError.context) {
      throw new Error(
        'Could not reach the "facebook-oauth" Edge Function (network error).',
      );
    }
    const status = fnError.context.status;
    let detail = ` (HTTP ${status})`;
    try {
      const body = await fnError.context.clone().json();
      detail = ` (HTTP ${status}: ${body?.error ?? JSON.stringify(body)})`;
    } catch {
      // Non-JSON body
    }
    throw new Error(error.message + detail);
  }
  return (data ?? {}) as EdgeResult;
}

export const facebookService = {
  async startConnect(): Promise<void> {
    const state = crypto.randomUUID();
    sessionStorage.setItem(STATE_KEY, state);

    const result = await callEdge({
      action: 'start',
      redirect_uri: FACEBOOK_REDIRECT_URI,
      state,
    });

    if (!result.authorize_url) {
      throw new Error(result.error ?? 'Backend did not return an authorize URL.');
    }

    window.location.href = result.authorize_url;
  },

  wasCodeSent(code: string): boolean {
    try {
      return sessionStorage.getItem(CODE_SENT_KEY_PREFIX + code) !== null;
    } catch {
      return false;
    }
  },

  async handleCallback(code: string, state: string | null): Promise<EdgeResult> {
    if (this.wasCodeSent(code)) {
      const err = new Error(
        'This authorization code was already submitted. Start a new connection.',
      );
      err.name = 'CodeAlreadySent';
      throw err;
    }
    try {
      sessionStorage.setItem(CODE_SENT_KEY_PREFIX + code, '1');
    } catch {
      /* ignore storage errors */
    }

    const expectedState = sessionStorage.getItem(STATE_KEY);
    if (expectedState && state !== expectedState) {
      throw new Error('OAuth state mismatch — possible CSRF. Please retry.');
    }
    sessionStorage.removeItem(STATE_KEY);

    const result = await callEdge({
      action: 'callback',
      code,
      redirect_uri: FACEBOOK_REDIRECT_URI,
    });

    if (result.error) throw new Error(result.error);
    return result;
  },

  async selectPage(userAccessToken: string, pageId: string): Promise<EdgeResult> {
    const result = await callEdge({
      action: 'select_page',
      user_access_token: userAccessToken,
      page_id: pageId,
    });

    if (result.error) throw new Error(result.error);
    return result;
  },

  async getConnectedAccount(): Promise<SocialAccount | null> {
    const { data, error } = await supabase
      .from('social_accounts')
      .select('id, organization_id, platform, external_account_id, account_name')
      .eq('platform', 'facebook')
      .maybeSingle();

    if (error) throw new Error(error.message);
    return (data as SocialAccount) ?? null;
  },

  async disconnect(accountId: string): Promise<void> {
    const { error } = await supabase
      .from('social_accounts')
      .delete()
      .eq('id', accountId)
      .eq('platform', 'facebook');
    if (error) throw new Error(error.message);
  },
};
