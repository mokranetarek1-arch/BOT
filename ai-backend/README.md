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

| Name             | Required | Purpose                                  |
|------------------|----------|------------------------------------------|
| `GEMINI_API_KEY` | Yes (for `/ai/test`) | Google Gemini API key |
| `PORT`           | No       | HTTP port (defaults to 3000)             |

The key is read from the environment only — it is never hardcoded, logged, or
returned in any response.

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

## 6. Test POST /ai/analyze-lead

Lead analysis for the CRM smart pipeline. Accepts a customer message and
returns a structured JSON-only extraction.

```bash
curl -X POST http://localhost:3000/ai/analyze-lead \
  -H "Content-Type: application/json" \
  -d '{
    "message_text": "Hi! Im Karim, interested in the leather bag. How much? My number is 0555 123 456",
    "contact_id": "00000000-0000-0000-0000-000000000000",
    "organization_id": "00000000-0000-0000-0000-000000000000"
  }'
```

Success response:

```json
{
  "success": true,
  "model": "gemini-3.5-flash-lite",
  "prompt_version": "lead-analyzer-v1",
  "contact_id": "00000000-0000-0000-0000-000000000000",
  "organization_id": "00000000-0000-0000-0000-000000000000",
  "data": {
    "client_name": "Karim",
    "phone_number": "0555 123 456",
    "intent": "purchase",
    "product_or_service": "leather bag",
    "lead_score": 85,
    "summary": "Karim asked about the price of the leather bag.",
    "suggested_reply": "Hi Karim! The leather bag is ... "
  }
}
```

Notes:

- `contact_id` / `organization_id` are validated and echoed back for
  correlation — they are never sent to Gemini.
- The model is forced to JSON-only output (`responseMimeType: application/json`)
  and every field is validated/normalized server-side before returning.
- `contact_id` and `organization_id` must be non-empty strings;
  `message_text` is capped at 8000 characters.

| Condition                          | HTTP status |
|------------------------------------|-------------|
| Missing `GEMINI_API_KEY`            | 500         |
| Missing/invalid body fields         | 400         |
| Gemini API error                    | Gemini's own status |
| Non-JSON / unusable model output    | 502         |
| Gemini request timeout              | 504         |

## 7. Deploying to Render (later — not yet)

This directory can be deployed independently from the existing BOTD GitHub
repository by setting the Render service's **Root Directory** to `ai-backend`.

Suggested Render configuration:

| Setting        | Value                        |
|----------------|------------------------------|
| Repository     | current BOTD GitHub repo     |
| Root Directory | `ai-backend`                 |
| Build Command  | `npm install && npm run build` |
| Start Command  | `npm start`                  |
| Env Var        | `GEMINI_API_KEY` = (your real key, set via Render dashboard) |

Render injects `PORT` automatically — the server already binds to
`0.0.0.0:$PORT` and does not hardcode localhost.
