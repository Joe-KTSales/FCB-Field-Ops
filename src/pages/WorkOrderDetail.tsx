import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { assignWorkOrder, spawnWorkOrder, useCrews, useEmployees, useFlagTypes } from '@/lib/data';
import { shortDate, stamp } from '@/lib/dates';
import type { WoStatus } from '@/lib/types';
import { useWorkOrder, usePw } from '@/components/WorkOrderDrawer';
import NotesPanel from '@/components/NotesPanel';
import FilesPanel from '@/components/FilesPanel';
import { Button, Card, ErrorBox, Field, FlagChip, PwBadge, SectionLabel, Spinner, STATUS_META, TypePill, cx, inputCls } from '@/components/ui';

interface Line {
  id: string; lot_label: string | null; room: string | null; raw_product: string | null; hand: string | null;
  qty_planned: number; qty_done: number | null; status: string; codes: string[]; note: string | null; sort_order: number;
}
const LINE_STATUSES = ['pending', 'done', 'stockpiled', 'room_in', 'returned', 'not_ready', 'missing', 'skipped', 'damaged'];
const STATUSES: WoStatus[] = ['planned', 'started', 'on_hold', 'complete', 'canceled'];

function Candidates({ raw, onPick }: { raw: string; onPick: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['match', raw],
    queryFn: async () => must(await supabase.rpc('match_employee', { p_raw: raw, p_limit: 4 })) as { employee_id: string; display_name: string; score: number }[],
  });
  if (!q.data) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {q.data.map((c) => (
        <button key={c.employee_id} onClick={() => onPick(c.employee_id)} className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs hover:bg-blue-50">
          {c.display_name} · {Math.round(c.score * 100)}%
        </button>
      ))}
      {q.data.length === 0 && <span className="text-xs text-slate-500">no close match — pick below</span>}
    </span>
  );
}

