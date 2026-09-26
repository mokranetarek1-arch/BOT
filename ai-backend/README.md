# BOTD AI Backend

Minimal, independent Node.js/TypeScript/Express backend for testing Gemini API
connectivity. Fully self-contained inside `ai-backend/` — it does not touch the
frontend (`src/`), Supabase functions, or any other part of the repository.

No AI frameworks, databases, queues, or workers — just Express and a direct
Gemini REST call.

## 1. Install dependencies

```bash
cd ai-backend
npm install
```

## 2. Run locally

Create a local `.env` (optional, for dev only — never commit it):

```bash
cp .env.example .env
# then edit .env and set your real GEMINI_API_KEY
```

Start in dev mode (auto-reload on changes):

```bash
npm run dev
```

Or build and start in production mode:

```bash
npm run build
npm start
```

The server listens on `0.0.0.0` and uses `process.env.PORT || 3000`.

## 3. Required environment variable

| Name | Required | Purpose |
|------|----------|---------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key (used by every AI route) |
| `SUPABASE_URL` | Yes (automatic pipeline) | Supabase project URL — service-role DB access |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (automatic pipeline) | Bypasses RLS so the pipeline can write insights/values/contacts |
| `WEBHOOK_SECRET` | No | Optional shared secret for `/ai/webhook/message` (`x-webhook-secret` header) |
| `ALLOWED_ORIGINS` | No | Comma-separated browser origins allowed by CORS. Empty = any origin (the API is public and credential-less). |
| `PORT` | No | HTTP port (defaults to 3000) |
| `OPENROUTER_API_KEY` | No (fallback) | OpenRouter API key — enables the sequential fallback used ONLY when Gemini is temporarily unavailable (429/500/502/503/504/network/timeout, after one Gemini retry). The chain walks FREE OpenRouter models one at a time until the first valid response |
| `OPENROUTER_BASE_URL` | No | OpenRouter REST base (defaults to `https://openrouter.ai/api/v1`) |
| `OPENROUTER_TIMEOUT_MS` | No | Per-model attempt deadline in ms (defaults to `30000`) |
| `OPENROUTER_MAX_MODELS` | No | Max free models tried per request (defaults to `3`) |
| `OPENROUTER_FREE_MODELS` | No | Comma-separated explicit free model ids — overrides dynamic discovery |
| `AI_TEST_PROVIDER` | No (dev only) | `gemini` or `openrouter` — forces a single provider path so each can be tested without a real Gemini outage. Never bypasses validation. Leave unset in production |
| `AI_TEST_MODEL` | No (dev only) | Pins the single OpenRouter model to try. Leave unset in production |

Secrets are read from the environment only — never hardcoded, logged, or
returned in any response. `SUPABASE_SERVICE_ROLE_KEY` must never reach a browser.
`GEMINI_API_KEY` and `OPENROUTER_API_KEY` are never sent to the frontend or
stored in Supabase.

## 4. Test GET /health

```bash
curl http://localhost:3000/health
```

Expected response (does NOT call Gemini):

```json
{ "status": "ok", "service": "botd-ai-backend" }
```

## 5. Test POST /ai/test

```bash
curl -X POST http://localhost:3000/ai/test \
  -H "Content-Type: application/json" \
  -d '{}'
```

Success response:

```json
{
  "success": true,
  "model": "gemini-3.5-flash-lite",
  "text": "...gemini confirmation text..."
}
```

Error responses:

| Condition                        | HTTP status |
|----------------------------------|-------------|
| Missing `GEMINI_API_KEY`          | 500         |
| Gemini API error (e.g. bad model) | Gemini's own status (e.g. 404, 429) |
| Invalid/unexpected Gemini response| 502         |
| Gemini request timeout            | 504         |

## 6. Test POST /ai/extract-crm-fields

CRM field extraction. The caller sends the CRM schema (the fields the
organization defined, plus the built-in contact fields) together with the
conversation messages, and gets back the values the messages explicitly
provide — each with a confidence and the id of the message it was read from.

```bash
curl -X POST http://localhost:3000/ai/extract-crm-fields \
  -H "Content-Type: application/json" \
  -d '{
    "organization_id": "00000000-0000-0000-0000-000000000000",
    "contact_id": "00000000-0000-0000-0000-000000000000",
    "crm_fields": [
      { "field_name": "wilaya", "field_label": "Wilaya", "field_type": "text", "target": "contact" },
      { "field_name": "vehicle_wanted", "field_label": "Vehicle wanted", "field_type": "text" },
      { "field_name": "budget", "field_label": "Budget in DZD", "field_type": "number" },
      { "field_name": "purchase_timeframe", "field_label": "Purchase timeframe", "field_type": "select", "options": ["This month", "1-3 months", "Later"] }
    ],
    "messages": [
      { "id": "b1f0c6f4-1111-4111-8111-111111111111", "direction": "inbound", "text": "Salam, I want to buy a Peugeot 208, budget 350 million, I am from Algiers and I want it this month." }
    ]
  }'
```

