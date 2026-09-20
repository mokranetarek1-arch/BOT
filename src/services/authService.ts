import { Organization, Profile } from '@/types';

export const authService = {
  async login(): Promise<{ profile: Profile; organization: Organization }> {
    await new Promise(resolve => setTimeout(resolve, 500));
    return {
      profile: {
        id: 'p1',
        email: 'user@company.com',
        first_name: 'John',
        last_name: 'Doe',
        organization_id: 'org1',
        created_at: new Date().toISOString()
      },
      organization: {
        id: 'org1',
        name: 'Acme Corp',
        created_at: new Date().toISOString()
      }
    };
  }
};

