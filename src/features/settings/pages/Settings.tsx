import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import InstagramConnect from '@/features/settings/components/InstagramConnect';

export default function Settings() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Instagram returns to our redirect URI with ?code=...&state=...
  const code = searchParams.get('code');
  const state = searchParams.get('state');

  // Memoize so the callback effect doesn't re-run on every render.
  const initialCode = useMemo(() => code, []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialState = useMemo(() => state, []); // eslint-disable-line react-hooks/exhaustive-deps
  const clearCallbackParams = useCallback(() => {
    // Remove code/state from the URL so a refresh doesn't replay the callback.
    const next = new URLSearchParams(searchParams);
    next.delete('code');
    next.delete('state');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">Organization Settings</h1>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>General Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Organization Name</label>
              <input type="text" className="flex h-9 w-full rounded-md border-input bg-transparent px-3 py-1 text-sm shadow-sm" defaultValue="Acme Corp" />
            </div>
            <button className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium">Save Changes</button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Social Integrations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Instagram OAuth (Instagram Business Login) — handled server-side. */}
            <InstagramConnect
              code={initialCode}
              state={initialState}
              onCallbackHandled={clearCallbackParams}
            />

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-md flex items-center justify-center font-bold">FB</div>
                <div>
                  <p className="font-medium">Facebook Messenger</p>
                  <p className="text-sm text-muted-foreground">Not connected</p>
                </div>
              </div>
              <button className="h-9 px-4 rounded-md border-input bg-background hover:bg-accent text-sm font-medium">Connect</button>
            </div>

            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-green-100 text-green-600 rounded-md flex items-center justify-center font-bold">WA</div>
                <div>
                  <p className="font-medium">WhatsApp Business</p>
                  <p className="text-sm text-muted-foreground">Not connected</p>
                </div>
              </div>
              <button className="h-9 px-4 rounded-md border-input bg-background hover:bg-accent text-sm font-medium">Connect</button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
