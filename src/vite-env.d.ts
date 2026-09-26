/// <reference types="vite/client" />

// Explicit typing for our public Vite env vars (see .env / .env.example).
// These are PUBLIC values only — never add secrets (App Secret, tokens) here.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** Must exactly match the OAuth redirect URI registered in the Meta dashboard. */
  readonly VITE_INSTAGRAM_REDIRECT_URI: string;
  /** Base URL of the AI backend (Render). No secrets — public URL only. */
  readonly VITE_AI_BACKEND_URL: string;
  /** Meta App ID. Public — used to init the Meta JavaScript SDK. */
  readonly VITE_FACEBOOK_APP_ID: string;
  /** Facebook Login for Business configuration ID driving Embedded Signup. */
  readonly VITE_FACEBOOK_CONFIG_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