Success response:

```json
{
  "success": true,
  "model": "gemini-3.5-flash-lite",
  "prompt_version": "crm-field-extractor-v1",
  "contact_id": "00000000-0000-0000-0000-000000000000",
  "organization_id": "00000000-0000-0000-0000-000000000000",
  "crm_fields_used": 8,
  "updates": [
    {
      "field": "wilaya",
      "value": "Alger",
      "confidence": 0.97,
      "evidence_message_id": "b1f0c6f4-1111-4111-8111-111111111111"
    },
    {
      "field": "vehicle_wanted",
      "value": "Peugeot 208",
      "confidence": 0.98,
      "evidence_message_id": "b1f0c6f4-1111-4111-8111-111111111111"
    },
    {
      "field": "budget",
      "value": 350000000,
      "confidence": 0.93,
      "evidence_message_id": "b1f0c6f4-1111-4111-8111-111111111111"
    },
    {
      "field": "purchase_timeframe",
      "value": "This month",
      "confidence": 0.9,
      "evidence_message_id": "b1f0c6f4-1111-4111-8111-111111111111"
    }
  ]
}
```

Notes:

- Pure extraction: this route never touches the database. The caller (the CRM
  frontend) writes the values through its own RLS-scoped session.
- `target: "contact"` marks a built-in `contacts` column (name / phone / city /
  wilaya, only ever filled while empty); a missing/other target means a key in
  `contact_custom_values`.
- The schema is merged with the built-in fields server-side, and a custom field
  with the same name as a built-in one wins.
- Dropped without an error (the field then simply stays unchanged): unknown
  field names, values that do not fit the declared type (bad date, select option
  outside the list), a missing/too low `confidence` (< 0.55), and an
  `evidence_message_id` that is not one of the supplied messages.
- `contact_id` / `organization_id` are validated and echoed back for
  correlation — they are never sent to Gemini.
- The model is forced to JSON-only output (`responseMimeType: application/json`).

| Condition                          | HTTP status |
|------------------------------------|-------------|
| Missing `GEMINI_API_KEY`            | 500         |
| Missing/invalid body fields         | 400         |
| Invalid `crm_fields` / `messages`   | 400         |
| Gemini API error                    | Gemini's own status |
| Non-JSON / unusable model output    | 502         |
| Gemini request timeout              | 504         |

## 7. Automatic pipeline: POST /ai/webhook/message

Fully automated background extraction — no user interaction required. Called by
`bright-worker` (Supabase Edge Function) right after every inbound message is
saved, in the background (`EdgeRuntime.waitUntil`) so the Meta webhook is never
delayed.

What the pipeline does, server-side:

1. Loads the contact, the conversation transcript (last 30 messages, each with
   its message id) and the organization's CRM schema: the built-in contact
   columns (name / phone / city / wilaya) plus every field in `crm_custom_fields`.
2. Sends the schema + the transcript to Gemini (same prompt/validation as
   `/ai/extract-crm-fields`).
3. Writes the accepted updates with the service role:
   - `contact_custom_values` → organization-defined fields, **merged**: an empty
     field is filled; a stored value is only replaced by a clearly stated
     (evidence-backed, confidence ≥ 0.85) value — never weakened, never blanked;
   - `contacts` → the built-in columns are filled **only** while they are empty
     or still an ingestion placeholder (`instagram user …`), and `lead_status`
     only moves forward `new` → `contacted` (`qualified` / `won` / `lost` stay
     manual).
4. Writes nothing else. There is **no** `contact_ai_insights` write path: the AI
   fills the CRM fields the organization defined instead of producing a separate
   insights layer (intent / interests / sentiment / summary).

Body:

```json
{ "organization_id": "uuid", "contact_id": "uuid", "conversation_id": "uuid", "message_id": "optional" }
```

Response: `{ success, organizationId, contactId, conversationId,
transcript_messages, crm_fields_used, updates, applied_custom_values,
applied_contact_fields, skipped_updates, contact_updates, custom_values_written }`
— `skipped_updates` lists the accepted values that were kept out to protect a
stored/confirmed value.

Errors: `401` invalid webhook secret, `400` missing fields, `500` missing
env/secrets, `404` unknown contact, `502`/Gemini status on model errors.

Required Supabase secrets on the **bright-worker** function:

| Secret | Purpose |
|--------|---------|
| `AI_BACKEND_URL` | e.g. `https://botd-ai-backend.onrender.com` — enables the trigger |
| `AI_BACKEND_WEBHOOK_SECRET` | Only if `WEBHOOK_SECRET` is set on Render (same value) |

```bash
supabase secrets set AI_BACKEND_URL=https://botd-ai-backend.onrender.com \
  --project-ref exoajfewjydcgxsslswq
supabase functions deploy bright-worker --project-ref exoajfewjydcgxsslswq
```

