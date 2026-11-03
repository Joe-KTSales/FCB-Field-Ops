import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { assignWorkOrder, deptLabel, putMemberOnCrewDay, unassignStop, useCrews, useDepartments, useEmployees } from '@/lib/data';
import { clock, longDate, shift, shortDate, todayIso } from '@/lib/dates';
import type { BoardCrewDay, BoardMember, BoardStop, TrayItem, WoStatus } from '@/lib/types';
import NewWorkOrder from '@/components/NewWorkOrder';
import WorkOrderDrawer from '@/components/WorkOrderDrawer';
import { Button, ErrorBox, PwBadge, SectionLabel, Spinner, StatusText, TypePill, cx } from '@/components/ui';


function MemberChip({ m, onToggle, disabled }: { m: BoardMember; onToggle: () => void; disabled: boolean }) {
  const out = m.status === 'called_out' || m.status === 'no_show';
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={out ? 'Click to mark back in' : 'Click to mark called out'}
      className={cx(
        'min-h-8 rounded-full border px-2.5 text-[13px]',
        out ? 'border-red-300 bg-red-100 font-semibold text-red-800 line-through'
          : m.position === 'lead' ? 'border-navy bg-navy font-semibold text-white'
          : 'border-slate-300 bg-slate-100 text-slate-900',
      )}
    >
      {m.position === 'lead' ? '★ ' : ''}{m.name}{out ? ' · OUT' : ''}
    </button>
  );
}

function StopCard({ s, selected, onOpen, onUp, onDown, onRemove, canEdit }: {
  s: BoardStop; selected: boolean; onOpen: () => void; onUp?: () => void; onDown?: () => void; onRemove: () => void; canEdit: boolean;
}) {
  return (
    <div
      draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.setData('text/wo', s.work_order_id); e.dataTransfer.effectAllowed = 'move'; }}
      className={cx('rounded-lg border bg-white', selected ? 'border-2 border-brand bg-blue-50' : 'border-slate-200')}
    >
      <button onClick={onOpen} className="flex w-full flex-col gap-0.5 p-2.5 text-left">
        <div className="flex w-full items-center gap-2">
          {s.planned_time && <span className="font-mono text-xs text-slate-600">{clock(s.planned_time)}</span>}
          <TypePill type={s.type} />
          {s.prevailing_wage && <PwBadge />}
          <span className="font-mono text-xs text-slate-500">{s.number}</span>
          <span className="flex-1" />
          <StatusText status={s.status} />
        </div>
        <div className={cx('text-[15px] font-semibold', s.status === 'canceled' && 'text-slate-500 line-through')}>{s.job}</div>
        <div className="text-[13px] text-slate-600">{s.customer}{s.city ? ` · ${s.city}` : ''}</div>
        {s.open_flags > 0 && <div className="mt-1 text-xs font-semibold text-red-700">{s.open_flags} open flag{s.open_flags > 1 ? 's' : ''}</div>}
      </button>
      {canEdit && (
        <div className="flex border-t border-slate-100 text-xs text-slate-600">
          <button disabled={!onUp} onClick={onUp} aria-label={`Move ${s.number} up`} className="min-h-8 flex-1 hover:bg-slate-50">↑</button>
          <button disabled={!onDown} onClick={onDown} aria-label={`Move ${s.number} down`} className="min-h-8 flex-1 hover:bg-slate-50">↓</button>
          <button onClick={onRemove} className="min-h-8 flex-[2] hover:bg-slate-50">Unassign</button>
        </div>
      )}
    </div>
  );
}

