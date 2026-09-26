import { useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import FacebookConnect from '@/features/settings/components/FacebookConnect';

export default function FacebookCallback() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  const initialCode = useMemo(() => code, []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialState = useMemo(() => state, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDone = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    next.delete('code');
    next.delete('state');
    next.delete('error');
    next.delete('error_description');
    setSearchParams(next, { replace: true });
  }, [setSearchParams]);

  const handleConnected = useCallback(() => {
    window.setTimeout(() => navigate('/settings', { replace: true }), 1200);
  }, [navigate]);

  return (
    <div className="p-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Facebook Messenger Connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm font-medium">
              Facebook returned an error: {errorDescription || error}
            </div>
          ) : (
            <FacebookConnect
              code={initialCode}
              state={initialState}
              onCallbackHandled={handleDone}
              onConnected={handleConnected}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
