/**
 * Meta JavaScript SDK loader + Embedded Signup launcher (WhatsApp).
 *
 * Embedded Signup is the only Meta flow that returns a WhatsApp phone number
 * and a business token without the user pasting an ID or a token into a form.
 * It REQUIRES the JS SDK (unlike the Instagram/Facebook flows in this app,
 * which are plain OAuth redirects and load no script).
 *
 * This module never sees an App Secret: it returns a short-lived `code` that
 * the `facebook-oauth` Edge Function exchanges server-side. That code has a
 * ~30 second TTL, so callers must forward it immediately.
 */

/** Graph API version shared with the server-side calls. */
const GRAPH_VERSION = 'v22.0';
const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';

export interface EmbeddedSignupResult {
  /** Exchangeable token code. ~30 second TTL — send it immediately. */
  code: string;
  /** WABA (WhatsApp Business Account) ID, when Meta returns one. */
  whatsappBusinessId?: string;
  /** Business phone number ID, when Meta returns one. */
  phoneNumberId?: string;
}

interface FBResponse {
  status?: string;
  authResponse?: {
    code?: string;
    accessToken?: string;
    whatsappBusinessId?: string;
    phoneNumberId?: string;
  };
}

type FBApi = {
  init: (options: { xfbml?: boolean; version: string }) => void;
  login: (
    callback: (response: FBResponse) => void,
    options?: Record<string, unknown>,
  ) => void;
};

declare global {
  interface Window {
    FB?: FBApi;
    fbAsyncInit?: () => void;
  }
}

let sdkPromise: Promise<void> | null = null;

/** Loads the Meta JS SDK exactly once and resolves once FB is initialised. */
export function loadFacebookSdk(): Promise<void> {
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    // The SDK mounts its dialog into #fb-root, declared in index.html.
    if (document.getElementById('fb-root') === null) {
      const root = document.createElement('div');
      root.id = 'fb-root';
      document.body.appendChild(root);
    }

    if (window.FB) {
      window.FB.init({ xfbml: false, version: GRAPH_VERSION });
      resolve();
      return;
    }

    window.fbAsyncInit = () => {
      window.FB?.init({ xfbml: false, version: GRAPH_VERSION });
      resolve();
    };

    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.src = SDK_SRC;
    script.onerror = () => {
      sdkPromise = null;
      reject(
        new Error(
          'Could not load the Meta JavaScript SDK. Check your connection and any ad blocker, then retry.',
        ),
      );
    };
    document.body.appendChild(script);
  });

  return sdkPromise;
}

/**
 * Opens the Meta Embedded Signup dialog and resolves with the exchangeable
 * code once the user has finished onboarding their WhatsApp number.
 *
 * Rejects with a "cancelled" error when the user simply closes the dialog so
 * callers can stay silent instead of showing a scary message.
 */
export async function launchWhatsAppEmbeddedSignup(): Promise<EmbeddedSignupResult> {
  const appId = import.meta.env.VITE_FACEBOOK_APP_ID;
  const configId = import.meta.env.VITE_FACEBOOK_CONFIG_ID;

  if (!appId) {
    throw new Error(
      'VITE_FACEBOOK_APP_ID is missing. Add your Meta App ID to the .env file and restart the dev server.',
    );
  }
  if (!configId) {
    throw new Error(
      'VITE_FACEBOOK_CONFIG_ID is missing. Create a "WhatsApp Embedded Signup" configuration in the Meta dashboard (Facebook Login for Business > Configurations) and add its ID to the .env file.',
    );
  }

  await loadFacebookSdk();
  const FB = window.FB;
  if (!FB) throw new Error('The Meta JavaScript SDK failed to initialise.');

  return new Promise<EmbeddedSignupResult>((resolve, reject) => {
    FB.login(
      (response) => {
        const auth = response.authResponse;

        if (auth?.code) {
          resolve({
            code: auth.code,
            whatsappBusinessId: auth.whatsappBusinessId,
            phoneNumberId: auth.phoneNumberId,
          });
          return;
        }

        if (response.status === 'unknown') {
          reject(
            new Error(
              'Meta could not complete the sign-up. Check that Embedded Signup is enabled for this app and that the app is in Live mode.',
            ),
          );
          return;
        }

        // No code and no error status === the user closed the dialog.
        reject(new Error('Sign-up cancelled.'));
      },
      {
        // NOTE: no `scope` here. When `config_id` is used, the requested
        // permissions come from the Facebook Login for Business configuration
        // itself; passing an explicit scope here makes the login fail.
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} },
      },
    );
  });
}