## 8. Deploying to Render

This directory can be deployed independently from the existing BOTD GitHub
repository by setting the Render service's **Root Directory** to `ai-backend`.

Suggested Render configuration:

| Setting        | Value                        |
|----------------|------------------------------|
| Repository     | current BOTD GitHub repo     |
| Root Directory | `ai-backend`                 |
| Build Command  | `npm install && npm run build` |
| Start Command  | `npm start`                  |
| Env Vars       | `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optional `WEBHOOK_SECRET`, optional `OPENROUTER_API_KEY` (+ optional `OPENROUTER_*` tuning vars), optional `AI_TEST_PROVIDER` / `AI_TEST_MODEL` (dev only) |

Render injects `PORT` automatically — the server already binds to
`0.0.0.0:$PORT` and does not hardcode localhost.

## 9. Provider fallback: Gemini → OpenRouter free models

Conversation analysis (CRM field extraction) runs through a strictly
**sequential** provider chain — never parallel:

1. **Gemini (primary)** — one attempt with the existing prompt, generation
   config and timeout.
2. **Gemini retry** — only for temporary provider problems (HTTP 429/500/502/
   503/504, network error, timeout), once, after a short exponential backoff
   (500 ms base). Non-transient errors (e.g. 400/401/404) surface immediately
   with no retry and no fallback.
3. **OpenRouter free models (fallback)** — only after Gemini failed transiently
   twice, and only when `OPENROUTER_API_KEY` is set. Free models are discovered
   dynamically from `GET /models` (pricing = 0 for prompt *and* completion,
   text in/out), sorted deterministically by id and capped at
   `OPENROUTER_MAX_MODELS`; each model gets its own `OPENROUTER_TIMEOUT_MS`
   deadline. `OPENROUTER_FREE_MODELS` / `AI_TEST_MODEL` can pin the list
   instead. The `openrouter/free` alias is never used (it would make the model
   choice non-deterministic).
4. Every model receives the *identical* prompt, and its raw output must pass
   the *same* parse/validation (`parseModelJson` → `normalizeCrmFieldUpdates`)
   **before** the chain accepts it — invalid JSON or a schema mismatch fails
   that model and the chain moves to the next free model. Only accepted text
   reaches the CRM write, so the extraction contract and stored data shape are
   provider-independent.
5. If every free model fails, the route returns a clean `AiProviderError`
   (HTTP 503) naming the Gemini status — errors are never swallowed.

Safe server-side log lines (provider, model, HTTP status, durations and
attempt/fallback decisions only — never keys, prompts, messages, headers,
customer data or model responses):

```
[ai-provider] attempt {"provider":"gemini","attempt":1}
[ai-provider] retry {"provider":"gemini","next_attempt":2,"status":503,"delay_ms":500}
[ai-provider] fallback_triggered {"from":"gemini","to":"openrouter","reason":"gemini_status_503"}
[ai-provider] model_failed {"provider":"openrouter","model":"…","status":429,"duration_ms":120}
[ai-provider] success {"provider":"openrouter","model":"…","fallback":true,"duration_ms":842}
[ai-provider] chain_complete {"provider":"openrouter","model":"…","models_tried":2,"total_duration_ms":1450}
```

### Testing without a real Gemini outage

Set `AI_TEST_PROVIDER` (server-side env var only — clients cannot set it):

```bash
# Exercise the OpenRouter fallback chain directly (Gemini is never called):
AI_TEST_PROVIDER=openrouter curl -X POST http://localhost:3000/ai/extract-crm-fields \
  -H 'Content-Type: application/json' -d '{"crm_fields":[...],"messages":[...]}'

# Optionally pin ONE free model for that run (validation still applies):
AI_TEST_PROVIDER=openrouter AI_TEST_MODEL=<free-model-id> curl …

# Exercise the isolated Gemini primary path (no retry, no fallback):
AI_TEST_PROVIDER=gemini
```

Production behavior requires leaving `AI_TEST_PROVIDER` unset. To verify a
live Gemini-outage fallback end-to-end, temporarily set
`AI_TEST_PROVIDER=openrouter` in a development environment, or rely on the
logged `fallback_triggered` / `chain_complete` events when Gemini rate-limits
you in production.

Unit tests for the provider orchestration (mocked providers — no API keys and
no network access required):

```bash
cd ai-backend
npm test        # builds dist/ then runs node --test tests/
```

Covered: Gemini success (no fallback), Gemini retry, fallback chain order,
per-model validation failure advancing to the next free model, all-models
failure → clean HTTP 503, missing-key behavior, strict sequential execution
(never parallel), and that API keys / conversation contents never appear in
the logs.

The Gemini connectivity route `POST /ai/test` still verifies the primary
provider directly and can be used after every deploy.
