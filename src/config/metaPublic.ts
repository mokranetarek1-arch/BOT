/**
 * Public Meta identifiers.
 *
 * SECURITY: these are NOT secrets. The Meta JavaScript SDK requires the App ID
 * to be present in client-side code, and the configuration ID is just a
 * reference to a server-side Login for Business configuration. The only secret
 * involved is the App Secret, which stays in Supabase secrets and is never
 * read by the browser.
 *
 * They are committed here so that deployments without a local `.env` (CI,
 * hosting platforms) still boot. A `VITE_*` env var always wins when set,
 * which lets you point a build at a different Meta app.
 */

export const META_APP_ID = '1750024546231887';

/** Facebook Login for Business > Configurations > WhatsApp Embedded Signup. */
export const META_CONFIG_ID = '1389746773328124';

/** Resolved values, preferring the environment when it is configured. */
export const META_PUBLIC = {
  appId: import.meta.env.VITE_FACEBOOK_APP_ID || META_APP_ID,
  configId: import.meta.env.VITE_FACEBOOK_CONFIG_ID || META_CONFIG_ID,
};
