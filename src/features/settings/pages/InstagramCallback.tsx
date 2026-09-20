import { useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import InstagramConnect from '@/features/settings/components/InstagramConnect';

/**
 * Dedicated OAuth redirect target for Instagram.
 * Register this exact URL (VITE_INSTAGRAM_REDIRECT_URI) in the Meta dashboard.
 */
export default function InstagramCallback() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorReason = searchParams.get('error_reason');

  const initialCode = useMemo(() => code, []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialState = useMemo(() => state, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable identity: reads the URL at call time instead of capturing
  // `searchParams`, so clearing the params never recreates this callback.
  // (A changing identity used to re-fire the OAuth effect in InstagramConnect
  // with the same, already-consumed authorization code.)
  const handleDone = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    next.delete('code');
    next.delete('state');
    next.delete('error');
    next.delete('error_reason');
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);

  // On successful connection, return to Settings automatically (the connected
  // state is shown there). Errors remain on this page with a visible message
  // and the "Back to Settings" button. `replace` keeps the callback URL (whose
  // code/state are already cleaned) out of the history.
  const handleConnected = useCallback(() => {
    window.setTimeout(() => navigate('/settings', { replace: true }), 1200);
  }, [navigate]);

  return (
    <div className="p-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Instagram Connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm font-medium">
              Instagram returned an error: {errorReason || error}
            </div>
          ) : (
            <InstagramConnect
              code={initialCode}
              state={initialState}
              onCallbackHandled={handleDone}
              onConnected={handleConnected}
            />
          )}

          <button
            className="h-9 px-4 rounded-md border-input bg-background hover:bg-accent text-sm font-medium"
            onClick={() => navigate('/settings')}
          >
            Back to Settings
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
