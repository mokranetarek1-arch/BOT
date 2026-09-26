import { useEffect, useRef, useState } from 'react';
import { facebookService } from '@/services/facebookService';
import { SocialAccount } from '@/types';
import { Button } from '@/components/ui/button';

type Phase = 'idle' | 'connecting' | 'callback' | 'done' | 'error';

interface FacebookConnectProps {
  code?: string | null;
  state?: string | null;
  onCallbackHandled?: () => void;
  onConnected?: () => void;
}

export default function FacebookConnect({
  code,
  state,
  onCallbackHandled,
  onConnected,
}: FacebookConnectProps) {
  const [account, setAccount] = useState<SocialAccount | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [phase, setPhase] = useState<Phase>(code ? 'callback' : 'idle');
  const [message, setMessage] = useState<string | null>(
    code ? 'Finishing Facebook connection…' : null,
  );

  const onCallbackHandledRef = useRef(onCallbackHandled);
  useEffect(() => {
    onCallbackHandledRef.current = onCallbackHandled;
  });

  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  });

  useEffect(() => {
    let cancelled = false;

    if (!code) {
      facebookService
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

    if (facebookService.wasCodeSent(code)) {
      onCallbackHandledRef.current?.();
      facebookService
        .getConnectedAccount()
        .then((existing) => {
          if (cancelled) return;
          setAccount(existing);
          setPhase(existing ? 'done' : 'idle');
          setMessage(
            existing
              ? `Connected as ${existing.account_name ?? 'Facebook Page'}.`
              : 'This authorization code was already used. Please start a new connection.',
          );
          if (existing) onConnectedRef.current?.();
        })
        .catch(() => {
          if (!cancelled) {
            setPhase('idle');
            setMessage('This authorization code was already used.');
          }
        });
      return () => {
        cancelled = true;
      };
    }

    facebookService
      .handleCallback(code, state ?? null)
      .then((result) => {
        if (cancelled) return;
        setPhase('done');
        setMessage(`Connected as ${result.account?.name ?? 'Facebook Page'}.`);
        onConnectedRef.current?.();
        return facebookService.getConnectedAccount();
      })
      .then((acc) => {
        if (!cancelled && acc) setAccount(acc);
      })
      .catch((err) => {
        if (cancelled) return;
        setPhase('error');
        setMessage(err instanceof Error ? err.message : 'Facebook connection failed.');
      })
      .finally(() => {
        onCallbackHandledRef.current?.();
      });

    return () => {
      cancelled = true;
    };
  }, [code, state]);

  const handleConnect = async () => {
    try {
      setPhase('connecting');
      setMessage('Redirecting to Facebook…');
      await facebookService.startConnect();
    } catch (err) {
      setPhase('error');
      setMessage(err instanceof Error ? err.message : 'Could not start Facebook login.');
    }
  };

  const handleDisconnect = async () => {
    if (!account) return;
    try {
      setDisconnecting(true);
      await facebookService.disconnect(account.id);
      setAccount(null);
      setPhase('idle');
      setMessage('Facebook disconnected.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not disconnect Facebook.');
    } finally {
      setDisconnecting(false);
    }
  };

  const isConnected = !!account;

  return (
    <div className="flex flex-col gap-2 p-4 border rounded-lg bg-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-100 dark:bg-blue-950/40 text-blue-600 rounded-md flex items-center justify-center font-bold">
            FB
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">Facebook Messenger</p>
              {isConnected && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300">
                  Connected
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {isConnected
                ? account.account_name ?? account.external_account_id
                : 'Connect your Facebook Page to chat with customers.'}
            </p>
          </div>
        </div>

        {isConnected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={handleConnect}
            disabled={phase === 'connecting' || phase === 'callback'}
          >
            {phase === 'connecting' || phase === 'callback' ? 'Connecting…' : 'Connect'}
          </Button>
        )}
      </div>

      {message && (
        <p
          className={`text-xs mt-1 ${
            phase === 'error'
              ? 'text-destructive'
              : phase === 'done'
                ? 'text-green-600 dark:text-green-400'
                : 'text-muted-foreground'
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
