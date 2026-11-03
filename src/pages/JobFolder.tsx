import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { shortDate, stamp } from '@/lib/dates';
import type { JobSummary, WoStatus, WoType } from '@/lib/types';
import NotesPanel from '@/components/NotesPanel';
import FilesPanel from '@/components/FilesPanel';
import NewWorkOrder from '@/components/NewWorkOrder';
import WorkDoneList, { type DoneLine } from '@/components/WorkDoneList';
import { Button, Card, ErrorBox, Field, Modal, PwBadge, Spinner, StatusText, TypePill, cx, inputCls } from '@/components/ui';

interface Job {
  id: string; name: string; status: string; city: string | null; address: string | null; description: string | null; facility_code: string | null;
  customer: { id: string; name: string };
  parties: { id: string; role: string; company: { id: string; name: string } }[];
  contacts: { id: string; role: string | null; contact: { id: string; name: string; phone: string | null; email: string | null } }[];
  aliases: { alias: string }[];
}
interface Area { id: string; parent_id: string | null; kind: string; name: string; sort_order: number }
interface Lot { id: string; area_id: string | null; lot_number: string }
interface Wo { id: string; number: string; type_code: WoType; status: WoStatus; scheduled_date: string | null; scope: string | null;
  status_reason: string | null; completion_notes: string | null; completion_notes_en: string | null; lines: DoneLine[];
  flags: { id: string; resolved_at: string | null; type: { severity: number } }[]; locations: { area_id: string | null; lot_id: string | null; label: string | null }[];
  workers: { employee: { display_name: string } | null; raw_name: string | null }[] }
interface Ship { id: string; order_number: string | null; ship_date: string | null; status: string; notes: string | null; facility_code: string;
  lines: { raw_product_name: string; quantity: number }[] }

type Tab = 'timeline' | 'work_orders' | 'shipments' | 'files' | 'activity';

