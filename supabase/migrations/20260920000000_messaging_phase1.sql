-- ============================================================================
-- Migration: Instagram messaging Phase 1 (minimal, additive, idempotent)
-- Adds ONLY optional columns to public.messages. No tables, policies, or
-- data are changed or removed.
-- Run in: Supabase Dashboard → SQL Editor
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS channel     text,
  ADD COLUMN IF NOT EXISTS direction   text NOT NULL DEFAULT 'inbound',
  ADD COLUMN IF NOT EXISTS attachments jsonb;

-- Backfill: existing inbound messages inherit the channel of their conversation
UPDATE public.messages m
SET channel = c.channel
FROM public.conversations c
WHERE m.conversation_id = c.id
  AND m.channel IS NULL;
