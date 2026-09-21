import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from "@/components/ui/card";
import { contactService } from '@/services/contactService';
import { Contact } from '@/types';
import { customerStatusClasses, formatDate, formatLocation } from '../crmFormat';

export default function CustomersList() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initial load (same pattern as Inbox): every setState lives in the promise
  // chain, nothing runs synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    contactService
      .listCustomers()
      .then((list) => {
        if (!cancelled) setCustomers(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load customers.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
                {loading && (
                  <tr className="bg-card">
                    <td className="px-6 py-6 text-muted-foreground" colSpan={5}>
                      Loading customers…
                    </td>
                  </tr>
                )}

                {!loading && error && (
                  <tr className="bg-card">
                    <td className="px-6 py-6 text-destructive" colSpan={5}>
                      {error}
                    </td>
                  </tr>
                )}

                {!loading && !error && customers.length === 0 && (
                  <tr className="bg-card">
                    <td className="px-6 py-6 text-muted-foreground" colSpan={5}>
                      No customers yet.
                    </td>
                  </tr>
                )}

                {!loading &&
                  !error &&
                  customers.map((customer) => (
                    <tr key={customer.id} className="bg-card hover:bg-muted/50">
                      <td className="px-6 py-4 font-medium">{customer.name}</td>
                      <td className="px-6 py-4">
                        {formatLocation(customer.city, customer.wilaya)}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-medium ${
                            customerStatusClasses[customer.customer_status] ??
                            'bg-secondary text-secondary-foreground'
                          }`}
                        >
                          {customer.customer_status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">
                        {formatDate(customer.created_at)}
                      </td>
                      <td className="px-6 py-4">
                        <button
                          onClick={() => navigate(`/crm/contacts/${customer.id}`)}
                          className="text-primary font-medium text-xs hover:underline"
                        >
                          View
                        </button>
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

