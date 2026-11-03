import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth, ROLE_LABEL } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { cx } from './ui';

function IntakeCount() {
  const q = useQuery({
    queryKey: ['scan-count'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('work_order_scans')
        .select('id', { count: 'exact', head: true })
        .in('status', ['uploaded', 'processing', 'needs_review']);
      return count ?? 0;
    },
  });
  if (!q.data) return null;
  return <span className="ml-1 rounded-full bg-white px-1.5 text-xs font-bold text-navy">{q.data}</span>;
}

export default function Layout() {
  const { profile, role, isAdmin, signOut } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const links: [string, string, boolean][] = [
    ['/', 'Dispatch', true],
    ['/week', 'Week', true],
    ['/work-orders', 'Work orders', true],
    ['/jobs', 'Jobs', true],
    ['/intake', 'Paper intake', true],
    ['/pw', 'PW report', isAdmin],
    ['/crews', 'Crews', true],
    ['/admin', 'Admin', isAdmin],
  ];
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-navy px-4 py-3 text-white sm:px-6">
        <NavLink to="/" className="flex items-center gap-2.5 text-white no-underline">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-[13px] font-bold">FCB</span>
          <span className="text-base font-semibold">Field Ops</span>
        </NavLink>
        <nav aria-label="Main" className="flex flex-wrap gap-1 text-sm">
          {links
            .filter((l) => l[2])
            .map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  cx('rounded-md px-3.5 py-2 no-underline', isActive ? 'bg-brand font-semibold text-white' : 'text-navy-text hover:text-white')
                }
              >
                {label}
                {to === '/intake' && <IntakeCount />}
              </NavLink>
            ))}
        </nav>
        <form
          className="flex flex-1 justify-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) nav(`/jobs?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <label className="flex w-full max-w-xs items-center gap-2 rounded-md bg-navy-2 px-3 py-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <span className="sr-only">Search jobs</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search jobs, customers, contractors…" className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-400" />
          </label>
        </form>
        <div className="flex items-center gap-3 text-sm">
          <div className="text-right leading-tight">
            <div className="font-semibold">{profile?.full_name || profile?.email}</div>
            <div className="text-xs text-navy-text">{role ? ROLE_LABEL[role] : ''}</div>
          </div>
          <button onClick={signOut} className="rounded-md bg-navy-2 px-3 py-2 text-navy-text hover:text-white">Sign out</button>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
