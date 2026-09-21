-- ============================================================================
-- Migration: CRM Foundation Phase 1 (additive only, idempotent)
-- Target: public.contacts ONLY.
--
-- Purpose
--   Turn a messaging-only contact into a filterable CRM record by adding the
--   confirmed-identity fields and the CRM state fields. `contacts.notes` already
--   exists and is reused as-is.
--
-- Explicitly NOT in this migration
--   * no AI-enriched fields (intent / interests / needs / sentiment / summary)
--     -> planned as a separate opt-in table in a later phase
--   * no contacts.username, no contacts.display_name, no contacts.metadata
--     (the channel username already lives in contact_channels.username, and
--      IGSID already lives in contact_channels.external_user_id)
--   * no new tables (no customers / leads), no RLS changes, no trigger changes
--   * no changes to contact_channels, conversations, messages, social_accounts
--
-- Run in: Supabase Dashboard -> SQL Editor
-- Safe to run multiple times. No data is deleted or rewritten.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
--
-- Every new column is either nullable or NOT NULL *with* a DEFAULT, so existing
-- writers keep working untouched -- notably bright-worker's contact insert
-- ({ organization_id, name }) and its enrichment update ({ name: username }).
--
-- CHECK constraints live in section 2 because Postgres has no
-- "ADD CONSTRAINT IF NOT EXISTS".
-- ---------------------------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS phone           text,
  ADD COLUMN IF NOT EXISTS email           text,
  ADD COLUMN IF NOT EXISTS company         text,
  ADD COLUMN IF NOT EXISTS city            text,
  ADD COLUMN IF NOT EXISTS wilaya          text,
  ADD COLUMN IF NOT EXISTS country         text,
  ADD COLUMN IF NOT EXISTS source          text,
  ADD COLUMN IF NOT EXISTS lead_status     text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS customer_status text NOT NULL DEFAULT 'prospect',
  ADD COLUMN IF NOT EXISTS tags            text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_contact_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Allowed values for the two status columns
--
-- Guarded by an existence check on (constraint name + table), so re-running the
-- migration is a no-op instead of an error. Existing rows are all set to the
-- column DEFAULT ('new' / 'prospect'), therefore validation of the new
-- constraints cannot fail.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_lead_status_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_lead_status_check
      CHECK (lead_status IN ('new', 'contacted', 'qualified', 'won', 'lost'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contacts_customer_status_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_customer_status_check
      CHECK (customer_status IN ('prospect', 'active', 'inactive', 'blocked'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes that the CRM actually filters/sorts by
--
-- Each B-tree leads with organization_id (every query is tenant-scoped).
-- The tags GIN index is intentionally not org-prefixed: it serves containment
-- lookups (tags @> ARRAY['vip']) and is combined with the org predicate at
-- query time.
--
-- No index on organization_id alone is added: idx_contacts_org already exists.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_contacts_org_lead_status
  ON public.contacts (organization_id, lead_status);

CREATE INDEX IF NOT EXISTS idx_contacts_org_customer_status
  ON public.contacts (organization_id, customer_status);

CREATE INDEX IF NOT EXISTS idx_contacts_org_created_at
  ON public.contacts (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contacts_org_city
  ON public.contacts (organization_id, city);

CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin
  ON public.contacts USING gin (tags);
