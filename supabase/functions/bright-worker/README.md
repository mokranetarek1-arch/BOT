# bright-worker — Deployment Guide

## What this function does
Handles Meta Webhook events (GET verification + POST messages) for:
- ✅ Instagram DMs (`object: "instagram"`)
- ✅ Facebook Messenger (`object: "page"`)
- ✅ WhatsApp Business Cloud API (`object: "whatsapp_business_account"`)

All three channels share ONE pipeline. `parseWhatsAppEvent` only translates the
Cloud API payload into the same `NormalizedEvent` shape as the other two, after
which the contact / conversation / message / AI-CRM steps are channel-agnostic
and reuse the existing tables. There is no WhatsApp-specific table, pipeline or
AI field.

## Required Supabase Secrets
Set these in: **Supabase Dashboard → Edge Functions → Secrets**

| Secret Key                | Value                                       |
|---------------------------|---------------------------------------------|
| `META_VERIFY_TOKEN`       | Your Meta webhook verify token (already set)|
| `SUPABASE_URL`            | Auto-set by Supabase runtime                |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set by Supabase runtime              |
| `DEFAULT_ORGANIZATION_ID` | UUID of your organization (from Supabase)   |
| `AI_BACKEND_URL`          | Optional — enables automatic AI CRM extraction |
| `AI_BACKEND_WEBHOOK_SECRET` | Optional — must match the AI backend secret |

> `DEFAULT_ORGANIZATION_ID` is only a fallback for raw events that cannot be
> attributed to any connected account. Real attribution always comes from
> `social_accounts.organization_id`, so messages are never filed under the
> wrong tenant.

## Deploy the function

### Option A: Supabase CLI (recommended)
```bash
# Install Supabase CLI if not already installed
npm install -g supabase

# Login
supabase login

# Link to your project
supabase link --project-ref exoajfewjydcgxsslswq

# Deploy bright-worker
supabase functions deploy bright-worker --no-verify-jwt
```

> **`--no-verify-jwt`** is required because Meta calls this endpoint without a Supabase JWT token.

### Option B: Supabase Dashboard
1. Go to **Edge Functions** in the Supabase Dashboard
2. Create a new function called `bright-worker`
3. Paste the contents of `supabase/functions/bright-worker/index.ts`

## After deploying

### Step 1: Run the SQL migration
Open `supabase_multichannel_migration.sql` and paste it into the **Supabase SQL Editor** and run it.

### Step 2: Insert your social account
```sql
-- Find your organization ID first
SELECT id, name FROM public.organizations LIMIT 5;

-- Insert your Instagram account
-- Replace the placeholders with your actual values
INSERT INTO public.social_accounts 
  (organization_id, platform, external_account_id, account_name)
VALUES 
  ('<your-org-uuid>', 'instagram', '<your-ig-page-id>', 'My Instagram Account');
```

> Your Instagram Page ID is visible in the Meta Developer App dashboard under the Instagram account settings.

### Step 3: Add DEFAULT_ORGANIZATION_ID secret
Add `DEFAULT_ORGANIZATION_ID = <your-org-uuid>` to Edge Function Secrets.

### Step 4: Verify webhook
Meta webhook URL: `https://exoajfewjydcgxsslswq.supabase.co/functions/v1/bright-worker`

Use the Meta Developer Dashboard → Webhooks → Test to send a test POST.
Check Supabase Edge Function logs for `✅ Event persisted successfully`.

## Data flow (identical for all three channels)

```
Customer DM on Instagram / Facebook / WhatsApp
    ↓
Meta sends POST to bright-worker
    ↓
parseInstagramEvent() | parseFacebookEvent() | parseWhatsAppEvent()
    ↓              → one NormalizedEvent per message
    ↓
Look up social_accounts by external_account_id + platform
    ↓  (Instagram: IGSID | Facebook: Page ID | WhatsApp: Phone Number ID)
    ↓  organization_id comes from THAT row — never from the request
    ↓
Find or create: contacts + contact_channels   (channel = instagram|facebook|whatsapp)
    ↓
Find or create: conversations
    ↓
Insert: messages (deduplicated via external_message_id, direction = inbound)
    ↓
Insert: raw_webhook_events (for debugging)
    ↓
Best-effort identity enrichment (Instagram/Messenger only — WhatsApp already
carries contacts[].profile.name in the payload)
    ↓
Fire-and-forget → AI backend → existing CRM fields
```

### WhatsApp specifics

- **Attribution key** is `metadata.phone_number_id`, stored as
  `social_accounts.external_account_id` with `platform = 'whatsapp'`.
- **Contact identity** is the sender's `wa_id` (their phone number), stored in
  `contact_channels.external_user_id`. There is no username on WhatsApp, so the
  webhook's `contacts[].profile.name` is used as the display name when the
  contact name is still a technical placeholder.
- **Idempotency** is the same `external_message_id` unique constraint used by
  the other channels; a redelivery is logged as `MESSAGE_DUPLICATE_SKIPPED`.
- **Message types** mapped: `text`, `image`, `video`, `audio`, `document`,
  `location`, `contacts`, `interactive`; anything else is stored as
  `unsupported` with its raw payload preserved.
- A disconnected account (`is_active = false`) is hidden from the Settings UI and
  no longer attributes messages to a *new* tenant, but the inbound lookup in
  `persistEvent` still matches on `external_account_id` + `platform` only. A
  number that is unlinked while Meta keeps delivering its webhooks will
  therefore still land in the same (correct) organization. The side effect is
  that those conversations keep accruing until the Meta webhook is unsubscribed;
  no cross-tenant leak is possible, because the organization still comes from
  that same row. Filtering on `is_active` here is a one-line follow-up.

