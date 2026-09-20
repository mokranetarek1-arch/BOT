# bright-worker — Deployment Guide

## What this function does
Handles Meta Webhook events (GET verification + POST messages) for:
- ✅ Instagram DMs (`object: "instagram"`)
- 🔜 Facebook Messenger (`object: "page"`) — parser is ready, enable when the Meta app is extended

## Required Supabase Secrets
Set these in: **Supabase Dashboard → Edge Functions → Secrets**

| Secret Key                | Value                                       |
|---------------------------|---------------------------------------------|
| `META_VERIFY_TOKEN`       | Your Meta webhook verify token (already set)|
| `SUPABASE_URL`            | Auto-set by Supabase runtime                |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set by Supabase runtime              |
| `DEFAULT_ORGANIZATION_ID` | UUID of your organization (from Supabase)   |

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

## Data flow (Instagram)

```
Instagram DM (phone)
    ↓
Meta sends POST to bright-worker
    ↓
parseInstagramEvent() → NormalizedEvent
    ↓
Look up social_accounts by external_account_id
    ↓
Find or create: contacts + contact_channels
    ↓
Find or create: conversations
    ↓
Insert: messages (deduplicated via external_message_id)
    ↓
Insert: raw_webhook_events (for debugging)
```

