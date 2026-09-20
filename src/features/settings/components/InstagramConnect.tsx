import { useEffect, useRef, useState } from 'react';
import { instagramService } from '@/services/instagramService';
import { SocialAccount } from '@/types';
import { Button } from '@/components/ui/button';

type Phase = 'idle' | 'connecting' | 'callback' | 'done' | 'error';

interface InstagramConnectProps {
  /**
   * The authorization `code` returned by Instagram on the redirect back to us,
   * if present. Read from the URL by the parent page.
   */
  code?: string | null;
  /** The `state` returned alongside `code`, used for CSRF checking. */
  state?: string | null;
  /** Called once the callback is handled so the parent can clean the URL. */
  onCallbackHandled?: () => void;
}

/**
 * Connect Instagram UI. Renders the connect button and the connected state.
 * All secret-bearing work happens in the `instagram-oauth` Edge Function.
 */
export default function InstagramConnect({
  code,
  state,
  onCallbackHandled,
}: InstagramConnectProps) {
  const [account, setAccount] = useState<SocialAccount | null>(null);
  const [phase, setPhase] = useState<Phase>(code ? 'callback' : 'idle');
  const [message, setMessage] = useState<string | null>(
    code ? 'Finishing Instagram connection…' : null,
  );

  // `code` presence is derived, not stateful: while it's set and no result
  // has arrived yet, the UI shows the callback phase.
  const showCallback = phase === 'callback' && !!code;

  // Latest-ref: the parent may recreate `onCallbackHandled` after it clears
  // the URL params. Keeping it in a ref lets the OAuth effect below depend
  // only on [code, state] so it can never re-fire with the same code when the
  // callback identity changes.
  const onCallbackHandledRef = useRef(onCallbackHandled);
  useEffect(() => {
    onCallbackHandledRef.current = onCallbackHandled;
  });

  // Handle the OAuth redirect back (?code=...&state=...) and load existing state.
  useEffect(() => {
    let cancelled = false;

    if (!code) {
      // Load any existing connection asynchronously (no sync setState).
      instagramService
        .getConnectedAccount()
        .then((existing) => {
          if (!cancelled) setAccount(existing);
        })
        .catch(() => {
          if (!cancelled) setAccount(null);
        });
      return () => {
        cancelled = true;
      };
    }

    // Instagram authorization codes are strictly one-time-use: NEVER submit
    // the same code twice (effect re-fire, page refresh on the callback URL,
    // React StrictMode double-mount in dev). If it was already sent, refresh
    // the local state and clean the URL instead of calling the Edge Function.
    if (instagramService.wasCodeSent(code)) {
      onCallbackHandledRef.current?.(); // remove code/state from the URL
      instagramService
        .getConnectedAccount()
        .then((existing) => {
          if (cancelled) return;
          setAccount(existing);
          setPhase(existing ? 'done' : 'idle');
          setMessage(
            existing
              ? `Connected${existing.account_name ? ` as @${existing.account_name}` : ''}.`
              : 'This authorization code was already used. Please start a new connection.',
          );
        })
        .catch(() => {
          if (!cancelled) {
            setPhase('idle');
            setMessage(
              'This authorization code was already used. Please start a new connection.',
            );
          }
        });
      return () => {
        cancelled = true;
      };
    }

    instagramService
      .handleCallback(code, state ?? null)
      .then((result) => {
        if (cancelled) return;
        setPhase('done');
        setMessage(
          result.warning
            ? `Connected @${result.account?.username ?? ''}. Note: ${result.warning}`
            : `Connected @${result.account?.username ?? 'Instagram account'}.`,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase('error');
        setMessage(err instanceof Error ? err.message : 'Connection failed.');
      })
      .finally(() => {
        // Refresh the connected account without setting state synchronously.
        instagramService
          .getConnectedAccount()
          .then((existing) => {
            if (!cancelled) setAccount(existing);
          })
          .catch(() => {
            if (!cancelled) setAccount(null);
          });
        onCallbackHandledRef.current?.();
      });

    return () => {
      cancelled = true;
    };
  }, [code, state]);

  const handleConnect = async () => {
    setPhase('connecting');
    setMessage(null);
    try {
      await instagramService.startConnect();
      // Redirect happens inside startConnect; nothing else to do here.
    } catch (err) {
      setPhase('error');
      setMessage(err instanceof Error ? err.message : 'Could not start OAuth.');
    }
  };

  const isConnected = !!account;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-pink-100 text-pink-600 rounded-md flex items-center justify-center font-bold">
            IG
          </div>
          <div>
            <p className="font-medium">Instagram</p>
            <p className="text-sm text-muted-foreground">
              {isConnected
                ? `Connected${account?.account_name ? ` as @${account.account_name}` : ''}`
                : 'Not connected'}
            </p>
          </div>
        </div>
        <Button
          variant={isConnected ? 'outline' : 'default'}
          onClick={handleConnect}
          disabled={phase === 'connecting' || showCallback}
        >
          {phase === 'connecting'
            ? 'Redirecting…'
            : isConnected
              ? 'Reconnect Instagram'
              : 'Connect Instagram'}
        </Button>
      </div>

      {message && (
        <div
          className={
            'p-3 rounded-md text-sm font-medium ' +
            (phase === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-muted text-muted-foreground')
          }
        >
          {message}
        </div>
      )}
    </div>
  );
}
