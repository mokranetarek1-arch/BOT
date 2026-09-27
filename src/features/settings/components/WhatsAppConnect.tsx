import { useEffect, useState } from 'react';
import { whatsappService } from '@/services/whatsappService';
import { SocialAccount } from '@/types';
import { Button } from '@/components/ui/button';

/**
 * The full UI state machine required of every channel card:
 *   loading -> not_connected -> connecting -> connected
 *   connected -> disconnecting -> disconnected
 *   any state -> error (showing the REAL backend error, never a fake success)
 */
type Phase =
  | 'loading'
  | 'not_connected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'error';

export function WhatsAppConnect() {
  const [account, setAccount] = useState<SocialAccount | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    whatsappService
      .getConnectedAccount()
      .then((existing) => {
        if (cancelled) return;
        setAccount(existing);
        setPhase(existing ? 'connected' : 'not_connected');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A read failure is a real problem: surface it rather than pretending
        // the channel is simply not connected.
        setPhase('error');
        setMessage(
          err instanceof Error
            ? err.message
            : 'Could not read the WhatsApp connection status.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Meta Embedded Signup. The user picks or creates a WhatsApp Business Account
   * and a phone number inside Meta's own dialog; we only forward the short-lived
   * code to the Edge Function, which performs the token exchange and stores the
   * account. No access token is ever held in the browser.
   */
  const handleConnect = async () => {
    setPhase('connecting');
    setMessage('Complete the Meta sign-up dialog…');
    try {
      const saved = await whatsappService.connectWithEmbeddedSignup();
      setAccount(saved);
      setPhase('connected');
      setMessage(null);
    } catch (err: unknown) {
      const text =
        err instanceof Error ? err.message : 'WhatsApp could not be connected.';
      // Closing the Meta dialog without finishing is a cancellation, not a failure.
      if (text.toLowerCase().includes('cancelled')) {
        setPhase(account ? 'connected' : 'not_connected');
        setMessage(null);
        return;
      }
      setPhase('error');
      setMessage(text);
    }
  };

  const handleDisconnect = async () => {
    if (!account) return;
    setPhase('disconnecting');
    setMessage(null);
    try {
      // Soft disconnect: contacts, conversations, messages and CRM history stay.
      await whatsappService.disconnect(account.id);
      setAccount(null);
      setPhase('disconnected');
    } catch (err: unknown) {
      setPhase('error');
      setMessage(
        err instanceof Error ? err.message : 'Could not disconnect WhatsApp.',
      );
    }
  };

  const isBusy =
    phase === 'loading' || phase === 'connecting' || phase === 'disconnecting';
  const isDisconnecting = phase === 'disconnecting';
  const isConnected = phase === 'connected';
  const phone = account?.phone_number ?? null;
  const businessName = account?.display_name ?? account?.account_name ?? null;

  return (
    <div className="flex flex-col gap-2 p-4 border rounded-lg bg-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-green-100 dark:bg-green-950/40 text-green-600 rounded-md flex items-center justify-center font-bold">
            WA
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium">WhatsApp Business</p>
              {isConnected && (
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300">
                  Connected
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {phase === 'loading'
                ? 'Checking…'
                : isConnected
                  ? (phone ?? account?.account_name ?? 'WhatsApp Business')
                  : 'Connect your WhatsApp Business number to chat with customers.'}
            </p>
            {isConnected && businessName && (
              <p className="text-xs text-muted-foreground">
                Business Account: {businessName}
              </p>
            )}
          </div>
        </div>

        {isConnected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            disabled={isBusy}
          >
            {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        ) : (
          <Button size="sm" onClick={handleConnect} disabled={isBusy}>
            {phase === 'connecting'
              ? 'Connecting…'
              : phase === 'disconnected'
                ? 'Reconnect'
                : 'Connect'}
          </Button>
        )}
      </div>

      {message && phase !== 'loading' && (
        <p
          className={`text-xs mt-1 ${
            phase === 'error' ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