export default function WorkOrderDetail() {
  const { id = '' } = useParams();
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const wq = useWorkOrder(id);
  const wo = wq.data;
  const pw = usePw(wo?.job.id, wo?.scheduled_date);
  const crews = useCrews();
  const emps = useEmployees();
  const flagTypes = useFlagTypes();
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [newFlag, setNewFlag] = useState({ code: '', note: '' });
  const [newLine, setNewLine] = useState({ lot_label: '', room: '', raw_product: '', hand: '', qty_planned: 1, status: 'done' });
  const [addWorker, setAddWorker] = useState('');

  useEffect(() => {
    if (wo) {
      setForm({
        scope: wo.scope ?? '', status_reason: wo.status_reason ?? '', scheduled_date: wo.scheduled_date ?? '', priority: wo.priority,
        time_in: wo.time_in ?? '', time_out: wo.time_out ?? '', completion_notes: wo.completion_notes ?? '', completion_notes_en: wo.completion_notes_en ?? '',
        superintendent_name: wo.superintendent_name ?? '', superintendent_signed: !!wo.superintendent_signed, crew_on_site: wo.crew_on_site,
      });
    }
  }, [wo]);

  const lines = useQuery({
    queryKey: ['wo-lines', id],
    queryFn: async () => must(await supabase.from('work_order_lines').select('*').eq('work_order_id', id).order('sort_order').order('created_at')) as Line[],
  });
  const assignment = useQuery({
    queryKey: ['wo-assignment', id],
    queryFn: async () =>
      must(await supabase.from('crew_day_stops').select('id, crew_day:crew_days(work_date, crew:crews(id, name))').eq('work_order_id', id)) as unknown as {
        id: string; crew_day: { work_date: string; crew: { id: string; name: string } | null };
      }[],
  });
  const chain = useQuery({
    queryKey: ['wo-chain', id, wo?.parent_id],
    enabled: !!wo,
    queryFn: async () => {
      const r = await supabase.from('work_orders').select('id, number, status, scheduled_date').or(`parent_id.eq.${id}${wo?.parent_id ? `,id.eq.${wo.parent_id}` : ''}`);
      return must(r) as { id: string; number: string; status: WoStatus; scheduled_date: string | null }[];
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['wo', id] });
    qc.invalidateQueries({ queryKey: ['wo-lines', id] });
    qc.invalidateQueries({ queryKey: ['wo-assignment', id] });
    qc.invalidateQueries({ queryKey: ['wo-chain'] });
    qc.invalidateQueries({ queryKey: ['board'] });
    qc.invalidateQueries({ queryKey: ['tray'] });
  };
  const run = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: refresh });
  const patch = (p: Record<string, unknown>) => run.mutate(async () => must(await supabase.from('work_orders').update(p).eq('id', id)));

  if (!wo) return wq.error ? <div className="p-6"><ErrorBox error={wq.error} /></div> : <Spinner />;

  const f = (k: string) => form[k] as string;
  const setF = (k: string, v: unknown) => setForm((s) => ({ ...s, [k]: v }));
  const saveForm = () =>
    patch({
      scope: f('scope') || null, status_reason: f('status_reason') || null, scheduled_date: f('scheduled_date') || null, priority: Number(form.priority),
      time_in: f('time_in') || null, time_out: f('time_out') || null, completion_notes: f('completion_notes') || null, completion_notes_en: f('completion_notes_en') || null,
      superintendent_name: f('superintendent_name') || null, superintendent_signed: !!form.superintendent_signed, crew_on_site: !!form.crew_on_site,
    });
  const a = assignment.data?.[0];
  const ro = !canEdit;

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="text-[13px] text-slate-600">
        <Link to={`/customers/${wo.job.customer.id}`}>{wo.job.customer.name}</Link> › <Link to={`/jobs/${wo.job.id}`}>{wo.job.name}</Link> › {wo.number}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <TypePill type={wo.type_code} />
        <h1 className="font-mono text-2xl font-bold">{wo.number}</h1>
        <span className="text-xl font-semibold">{wo.job.name}</span>
        {pw.data && <PwBadge solid />}
        <span className="flex-1" />
        <div role="group" aria-label="Status" className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <button key={s} disabled={ro} onClick={() => patch({ status: s })} className={cx('min-h-10 rounded-md border px-3 text-sm font-semibold', wo.status === s ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white')}>
              {STATUS_META[s].label}
            </button>
          ))}
        </div>
      </div>
      <ErrorBox error={run.error} />

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
          <Card className="flex flex-col gap-4 p-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Date"><input type="date" disabled={ro} className={inputCls} value={f('scheduled_date')} onChange={(e) => setF('scheduled_date', e.target.value)} /></Field>
              <Field label="Crew">
                <select
                  disabled={ro || !wo.scheduled_date}
                  className={inputCls}
                  value={a?.crew_day.crew?.id ?? ''}
                  onChange={(e) => e.target.value && wo.scheduled_date && run.mutate(() => assignWorkOrder(wo.id, e.target.value, wo.scheduled_date!))}
                >
                  <option value="">{wo.scheduled_date ? '— not assigned —' : 'set a date first'}</option>
                  {(crews.data ?? []).filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="Priority">
                <select disabled={ro} className={inputCls} value={String(form.priority ?? 0)} onChange={(e) => setF('priority', Number(e.target.value))}>
                  <option value="0">Normal</option><option value="1">High</option><option value="2">Urgent</option>
                </select>
              </Field>
            </div>
            <Field label="Scope — what needs doing"><textarea disabled={ro} rows={3} className={inputCls + ' py-2'} value={f('scope')} onChange={(e) => setF('scope', e.target.value)} /></Field>
            {(wo.status === 'on_hold' || wo.status === 'canceled' || f('status_reason')) && (
              <Field label="Why on hold / canceled"><input disabled={ro} className={inputCls} value={f('status_reason')} onChange={(e) => setF('status_reason', e.target.value)} /></Field>
            )}
            {wo.status === 'canceled' && (
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" disabled={ro} className="h-5 w-5" checked={!!form.crew_on_site} onChange={(e) => setF('crew_on_site', e.target.checked)} />
                Crew went to the site (counts on the PW report)
              </label>
            )}
            {wo.locations.length > 0 && <div className="text-sm"><SectionLabel>Where</SectionLabel>{wo.locations.map((l) => l.label ?? l.lot?.lot_number ?? l.area?.name).join(' · ')}</div>}
          </Card>

          <Card className="flex flex-col gap-4 p-4">
            <h2 className="text-base font-bold">Returned paperwork</h2>
            <div className="grid gap-4 sm:grid-cols-4">
              <Field label="Time in"><input type="time" disabled={ro} className={inputCls} value={f('time_in')?.slice(0, 5)} onChange={(e) => setF('time_in', e.target.value)} /></Field>
              <Field label="Time out"><input type="time" disabled={ro} className={inputCls} value={f('time_out')?.slice(0, 5)} onChange={(e) => setF('time_out', e.target.value)} /></Field>
              <Field label="Superintendent"><input disabled={ro} className={inputCls} value={f('superintendent_name')} onChange={(e) => setF('superintendent_name', e.target.value)} /></Field>
              <label className="flex items-end gap-2 pb-3 text-sm font-semibold"><input type="checkbox" disabled={ro} className="h-5 w-5" checked={!!form.superintendent_signed} onChange={(e) => setF('superintendent_signed', e.target.checked)} /> Signed</label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Crew notes (as written)"><textarea disabled={ro} rows={3} className={inputCls + ' py-2'} value={f('completion_notes')} onChange={(e) => setF('completion_notes', e.target.value)} /></Field>
              <Field label="English"><textarea disabled={ro} rows={3} className={inputCls + ' py-2'} value={f('completion_notes_en')} onChange={(e) => setF('completion_notes_en', e.target.value)} /></Field>
            </div>
            {canEdit && <Button variant="primary" className="self-start" disabled={run.isPending} onClick={saveForm}>Save changes</Button>}
          </Card>

          <Card className="flex flex-col gap-3 p-4">
            <h2 className="text-base font-bold">Lines · {lines.data?.length ?? 0}</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-slate-300 text-xs tracking-wider text-slate-600 uppercase">
                  <tr><th className="py-2">Lot</th><th>Room</th><th>Product</th><th>Hand</th><th>Qty</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {(lines.data ?? []).map((l) => (
                    <tr key={l.id} className="border-b border-slate-100">
                      <td className="py-2 font-semibold">{l.lot_label}</td>
                      <td>{l.room}</td>
                      <td className="font-mono text-[13px]">{l.raw_product}</td>
                      <td>{l.hand}</td>
                      <td>{l.qty_done ?? l.qty_planned}</td>
                      <td>
                        <select disabled={ro} aria-label="Line status" className="min-h-8 rounded border border-slate-300 bg-white px-1 text-[13px]" value={l.status}
                          onChange={(e) => run.mutate(async () => must(await supabase.from('work_order_lines').update({ status: e.target.value }).eq('id', l.id)))}>
                          {LINE_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                        </select>
                      </td>
                      <td>{canEdit && <button aria-label="Delete line" className="text-red-700" onClick={() => run.mutate(async () => must(await supabase.from('work_order_lines').delete().eq('id', l.id)))}>×</button>}</td>
                    </tr>
                  ))}
                  {canEdit && (
                    <tr>
                      <td className="py-2 pr-1"><input aria-label="Lot" className="min-h-9 w-20 rounded border border-slate-300 px-2" value={newLine.lot_label} onChange={(e) => setNewLine({ ...newLine, lot_label: e.target.value })} /></td>
                      <td className="pr-1">
                        <select aria-label="Room" className="min-h-9 rounded border border-slate-300 px-1" value={newLine.room} onChange={(e) => setNewLine({ ...newLine, room: e.target.value })}>
                          <option value="">—</option><option>Master</option><option>Bath 2</option><option>Bath 3</option><option>Option</option><option>Garage</option>
                        </select>
                      </td>
                      <td className="pr-1"><input aria-label="Product" className="min-h-9 w-full rounded border border-slate-300 px-2 font-mono" value={newLine.raw_product} onChange={(e) => setNewLine({ ...newLine, raw_product: e.target.value })} /></td>
                      <td className="pr-1">
                        <select aria-label="Hand" className="min-h-9 rounded border border-slate-300 px-1" value={newLine.hand} onChange={(e) => setNewLine({ ...newLine, hand: e.target.value })}>
                          <option value="">—</option><option value="L">L</option><option value="R">R</option>
                        </select>
                      </td>
                      <td className="pr-1"><input aria-label="Quantity" type="number" min={0} className="min-h-9 w-16 rounded border border-slate-300 px-2" value={newLine.qty_planned} onChange={(e) => setNewLine({ ...newLine, qty_planned: Number(e.target.value) })} /></td>
                      <td className="pr-1">
                        <select aria-label="New line status" className="min-h-9 rounded border border-slate-300 px-1" value={newLine.status} onChange={(e) => setNewLine({ ...newLine, status: e.target.value })}>
                          {LINE_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                        </select>
                      </td>
                      <td>
                        <Button size="sm" disabled={!newLine.lot_label && !newLine.raw_product}
                          onClick={() => run.mutate(async () => {
                            must(await supabase.from('work_order_lines').insert({
                              work_order_id: id, lot_label: newLine.lot_label || null, room: newLine.room || null, raw_product: newLine.raw_product || null,
                              hand: newLine.hand || null, qty_planned: newLine.qty_planned, qty_done: newLine.status === 'done' ? newLine.qty_planned : null,
                              status: newLine.status, sort_order: (lines.data?.length ?? 0) + 1,
                            }));
                            setNewLine({ ...newLine, lot_label: '', raw_product: '' });
                          })}>Add</Button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-4"><FilesPanel target={{ work_order_id: id, job_id: wo.job.id }} title="Scans, photos & video" /></Card>
        </div>

        <aside className="flex max-w-[400px] flex-[1_1_320px] flex-col gap-4">
          <Card className="flex flex-col gap-3 p-4">
            <h2 className="text-base font-bold">Flags</h2>
            {wo.flags.length === 0 && <p className="text-sm text-slate-500">No flags.</p>}
            {wo.flags.map((fl) => (
              <div key={fl.id} className="flex flex-col gap-1.5 border-b border-slate-100 pb-2">
                <div className="flex items-center gap-2">
                  <FlagChip label={fl.type.label} color={fl.type.color} resolved={!!fl.resolved_at} />
                  <span className="flex-1" />
                  {canEdit && !fl.resolved_at && (
                    <button className="text-xs font-semibold text-brand-dark underline" onClick={() => run.mutate(async () => must(await supabase.from('work_order_flags').update({ resolved_at: new Date().toISOString() }).eq('id', fl.id)))}>Resolve</button>
                  )}
                  {fl.resolved_at && <span className="text-xs text-slate-500">resolved {stamp(fl.resolved_at)}</span>}
                </div>
                {fl.note && <p className="text-[13px] text-slate-700">{fl.note}</p>}
                {canEdit && !fl.resolved_at && fl.type.offers_action && !fl.spawned_work_order_id && (
                  <Button size="sm" className="self-start"
                    onClick={() => run.mutate(async () => {
                      const created = await spawnWorkOrder({
                        from: { id: wo.id, job_id: wo.job.id, type_code: wo.type_code },
                        kind: fl.type.offers_action === 'create_repair_wo' ? 'repair' : 'follow_up',
                        scope: `${fl.type.label}${fl.note ? ` — ${fl.note}` : ''} (from ${wo.number})`,
                        flagId: fl.id,
                      });
                      nav(`/work-orders/${created.id}`);
                    })}>
                    {fl.type.offers_action === 'create_repair_wo' ? 'Create repair work order' : 'Create follow-up'}
                  </Button>
                )}
                {fl.spawned_work_order_id && <Link className="text-xs" to={`/work-orders/${fl.spawned_work_order_id}`}>→ open the work order it created</Link>}
              </div>
            ))}
            {canEdit && (
              <div className="flex flex-col gap-2">
                <select aria-label="Add flag" className={inputCls} value={newFlag.code} onChange={(e) => setNewFlag({ ...newFlag, code: e.target.value })}>
                  <option value="">+ Add a flag…</option>
                  {(flagTypes.data ?? []).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                </select>
                {newFlag.code && (
                  <>
                    <input aria-label="Flag note" className={inputCls} placeholder="Note (lots, units, what’s wrong)" value={newFlag.note} onChange={(e) => setNewFlag({ ...newFlag, note: e.target.value })} />
                    <Button size="sm" variant="primary" className="self-start" onClick={() => run.mutate(async () => {
                      must(await supabase.from('work_order_flags').insert({ work_order_id: id, flag_code: newFlag.code, note: newFlag.note || null }));
                      setNewFlag({ code: '', note: '' });
                    })}>Add flag</Button>
                  </>
                )}
              </div>
            )}
          </Card>

          <Card className="flex flex-col gap-2 p-4">
            <h2 className="text-base font-bold">Who worked</h2>
            <p className="text-xs text-slate-500">Filled from the crew roster when the job is marked done; corrected from the scanned sheet. Feeds the PW report.</p>
            {wo.workers.map((w) => (
              <div key={w.id} className="flex flex-col gap-1 border-b border-slate-100 py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className={cx('flex-1 font-semibold', !w.employee && 'text-amber-800')}>{w.employee?.display_name ?? `“${w.raw_name}” — not matched`}</span>
                  {w.position && <span className="text-xs text-slate-500">{w.position}</span>}
                  {canEdit && <button aria-label="Remove worker" className="text-red-700" onClick={() => run.mutate(async () => must(await supabase.from('work_order_workers').delete().eq('id', w.id)))}>×</button>}
                </div>
                {!w.employee && w.raw_name && canEdit && (
                  <Candidates raw={w.raw_name} onPick={(emp) => run.mutate(async () => must(await supabase.rpc('confirm_worker_match', { p_worker: w.id, p_employee: emp })))} />
                )}
              </div>
            ))}
            {canEdit && (
              <div className="flex gap-2">
                <select aria-label="Add a worker" className={inputCls + ' flex-1'} value={addWorker} onChange={(e) => setAddWorker(e.target.value)}>
                  <option value="">+ Add someone…</option>
                  {(emps.data ?? []).filter((e) => e.active && !wo.workers.some((w) => w.employee?.id === e.id)).map((e) => <option key={e.id} value={e.id}>{e.display_name}</option>)}
                </select>
                <Button size="sm" disabled={!addWorker} onClick={() => run.mutate(async () => {
                  must(await supabase.from('work_order_workers').insert({ work_order_id: id, employee_id: addWorker, source: 'manual' }));
                  setAddWorker('');
                })}>Add</Button>
              </div>
            )}
          </Card>

          {(chain.data?.length ?? 0) > 0 && (
            <Card className="flex flex-col gap-1.5 p-4 text-sm">
              <h2 className="text-base font-bold">Related work orders</h2>
              {chain.data!.map((c) => (
                <Link key={c.id} to={`/work-orders/${c.id}`} className="flex gap-2">
                  <span className="font-mono">{c.number}</span><span className="text-slate-600">{shortDate(c.scheduled_date)} · {STATUS_META[c.status].label}</span>
                </Link>
              ))}
            </Card>
          )}

          <Card className="p-4"><NotesPanel target={{ work_order_id: id, job_id: wo.job.id }} title="Notes on this work order" /></Card>
        </aside>
      </div>
    </div>
  );
}
