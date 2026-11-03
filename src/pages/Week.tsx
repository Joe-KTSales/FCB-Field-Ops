import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endOfMonth, endOfWeek, format, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { assignWorkOrder, deptLabel, useCrews, useDepartments } from '@/lib/data';
import { dayLabel, iso, monthDay, mondayOf, shift, todayIso, weekDays } from '@/lib/dates';
import type { BoardCrewDay, BoardStop, WoStatus, WoType } from '@/lib/types';
import { ErrorBox, PwBadge, Spinner, TYPE_META, cx } from '@/components/ui';

type Chip = BoardStop & { crew_name: string; crew_id: string | null; date: string };

function ChipView({ c, canEdit, showCrew }: { c: Chip; canEdit: boolean; showCrew?: boolean }) {
  return (
    <Link
      to={`/work-orders/${c.work_order_id}`}
      draggable={canEdit}
      onDragStart={(e) => e.dataTransfer.setData('text/wo', c.work_order_id)}
      className={cx('flex flex-col gap-px rounded-md px-1.5 py-1 no-underline', TYPE_META[c.type].tint)}
    >
      <span className="flex items-center gap-1">
        <span className="font-mono text-[11px] opacity-80">{c.type}</span>
        {c.prevailing_wage && <PwBadge solid />}
        {c.open_flags > 0 && <span className="rounded bg-red-600 px-1 text-[10px] font-bold text-white">!</span>}
      </span>
      <span className={cx('text-[13px] leading-tight font-semibold', c.status === 'canceled' && 'line-through')}>
        {showCrew ? c.crew_name : c.job}
      </span>
    </Link>
  );
}

function MonthView({ anchor }: { anchor: string }) {
  const nav = useNavigate();
  const first = iso(startOfWeek(startOfMonth(parseISO(anchor)), { weekStartsOn: 1 }));
  const last = iso(endOfWeek(endOfMonth(parseISO(anchor)), { weekStartsOn: 1 }));
  const q = useQuery({
    queryKey: ['month', first],
    queryFn: async () =>
      must(
        await supabase.from('work_orders').select('id, type_code, status, scheduled_date').gte('scheduled_date', first).lte('scheduled_date', last).neq('status', 'canceled'),
      ) as { id: string; type_code: WoType; status: WoStatus; scheduled_date: string }[],
  });
  const byDay = useMemo(() => {
    const m = new Map<string, Record<WoType, number>>();
    for (const w of q.data ?? []) {
      const r = m.get(w.scheduled_date) ?? { IN: 0, ST: 0, FN: 0 };
      r[w.type_code] += 1;
      m.set(w.scheduled_date, r);
    }
    return m;
  }, [q.data]);
  const days: string[] = [];
  for (let d = first; d <= last; d = shift(d, 1)) days.push(d);
  const month = parseISO(anchor).getMonth();
  return (
    <div className="overflow-x-auto rounded-[10px] border border-slate-300 bg-white">
      <div className="grid min-w-[760px] grid-cols-7">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="border-b border-slate-300 bg-slate-50 px-3 py-2 text-xs font-bold tracking-wider text-slate-600 uppercase">{d}</div>
        ))}
        {days.map((d) => {
          const c = byDay.get(d);
          return (
            <button
              key={d}
              onClick={() => nav(`/?date=${d}`)}
              className={cx('flex min-h-24 flex-col gap-1 border-b border-l border-slate-200 p-2 text-left hover:bg-blue-50', parseISO(d).getMonth() !== month && 'bg-slate-50 text-slate-400', d === todayIso() && 'ring-2 ring-brand ring-inset')}
            >
              <span className="text-sm font-bold">{parseISO(d).getDate()}</span>
              {c && (Object.keys(c) as WoType[]).filter((t) => c[t]).map((t) => (
                <span key={t} className={cx('rounded px-1.5 py-0.5 text-xs font-semibold', TYPE_META[t].tint)}>{c[t]} {TYPE_META[t].label}</span>
              ))}
            </button>
          );
        })}
      </div>
      {q.isLoading && <Spinner />}
    </div>
  );
}

