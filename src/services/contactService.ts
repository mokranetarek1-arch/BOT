import { supabase } from '@/utils/supabase';
import { Contact, CustomerStatus, LeadStatus } from '@/types';

/**
 * Real database access for the CRM (public.contacts).
 *
 * Reads are scoped by RLS to the signed-in user's organization — a company can
 * only ever see its own contacts. No mock data, no service role, explicit
 * column lists only.
 */

/** Explicit column list — never `select('*')`. */
const CONTACT_FIELDS =
  'id, organization_id, name, phone, email, company, city, wilaya, country, source, lead_status, customer_status, tags, notes, last_contact_at, created_at, updated_at';

/**
 * Statuses listed on the Leads Pipeline page: the open pipeline.
 * 'qualified' is still being worked on; 'won' contacts belong to the customers
 * view and 'lost' contacts are out of the pipeline.
 */
const OPEN_LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified'];

/**
 * Statuses listed on the Customers page.
 * 'prospect' is included because it is the column DEFAULT: every contact created
 * from an incoming message starts as a prospect, and there is no UI yet to move
 * it to active/inactive/blocked — excluding it would leave the page empty.
 */
const CUSTOMER_STATUSES: CustomerStatus[] = [
  'prospect',
  'active',
  'inactive',
  'blocked',
];

export const contactService = {
  /** Every contact of the organization, newest first. */
  async listContacts(): Promise<Contact[]> {
    const { data, error } = await supabase
      .from('contacts')
      .select(CONTACT_FIELDS)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Contact[];
  },

  /**
   * Contacts in the open lead pipeline, newest first.
   * Pass a different `statuses` array to change what the page lists.
   */
  async listLeads(statuses: LeadStatus[] = OPEN_LEAD_STATUSES): Promise<Contact[]> {
    const { data, error } = await supabase
      .from('contacts')
      .select(CONTACT_FIELDS)
      .in('lead_status', statuses)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Contact[];
  },

  /**
   * Contacts that are customers, newest first.
   * Pass a different `statuses` array to change what the page lists.
   */
  async listCustomers(statuses: CustomerStatus[] = CUSTOMER_STATUSES): Promise<Contact[]> {
    const { data, error } = await supabase
      .from('contacts')
      .select(CONTACT_FIELDS)
      .in('customer_status', statuses)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Contact[];
  },
};
