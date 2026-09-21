import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from "@/components/ui/card";
import { contactService } from '@/services/contactService';
import { Contact } from '@/types';
import { leadStatusClasses } from '../crmFormat';

export default function LeadsList() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initial load (same pattern as Inbox): every setState lives in the promise
  // chain, nothing runs synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    contactService
      .listLeads()
      .then((list) => {
        if (!cancelled) setLeads(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load leads.');
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
                  <th className="px-6 py-4">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading && (
                  <tr className="bg-card">
                    <td className="px-6 py-6 text-muted-foreground" colSpan={4}>
                      Loading leads…
                    </td>
                  </tr>
                )}

                {!loading && error && (
                  <tr className="bg-card">
                    <td className="px-6 py-6 text-destructive" colSpan={4}>
                      {error}
                    </td>
                  </tr>
                )}

                {!loading && !error && leads.length === 0 && (
                  <tr className="bg-card">
                    <td className="px-6 py-6 text-muted-foreground" colSpan={4}>
                      No leads yet. Contacts created from incoming Instagram messages appear here.
                    </td>
                  </tr>
                )}

                {!loading &&
                  !error &&
                  leads.map((lead) => (
                    <tr key={lead.id} className="bg-card hover:bg-muted/50">
                      <td className="px-6 py-4 font-medium">{lead.name}</td>
                      <td className="px-6 py-4">{lead.source ?? '—'}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-medium ${
                            leadStatusClasses[lead.lead_status] ??
                            'bg-secondary text-secondary-foreground'
                          }`}
                        >
                          {lead.lead_status}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <button
                          onClick={() => navigate(`/crm/contacts/${lead.id}`)}
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