function AddPartyModal({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'party' | 'contact'>('party');
  const [role, setRole] = useState('contractor');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('Superintendent');
  const [err, setErr] = useState<unknown>(null);
  async function save() {
    try {
      if (kind === 'party') {
        const existing = must(await supabase.rpc('resolve_company', { p_raw: name })) as string | null;
        const companyId = existing ?? (must(await supabase.from('companies').insert({ name, kinds: [role] }).select('id').single()) as { id: string }).id;
        must(await supabase.from('job_parties').insert({ job_id: jobId, company_id: companyId, role }));
      } else {
        const c = must(await supabase.from('contacts').insert({ name, phone: phone || null, title }).select('id').single()) as { id: string };
        must(await supabase.from('job_contacts').insert({ job_id: jobId, contact_id: c.id, role: title }));
      }
      qc.invalidateQueries({ queryKey: ['job', jobId] });
      onClose();
    } catch (x) { setErr(x); }
  }
  return (
    <Modal open onClose={onClose} title="Add to this job">
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Button variant={kind === 'party' ? 'primary' : 'secondary'} onClick={() => setKind('party')}>Company</Button>
          <Button variant={kind === 'contact' ? 'primary' : 'secondary'} onClick={() => setKind('contact')}>Person / contact</Button>
        </div>
        {kind === 'party' ? (
          <Field label="Role">
            <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="contractor">Contractor (crew works with them)</option><option value="builder">Builder</option><option value="gc">General contractor</option><option value="bill_to_alt">Also billed to</option><option value="other">Other</option>
            </select>
          </Field>
        ) : (
          <Field label="Title"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        )}
        <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {kind === 'contact' && <Field label="Phone"><input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>}
        <ErrorBox error={err} />
        <Button variant="primary" disabled={!name.trim()} onClick={save}>Add</Button>
      </div>
    </Modal>
  );
}

export default function JobFolder() {
  const { id = '' } = useParams();
  const { canEdit, isAdmin } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('timeline');
  const [area, setArea] = useState<string>('all');
  const [partyOpen, setPartyOpen] = useState(false);
  const [newWo, setNewWo] = useState(false);
  const [newArea, setNewArea] = useState('');

  const job = useQuery({
    queryKey: ['job', id],
    queryFn: async () =>
      must(
        await supabase
          .from('jobs')
          .select('*, customer:companies!jobs_customer_id_fkey(id, name), parties:job_parties(id, role, company:companies(id, name)), contacts:job_contacts(id, role, contact:contacts(id, name, phone, email)), aliases:job_aliases(alias)')
          .eq('id', id)
          .single(),
      ) as unknown as Job,
  });
  const summary = useQuery({
    queryKey: ['job-summary', id],
    queryFn: async () => must(await supabase.from('v_job_summary').select('*').eq('job_id', id).single()) as JobSummary,
  });
  const areas = useQuery({
    queryKey: ['areas', id],
    queryFn: async () => must(await supabase.from('job_areas').select('*').eq('job_id', id).order('sort_order').order('name')) as Area[],
  });
  const lots = useQuery({
    queryKey: ['lots', id],
    queryFn: async () => must(await supabase.from('lots').select('id, area_id, lot_number').eq('job_id', id).order('sort_key').order('lot_number')) as Lot[],
  });
  const wos = useQuery({
    queryKey: ['job-wos', id],
    queryFn: async () =>
      must(
        await supabase
          .from('work_orders')
          .select('id, number, type_code, status, scheduled_date, scope, status_reason, completion_notes, completion_notes_en, lines:work_order_lines(lot_label, room, raw_product, hand, qty_planned, qty_done, status, sort_order), flags:work_order_flags!work_order_flags_work_order_id_fkey(id, resolved_at, type:flag_types(severity)), locations:work_order_locations(area_id, lot_id, label), workers:work_order_workers(raw_name, employee:employees(display_name))')
          .eq('job_id', id)
          .order('scheduled_date', { ascending: false, nullsFirst: true }),
      ) as unknown as Wo[],
  });
  const ships = useQuery({
    queryKey: ['job-ships', id],
    queryFn: async () =>
      must(await supabase.from('shipments').select('id, order_number, ship_date, status, notes, facility_code, lines:shipment_lines(raw_product_name, quantity)').eq('job_id', id).order('ship_date', { ascending: false })) as Ship[],
  });
  const audit = useQuery({
    queryKey: ['job-audit', id],
    enabled: isAdmin && tab === 'activity',
    queryFn: async () =>
      must(await supabase.from('audit_log').select('id, table_name, action, changed_at, changed_fields, changed_by').eq('job_id', id).order('changed_at', { ascending: false }).limit(200)) as {
        id: number; table_name: string; action: string; changed_at: string; changed_fields: string[] | null; changed_by: string | null;
      }[],
  });
  const people = useQuery({
    queryKey: ['profiles-min'],
    enabled: isAdmin,
    queryFn: async () => must(await supabase.from('profiles').select('id, full_name, email')) as { id: string; full_name: string | null; email: string | null }[],
  });

  const run = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['areas', id] }); qc.invalidateQueries({ queryKey: ['job', id] }); },
  });

  const areaWoIds = useMemo(() => {
    if (area === 'all') return null;
    const lotIds = new Set((lots.data ?? []).filter((l) => l.area_id === area).map((l) => l.id));
    return new Set((wos.data ?? []).filter((w) => w.locations.some((l) => l.area_id === area || (l.lot_id && lotIds.has(l.lot_id)))).map((w) => w.id));
  }, [area, lots.data, wos.data]);

  const timeline = useMemo(() => {
    const a = (wos.data ?? []).filter((w) => !areaWoIds || areaWoIds.has(w.id)).map((w) => ({ kind: 'wo' as const, date: w.scheduled_date ?? '9999-12-31', w }));
    const b = area === 'all' ? (ships.data ?? []).map((s) => ({ kind: 'ship' as const, date: s.ship_date ?? '9999-12-31', s })) : [];
    return [...a, ...b].sort((x, y) => y.date.localeCompare(x.date));
  }, [wos.data, ships.data, areaWoIds, area]);

  const j = job.data;
  if (!j) return job.error ? <div className="p-6"><ErrorBox error={job.error} /></div> : <Spinner />;
  const s = summary.data;
  const nameOf = (uid: string | null) => people.data?.find((p) => p.id === uid)?.full_name ?? people.data?.find((p) => p.id === uid)?.email ?? 'system';

  const tiles: [string | number, string, boolean][] = s
    ? [[s.work_orders, 'work orders', false], [s.open_flags, 'open flags', s.open_flags > 0], [s.shipments, 'shipments', false], [s.photos, 'photos', false], [s.videos, 'videos', false], [s.notes, 'notes', false]]
    : [];

  return (
    <div className="flex flex-col">
      <section className="flex flex-col gap-3 border-b border-slate-300 bg-white px-4 py-4 sm:px-6">
        <div className="text-[13px] text-slate-600"><Link to="/jobs">Jobs</Link> › <Link to={`/customers/${j.customer.id}`}>{j.customer.name}</Link> › {j.name}</div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[28px] font-bold">{j.name}</h1>
          <span className={cx('rounded px-2 py-1 text-xs font-bold uppercase', j.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-700')}>{j.status}</span>
          {s?.prevailing_wage ? <PwBadge solid /> : <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">Not prevailing wage</span>}
          <span className="flex-1" />
          {canEdit && <Button variant="primary" onClick={() => setNewWo(true)}>+ Work order</Button>}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div><span className="text-slate-600">Customer</span> <Link to={`/customers/${j.customer.id}`} className="font-bold text-slate-900">{j.customer.name}</Link></div>
          {j.parties.map((p) => <div key={p.id}><span className="text-slate-600 capitalize">{p.role.replace('_', ' ')}</span> <b>{p.company.name}</b></div>)}
          {j.city && <div><span className="text-slate-600">City</span> <b>{j.city}</b></div>}
          {j.facility_code && <div><span className="text-slate-600">Plant</span> <b className="capitalize">{j.facility_code}</b></div>}
          {j.contacts.map((c) => <div key={c.id}><span className="text-slate-600">{c.role ?? 'Contact'}</span> <b>{c.contact.name}</b>{c.contact.phone && <> · <a href={`tel:${c.contact.phone}`}>{c.contact.phone}</a></>}</div>)}
          {canEdit && <button onClick={() => setPartyOpen(true)} className="rounded-md border border-dashed border-slate-400 px-2.5 py-1 text-[13px] font-semibold text-slate-700">+ Add party or contact</button>}
        </div>
        {j.aliases.length > 0 && <div className="text-xs text-slate-500">Also known as: {j.aliases.map((a) => a.alias).join(' · ')}</div>}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5">
          {tiles.map(([n, label, warn]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <div className={cx('text-[22px] font-bold', warn && 'text-red-700')}>{n}</div>
              <div className="text-xs text-slate-600">{label}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-4 px-4 py-4 sm:px-6">
        <nav aria-label="Job structure" className="flex max-w-[260px] flex-[1_1_220px] flex-col gap-1 rounded-[10px] border border-slate-300 bg-white p-3">
          <div className="px-1.5 pb-2 text-xs font-bold tracking-wider text-slate-600 uppercase">Phases · buildings · levels</div>
          {[{ id: 'all', name: 'Whole job' }, ...(areas.data ?? [])].map((a) => (
            <button key={a.id} onClick={() => setArea(a.id)} className={cx('flex min-h-10 items-center gap-2 rounded-md px-2.5 text-left text-sm', area === a.id ? 'bg-blue-50 font-bold text-blue-900' : 'hover:bg-slate-50')}>
              <span className="flex-1">{a.name}</span>
              {a.id !== 'all' && <span className="text-xs text-slate-500">{(lots.data ?? []).filter((l) => l.area_id === a.id).length || ''}</span>}
            </button>
          ))}
          {canEdit && (
            <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (newArea.trim()) run.mutate(async () => { must(await supabase.from('job_areas').insert({ job_id: id, name: newArea.trim(), kind: /bldg|building/i.test(newArea) ? 'building' : /ph/i.test(newArea) ? 'phase' : /level|floor/i.test(newArea) ? 'level' : 'other' })); setNewArea(''); }); }}>
              <input aria-label="New area" className="min-h-9 w-full rounded-md border border-slate-300 px-2 text-sm" placeholder="Add: Bldg 2, PH10, Level 4…" value={newArea} onChange={(e) => setNewArea(e.target.value)} />
              <Button size="sm">Add</Button>
            </form>
          )}
          <p className="px-1.5 pt-2 text-xs text-slate-500">A work order can cover several buildings or levels in one visit.</p>
        </nav>

        <main className="flex min-w-0 flex-[999_1_520px] flex-col gap-3">
          <div role="tablist" className="flex flex-wrap gap-1 border-b border-slate-300">
            {([['timeline', 'Timeline'], ['work_orders', `Work orders · ${wos.data?.length ?? 0}`], ['shipments', `Shipments · ${ships.data?.length ?? 0}`], ['files', 'Photos, video & docs'], ...(isAdmin ? [['activity', 'Activity log']] : [])] as [Tab, string][]).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx('min-h-11 px-3.5', tab === k ? 'border-b-[3px] border-brand font-bold' : 'text-slate-600')}>{label}</button>
            ))}
          </div>

          {(tab === 'timeline' || tab === 'work_orders' || tab === 'shipments') && (
            <div className="flex flex-col gap-2.5">
              {timeline.filter((e) => tab === 'timeline' || (tab === 'work_orders' ? e.kind === 'wo' : e.kind === 'ship')).map((e) =>
                e.kind === 'wo' ? (
                  <Link key={e.w.id} to={`/work-orders/${e.w.id}`} className="grid grid-cols-[76px_minmax(0,1fr)] gap-3.5 rounded-[10px] border border-slate-200 bg-white p-3.5 text-slate-900 no-underline hover:border-brand">
                    <div>{e.w.scheduled_date ? <><div className="text-xs font-bold text-slate-600 uppercase">{shortDate(e.w.scheduled_date).split('/').slice(0, 2).join('/')}</div><div className="text-sm text-slate-500">{e.w.scheduled_date.slice(0, 4)}</div></> : <span className="text-xs text-slate-500">no date</span>}</div>
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2"><TypePill type={e.w.type_code} /><span className="font-mono text-[13px]">{e.w.number}</span><span className="flex-1" /><StatusText status={e.w.status} />{e.w.flags.some((f) => !f.resolved_at && f.type.severity >= 2) && <span className="text-xs font-bold text-red-700">{e.w.flags.filter((f) => !f.resolved_at && f.type.severity >= 2).length} open flags</span>}</div>
                      {e.w.scope && <div className="text-[15px] font-semibold">{e.w.scope}</div>}
                      <div className="text-[13px] text-slate-600">
                        {e.w.workers.map((x) => x.employee?.display_name ?? x.raw_name).join(', ')}
                        {e.w.locations.some((l) => l.label) && ` · ${e.w.locations.map((l) => l.label).filter(Boolean).join(', ')}`}
                      </div>
                      {e.w.status === 'canceled' && e.w.status_reason && <p className="text-sm text-slate-700"><b>Canceled:</b> {e.w.status_reason}</p>}
                      <WorkDoneList lines={e.w.lines} />
                      {(e.w.completion_notes_en || e.w.completion_notes) && e.w.status !== 'canceled' && (
                        <p className="mt-1 text-sm text-slate-700"><b className="text-slate-900">Crew note:</b> {e.w.completion_notes_en || e.w.completion_notes}</p>
                      )}
                    </div>
                  </Link>
                ) : (
                  <div key={e.s.id} className="grid grid-cols-[76px_minmax(0,1fr)] gap-3.5 rounded-[10px] border border-slate-200 bg-white p-3.5">
                    <div><div className="text-xs font-bold text-slate-600 uppercase">{e.s.ship_date ? shortDate(e.s.ship_date).split('/').slice(0, 2).join('/') : 'TBD'}</div><div className="text-sm text-slate-500">{e.s.ship_date?.slice(0, 4)}</div></div>
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-700 uppercase">Shipment</span><span className="font-mono text-[13px]">{e.s.order_number}</span><span className="text-[13px] text-slate-600 capitalize">{e.s.facility_code}</span><span className="flex-1" /><span className="text-xs font-bold text-green-800 capitalize">{e.s.status}</span></div>
                      <ul className="flex flex-col gap-0.5 text-sm">
                        {e.s.lines.map((l, i) => (
                          <li key={i} className="flex gap-2"><span aria-hidden="true" className="text-slate-400">•</span><span><b className="font-semibold">{l.quantity}×</b> <span className="font-mono text-[13px]">{l.raw_product_name}</span></span></li>
                        ))}
                      </ul>
                      {e.s.notes && <div className="text-[13px] text-slate-600">{e.s.notes}</div>}
                    </div>
                  </div>
                ),
              )}
              {timeline.length === 0 && <p className="text-sm text-slate-500">Nothing here yet.</p>}
            </div>
          )}
          {tab === 'files' && <Card className="p-4"><FilesPanel target={{ job_id: id }} rollup /></Card>}
          {tab === 'activity' && (
            <Card className="p-4 text-sm">
              {(audit.data ?? []).map((a) => (
                <div key={a.id} className="flex flex-wrap gap-x-3 border-b border-slate-100 py-1.5">
                  <span className="w-36 text-slate-500">{stamp(a.changed_at)}</span>
                  <b>{nameOf(a.changed_by)}</b>
                  <span>{a.action.toLowerCase()} {a.table_name.replace(/_/g, ' ')}</span>
                  {a.changed_fields && <span className="text-slate-600">({a.changed_fields.join(', ')})</span>}
                </div>
              ))}
              {audit.data?.length === 0 && <p className="text-slate-500">No changes recorded yet.</p>}
            </Card>
          )}
        </main>

        <aside className="flex max-w-[360px] flex-[1_1_280px] flex-col gap-3">
          <Card className="p-4"><NotesPanel target={{ job_id: id }} rollup title="Job notes" /></Card>
        </aside>
      </div>
      {partyOpen && <AddPartyModal jobId={id} onClose={() => setPartyOpen(false)} />}
      {newWo && <NewWorkOrder open onClose={() => setNewWo(false)} defaultJob={{ id: j.id, name: j.name, customer: j.customer.name, city: j.city }} />}
    </div>
  );
}
