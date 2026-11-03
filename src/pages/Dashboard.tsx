import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { dayLabel, longDate, mondayOf, monthDay, shift, todayIso } from '@/lib/dates';
import type { BoardCrewDay, WoStatus, WoType } from '@/lib/types';
import { Card, ErrorBox, PwBadge, SectionLabel, Spinner, StatusText, TYPE_META, TypePill, cx } from '@/components/ui';

interface Wo {
  id: string; number: string; type_code: WoType; status: WoStatus; status_reason: string | null; scheduled_date: string | null;
  priority: number; crew_on_site: boolean; created_at: string; job_id: string; job: string; city: string | null; customer: string;
  prevailing_wage: boolean; open_flags: number; max_flag_severity: number; open_flag_labels: string | null;
  crew_name: string | null; has_unmatched_worker: boolean;
}

const OPEN: WoStatus[] = ['planned', 'started', 'on_hold'];

function Tile({ n, label, to, tone }: { n: number | string; label: string; to?: string; tone?: 'warn' | 'bad' }) {
  const body = (
    <>
      <div className={cx('text-[28px] leading-none font-bold', tone === 'bad' && n !== 0 && 'text-red-700', tone === 'warn' && n !== 0 && 'text-amber-700')}>{n}</div>
      <div className="mt-1.5 text-[13px] text-slate-600">{label}</div>
    </>
  );
  const cls = 'rounded-[10px] border border-slate-300 bg-white px-4 py-3.5';
  return to ? <Link to={to} className={cx(cls, 'text-slate-900 no-underline hover:border-brand')}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** Single-series weekly bars: thin marks, rounded data-end, recessive grid, hover tooltip, table for screen readers. */
function WeeklyBars({ weeks }: { weeks: { label: string; start: string; done: number; canceled: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 200, padL = 28, padB = 26, padT = 12;   // drawn at real pixel size so text stays 11px
  const max = Math.max(4, ...weeks.map((w) => w.done));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const bw = (W - padL) / weeks.length;
  const barW = Math.min(36, bw * 0.55);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top);
  return (
    <div className="relative" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Work orders completed per week, last 8 weeks">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={padL} x2={W} y1={y(i * step)} y2={y(i * step)} stroke="#E2E8F0" strokeWidth={1} />
            <text x={padL - 6} y={y(i * step) + 4} textAnchor="end" fontSize="11" fill="#64748B">{i * step}</text>
          </g>
        ))}
        {weeks.map((w, i) => {
          const x = padL + i * bw + (bw - barW) / 2;
          const h = y(0) - y(w.done);
          const r = Math.min(4, h);
          return (
            <g key={w.start} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + i * bw} y={padT} width={bw} height={H - padT - padB} fill="transparent" />
              {w.done > 0 && (
                <path
                  d={`M${x},${y(0)} V${y(w.done) + r} Q${x},${y(w.done)} ${x + r},${y(w.done)} H${x + barW - r} Q${x + barW},${y(w.done)} ${x + barW},${y(w.done) + r} V${y(0)} Z`}
                  fill={hover === i ? '#1D4ED8' : '#2563EB'}
                />
              )}
              <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#475569">{w.label}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-0 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-lg" style={{ left: padL + hover * bw + bw / 2, transform: 'translateX(-50%)' }}>
          <div className="font-semibold">Week of {weeks[hover].label}</div>
          <div>{weeks[hover].done} completed · {weeks[hover].canceled} canceled</div>
        </div>
      )}
      <table className="sr-only">
        <caption>Work orders completed per week</caption>
        <thead><tr><th>Week of</th><th>Completed</th><th>Canceled</th></tr></thead>
        <tbody>{weeks.map((w) => <tr key={w.start}><td>{w.label}</td><td>{w.done}</td><td>{w.canceled}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export default function Dashboard() {
  const { profile, isAdmin } = useAuth();
  const today = todayIso();
  const statsFrom = shift(mondayOf(today), -49); // 8 weeks incl. this one
  const horizon = shift(today, 13);

  const ranged = useQuery({
    queryKey: ['dash-wos', statsFrom, horizon],
    queryFn: async () =>
      must(await supabase.from('v_work_order_overview').select('*').gte('scheduled_date', statsFrom).lte('scheduled_date', horizon).limit(5000)) as Wo[],
  });
  const undated = useQuery({
    queryKey: ['dash-undated'],
    queryFn: async () => must(await supabase.from('v_work_order_overview').select('*').is('scheduled_date', null).in('status', OPEN).limit(500)) as Wo[],
  });
  const flagged = useQuery({
    queryKey: ['dash-flagged'],
    queryFn: async () => must(await supabase.from('v_work_order_overview').select('*').gt('open_flags', 0).order('max_flag_severity', { ascending: false }).limit(300)) as Wo[],
  });
  const board = useQuery({
    queryKey: ['board', today],
    queryFn: async () => must(await supabase.from('v_dispatch_board').select('*').eq('work_date', today)) as BoardCrewDay[],
  });
  const absences = useQuery({
    queryKey: ['dash-absences', today],
    queryFn: async () =>
      must(await supabase.from('employee_absences').select('id, absence_date, kind, employee:employees(id, display_name)').gte('absence_date', shift(today, -29)).order('absence_date', { ascending: false })) as unknown as {
        id: string; absence_date: string; kind: string; employee: { id: string; display_name: string };
      }[],
  });
  const scans = useQuery({
    queryKey: ['dash-scans'],
    queryFn: async () => must(await supabase.from('work_order_scans').select('status').in('status', ['uploaded', 'processing', 'needs_review', 'failed'])) as { status: string }[],
  });
  const pwConfirm = useQuery({
    queryKey: ['dash-pw-confirm'],
    enabled: isAdmin,
    queryFn: async () => {
      const { count, error } = await supabase.from('prevailing_wage_periods').select('id', { count: 'exact', head: true }).eq('needs_review', true);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const all = useMemo(() => [...(ranged.data ?? []), ...(undated.data ?? [])], [ranged.data, undated.data]);
  const d = useMemo(() => {
    const open = all.filter((w) => OPEN.includes(w.status));
    const needsCrew = open.filter((w) => !w.crew_name && (!w.scheduled_date || w.scheduled_date >= today));
    const overdue = open.filter((w) => w.scheduled_date && w.scheduled_date < today);
    const soonNoCrew = needsCrew.filter((w) => w.scheduled_date && w.scheduled_date <= shift(today, 2));
    const urgent = needsCrew.filter((w) => w.priority > 0);
    const severe = (flagged.data ?? []).filter((w) => w.max_flag_severity >= 3);
    const pwUnmatched = all.filter((w) => w.prevailing_wage && w.has_unmatched_worker && w.scheduled_date && w.scheduled_date >= shift(today, -13));
    const upcomingDays = Array.from({ length: 7 }, (_, i) => shift(today, i)).map((day) => ({
      day,
      wos: all.filter((w) => w.scheduled_date === day && w.status !== 'canceled').sort((a, b) => (a.crew_name ?? 'zzz').localeCompare(b.crew_name ?? 'zzz')),
    }));
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const start = shift(statsFrom, i * 7);
      const inWeek = all.filter((w) => w.scheduled_date && w.scheduled_date >= start && w.scheduled_date <= shift(start, 6));
      return { start, label: monthDay(start), done: inWeek.filter((w) => w.status === 'complete').length, canceled: inWeek.filter((w) => w.status === 'canceled').length };
    });
    const past = all.filter((w) => w.scheduled_date && w.scheduled_date >= shift(today, -29) && w.scheduled_date <= today);
    const done30 = past.filter((w) => w.status === 'complete');
    const canceled30 = past.filter((w) => w.status === 'canceled');
    const byType = (['IN', 'ST', 'FN'] as WoType[]).map((t) => [t, done30.filter((w) => w.type_code === t).length] as const);
    const jobsWithFlags = new Map<string, { job: string; job_id: string; customer: string; n: number }>();
    for (const w of flagged.data ?? []) {
      const r = jobsWithFlags.get(w.job_id) ?? { job: w.job, job_id: w.job_id, customer: w.customer, n: 0 };
      r.n += w.open_flags;
      jobsWithFlags.set(w.job_id, r);
    }
    return {
      open, needsCrew, overdue, soonNoCrew, urgent, severe, pwUnmatched, upcomingDays, weeks, done30, canceled30, byType,
      topFlagJobs: [...jobsWithFlags.values()].sort((a, b) => b.n - a.n).slice(0, 5),
      openFlags: (flagged.data ?? []).reduce((a, w) => a + w.open_flags, 0),
    };
  }, [all, flagged.data, today, statsFrom]);

  const crewsToday = board.data ?? [];
  const peopleToday = crewsToday.reduce((a, c) => a + c.members.filter((m) => m.status !== 'called_out' && m.status !== 'no_show').length, 0);
  const outToday = crewsToday.flatMap((c) => c.members.filter((m) => m.status === 'called_out' || m.status === 'no_show').map((m) => ({ ...m, crew: c.crew_name })));
  const shortCrews = crewsToday.filter((c) => c.has_callout);
  const scansWaiting = (scans.data ?? []).filter((s) => s.status !== 'failed').length;
  const scansFailed = (scans.data ?? []).filter((s) => s.status === 'failed').length;
  const calloutsByPerson = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const a of absences.data ?? []) {
      const r = m.get(a.employee.id) ?? { name: a.employee.display_name, n: 0 };
      r.n += 1;
      m.set(a.employee.id, r);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 5);
  }, [absences.data]);

  type Alert = { tone: 'bad' | 'warn' | 'info'; text: string; detail?: string; to: string };
  const alerts: Alert[] = [
    ...shortCrews.map((c) => ({ tone: 'bad' as const, text: `${c.crew_name} is short-handed today`, detail: c.members.filter((m) => m.status === 'called_out' || m.status === 'no_show').map((m) => m.name).join(', ') + ' out', to: `/dispatch?date=${today}` })),
    ...d.soonNoCrew.map((w) => ({ tone: 'bad' as const, text: `${w.number} has no crew — ${dayLabel(w.scheduled_date!)} ${monthDay(w.scheduled_date!)}`, detail: `${w.job} · ${w.customer}`, to: `/dispatch?date=${w.scheduled_date}` })),
    ...d.overdue.map((w) => ({ tone: 'warn' as const, text: `${w.number} is past its date and still ${w.status.replace('_', ' ')}`, detail: `${w.job} · was ${monthDay(w.scheduled_date!)}`, to: `/work-orders/${w.id}` })),
    ...d.severe.slice(0, 8).map((w) => ({ tone: 'warn' as const, text: `${w.open_flag_labels ?? 'Open flag'} — ${w.job}`, detail: `${w.number} · ${w.customer}`, to: `/work-orders/${w.id}` })),
    ...d.pwUnmatched.map((w) => ({ tone: 'warn' as const, text: `Unmatched name on a PW job — ${w.job}`, detail: `${w.number} · fix before the weekly PW report`, to: `/work-orders/${w.id}` })),
    ...(scansFailed ? [{ tone: 'warn' as const, text: `${scansFailed} scanned sheet${scansFailed > 1 ? 's' : ''} couldn’t be read`, to: '/intake' }] : []),
    ...(scansWaiting ? [{ tone: 'info' as const, text: `${scansWaiting} scanned sheet${scansWaiting > 1 ? 's' : ''} waiting for review`, to: '/intake' }] : []),
    ...(pwConfirm.data ? [{ tone: 'info' as const, text: `${pwConfirm.data} prevailing wage job matches to confirm`, to: '/pw' }] : []),
  ];
  const loading = ranged.isLoading || undated.isLoading || board.isLoading;

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <h1 className="text-[24px] font-bold">Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}</h1>
          <div className="text-sm text-slate-600">{longDate(today)}</div>
        </div>
        <Link to="/dispatch" className="rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-white no-underline">Open today’s dispatch board</Link>
      </div>
      <ErrorBox error={ranged.error || undated.error || flagged.error || board.error} />
      {loading && <Spinner />}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <Tile n={crewsToday.length} label={`crews out today · ${peopleToday} people`} to={`/dispatch?date=${today}`} />
        <Tile n={outToday.length} label="called out today" tone="bad" to={`/dispatch?date=${today}`} />
        <Tile n={d.needsCrew.length} label={`need a crew${d.urgent.length ? ` · ${d.urgent.length} high/urgent` : ''}`} tone="warn" to="/dispatch" />
        <Tile n={d.overdue.length} label="past their date, not done" tone="warn" to="/work-orders" />
        <Tile n={d.openFlags} label="open flags (repairs, not ready…)" tone="warn" to="/work-orders?flagged=1" />
        <Tile n={scansWaiting} label="scanned sheets to review" to="/intake" />
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <Card className="flex min-w-0 flex-[999_1_520px] flex-col gap-3 p-4">
          <div className="flex items-center"><h2 className="flex-1 text-base font-bold">Next 7 days</h2><Link to="/week" className="text-sm">Week view →</Link></div>
          {d.upcomingDays.map(({ day, wos }) => (
            <div key={day} className="border-t border-slate-100 pt-2.5">
              <Link to={`/dispatch?date=${day}`} className="flex items-baseline gap-2 text-slate-900 no-underline">
                <span className="w-24 text-sm font-bold">{day === today ? 'Today' : day === shift(today, 1) ? 'Tomorrow' : `${dayLabel(day)} ${monthDay(day)}`}</span>
                <span className="text-xs text-slate-600">
                  {wos.length === 0 ? 'nothing scheduled' : (['IN', 'ST', 'FN'] as WoType[]).map((t) => { const n = wos.filter((w) => w.type_code === t).length; return n ? `${n} ${TYPE_META[t].label.toLowerCase()}` : null; }).filter(Boolean).join(' · ')}
                </span>
              </Link>
              {wos.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-1">
                  {wos.slice(0, 6).map((w) => (
                    <Link key={w.id} to={`/work-orders/${w.id}`} className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-900 no-underline hover:bg-slate-50">
                      <TypePill type={w.type_code} />
                      {w.prevailing_wage && <PwBadge />}
                      <span className="font-semibold">{w.job}</span>
                      <span className="text-slate-600">{w.customer}{w.city ? ` · ${w.city}` : ''}</span>
                      <span className="flex-1" />
                      {w.crew_name ? <span className="text-[13px] text-slate-700">{w.crew_name}</span> : <span className="text-[13px] font-semibold text-red-700">No crew yet</span>}
                      {w.open_flags > 0 && <span className="text-xs font-bold text-red-700">{w.open_flags} flag{w.open_flags > 1 ? 's' : ''}</span>}
                      <StatusText status={w.status} />
                    </Link>
                  ))}
                  {wos.length > 6 && <Link to={`/dispatch?date=${day}`} className="px-2 text-[13px]">+ {wos.length - 6} more on the board</Link>}
                </div>
              )}
            </div>
          ))}
        </Card>

        <Card className="flex max-w-[460px] flex-[1_1_340px] flex-col gap-2 p-4">
          <h2 className="text-base font-bold">Needs attention · {alerts.length}</h2>
          {alerts.length === 0 && !loading && <p className="text-sm text-slate-600">Nothing needs attention right now.</p>}
          {alerts.slice(0, 14).map((a, i) => (
            <Link key={i} to={a.to} className="flex gap-2.5 rounded-md px-2 py-2 text-slate-900 no-underline hover:bg-slate-50">
              <span aria-hidden="true" className={cx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', a.tone === 'bad' ? 'bg-red-600' : a.tone === 'warn' ? 'bg-amber-500' : 'bg-blue-500')} />
              <span className="flex flex-col">
                <span className="text-sm font-semibold"><span className="sr-only">{a.tone === 'bad' ? 'Urgent: ' : a.tone === 'warn' ? 'Warning: ' : ''}</span>{a.text}</span>
                {a.detail && <span className="text-[13px] text-slate-600">{a.detail}</span>}
              </span>
            </Link>
          ))}
          {alerts.length > 14 && <p className="px-2 text-[13px] text-slate-600">+ {alerts.length - 14} more</p>}
        </Card>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <Card className="flex min-w-0 flex-[999_1_520px] flex-col gap-3 p-4">
          <div className="flex items-baseline gap-2"><h2 className="flex-1 text-base font-bold">Completed work orders per week</h2><span className="text-xs text-slate-600">last 8 weeks · hover a bar</span></div>
          <WeeklyBars weeks={d.weeks} />
          <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3 border-t border-slate-100 pt-3">
            <div><SectionLabel>Done · 30 days</SectionLabel><div className="mt-1 text-[22px] font-bold">{d.done30.length}</div>
              <div className="text-xs text-slate-600">{d.byType.map(([t, n]) => `${n} ${TYPE_META[t].label.toLowerCase()}`).join(' · ')}</div></div>
            <div><SectionLabel>Canceled visits</SectionLabel><div className="mt-1 text-[22px] font-bold">{d.canceled30.length}</div>
              <div className="text-xs text-slate-600">{d.done30.length + d.canceled30.length ? `${Math.round((d.canceled30.length / (d.done30.length + d.canceled30.length)) * 100)}% of visits` : '—'} · crew went, couldn’t work</div></div>
            <div><SectionLabel>Call-outs · 30 days</SectionLabel><div className="mt-1 text-[22px] font-bold">{absences.data?.length ?? 0}</div>
              <div className="text-xs text-slate-600">{calloutsByPerson.length ? calloutsByPerson.slice(0, 2).map((p) => `${p.name} (${p.n})`).join(', ') : 'none'}</div></div>
          </div>
        </Card>
        <Card className="flex max-w-[460px] flex-[1_1_340px] flex-col gap-2 p-4">
          <h2 className="text-base font-bold">Jobs with the most open flags</h2>
          {d.topFlagJobs.length === 0 && <p className="text-sm text-slate-600">No open flags.</p>}
          {d.topFlagJobs.map((j) => (
            <Link key={j.job_id} to={`/jobs/${j.job_id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-900 no-underline hover:bg-slate-50">
              <span className="flex-1"><span className="font-semibold">{j.job}</span> <span className="text-slate-600">· {j.customer}</span></span>
              <span className="font-bold text-red-700">{j.n}</span>
            </Link>
          ))}
          {calloutsByPerson.length > 0 && (
            <>
              <h2 className="mt-3 text-base font-bold">Most call-outs · 30 days</h2>
              {calloutsByPerson.map((p) => (
                <div key={p.name} className="flex items-center gap-2 px-2 py-1 text-sm"><span className="flex-1">{p.name}</span><span className="font-bold">{p.n}</span></div>
              ))}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
