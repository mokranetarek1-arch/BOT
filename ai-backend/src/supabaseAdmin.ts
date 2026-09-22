import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client with the SERVICE ROLE key.
 *
 * Used ONLY by the automatic background pipeline (POST /ai/webhook/message)
 * so it can read crm_custom_fields / messages and write insights, custom
 * values and contact updates without being blocked by RLS.
 *
 * The service role key bypasses Row Level Security — it must NEVER leave the
 * server: no logging, no responses, no client bundles.
 */
let adminClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (adminClient) return adminClient;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured for the automatic pipeline.',
    );
  }

  adminClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}
