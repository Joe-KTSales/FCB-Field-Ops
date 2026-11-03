import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { shift, shortDate, todayIso } from '@/lib/dates';
import type { WoStatus, WoType } from '@/lib/types';
import NewWorkOrder from '@/components/NewWorkOrder';
import { Button, ErrorBox, Spinner, StatusText, TypePill, inputCls } from '@/components/ui';

interface Row {
  id: string; number: string; type_code: WoType; status: WoStatus; scheduled_date: string | null; scope: string | null; priority: number;
  job: { id: string; name: string; city: string | null; customer: { name: string } };
  flags: { id: string; resolved_at: string | null; type: { severity: number } }[];
}

export default function WorkOrders() {
  const { canEdit } = useAuth();
  const [status, setStatus] = useState<'open' | WoStatus | 'all'>('open');
  const [type, setType] = useState<'all' | WoType>('all');
  const [from, setFrom] = useState(shift(todayIso(), -30));
  const [to, setTo] = useState(shift(todayIso(), 30));
  const [flagged, setFlagged] = useState(false);
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [newOpen, setNewOpen] = useState(false);

  const q = useQuery({
    queryKey: ['wo-list', status, type, from, to],
    queryFn: async () => {
      let r = supabase
        .from('work_orders')
        .select('id, number, type_code, status, scheduled_date, scope, priority, job:jobs(id, name, city, customer:companies(name)), flags:work_order_flags!work_order_flags_work_order_id_fkey(id, resolved_at, type:flag_types(severity))')
        .order('scheduled_date', { ascending: false, nullsFirst: true })
        .limit(500);
      if (status === 'open') r = r.in('status', ['planned', 'started', 'on_hold']);
      else if (status !== 'all') r = r.eq('status', status);
      if (type !== 'all') r = r.eq('type_code', type);
      if (from) r = r.or(`scheduled_date.gte.${from},scheduled_date.is.null`);
      if (to) r = r.or(`scheduled_date.lte.${to},scheduled_date.is.null`);
      return must(await r) as unknown as Row[];
    },
  });

  const t = text.trim().toLowerCase();
  const rows = (q.data ?? []).filter(
    (r) =>
      (!flagged || r.flags.some((f) => !f.resolved_at && f.type.severity >= 2)) &&
      (!t || `${r.number} ${r.job.name} ${r.job.customer.name} ${r.job.city ?? ''} ${r.scope ?? ''}`.toLowerCase().includes(t)),
  );

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-[22px] font-bold">Work orders</h1>
        {canEdit && <Button variant="primary" onClick={() => setNewOpen(true)}>+ New work order</Button>}
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded-[10px] border border-slate-300 bg-white p-3">
        <input aria-label="Filter" placeholder="Filter by number, job, customer…" className={inputCls + ' min-w-56 flex-1'} value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Status" className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="open">Open (planned / started / on hold)</option><option value="all">All statuses</option>
          <option value="planned">Planned</option><option value="started">Started</option><option value="on_hold">On hold</option><option value="complete">Done</option><option value="canceled">Canceled</option>
        </select>
        <select aria-label="Type" className={inputCls} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="all">All types</option><option value="IN">Install</option><option value="ST">Stocking</option><option value="FN">Finals / repair</option>
        </select>
        <label className="text-xs font-semibold text-slate-600">From<input type="date" className={inputCls + ' block'} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs font-semibold text-slate-600">To<input type="date" className={inputCls + ' block'} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold"><input type="checkbox" className="h-5 w-5" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Open flags only</label>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading && <Spinner />}
      <div className="overflow-x-auto rounded-[10px] border border-slate-300 bg-white">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-b border-slate-300 bg-slate-50 text-xs tracking-wider text-slate-600 uppercase">
            <tr><th className="px-3 py-2.5">Number</th><th className="px-3">Type</th><th className="px-3">Date</th><th className="px-3">Job</th><th className="px-3">Scope</th><th className="px-3">Status</th><th className="px-3">Flags</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = r.flags.filter((f) => !f.resolved_at && f.type.severity >= 2).length;
              return (
                <tr key={r.id} className="border-b border-slate-100 hover:bg-blue-50/50">
                  <td className="px-3 py-2.5 font-mono"><Link to={`/work-orders/${r.id}`}>{r.number}</Link></td>
                  <td className="px-3"><TypePill type={r.type_code} /></td>
                  <td className="px-3 whitespace-nowrap">{r.scheduled_date ? shortDate(r.scheduled_date) : <span className="text-slate-500">no date</span>}</td>
                  <td className="px-3"><Link to={`/jobs/${r.job.id}`} className="font-semibold text-slate-900">{r.job.name}</Link><div className="text-xs text-slate-600">{r.job.customer.name}{r.job.city ? ` · ${r.job.city}` : ''}</div></td>
                  <td className="max-w-xs truncate px-3 text-slate-700">{r.scope}</td>
                  <td className="px-3"><StatusText status={r.status} /></td>
                  <td className="px-3">{open > 0 ? <span className="font-bold text-red-700">{open}</span> : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {q.data && rows.length === 0 && <p className="p-6 text-sm text-slate-500">No work orders match.</p>}
      </div>
      {newOpen && <NewWorkOrder open onClose={() => setNewOpen(false)} />}
    </div>
  );
}
