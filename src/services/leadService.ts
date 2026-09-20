import { Lead } from '@/types';

const mockLeads: Lead[] = [
  {
    id: 'l1',
    organization_id: 'org1',
    name: 'Lead 1',
    source: 'instagram',
    status: 'new',
    value: 500,
    created_at: new Date().toISOString(),
  }
];

export const leadService = {
  async getLeads(organizationId: string): Promise<Lead[]> {
    await new Promise(resolve => setTimeout(resolve, 500));
    return mockLeads.filter(l => l.organization_id === organizationId);
  }
};

