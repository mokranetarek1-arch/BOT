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

import { META_PUBLIC } from '../config/metaPublic';

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
  init: (options: { xfbml?: boolean; version: string; appId?: string }) => void;
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

  const { appId } = META_PUBLIC;
  // The SDK discovers the app through the script URL fragment, the
  // data-app-id attribute or FB.init(). We set all three so it resolves the
  // app whichever one it looks at first.
  const initOptions = { xfbml: false, version: GRAPH_VERSION, appId };

  sdkPromise = new Promise<void>((resolve, reject) => {
    // The SDK mounts its dialog into #fb-root, declared in index.html.
    const root =
      document.getElementById('fb-root') ??
      Object.assign(document.createElement('div'), { id: 'fb-root' });
    if (root.parentNode === null) document.body.appendChild(root);
    if (appId) root.setAttribute('data-app-id', appId);

    if (window.FB) {
      window.FB.init(initOptions);
      resolve();
      return;
    }

    window.fbAsyncInit = () => {
      window.FB?.init(initOptions);
      resolve();
    };

    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.src = appId
      ? `${SDK_SRC}#xfbml=false&version=${GRAPH_VERSION}&appId=${appId}`
      : SDK_SRC;
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
  // Falls back to the committed public values in src/config/metaPublic.ts.
  const { appId, configId } = META_PUBLIC;

  if (!appId) {
    throw new Error(
      'No Meta App ID is configured. Set VITE_FACEBOOK_APP_ID or META_APP_ID in src/config/metaPublic.ts.',
    );
  }
  if (!configId) {
    throw new Error(
      'No Facebook Login for Business configuration ID is set. Create a "WhatsApp Embedded Signup" configuration in the Meta dashboard, then set VITE_FACEBOOK_CONFIG_ID or META_CONFIG_ID.',
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