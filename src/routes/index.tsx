import { createBrowserRouter, Navigate } from 'react-router-dom';
import DashboardLayout from '@/layouts/DashboardLayout';
import AuthLayout from '@/layouts/AuthLayout';
import DashboardOverview from '@/features/dashboard/pages/DashboardOverview';
import Inbox from '@/features/inbox/pages/Inbox';
import CustomersList from '@/features/crm/pages/CustomersList';
import LeadsList from '@/features/crm/pages/LeadsList';
import ContactDetails from '@/features/crm/pages/ContactDetails';
import AISettings from '@/features/ai/pages/AISettings';
import Analytics from '@/features/analytics/pages/Analytics';
import Settings from '@/features/settings/pages/Settings';
import InstagramCallback from '@/features/settings/pages/InstagramCallback';
import FacebookCallback from '@/features/settings/pages/FacebookCallback';
import Login from '@/features/auth/pages/Login';
import Register from '@/features/auth/pages/Register';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <DashboardLayout />,
    children: [
      { path: '/', element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardOverview /> },
      { path: 'inbox', element: <Inbox /> },
      { path: 'crm/customers', element: <CustomersList /> },
      { path: 'crm/leads', element: <LeadsList /> },
      { path: 'crm/contacts/:id', element: <ContactDetails /> },
      { path: 'ai', element: <AISettings /> },
      { path: 'analytics', element: <Analytics /> },
      { path: 'settings', element: <Settings /> },
      { path: 'integrations/instagram/callback', element: <InstagramCallback /> },
      { path: 'integrations/facebook/callback', element: <FacebookCallback /> },
    ],
  },
  {
    path: '/auth',
    element: <AuthLayout />,
    children: [
      { path: 'login', element: <Login /> },
      { path: 'register', element: <Register /> },
    ],
  },
]);

