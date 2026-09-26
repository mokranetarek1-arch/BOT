import { useState, useEffect } from 'react';
import { SocialAccount } from '../../../types';
import { whatsappService } from '../../../services/whatsappService';

export function WhatsAppConnect() {
  const [account, setAccount] = useState<SocialAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accessToken, setAccessToken] = useState('');

  useEffect(() => {
    whatsappService
      .getConnectedAccount()
      .then(setAccount)
      .catch((err) => console.warn('WA load error:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phoneNumberId.trim() || !accessToken.trim()) {
      setError('Phone Number ID and Access Token are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await whatsappService.connectAccount({
        phoneNumberId: phoneNumberId.trim(),
        accountName: accountName.trim() || 'WhatsApp Business',
        accessToken: accessToken.trim(),
      });
      setAccount(saved);
      setSuccess('WhatsApp connected successfully!');
      setIsModalOpen(false);
      setPhoneNumberId('');
      setAccessToken('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to connect WhatsApp.');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!account) return;
    setSaving(true);
    setError(null);
    try {
      await whatsappService.disconnect(account.id);
      setAccount(null);
      setSuccess('WhatsApp disconnected.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect WhatsApp.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-green-100 text-green-600 rounded-md flex items-center justify-center font-bold">WA</div>
          <div>
            <p className="font-medium">WhatsApp Business (Cloud API)</p>
            {loading ? (
              <p className="text-sm text-muted-foreground">Checking...</p>
            ) : account ? (
              <p className="text-sm text-green-600 font-medium">Connected: {account.account_name ?? 'WhatsApp'} (ID: {account.external_account_id})</p>
            ) : (
              <p className="text-sm text-muted-foreground">Not connected</p>
            )}
          </div>
        </div>
        <div>
          {account ? (
            <button onClick={handleDisconnect} disabled={saving} className="h-9 px-4 rounded-md border border-red-200 text-red-600 hover:bg-red-50 text-sm font-medium disabled:opacity-50">
              {saving ? 'Disconnecting...' : 'Disconnect'}
            </button>
          ) : (
            <button onClick={() => setIsModalOpen(true)} className="h-9 px-4 rounded-md border-input bg-background hover:bg-accent text-sm font-medium">Connect</button>
          )}
        </div>
      </div>
      {error && <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md">{error}</div>}
      {success && <div className="p-3 text-sm text-green-600 bg-green-50 border border-green-200 rounded-md">{success}</div>}

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-background border rounded-xl shadow-lg max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-semibold">Connect WhatsApp Business</h3>
            <form onSubmit={handleConnect} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Account Name</label>
                <input type="text" value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="WhatsApp Pro" className="w-full h-9 px-3 border rounded-md text-sm bg-background" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Phone Number ID *</label>
                <input type="text" required value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} placeholder="e.g. 5521998..." className="w-full h-9 px-3 border rounded-md text-sm bg-background" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Access Token *</label>
                <input type="password" required value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="EAAB..." className="w-full h-9 px-3 border rounded-md text-sm bg-background" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setIsModalOpen(false)} className="h-9 px-4 rounded-md border text-sm font-medium hover:bg-accent">Cancel</button>
                <button type="submit" disabled={saving} className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                  {saving ? 'Connecting...' : 'Save & Connect'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