function TrayCard({ t, crews, onAssign, canEdit, onOpen }: { t: TrayItem; crews: { id: string; name: string }[]; onAssign: (crewId: string) => void; canEdit: boolean; onOpen: () => void }) {
  return (
    <div
      draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.setData('text/wo', t.id); e.dataTransfer.effectAllowed = 'move'; }}
      className="flex flex-col gap-1.5 rounded-lg border border-dashed border-slate-400 bg-white p-3"
    >
      <button onClick={onOpen} className="flex flex-col gap-1 text-left">
        <div className="flex items-center gap-2">
          <TypePill type={t.type_code} />
          {t.prevailing_wage && <PwBadge />}
          <span className="font-mono text-xs text-slate-600">{t.number}</span>
          <span className="flex-1" />
          {t.priority > 0 && <span className="text-xs font-bold text-red-700">{t.priority > 1 ? 'URGENT' : 'HIGH'}</span>}
        </div>
        <div className="text-[15px] font-semibold">{t.job}</div>
        <div className="text-[13px] text-slate-600">{t.customer}{t.city ? ` · ${t.city}` : ''}</div>
        {t.scope && <div className="line-clamp-2 text-[13px] text-slate-700">{t.scope}</div>}
      </button>
      {canEdit && (
        <select
          aria-label={`Assign ${t.number} to a crew`}
          className="min-h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          value=""
          onChange={(e) => e.target.value && onAssign(e.target.value)}
        >
          <option value="">Assign to crew…</option>
          {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
    </div>
  );
}

export default function Dispatch() {
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || todayIso();
  const [dept, setDeptState] = useState<string>(() => {
    try { return localStorage.getItem('fcb-dispatch-dept') || 'all'; } catch { return 'all'; }
  });
  const setDept = (d: string) => { setDeptState(d); try { localStorage.setItem('fcb-dispatch-dept', d); } catch { /* private mode */ } };
  const departments = useDepartments();
  const [sel, setSel] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const crews = useCrews();
  const employees = useEmployees();
  const setDate = (d: string) => setParams({ date: d });

  const board = useQuery({
    queryKey: ['board', date],
    queryFn: async () => must(await supabase.from('v_dispatch_board').select('*').eq('work_date', date)) as BoardCrewDay[],
  });
  const tray = useQuery({
    queryKey: ['tray', date],
    queryFn: async () =>
      must(
        await supabase
          .from('v_unassigned_work_orders')
          .select('*')
          .or(`scheduled_date.is.null,scheduled_date.lte.${shift(date, 14)}`)
          .order('priority', { ascending: false })
          .order('scheduled_date', { ascending: true, nullsFirst: false })
          .limit(100),
      ) as TrayItem[],
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['board'] });
    qc.invalidateQueries({ queryKey: ['tray'] });
    qc.invalidateQueries({ queryKey: ['week'] });
  };
  const run = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: refresh });

  const crewOrder = useMemo(() => new Map((crews.data ?? []).map((c, i) => [c.id, i])), [crews.data]);
  const days = useMemo(
    () => [...(board.data ?? [])].sort((a, b) => (crewOrder.get(a.crew_id ?? '') ?? 999) - (crewOrder.get(b.crew_id ?? '') ?? 999)),
    [board.data, crewOrder],
  );
  const shown = days.filter((d) => dept === 'all' || d.department === dept);
  const deptCount = (k: string) => days.filter((d) => k === 'all' || d.department === k).length;

  const stats = useMemo(() => {
    let people = 0, out = 0, stops = 0, flags = 0;
    for (const d of shown) {
      people += d.members.length;
      out += d.members.filter((m) => m.status === 'called_out' || m.status === 'no_show').length;
      stops += d.stops.length;
      flags += d.stops.reduce((a, s) => a + s.open_flags, 0);
    }
    return `${shown.length} crews · ${people} people · ${stops} stops · ${out} out · ${flags} open flags`;
  }, [shown]);

  const onDayIds = new Set(days.flatMap((d) => d.members.map((m) => m.employee_id)));
  const benched = (employees.data ?? []).filter((e) => e.active && !onDayIds.has(e.id));
  const activeCrews = (crews.data ?? []).filter((c) => c.active && (dept === 'all' || c.department === dept));
  const trayToday = (tray.data ?? []).filter((t) => t.scheduled_date === date);
  const trayLater = (tray.data ?? []).filter((t) => t.scheduled_date && t.scheduled_date > date);
  const trayUndated = (tray.data ?? []).filter((t) => !t.scheduled_date);
  const trayOverdue = (tray.data ?? []).filter((t) => t.scheduled_date && t.scheduled_date < date);

  const toggleMember = (d: BoardCrewDay, m: BoardMember) =>
    run.mutate(async () => {
      const out = m.status === 'called_out' || m.status === 'no_show';
      if (!out) {
        const reason = window.prompt(`Mark ${m.name} as called out. Reason (optional):`, '');
        if (reason === null) return;
        must(await supabase.from('crew_day_members').update({ status: 'called_out', note: reason || null }).eq('crew_day_id', d.crew_day_id).eq('employee_id', m.employee_id));
      } else {
        must(await supabase.from('crew_day_members').update({ status: 'present' }).eq('crew_day_id', d.crew_day_id).eq('employee_id', m.employee_id));
      }
    });

  const moveStop = (d: BoardCrewDay, i: number, dir: -1 | 1) =>
    run.mutate(async () => {
      const a = d.stops[i], b = d.stops[i + dir];
      must(await supabase.from('crew_day_stops').update({ sequence: b.sequence }).eq('id', a.stop_id));
      must(await supabase.from('crew_day_stops').update({ sequence: a.sequence === b.sequence ? a.sequence + dir : a.sequence }).eq('id', b.stop_id));
    });

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-4 px-4 pt-4 pb-2 sm:px-6">
        <div className="flex items-center gap-1">
          <button aria-label="Previous day" onClick={() => setDate(shift(date, -1))} className="h-10 w-10 rounded-md border border-slate-300 bg-white text-lg">‹</button>
          <div className="px-3">
            <div className="text-[22px] font-bold">{longDate(date)}</div>
            <div className="text-[13px] text-slate-600">{stats}</div>
          </div>
          <button aria-label="Next day" onClick={() => setDate(shift(date, 1))} className="h-10 w-10 rounded-md border border-slate-300 bg-white text-lg">›</button>
          <input aria-label="Pick a date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="ml-2 min-h-10 rounded-md border border-slate-300 bg-white px-2 text-sm" />
          {date !== todayIso() && <Button size="sm" variant="ghost" onClick={() => setDate(todayIso())}>Today</Button>}
        </div>
        <div role="group" aria-label="Department" className="flex flex-wrap gap-1 rounded-lg bg-slate-200 p-1">
          {[['all', 'All'] as [string, string], ...(departments.data ?? []).map((d) => [d.code, deptLabel(d)] as [string, string])].map(([k, label]) => (
            <button key={k} onClick={() => setDept(k)} className={cx('min-h-9 rounded-md px-3 text-sm font-semibold whitespace-nowrap', dept === k ? 'bg-white shadow-sm' : 'text-slate-600')}>
              {label} · {deptCount(k)}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <Link to={`/week?date=${date}`} className="rounded-md border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 no-underline">Week view</Link>
        {canEdit && <Button variant="primary" onClick={() => setNewOpen(true)}>+ New work order</Button>}
      </div>

      <ErrorBox error={board.error || tray.error || run.error} />

      <div className="flex flex-wrap items-start gap-4 px-4 pt-2 pb-6 sm:px-6">
        <aside aria-label="Needs a crew" className="flex max-w-[300px] flex-[1_1_260px] flex-col gap-2.5">
          <SectionLabel>Needs a crew {canEdit && '· drag onto a crew'}</SectionLabel>
          {tray.isLoading && <Spinner />}
          {[['Overdue', trayOverdue], ['This day', trayToday], ['No date yet', trayUndated], ['Coming up (2 weeks)', trayLater]].map(([label, items]) =>
            (items as TrayItem[]).length ? (
              <div key={label as string} className="flex flex-col gap-2">
                <div className={cx('text-xs font-semibold', label === 'Overdue' ? 'text-red-700' : 'text-slate-600')}>{label as string}</div>
                {(items as TrayItem[]).map((t) => (
                  <TrayCard
                    key={t.id}
                    t={t}
                    canEdit={canEdit}
                    crews={activeCrews}
                    onOpen={() => setSel(t.id)}
                    onAssign={(crewId) => run.mutate(() => assignWorkOrder(t.id, crewId, date))}
                  />
                ))}
              </div>
            ) : null,
          )}
          {tray.data && tray.data.length === 0 && <p className="text-sm text-slate-500">Everything is on a crew.</p>}
        </aside>

        <section className="grid min-w-0 flex-[999_1_560px] grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-3">
          {board.isLoading && <Spinner />}
          {board.data && days.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed border-slate-400 bg-white p-6 text-center">
              <p className="font-semibold">No crews set up for {shortDate(date)} yet.</p>
              {canEdit && (
                <Button className="mt-3" variant="primary" disabled={run.isPending} onClick={() => run.mutate(async () => must(await supabase.rpc('load_default_roster', { p_date: date })))}>
                  Load the usual crews
                </Button>
              )}
            </div>
          )}
          {shown.map((d) => {
            const short = d.has_callout;
            return (
              <div
                key={d.crew_day_id}
                onDragOver={(e) => { if (canEdit && d.crew_id) { e.preventDefault(); setDropTarget(d.crew_day_id); } }}
                onDragLeave={() => setDropTarget((t) => (t === d.crew_day_id ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropTarget(null);
                  const wo = e.dataTransfer.getData('text/wo');
                  if (wo && d.crew_id) run.mutate(() => assignWorkOrder(wo, d.crew_id!, date));
                }}
                className={cx(
                  'flex flex-col rounded-[10px] border bg-slate-50',
                  short ? 'border-2 border-red-600' : 'border-slate-300',
                  dropTarget === d.crew_day_id && 'ring-4 ring-brand/30',
                )}
                style={{ borderTop: `4px solid ${short ? '#DC2626' : d.color ?? '#64748B'}` }}
              >
                <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                  <span className="h-3 w-3 rounded-sm" style={{ background: d.color ?? '#64748B' }} />
                  <h2 className="text-base font-bold">{d.crew_name}</h2>
                  <span className="flex-1" />
                  <span className="text-xs text-slate-600">{d.stops.length} {d.stops.length === 1 ? 'stop' : 'stops'}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
                  {d.members.map((m) => <MemberChip key={m.employee_id} m={m} disabled={!canEdit} onToggle={() => toggleMember(d, m)} />)}
                  {canEdit && (
                    <select
                      aria-label={`Add someone to ${d.crew_name}`}
                      value=""
                      onChange={(e) => {
                        const id = e.target.value;
                        if (id) run.mutate(() => putMemberOnCrewDay(id, d.crew_day_id, date, 'helper'));
                      }}
                      className="min-h-8 rounded-full border border-dashed border-slate-400 bg-white px-2 text-[13px] text-slate-700"
                    >
                      <option value="">+ person</option>
                      {benched.length > 0 && (
                        <optgroup label="Not on a crew today">
                          {benched.map((e) => <option key={e.id} value={e.id}>{e.display_name}</option>)}
                        </optgroup>
                      )}
                      {days.filter((o) => o.crew_day_id !== d.crew_day_id).map((o) => (
                        <optgroup key={o.crew_day_id} label={`Move from ${o.crew_name}`}>
                          {o.members.map((m) => <option key={m.employee_id} value={m.employee_id}>{m.name}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </div>
                {short && <div className="mx-3 mb-2.5 rounded-md border border-red-300 bg-red-50 px-2.5 py-2 text-[13px] font-semibold text-red-800">Short-handed — add a helper with “+ person”</div>}
                <div className="flex flex-col gap-2 px-2 pb-2.5">
                  {d.stops.map((s, i) => (
                    <StopCard
                      key={s.stop_id}
                      s={s}
                      canEdit={canEdit}
                      selected={sel === s.work_order_id}
                      onOpen={() => setSel(s.work_order_id)}
                      onUp={i > 0 ? () => moveStop(d, i, -1) : undefined}
                      onDown={i < d.stops.length - 1 ? () => moveStop(d, i, 1) : undefined}
                      onRemove={() => run.mutate(() => unassignStop(s.stop_id))}
                    />
                  ))}
                  {d.stops.length === 0 && <div className="rounded-md border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500">Drop a work order here</div>}
                </div>
              </div>
            );
          })}
        </section>

        {sel && (
          <WorkOrderDrawer
            id={sel}
            onClose={() => setSel(null)}
            onChanged={refresh}
            onStatus={(status: WoStatus) => run.mutate(async () => must(await supabase.from('work_orders').update({ status }).eq('id', sel)))}
          />
        )}
      </div>

      {newOpen && <NewWorkOrder open onClose={() => setNewOpen(false)} defaultDate={date} defaultType={departments.data?.find((d) => d.code === dept)?.work_type} />}
    </div>
  );
}
