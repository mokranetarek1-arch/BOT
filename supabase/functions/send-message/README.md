# send-message — Deployment Guide

Sends **outbound Instagram DMs** from the BOTD Inbox (replies).

It is the *only* place that uses the stored Instagram access token to SEND. The
token never reaches the browser: the frontend calls this function with the
user's Supabase JWT, the function resolves the tenant server-side, reads the
token with the service role and calls the Meta Graph API.

## What it does

1. Verifies the caller's Supabase JWT (only logged-in users may send).
2. Resolves the organization from `organization_members` — never from the request body.
3. Loads the conversation, scoped to that organization (`id` + `organization_id`).
4. Resolves the recipient IGSID from `contact_channels.external_user_id`.
5. Checks Meta's 24-hour reply window.
6. Reads the access token from `social_accounts` (service role only).
7. Sends with `POST {graph}/{ig-id}/messages`.
8. Stores the outbound row in `messages` (`direction = 'outbound'`) and bumps
   `conversations.last_message_at`.

## Required Supabase Secrets

Set in: **Supabase Dashboard → Edge Functions → Secrets**

| Secret Key | Value |
|------------|-------|
| `INSTAGRAM_LOGIN_MODE` | `instagram` (default) or `facebook` — must match `instagram-oauth` |
| `SUPABASE_URL` | Auto-set by the Supabase runtime |
| `SUPABASE_ANON_KEY` | Auto-set |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-set (used to read the token) |

No App Secret and no new secret are needed: the access token already stored by
`instagram-oauth` is reused.

## Deploy the function

```bash
supabase functions deploy send-message --project-ref exoajfewjydcgxsslswq
```

> **JWT verification MUST stay ENABLED here.** Do NOT pass `--no-verify-jwt`:
> unlike `bright-worker` (called by Meta without a token), this endpoint is
> called by logged-in users only.

## No SQL migration needed

`messages` already has what is required (`direction`, `external_message_id`,
`sender_external_id`, `channel`), and `social_accounts` must already hold the
token (see `supabase/functions/instagram-oauth/README.md`, step 4). Nothing to
run in the SQL Editor.

## Request / response

POST JSON (called from the frontend by
`conversationService.sendMessage` → `supabase.functions.invoke('send-message', …)`):

```json
{ "conversation_id": "<uuid>", "text": "Bonjour !" }
```

Success:

```json
{
  "ok": true,
  "recipient_id": "<IGSID>",
  "message": { "id": "…", "direction": "outbound", "message_text": "Bonjour !", … }
}
```

A `warning` field is added when the DM was sent but could not be stored locally.

## Errors

| HTTP | Meaning | What to do |
|------|---------|------------|
| 400 | missing `conversation_id`, empty text, text > 1000 chars, or a non-Instagram channel | fix the request |
| 401 | not signed in, or Meta rejected the token (code 190) | sign in again / reconnect Instagram |
| 403 | Meta refused the message — missing permission (code 200) | reconnect Instagram so the scopes are granted |
| 404 | conversation or social account not found | check the conversation / reconnect Instagram |
| 409 | 24-hour reply window closed (Meta code 10) | wait for the customer to write again |
| 422 | the customer IGSID could not be resolved | the contact has no Instagram channel row |
| 502 / 504 | Graph unreachable or timed out | check the Edge Function logs |
| 500 | `social_accounts` has no token column | add it, then reconnect Instagram |

## Troubleshooting

- **`Edge Function "send-message" was not found`** in the UI → not deployed; run the deploy command above.
- **`No Instagram access token stored`** → the token column was missing during OAuth, or the token was revoked. Reconnect Instagram in Settings.
- **`the 24-hour reply window has closed`** → Meta's rule, not a bug. The customer must write again first.
- **`could not be stored locally`** → the DM did leave Instagram, but the `messages`
  insert failed. Check the logs for the Postgres error.
