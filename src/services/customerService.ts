import { Customer } from '@/types';

const mockCustomers: Customer[] = [
  {
    id: 'c1',
    organization_id: 'org1',
    name: 'Customer 1',
    city: 'Algiers',
    wilaya: '16',
    status: 'active',
    created_at: new Date().toISOString(),
  },
  {
    id: 'c2',
    organization_id: 'org1',
    name: 'Customer 2',
    city: 'Oran',
    wilaya: '31',
    status: 'active',
    created_at: new Date().toISOString(),
  },
];

export const customerService = {
  async getCustomers(organizationId: string): Promise<Customer[]> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 500));
    return mockCustomers.filter(c => c.organization_id === organizationId);
  },
  async getCustomerById(id: string): Promise<Customer | undefined> {
    await new Promise(resolve => setTimeout(resolve, 500));
    return mockCustomers.find(c => c.id === id);
  }
};

