import { Card, CardContent } from "@/components/ui/card";

export default function CustomersList() {
  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Customers</h1>
        <button className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">Add Customer</button>
      </div>
      
      <Card>
        <CardContent className="p-0">
          <div className="w-full overflow-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted text-muted-foreground text-xs uppercase font-semibold">
                <tr>
                  <th className="px-6 py-4">Name</th>
                  <th className="px-6 py-4">Location</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Added</th>
                  <th className="px-6 py-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[1, 2, 3, 4, 5].map(i => (
                  <tr key={i} className="bg-card hover:bg-muted/50">
                    <td className="px-6 py-4 font-medium">Customer {i}</td>
                    <td className="px-6 py-4">Algiers, AL</td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-1 rounded-full bg-green-100 text-green-800 text-xs font-medium">Active</span>
                    </td>
                    <td className="px-6 py-4 text-muted-foreground">Sep 20, 2026</td>
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

