import { supabase } from '@/utils/supabase';
import { SocialAccount } from '@/types';

/**
 * Client-side helper for the Instagram OAuth flow.
 *
 * IMPORTANT: this never sees an App Secret or an access token.
 * It only forwards the authorization `code` to the `instagram-oauth`
 * Edge Function, which performs the secret-bearing work server-side.
 */

const STATE_KEY = 'instagram_oauth_state';

/** The redirect URI registered in the Meta dashboard. Configured via .env. */
export const INSTAGRAM_REDIRECT_URI: string =
  import.meta.env.VITE_INSTAGRAM_REDIRECT_URI ?? '';

interface EdgeResult {
  ok?: boolean;
  error?: string;
  hint?: string;
  warning?: string | null;
  token_stored?: boolean;
  authorize_url?: string;
  account?: {
    id: string | null;
    external_account_id: string;
    username: string | null;
    account_type: string | null;
  };
}

async function callEdge(
  payload: Record<string, unknown>,
): Promise<EdgeResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData.session?.access_token;

  if (!jwt) throw new Error('You must be signed in to connect Instagram.');

  const { data, error } = await supabase.functions.invoke('instagram-oauth', {
    body: payload,
    headers: { Authorization: `Bearer ${jwt}` },
  });

  if (error) {
    const fnError = error as { message: string; name?: string; context?: Response };
    console.error('[instagramService] Edge Function error:', error);

    // `FunctionsFetchError` = the request never reached a server (network/
    // CORS/missing endpoint). It carries NO response, so `context` is absent.
    if (fnError.name === 'FunctionsFetchError' || !fnError.context) {
      throw new Error(
        'Could not reach the "instagram-oauth" Edge Function (network error). ' +
          'Most common causes: (1) the function is not deployed — run ' +
          '`supabase functions deploy instagram-oauth`; (2) CORS preflight blocked; ' +
          '(3) a browser extension/adblocker is blocking functions/v1. ' +
          'Check the Network tab for the failed request.',
      );
    }

    // `FunctionsHttpError` carries a Response with a real status + body.
    const status = fnError.context.status;
    let detail = ` (HTTP ${status})`;
    try {
      const body = await fnError.context.clone().json();
      detail = ` (HTTP ${status}: ${body?.error ?? JSON.stringify(body)})`;
    } catch {
      // Non-JSON body; keep the status-only detail.
    }

    if (status === 404) {
      throw new Error(
        'Edge Function "instagram-oauth" was not found — is it deployed? ' +
          'Run: `supabase functions deploy instagram-oauth`' + detail,
      );
    }
    if (status === 401 || status === 403) {
      throw new Error(
        'Edge Function rejected the request (auth). Your session may have expired — ' +
          'try signing in again.' + detail,
      );
    }
    throw new Error(error.message + detail);
  }
  return (data ?? {}) as EdgeResult;
}

export const instagramService = {
  /**
   * Ask the backend for the Instagram authorize URL, then navigate the user
   * there for login + consent.
   */
  async startConnect(): Promise<void> {
    if (!INSTAGRAM_REDIRECT_URI) {
      throw new Error(
        'VITE_INSTAGRAM_REDIRECT_URI is not set. Configure it in your .env and in the Meta dashboard.',
      );
    }

    const state = crypto.randomUUID();
    sessionStorage.setItem(STATE_KEY, state);

    const result = await callEdge({
      action: 'start',
      redirect_uri: INSTAGRAM_REDIRECT_URI,
      state,
    });

    if (!result.authorize_url) {
      throw new Error(result.error ?? 'Backend did not return an authorize URL.');
    }

    window.location.href = result.authorize_url;
  },

  /**
   * Verify the `state` echoed back by Instagram matches the one we stored,
   * then send the `code` to the backend for exchange + storage.
   */
  async handleCallback(code: string, state: string | null): Promise<EdgeResult> {
    const expectedState = sessionStorage.getItem(STATE_KEY);
    if (expectedState && state !== expectedState) {
      throw new Error('OAuth state mismatch — possible CSRF. Please retry.');
    }
    sessionStorage.removeItem(STATE_KEY);

    const result = await callEdge({
      action: 'callback',
      code,
      redirect_uri: INSTAGRAM_REDIRECT_URI,
    });

    if (result.error) throw new Error(result.error);
    return result;
  },

  /** Read the connected Instagram account for the current organization. */
  async getConnectedAccount(): Promise<SocialAccount | null> {
    const { data, error } = await supabase
      .from('social_accounts')
      .select('id, organization_id, platform, external_account_id, account_name')
      .eq('platform', 'instagram')
      .maybeSingle();

    if (error) throw new Error(error.message);
    return (data as SocialAccount) ?? null;
  },
};
