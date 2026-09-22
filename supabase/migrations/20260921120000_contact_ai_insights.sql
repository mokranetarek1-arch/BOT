-- ============================================================================
-- Migration: AI Customer Intelligence — Step 0 (structure only, zero AI calls)
-- Target: new table public.contact_ai_insights ONLY.
--
-- Purpose
--   Provide the storage + read path the AI will use later, without any LLM,
--   API key, Edge Function, prompt, or analysis. The frontend reads through
--   RLS; a future server-side analyzer will write with the service role.
--
-- Explicitly NOT in this migration
--   * no changes to contacts / contact_channels / conversations / messages
--   * no AI-enriched columns on contacts (inference must never mix with
--     confirmed facts — see the Contact docs in src/types/index.ts)
--   * no provider, key, function, chatbot, auto-reply, or scraping
--
-- Run in: Supabase Dashboard -> SQL Editor
-- Safe to run multiple times. No data is deleted or rewritten.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table
--
-- contact_id is the permanent anchor: a contact can own many conversations
-- across Instagram / Facebook / WhatsApp, and insights stay attached to the
-- contact. conversation_id is NULL for contact-level rollups and set for
-- per-conversation insights.
--
-- UNIQUE note: Postgres treats NULLs as distinct, so contact-level rows
-- (conversation_id IS NULL) are NOT deduplicated by the unique constraint.
-- Left as-is per the approved scope; a partial unique index for the NULL
-- case can be added later if needed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  insight_type text NOT NULL,
  value jsonb NOT NULL,
  confidence numeric NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  source_message_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_ai_insights_type_check
    CHECK (insight_type IN (
      'intent', 'interests', 'needs',
      'buying_timeframe', 'sentiment', 'summary'
    )),
  CONSTRAINT contact_ai_insights_unique
    UNIQUE (organization_id, contact_id, conversation_id, insight_type, prompt_version)
);

-- ---------------------------------------------------------------------------
-- 2. Indexes (every lookup is tenant-scoped, so organization_id leads)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_contact_ai_insights_org_contact
  ON public.contact_ai_insights (organization_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_ai_insights_org_conversation
  ON public.contact_ai_insights (organization_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_contact_ai_insights_org_type
  ON public.contact_ai_insights (organization_id, insight_type);
-- ---------------------------------------------------------------------------
-- 3. RLS — same tenant-isolation pattern as contacts / conversations.
--
-- A member only sees rows whose organization_id matches their own membership:
--   organization_members.organization_id = contact_ai_insights.organization_id
--   AND organization_members.user_id = auth.uid()
-- The frontend never uses the service role; the future server-side analyzer
-- will bypass RLS with it when writing.
-- ---------------------------------------------------------------------------
ALTER TABLE public.contact_ai_insights ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.contact_ai_insights TO authenticated;

DROP POLICY IF EXISTS contact_ai_insights_select ON public.contact_ai_insights;
CREATE POLICY contact_ai_insights_select
  ON public.contact_ai_insights FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_ai_insights.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS contact_ai_insights_insert ON public.contact_ai_insights;
CREATE POLICY contact_ai_insights_insert
  ON public.contact_ai_insights FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_ai_insights.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS contact_ai_insights_update ON public.contact_ai_insights;
CREATE POLICY contact_ai_insights_update
  ON public.contact_ai_insights FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_ai_insights.organization_id
        AND om.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_ai_insights.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS contact_ai_insights_delete ON public.contact_ai_insights;
CREATE POLICY contact_ai_insights_delete
  ON public.contact_ai_insights FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_ai_insights.organization_id
        AND om.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 4. updated_at
--
-- No set_updated_at-style function was found anywhere in the repo (the trigger
-- bodies live outside version control), so this reuses the existing function
-- when it is present and creates the standard one only when it is missing —
-- never overwriting anything. The trigger name follows the
-- set_<table>_updated_at convention.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_updated_at'
  ) THEN
    CREATE FUNCTION public.set_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END
      $fn$;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'set_contact_ai_insights_updated_at'
  ) THEN
    CREATE TRIGGER set_contact_ai_insights_updated_at
      BEFORE UPDATE ON public.contact_ai_insights
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

