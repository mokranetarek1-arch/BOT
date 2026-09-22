// diag-echo — temporary diagnostic Edge Function.
// Purpose: prove whether Supabase Edge Functions can execute and return an
// HTTP response at all, independent of Gemini, the database, secrets, or any
// external fetch. No imports, no env vars, no I/O.
//
// Deploy: supabase functions deploy diag-echo --no-verify-jwt

const handler = () => {
  console.log('[diag-echo] handler reached');
  return new Response(
    JSON.stringify({ ok: true, function: 'diag-echo' }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
};

export default handler;
