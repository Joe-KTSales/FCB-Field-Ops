import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery } from '@tanstack/react-query';
import { supabase, must } from './supabase';
import type { AppRole, Profile } from './types';

interface AuthCtx {
  session: Session | null;
  loading: boolean;
  profile: Profile | null;
  role: AppRole | null;
  isAdmin: boolean;
  /** dispatcher / manager / admin: can change work orders, crews, jobs */
  canEdit: boolean;
  /** anyone in the office except read-only can add notes and files */
  canNote: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const uid = session?.user.id;
  const profileQ = useQuery({
    queryKey: ['profile', uid],
    enabled: !!uid,
    queryFn: async () =>
      must(await supabase.from('profiles').select('*').eq('id', uid!).maybeSingle()) as Profile | null,
  });

  const profile = profileQ.data ?? null;
  const role = profile?.active ? profile.role : null;
  const value: AuthCtx = {
    session,
    loading: !ready || (!!uid && profileQ.isLoading),
    profile,
    role,
    isAdmin: role === 'admin',
    canEdit: role === 'admin' || role === 'manager' || role === 'dispatcher',
    canNote: !!role && ['admin', 'manager', 'dispatcher', 'shipping_coordinator'].includes(role),
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export const ROLE_LABEL: Record<AppRole, string> = {
  admin: 'Admin',
  manager: 'Field manager',
  read_only_manager: 'Read-only manager',
  dispatcher: 'Dispatcher',
  shipping_coordinator: 'Shipping coordinator',
  driver: 'Driver',
  lead_tech: 'Lead tech',
  tech: 'Tech',
};
