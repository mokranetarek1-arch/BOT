/**
 * Minimal direct REST client for the Gemini generateContent API.
 * No SDK, no framework — just fetch. Never logs or exposes the API key.
 */
import { GEMINI_BASE_URL, GEMINI_TIMEOUT_MS } from './config';

/** Safe error type: carries an HTTP status and a secret-free message. */
export class GeminiError extends Error {
  status?: number;
  safeMessage: string;

  constructor(safeMessage: string, status?: number) {
    super(safeMessage);
    this.name = 'GeminiError';
    this.status = status;
    this.safeMessage = safeMessage;
  }
}

export interface CallGeminiParams {
  apiKey: string;
  model: string;
  prompt: string;
}

/** Extracts the first text candidate from a Gemini generateContent response. */
function extractText(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const candidates = (data as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const first = candidates[0] as { content?: { parts?: Array<{ text?: unknown }> } };
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return null;

  const texts = parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .filter((t) => t.length > 0);

  return texts.length > 0 ? texts.join('') : null;
}

export async function callGemini({ apiKey, model, prompt }: CallGeminiParams): Promise<string> {
  const endpoint = `${GEMINI_BASE_URL}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
      signal: controller.signal,
    });

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON body from upstream — treat as an invalid response below.
    }

    if (!res.ok) {
      // Surface Gemini's own message when present, without echoing the key.
      const upstreamMsg =
        typeof data === 'object' && data !== null && 'error' in data
          ? String((data as { error?: { message?: unknown } }).error?.message ?? '')
          : '';
      throw new GeminiError(
        upstreamMsg || `Gemini API request failed with status ${res.status}.`,
        res.status,
      );
    }

    const text = extractText(data);
    if (!text) {
      throw new GeminiError('Gemini returned an unexpected response shape.', 502);
    }

    return text;
  } catch (err) {
    if (err instanceof GeminiError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GeminiError(`Gemini request timed out after ${GEMINI_TIMEOUT_MS / 1000}s.`, 504);
    }
    throw new GeminiError('Could not reach the Gemini API.', 502);
  } finally {
    clearTimeout(timeoutId);
  }
}
