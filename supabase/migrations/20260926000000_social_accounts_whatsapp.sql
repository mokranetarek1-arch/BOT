-- ============================================================================
-- Migration: WhatsApp Business Account on public.social_accounts
-- (additive only, idempotent)
--
-- Why this exists
--   Embedded Signup hands the backend a WABA id and a Phone Number ID, but
--   `social_accounts` had nowhere to keep the WABA, the customer-facing phone
--   number, the verified business name, or a connection state. Without them the
--   Settings UI could only show a raw Phone Number ID, could not tell a
--   connected account from a disconnected one, and Disconnect had to DELETE the
--   row — which risks cascading onto conversations and destroying history.
--
-- No new tables. Instagram and Facebook are untouched: every column is
-- nullable, or NOT NULL *with* a DEFAULT, so existing rows and writers keep
-- working exactly as before.
--
-- Column mapping (NO new tables, NO new concepts):
--   organization_id   -> organization_id     (already exists, unchanged)
--   platform          -> platform            (already exists, value 'whatsapp')
--   Phone Number ID   -> external_account_id (already exists; bright-worker and
--                                             send-message already key on it)
--   Business Account  -> waba_id             (new)
--   phone number      -> phone_number        (new)
--   display name      -> display_name        (new)
--   connection status -> is_active           (new)
--   token             -> access_token / access_token_encrypted (already exists,
--                                             never selected by the frontend)
--   timestamps        -> connected_at        (new, additive)
--
-- Explicitly NOT in this migration
--   * no DROP TABLE / DROP COLUMN / DELETE / TRUNCATE
--   * no change to the organization model or organization_members
--   * no RLS change, no policy dropped, no RLS disabled
--   * no WhatsApp-specific contacts / conversations / messages tables
--   * no WhatsApp-specific AI or CRM fields (the shared AI pipeline is reused)
--
-- Run in: Supabase Dashboard -> SQL Editor (or `supabase db push`)
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Additive columns
--
-- `is_active` defaults to TRUE, so the Instagram / Facebook rows that already
-- exist are by definition active and keep working with no backfill.
-- ---------------------------------------------------------------------------
ALTER TABLE public.social_accounts
  ADD COLUMN IF NOT EXISTS waba_id        text,
  ADD COLUMN IF NOT EXISTS phone_number   text,
  ADD COLUMN IF NOT EXISTS display_name   text,
  ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS connected_at   timestamptz;


-- ---------------------------------------------------------------------------
-- 2. Unique key required by the server-side upsert
--
-- `facebook-oauth` and `instagram-oauth` upsert with
--   onConflict: 'organization_id,platform,external_account_id'
-- which PostgREST resolves to a UNIQUE constraint. Without it the connect call
-- fails with 42P10, so existing rows are checked first: if duplicates already
-- exist the constraint is skipped with a NOTICE instead of aborting the whole
-- migration (de-duplicate by hand, then re-run).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dupes bigint;
BEGIN
  SELECT count(*) INTO dupes
  FROM (
    SELECT 1
    FROM public.social_accounts
    WHERE organization_id IS NOT NULL
      AND platform         IS NOT NULL
      AND external_account_id IS NOT NULL
    GROUP BY organization_id, platform, external_account_id
    HAVING count(*) > 1
  ) duplicated;

  IF dupes > 0 THEN
    RAISE NOTICE
      'social_accounts: % duplicated (organization_id, platform, external_account_id) group(s). Constraint NOT added — de-duplicate first, then re-run this migration.',
      dupes;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname   = 'social_accounts_org_platform_ext_key'
      AND conrelid = 'public.social_accounts'::regclass
  ) THEN
    ALTER TABLE public.social_accounts
      ADD CONSTRAINT social_accounts_org_platform_ext_key
      UNIQUE (organization_id, platform, external_account_id);
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 3. Index for the inbound webhook lookup
--
-- bright-worker resolves every inbound event with
--   WHERE external_account_id = <phone_number_id> AND platform = <channel>
-- (service role). Instagram / Facebook do the same lookup with their IGSID /
-- Page ID, so this index serves all three channels — it is not WhatsApp-only.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_social_accounts_platform_external
  ON public.social_accounts (platform, external_account_id);


