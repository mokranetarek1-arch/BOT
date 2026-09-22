// No external imports — works in the default Supabase Edge Function runtime
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const TEST_PROMPT = 'Hello from BOTD test function';
const GEMINI_TIMEOUT_MS = 15_000;

const handler = async () => {
  // 1. Ensure the key is loaded from the secret (no hardcoded key in the code)
  if (!GEMINI_API_KEY) {
    return new Response(
      JSON.stringify({
        error: 'GEMINI_API_KEY is not configured as a Supabase secret.',
        details: 'Set GEMINI_API_KEY via: supabase secrets set GEMINI_API_KEY',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2. Use fetch directly to the Gemini API (no SDK)
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: TEST_PROMPT }],
      },
    ],
  };

  // Abort the outbound request if it hangs, so the worker is not held open.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await res.json();

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: 'Gemini API request failed', details: data }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Return Gemini's response directly — to verify that the key and connection works
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return new Response(
        JSON.stringify({ error: 'Gemini request timed out after 15 seconds' }),
        { status: 504, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({
        error: 'Request failed',
        details: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  } finally {
    clearTimeout(timeoutId);
  }
};

export default handler;