# instagram-oauth — Setup & Deployment Guide

Handles the **Instagram (Business) Login OAuth flow** for BOTD Social CRM.
It is the *only* place that sees the App Secret and the resulting access token.

> Scope of this function: **OAuth only**. No webhooks, no AI, no replies.
> The webhook handler stays in `bright-worker` and is untouched.

---

## What it does

Two POST actions (JSON body), both requiring the caller's Supabase JWT:

| Action     | Input                          | Output                                   |
|------------|--------------------------------|------------------------------------------|
| `start`    | `{ action:"start", redirect_uri, state }` | `{ authorize_url }`            |
| `callback` | `{ action:"callback", code, redirect_uri }` | `{ ok, account, token_stored }` |

Flow:
```
Browser → instagram-oauth (start)   → returns authorize_url
Browser → Instagram consent screen
Instagram → Redirect URI (?code=...&state=...)
Browser → instagram-oauth (callback) → exchanges code, fetches /me, upserts social_accounts
```

`organization_id` is **never** taken from the client — it is resolved from the
`organization_members` join table using the authenticated user's JWT
(`organization_members.organization_id` where `user_id = auth user`).
Multi-tenant safe. Note: there is **no** `organization_id` on `profiles`.

---

## 1. Supabase Secrets

Set in **Supabase Dashboard → Edge Functions → Secrets**
(or `supabase secrets set KEY=value`).

| Secret                   | Required | Value / Notes |
|--------------------------|----------|---------------|
| `INSTAGRAM_APP_ID`       | ✅       | Meta App ID |
| `INSTAGRAM_APP_SECRET`   | ✅       | Meta App Secret *(never in frontend / GitHub)* |
| `INSTAGRAM_LOGIN_MODE`   | ➖       | `instagram` (default) or `facebook` — see below |
| `INSTAGRAM_SCOPES`       | ➖       | Comma-separated. Default: `instagram_business_basic` |
| `SUPABASE_URL`           | auto     | Auto-set by Supabase runtime |
| `SUPABASE_ANON_KEY`      | auto     | Auto-set |
| `SUPABASE_SERVICE_ROLE_KEY` | auto  | Auto-set (used for the DB upsert) |

### Choosing `INSTAGRAM_LOGIN_MODE`

- **`instagram`** = *Instagram API with Instagram Login* (Instagram Business
  Login). Endpoints: `instagram.com/oauth/authorize`, `api.instagram.com/oauth/access_token`,
  `graph.instagram.com/me`. Default.
- **`facebook`** = *Facebook Login for Business* with Instagram Graph API.
  Endpoints: `facebook.com/v21.0/dialog/oauth`, `graph.facebook.com/v21.0/...`.

Pick the one matching how your Meta app is configured. Only the endpoint set changes.

---

## 2. Deploy the function

```bash
supabase link --project-ref exoajfewjydcgxsslswq
supabase functions deploy instagram-oauth
```

> **Do NOT** use `--no-verify-jwt` here. JWT verification stays ON so only
> logged-in users can call it (unlike the webhook, which Meta calls anonymously).

---

## 3. Meta Developer Dashboard

1. **Create / open your app** at https://developers.facebook.com/apps.
2. **Add the product** → *Instagram* → *API setup with Instagram login*
   (or *Facebook Login for Business* if using `facebook` mode).
3. **Add an Instagram Tester** (App roles → Roles → Instagram testers) and
   accept the invite from the Instagram account you want to connect.
   Required while the app is in Development mode.
4. **Valid OAuth Redirect URIs**: add the exact value of
   `VITE_INSTAGRAM_REDIRECT_URI`, e.g.
   `http://localhost:5173/integrations/instagram/callback`
   (and later your production URL).
5. Copy **App ID** and **App Secret** into Supabase Secrets (step 1).
6. Permissions/scopes: request `instagram_business_basic` (and, when you later
   add DM sending, `instagram_business_manage_messages`).

> ⚠️ The redirect URI must match **exactly** (scheme, host, port, path, no
> trailing slash mismatch). It is **not invented** here — set it in your `.env`
> and paste the same value into Meta.

---

## 4. `social_accounts` schema requirements

The function discovers which columns exist and writes only those, so it works
across migration states. For full functionality the table should have:

| Column (any one of the token pair) | Purpose |
|------------------------------------|---------|
| `organization_id`                  | tenant |
| `platform`                         | must be `'instagram'` |
| `external_account_id`              | Instagram user id |
| `account_name`                     | @username (optional) |
| `access_token` **or** `access_token_encrypted` | store the token |
| `token_expires_at`                 | optional expiry |
| `connected_at`                     | optional timestamp |

Plus a **unique constraint** so the upsert works:
```sql
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_org_platform_ext_key
  UNIQUE (organization_id, platform, external_account_id);
```

If no token column exists, the function still links the account (so the
webhook can attribute messages) and returns `token_stored: false` with a warning.

---

## 5. Testing step by step (Instagram Tester)

1. Set `VITE_INSTAGRAM_REDIRECT_URI` in `.env` and restart `npm run dev`.
2. Register the same URI in the Meta dashboard (step 3.4).
3. Log in to the app, go to **Settings → Social Integrations**.
4. Click **Connect Instagram**. You are redirected to Instagram.
5. Log in with the **Instagram Tester** account and approve.
6. Instagram redirects back to `/integrations/instagram/callback?code=...&state=...`.
7. The page calls the Edge Function, which stores the account.
   Success shows: `Connected @<username>`.
8. Verify in Supabase: `SELECT * FROM social_accounts WHERE platform = 'instagram';`

Troubleshooting:
- **`redirect_uri` mismatch** → the value in Meta ≠ `.env`. Make them identical.
- **`Invalid platform app` / API access blocked** → the account isn't an added
  Instagram Tester, or the app lacks the Instagram product.
- **`Unauthorized`** → you're not signed in (JWT missing/expired).
- **`no access_token column` warning** → add the token column (see step 4).

---

## 6. Migration path to Node/Express

Everything secret-bearing already lives on the server, so the swap is small:

| Supabase Edge Function                        | Node/Express equivalent |
|-----------------------------------------------|-------------------------|
| `instagram-oauth` `start` action              | `GET /api/integrations/instagram/start` |
| `instagram-oauth` `callback` action           | `GET /api/integrations/instagram/callback` |
| `Deno.env.get(...)`                           | `process.env.*` (dotenv) |
| `createClient(...).auth.getUser()` for JWT    | your auth middleware / session |
| `admin.from('social_accounts').upsert(...)`   | your DB query (Prisma/Knex/…) |
| `supabase.functions.invoke('instagram-oauth')`| `fetch('/api/integrations/instagram/...')` |

The `exchangeCodeForToken`, `fetchProfile`, and `buildSocialAccountRow` helpers
are pure functions and can be moved verbatim into an Express route/controller.
Only the auth resolution and DB layer change.