export default function Week() {
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const anchor = params.get('date') || todayIso();
  const range = (params.get('range') as 'week' | 'month') || 'week';
  const monday = mondayOf(anchor);
  const days = weekDays(monday);
  const [rowsBy, setRowsBy] = useState<'crews' | 'jobs'>('crews');
  const [pwOnly, setPwOnly] = useState(false);
  const [dept, setDept] = useState('all');
  const departments = useDepartments();
  const crews = useCrews();
  const set = (p: Record<string, string>) => setParams({ date: anchor, range, ...p });

  const q = useQuery({
    queryKey: ['week', monday],
    enabled: range === 'week',
    queryFn: async () =>
      must(await supabase.from('v_dispatch_board').select('*').gte('work_date', days[0]).lte('work_date', days[6])) as BoardCrewDay[],
  });
  const move = useMutation({
    mutationFn: async (v: { wo: string; crewId: string; date: string }) => assignWorkOrder(v.wo, v.crewId, v.date),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['week'] }); qc.invalidateQueries({ queryKey: ['board'] }); qc.invalidateQueries({ queryKey: ['tray'] }); },
  });

  const chips: Chip[] = useMemo(
    () => (q.data ?? []).flatMap((d) => d.stops.map((s) => ({ ...s, crew_name: d.crew_name, crew_id: d.crew_id, date: d.work_date })))
      .filter((c) => !pwOnly || c.prevailing_wage),
    [q.data, pwOnly],
  );
  const outByCrewDate = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const d of q.data ?? []) {
      const out = d.members.filter((x) => x.status === 'called_out' || x.status === 'no_show').map((x) => x.name.split(' ')[0]);
      if (out.length) m.set(`${d.crew_id}|${d.work_date}`, out);
    }
    return m;
  }, [q.data]);

  const crewRows = (crews.data ?? []).filter((c) => c.active && (dept === 'all' || c.department === dept));
  const jobRows = useMemo(() => {
    const m = new Map<string, string>();
    chips.forEach((c) => m.set(c.job_id, c.job));
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [chips]);
  const cols = 'grid-cols-[200px_repeat(5,minmax(0,1fr))_110px_110px]';

  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button aria-label="Previous" onClick={() => set({ date: range === 'week' ? shift(monday, -7) : iso(startOfMonth(parseISO(shift(iso(startOfMonth(parseISO(anchor))), -1)))) })} className="h-10 w-10 rounded-md border border-slate-300 bg-white text-lg">‹</button>
          <div className="px-2 text-[22px] font-bold">
            {range === 'week' ? `Week of ${monthDay(days[0])} – ${monthDay(days[6])}, ${days[6].slice(0, 4)}` : format(parseISO(anchor), 'MMMM yyyy')}
          </div>
          <button aria-label="Next" onClick={() => set({ date: range === 'week' ? shift(monday, 7) : iso(startOfMonth(parseISO(shift(iso(endOfMonth(parseISO(anchor))), 1)))) })} className="h-10 w-10 rounded-md border border-slate-300 bg-white text-lg">›</button>
        </div>
        <div className="flex-1" />
        {range === 'week' && (
          <>
            <select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className="min-h-10 rounded-md border border-slate-300 bg-white px-2 text-sm">
              <option value="all">All departments</option>
              {(departments.data ?? []).map((d) => <option key={d.code} value={d.code}>{deptLabel(d)}</option>)}
            </select>
            <div role="group" aria-label="Rows" className="flex gap-1 rounded-lg bg-slate-200 p-1">
              {(['crews', 'jobs'] as const).map((r) => (
                <button key={r} onClick={() => setRowsBy(r)} className={cx('min-h-9 rounded-md px-3 text-sm font-semibold', rowsBy === r ? 'bg-white shadow-sm' : 'text-slate-600')}>Rows: {r === 'crews' ? 'Crews' : 'Jobs'}</button>
              ))}
            </div>
            <label className="flex min-h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold">
              <input type="checkbox" checked={pwOnly} onChange={(e) => setPwOnly(e.target.checked)} className="h-[18px] w-[18px]" /> PW jobs only
            </label>
          </>
        )}
        <div role="group" aria-label="Range" className="flex gap-1 rounded-lg bg-slate-200 p-1">
          <Link to={`/?date=${anchor}`} className="min-h-9 rounded-md px-3 py-2 text-sm font-semibold text-slate-600 no-underline">Day</Link>
          {(['week', 'month'] as const).map((r) => (
            <button key={r} onClick={() => set({ range: r })} className={cx('min-h-9 rounded-md px-3 text-sm font-semibold capitalize', range === r ? 'bg-white shadow-sm' : 'text-slate-600')}>{r}</button>
          ))}
        </div>
      </div>
      <ErrorBox error={q.error || move.error} />

      {range === 'month' ? (
        <MonthView anchor={anchor} />
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-slate-300 bg-white">
          <div className="min-w-[1180px]">
            <div className={cx('grid border-b border-slate-300 bg-slate-50', cols)}>
              <div className="px-3.5 py-2.5 text-xs font-bold tracking-wider text-slate-600 uppercase">{rowsBy === 'crews' ? 'Crew' : 'Job'}</div>
              {days.map((d, i) => (
                <Link key={d} to={`/?date=${d}`} className={cx('border-l border-slate-200 px-3 py-2.5 text-slate-900 no-underline hover:bg-blue-50', i > 4 && 'bg-slate-100 text-slate-500', d === todayIso() && 'bg-blue-50')}>
                  <div className="text-xs font-bold tracking-wider text-slate-600 uppercase">{dayLabel(d)}</div>
                  <div className="text-lg font-bold">{monthDay(d)}</div>
                </Link>
              ))}
            </div>
            {q.isLoading && <Spinner />}
            {rowsBy === 'crews'
              ? crewRows.map((c) => (
                  <div key={c.id} className={cx('grid border-b border-slate-200', cols)}>
                    <div className="flex items-center gap-2 px-3.5 py-2.5">
                      <span className="h-3 w-3 rounded-sm" style={{ background: c.color ?? '#64748B' }} />
                      <span className="text-[15px] font-bold">{c.name}</span>
                    </div>
                    {days.map((d, i) => {
                      const cell = chips.filter((x) => x.crew_id === c.id && x.date === d).sort((a, b) => a.sequence - b.sequence);
                      const out = outByCrewDate.get(`${c.id}|${d}`);
                      return (
                        <div
                          key={d}
                          onDragOver={(e) => canEdit && e.preventDefault()}
                          onDrop={(e) => { const wo = e.dataTransfer.getData('text/wo'); if (wo) move.mutate({ wo, crewId: c.id, date: d }); }}
                          className={cx('flex min-h-[58px] flex-col gap-1 border-l border-slate-200 p-1.5', i > 4 && 'bg-slate-50')}
                        >
                          {cell.map((x) => <ChipView key={x.stop_id} c={x} canEdit={canEdit} />)}
                          {out && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-bold text-red-800">Out: {out.join(', ')}</span>}
                        </div>
                      );
                    })}
                  </div>
                ))
              : jobRows.map(([jobId, name]) => (
                  <div key={jobId} className={cx('grid border-b border-slate-200', cols)}>
                    <Link to={`/jobs/${jobId}`} className="px-3.5 py-2.5 text-[15px] font-bold text-slate-900">{name}</Link>
                    {days.map((d, i) => (
                      <div key={d} className={cx('flex min-h-[58px] flex-col gap-1 border-l border-slate-200 p-1.5', i > 4 && 'bg-slate-50')}>
                        {chips.filter((x) => x.job_id === jobId && x.date === d).map((x) => <ChipView key={x.stop_id} c={x} canEdit={false} showCrew />)}
                      </div>
                    ))}
                  </div>
                ))}
            {rowsBy === 'jobs' && jobRows.length === 0 && !q.isLoading && <p className="p-6 text-sm text-slate-500">Nothing scheduled this week.</p>}
          </div>
        </div>
      )}
      {range === 'week' && (
        <p className="text-[13px] text-slate-600">
          Blue = install · green = stocking · amber = finals/repair · <b>PW</b> = prevailing wage · <b>!</b> = open flag · struck through = canceled.
          {canEdit && rowsBy === 'crews' && ' Drag a chip to another day or crew to reschedule.'}
        </p>
      )}
    </div>
  );
}
