import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useAuth, ROLE_LABEL } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { cx } from './ui';

function useIntakeCount() {
  return useQuery({
    queryKey: ['scan-count'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('work_order_scans')
        .select('id', { count: 'exact', head: true })
        .in('status', ['uploaded', 'processing', 'needs_review']);
      return count ?? 0;
    },
  }).data ?? 0;
}

const Icon = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  board: <><rect x="3" y="4" width="7" height="16" rx="1.5" /><rect x="14" y="4" width="7" height="10" rx="1.5" /></>,
  week: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  jobs: <><path d="M3 7h18v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></>,
  more: <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
};
function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Dashboard'], [/^\/dispatch/, 'Dispatch'], [/^\/week/, 'Week'], [/^\/work-orders\/.+/, 'Work order'],
  [/^\/work-orders/, 'Work orders'], [/^\/jobs\/.+/, 'Job folder'], [/^\/jobs/, 'Jobs'], [/^\/customers/, 'Customer'],
  [/^\/intake/, 'Paper intake'], [/^\/pw/, 'PW report'], [/^\/crews/, 'Crews'], [/^\/admin/, 'Admin'],
];

export default function Layout() {
  const { profile, role, isAdmin, signOut } = useAuth();
  const dash = role === 'admin' || role === 'manager' || role === 'read_only_manager';
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const intake = useIntakeCount();
  useEffect(() => { setMoreOpen(false); setSearchOpen(false); }, [loc.pathname]);

  const links: [string, string, boolean][] = [
    ['/', 'Dashboard', dash],
    ['/dispatch', 'Dispatch', true],
    ['/week', 'Week', true],
    ['/work-orders', 'Work orders', true],
    ['/jobs', 'Jobs', true],
    ['/intake', 'Paper intake', true],
    ['/pw', 'PW report', isAdmin],
    ['/crews', 'Crews', true],
    ['/admin', 'Admin', isAdmin],
  ];
  const tabs: [string, string, ReactNode][] = [
    ...(dash ? [['/', 'Home', Icon.home] as [string, string, ReactNode]] : []),
    ['/dispatch', 'Dispatch', Icon.board],
    ['/week', 'Week', Icon.week],
    ['/jobs', 'Jobs', Icon.jobs],
  ];
  const inTabs = tabs.some(([to]) => (to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(to)));
  const title = TITLES.find(([re]) => re.test(loc.pathname))?.[1] ?? 'Field Ops';
  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) nav(`/jobs?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* ---------- desktop / tablet header ---------- */}
      <header className="hidden flex-wrap items-center gap-x-6 gap-y-2 bg-navy px-6 py-3 text-white lg:flex">
        <NavLink to="/" className="flex items-center gap-2.5 text-white no-underline">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-[13px] font-bold">FCB</span>
          <span className="text-base font-semibold">Field Ops</span>
        </NavLink>
        <nav aria-label="Main" className="flex flex-wrap gap-1 text-sm">
          {links.filter((l) => l[2]).map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => cx('rounded-md px-3 py-2 no-underline', isActive ? 'bg-brand font-semibold text-white' : 'text-navy-text hover:text-white')}
            >
              {label}
              {to === '/intake' && intake > 0 && <span className="ml-1 rounded-full bg-white px-1.5 text-xs font-bold text-navy">{intake}</span>}
            </NavLink>
          ))}
        </nav>
        <form className="flex flex-1 justify-end" onSubmit={submitSearch}>
          <label className="flex w-full max-w-xs items-center gap-2 rounded-md bg-navy-2 px-3 py-2">
            <span className="text-slate-400"><Svg size={16}>{Icon.search}</Svg></span>
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

      {/* ---------- phone header ---------- */}
      <header className="sticky top-0 z-30 flex items-center gap-3 bg-navy px-4 pt-[max(env(safe-area-inset-top),10px)] pb-2.5 text-white lg:hidden">
        <NavLink to="/" aria-label="Home" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand text-[13px] font-bold text-white no-underline">FCB</NavLink>
        {searchOpen ? (
          <form className="flex flex-1 items-center gap-2" onSubmit={submitSearch}>
            <label className="flex flex-1 items-center gap-2 rounded-md bg-navy-2 px-3 py-2">
              <span className="sr-only">Search jobs</span>
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search jobs, customers…" className="w-full bg-transparent text-base text-white outline-none placeholder:text-slate-400" />
            </label>
            <button type="button" aria-label="Close search" onClick={() => setSearchOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-md text-navy-text"><Svg>{Icon.close}</Svg></button>
          </form>
        ) : (
          <>
            <div className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</div>
            <button aria-label="Search jobs" onClick={() => setSearchOpen(true)} className="flex h-10 w-10 items-center justify-center rounded-md text-navy-text"><Svg>{Icon.search}</Svg></button>
          </>
        )}
      </header>

      <main className="flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:pb-0">
        <Outlet />
      </main>

      {/* ---------- phone bottom tabs ---------- */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
        {tabs.map(([to, label, icon]) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cx('flex min-h-[60px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold no-underline', isActive ? 'text-brand' : 'text-slate-500')}>
            <Svg>{icon}</Svg>{label}
          </NavLink>
        ))}
        <button onClick={() => setMoreOpen(true)} className={cx('relative flex min-h-[60px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold', !inTabs ? 'text-brand' : 'text-slate-500')}>
          <Svg>{Icon.more}</Svg>More
          {intake > 0 && <span className="absolute top-2 right-[calc(50%-18px)] h-2.5 w-2.5 rounded-full bg-red-600" aria-label={`${intake} scans to review`} />}
        </button>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="More">
          <button aria-label="Close menu" className="absolute inset-0 bg-slate-900/40" onClick={() => setMoreOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white pb-[calc(16px+env(safe-area-inset-bottom))]">
            <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-slate-300" />
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3.5">
              <div className="flex-1 leading-tight">
                <div className="font-semibold">{profile?.full_name || profile?.email}</div>
                <div className="text-xs text-slate-600">{role ? ROLE_LABEL[role] : ''}</div>
              </div>
              <button onClick={signOut} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold">Sign out</button>
            </div>
            <div className="grid grid-cols-2 gap-2 p-4">
              {links.filter((l) => l[2]).map(([to, label]) => (
                <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cx('flex min-h-14 items-center justify-between rounded-lg border px-4 text-[15px] font-semibold no-underline', isActive ? 'border-brand bg-blue-50 text-blue-900' : 'border-slate-200 text-slate-900')}>
                  {label}
                  {to === '/intake' && intake > 0 && <span className="rounded-full bg-red-600 px-2 text-xs font-bold text-white">{intake}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
