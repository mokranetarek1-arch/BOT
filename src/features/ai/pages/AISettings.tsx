import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function AISettings() {
  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">AI Configuration</h1>
      
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Brand Voice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Persona Description</label>
              <textarea className="flex min-h-[100px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm" placeholder="Describe how the AI should sound (e.g. professional, friendly, use emojis...)"></textarea>
            </div>
            <button className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium">Save Settings</button>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle>Extraction Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Configure what data the AI should attempt to extract from conversations.</p>
            <div className="space-y-2">
              {['Phone Numbers', 'Addresses', 'Product Intents'].map(item => (
                <div key={item} className="flex items-center space-x-2">
                  <input type="checkbox" id={item} className="rounded border-input text-primary focus:ring-primary h-4 w-4" defaultChecked />
                  <label htmlFor={item} className="text-sm font-medium leading-none">{item}</label>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

