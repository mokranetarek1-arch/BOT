import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { MessageSquare, LayoutDashboard, Users, UserPlus, Settings, LineChart, BrainCircuit, LogOut } from 'lucide-react';
import { supabase } from '@/utils/supabase';
import { Button } from '@/components/ui/button';
import { conversationService } from '@/services/conversationService';
import { readStateService } from '@/services/readStateService';

export default function DashboardLayout() {
  const navigate = useNavigate();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  // Function to calculate unread count across conversations
  const refreshUnreadCount = async () => {
    try {
      const convs = await conversationService.getConversations();
      let count = 0;
      for (const c of convs) {
        if (readStateService.isUnread(c.id, c.last_message_at)) {
          count++;
        }
      }
      setUnreadCount(count);
    } catch {
      // Ignore background fetch errors
    }
  };

  useEffect(() => {
    // Check if user is authenticated
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate('/auth/login');
      } else {
        setUserEmail(session.user.email ?? 'User');
        refreshUnreadCount();
      }
    };

    checkAuth();

    // Listen for auth changes (e.g. logging out from another tab)
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        navigate('/auth/login');
      } else {
        setUserEmail(session.user.email ?? 'User');
        refreshUnreadCount();
      }
    });

    // Listen to read state changes
    const onReadUpdate = () => refreshUnreadCount();
    window.addEventListener('botd-read-state-updated', onReadUpdate);

    // Poll for new messages every 15 seconds
    const interval = setInterval(refreshUnreadCount, 15000);

    return () => {
      authListener.subscription.unsubscribe();
      window.removeEventListener('botd-read-state-updated', onReadUpdate);
      clearInterval(interval);
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
          <Link to="/inbox" className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent text-sm">
            <div className="flex items-center gap-3">
              <MessageSquare size={18} />
              <span>Inbox</span>
            </div>
            {unreadCount > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-blue-600 text-white animate-pulse">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
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
