-- ============================================================================
-- Migration: Dynamic Custom CRM Engine — schema + drift repair (idempotent).
-- Target tables: public.crm_custom_fields, public.contact_custom_values.
--
-- Why this file exists
--   The two tables were created directly in the SQL Editor with a reduced
--   schema, so the app failed with:
--     "column crm_custom_fields.updated_at does not exist"
--   This migration (1) documents the intended schema in version control and
--   (2) safely adds every missing column / constraint / policy / trigger to an
--   already-existing table. It never drops data.
--
-- Run in: Supabase Dashboard -> SQL Editor
-- Safe to run multiple times. No existing data is deleted or rewritten.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables (created only when missing)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_custom_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  field_name text NOT NULL,
  field_label text NOT NULL,
  field_type text NOT NULL DEFAULT 'text',
  options jsonb NULL,
  description_for_ai text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.contact_custom_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_custom_values_unique_contact UNIQUE (contact_id)
);

-- ---------------------------------------------------------------------------
-- 2. Drift repair — add any column missing on a pre-existing table.
--    ADD COLUMN IF NOT EXISTS is a no-op when the column is already there,
--    and adding NOT NULL + DEFAULT is safe on populated tables (PG 11+).
-- ---------------------------------------------------------------------------
ALTER TABLE public.crm_custom_fields
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS field_name text,
  ADD COLUMN IF NOT EXISTS field_label text,
  ADD COLUMN IF NOT EXISTS field_type text DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS options jsonb,
  ADD COLUMN IF NOT EXISTS description_for_ai text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.contact_custom_values
  ADD COLUMN IF NOT EXISTS contact_id uuid,
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS values jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- 3. Indexes (every lookup is tenant-scoped, so organization_id leads)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_crm_custom_fields_org
  ON public.crm_custom_fields (organization_id);

CREATE INDEX IF NOT EXISTS idx_contact_custom_values_org
  ON public.contact_custom_values (organization_id);

-- ---------------------------------------------------------------------------
-- 4. Constraints — each one is added only when missing AND only when the
--    existing data satisfies it (otherwise a NOTICE is raised and the
--    constraint is skipped). The migration therefore never aborts on a table
--    that already contains rows.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_custom_fields_type_check') THEN
    BEGIN
      ALTER TABLE public.crm_custom_fields
        ADD CONSTRAINT crm_custom_fields_type_check
        CHECK (field_type IN ('text', 'number', 'select', 'phone', 'date'));
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Skipped crm_custom_fields_type_check: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_custom_fields_name_check') THEN
    BEGIN
      ALTER TABLE public.crm_custom_fields
        ADD CONSTRAINT crm_custom_fields_name_check
        CHECK (field_name ~ '^[a-z0-9_]+$');
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Skipped crm_custom_fields_name_check: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_custom_fields_options_check') THEN
    BEGIN
      ALTER TABLE public.crm_custom_fields
        ADD CONSTRAINT crm_custom_fields_options_check
        CHECK (
          (field_type = 'select' AND options IS NOT NULL AND jsonb_typeof(options) = 'array')
          OR (field_type <> 'select' AND options IS NULL)
        );
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Skipped crm_custom_fields_options_check: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_custom_fields_unique_name') THEN
    BEGIN
      ALTER TABLE public.crm_custom_fields
        ADD CONSTRAINT crm_custom_fields_unique_name UNIQUE (organization_id, field_name);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Skipped crm_custom_fields_unique_name: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_custom_values_unique_contact') THEN
    BEGIN
      ALTER TABLE public.contact_custom_values
        ADD CONSTRAINT contact_custom_values_unique_contact UNIQUE (contact_id);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Skipped contact_custom_values_unique_contact: %', SQLERRM;
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. RLS — same tenant-isolation pattern as contact_ai_insights: a member only
--    sees/writes rows whose organization_id matches their own membership.
--    The frontend never uses the service role.
-- ---------------------------------------------------------------------------
ALTER TABLE public.crm_custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_custom_values ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.crm_custom_fields TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.contact_custom_values TO authenticated;

-- ---- crm_custom_fields ----
DROP POLICY IF EXISTS crm_custom_fields_select ON public.crm_custom_fields;
CREATE POLICY crm_custom_fields_select
  ON public.crm_custom_fields FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = crm_custom_fields.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS crm_custom_fields_insert ON public.crm_custom_fields;
CREATE POLICY crm_custom_fields_insert
  ON public.crm_custom_fields FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = crm_custom_fields.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS crm_custom_fields_update ON public.crm_custom_fields;
CREATE POLICY crm_custom_fields_update
  ON public.crm_custom_fields FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = crm_custom_fields.organization_id
        AND om.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = crm_custom_fields.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS crm_custom_fields_delete ON public.crm_custom_fields;
CREATE POLICY crm_custom_fields_delete
  ON public.crm_custom_fields FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = crm_custom_fields.organization_id
        AND om.user_id = auth.uid()
    )
  );

-- ---- contact_custom_values ----
DROP POLICY IF EXISTS contact_custom_values_select ON public.contact_custom_values;
CREATE POLICY contact_custom_values_select
  ON public.contact_custom_values FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_custom_values.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS contact_custom_values_insert ON public.contact_custom_values;
CREATE POLICY contact_custom_values_insert
  ON public.contact_custom_values FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_custom_values.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS contact_custom_values_update ON public.contact_custom_values;
CREATE POLICY contact_custom_values_update
  ON public.contact_custom_values FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_custom_values.organization_id
        AND om.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_custom_values.organization_id
        AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS contact_custom_values_delete ON public.contact_custom_values;
CREATE POLICY contact_custom_values_delete
  ON public.contact_custom_values FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.organization_id = contact_custom_values.organization_id
        AND om.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 6. updated_at maintenance — reuses public.set_updated_at when it exists
--    (created by the contact_ai_insights migration) and creates it only when
--    missing. Triggers are added once and skipped afterwards.
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
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_crm_custom_fields_updated_at') THEN
    CREATE TRIGGER set_crm_custom_fields_updated_at
      BEFORE UPDATE ON public.crm_custom_fields
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_contact_custom_values_updated_at') THEN
    CREATE TRIGGER set_contact_custom_values_updated_at
      BEFORE UPDATE ON public.contact_custom_values
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;
