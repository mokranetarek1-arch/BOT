import { Card, CardContent } from "@/components/ui/card";

export default function LeadsList() {
  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Leads Pipeline</h1>
        <button className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">Add Lead</button>
      </div>
      
      <Card>
        <CardContent className="p-0">
          <div className="w-full overflow-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted text-muted-foreground text-xs uppercase font-semibold">
                <tr>
                  <th className="px-6 py-4">Lead Name</th>
                  <th className="px-6 py-4">Source</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Value</th>
                  <th className="px-6 py-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[1, 2, 3].map(i => (
                  <tr key={i} className="bg-card hover:bg-muted/50">
                    <td className="px-6 py-4 font-medium">Lead {i}</td>
                    <td className="px-6 py-4">Instagram</td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-1 rounded-full bg-yellow-100 text-yellow-800 text-xs font-medium">New</span>
                    </td>
                    <td className="px-6 py-4 font-medium">$500</td>
                    <td className="px-6 py-4">
                      <button className="text-primary hover:underline font-medium text-xs">View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

