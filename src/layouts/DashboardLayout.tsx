import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { MessageSquare, LayoutDashboard, Users, UserPlus, Settings, LineChart, BrainCircuit, LogOut } from 'lucide-react';
import { supabase } from '@/utils/supabase';
import { Button } from '@/components/ui/button';

export default function DashboardLayout() {
  const navigate = useNavigate();
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    // Check if user is authenticated
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth/login');
      } else {
        setUserEmail(session.user.email ?? 'User');
      }
    };

    checkAuth();

    // Listen for auth changes (e.g. logging out from another tab)
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        navigate('/auth/login');
      } else {
        setUserEmail(session.user.email ?? 'User');
      }
    });

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [navigate]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/auth/login');
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-card flex flex-col">
        <div className="p-6">
          <h2 className="text-2xl font-bold text-primary">BOTD</h2>
        </div>
        <nav className="flex-1 px-4 space-y-2">
          <Link to="/dashboard" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm">
            <LayoutDashboard size={18} /> Dashboard
          </Link>
          <Link to="/inbox" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm">
            <MessageSquare size={18} /> Inbox
          </Link>
          <div className="pt-4 pb-1">
            <p className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">CRM</p>
          </div>
          <Link to="/crm/customers" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm">
            <Users size={18} /> Customers
          </Link>
          <Link to="/crm/leads" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm">
            <UserPlus size={18} /> Leads
          </Link>
          <div className="pt-4 pb-1">
            <p className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Growth</p>
          </div>
          <Link to="/ai" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm">
            <BrainCircuit size={18} /> AI Settings
          </Link>
          <Link to="/analytics" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm">
            <LineChart size={18} /> Analytics
          </Link>
        </nav>
        <div className="p-4 border-t">
          <Link to="/settings" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent text-sm">
            <Settings size={18} /> Settings
          </Link>
        </div>
      </aside>
      
      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 border-b flex items-center justify-between px-6 bg-card">
          <div className="font-medium text-sm text-muted-foreground">Workspace</div>
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium">{userEmail}</span>
            <Button variant="outline" size="sm" onClick={handleLogout} className="flex items-center gap-2">
              <LogOut size={16} />
              Logout
            </Button>
          </div>
        </header>
        <div className="flex-1 overflow-auto bg-muted/20">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