-- ---------------------------------------------------------------------------
-- DISCONNECT (design note, not executable SQL)
--
-- Disconnecting sets `is_active = false`; it NEVER deletes the row, and this
-- migration adds no cascading delete. That matters because
-- conversations.social_account_id points at this table: deleting the row could
-- cascade onto conversations and their messages, destroying the historical CRM
-- data. Soft-disconnect keeps contacts, conversations, messages and every
-- AI-extracted CRM field exactly as they are.
--
-- MULTI-TENANT SECURITY (verify after running this migration)
--
-- WhatsApp is stored in the SAME RLS-protected table as Instagram/Facebook, so
-- it inherits their isolation. Confirm the existing policies scope every
-- command through `organization_members` — this migration does not create,
-- weaken or replace them. Expected result for this query, run as a user of
-- organization A while owning no membership in organization B: zero rows.
--
--   SELECT id, platform, external_account_id
--   FROM public.social_accounts
--   WHERE organization_id = '<organization B id>';
--
-- If that returns rows, the pre-existing policies are the problem (not this
-- migration) and must be tightened to the organization_members pattern already
-- used elsewhere in the project.
-- ============================================================================
-- AFTER RUNNING THIS MIGRATION — required Meta Dashboard configuration
-- ============================================================================
-- These steps are NOT automated by this file. Nothing in BOTD can substitute
-- for them, and until they are done the connect flow fails at the Meta API
-- with a real error (the UI surfaces it verbatim — it is never faked as
-- "Connected").
--
-- 1. Add the WhatsApp product
--    developers.facebook.com > your app > Add Product > WhatsApp
--
-- 2. Use the WhatsApp API (Cloud API) tier — Embedded Signup onboards Cloud
--    API numbers, not the separate "WhatsApp Business Platform" app.
--
-- 3. Permissions to request in App Review (Live mode)
--    - whatsapp_business_management   (read/manage the WABA and its numbers)
--    - whatsapp_business_messaging   (send and receive customer messages)
--    The app already requests business_management / pages_messaging for
--    Facebook, so this adds only the two WhatsApp-scoped permissions. No
--    generic public_profile or extra scopes are needed for messaging.
--
-- 4. Embedded Signup configuration
--    Facebook Login for Business > Configurations > create a configuration of
--    type "WhatsApp Embedded Signup", then put its Configuration ID in
--    VITE_FACEBOOK_CONFIG_ID (frontend) — the only public value the browser
--    needs. The App ID goes in VITE_FACEBOOK_APP_ID / src/config/metaPublic.ts.
--    Set Settings > Basic > App domains to your frontend host, otherwise the
--    dialog refuses to mount.
--
-- 5. Webhook
--    App Dashboard > Webhooks > Callback URL:
--      https://<project-ref>.supabase.co/functions/v1/bright-worker
--    Verify token: the META_VERIFY_TOKEN Supabase secret (any value you choose;
--    it must match exactly on both sides).
--    The WABA's /subscribed_apps is called automatically by the connect flow,
--    but the app-level webhook in this dashboard must still exist and must
--    list `whatsapp_business_account` among the subscribed fields.
--
-- 6. Supabase secrets (server-side only — never in VITE_ variables or Git)
--      supabase secrets set META_APP_ID=<app id> \
--        META_APP_SECRET=<app secret> \
--        META_VERIFY_TOKEN=<verify token>
--    META_APP_SECRET is only ever read inside the Edge Function. It is never
--    sent to the browser, and access tokens are never logged.
--
-- 7. Business verification
--    A WABA owned by an unverified business runs in a restricted mode
--    (limited to numbers owned by the app). To message arbitrary customers,
--    complete Meta's Business Verification and `account_review_status` must
--    show APPROVED. This is an external, manual, per-business step.
-- ============================================================================
