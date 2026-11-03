import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { deptLabel, useCrews, useDepartments, useEmployees } from '@/lib/data';
import { stamp } from '@/lib/dates';
import { Button, Card, ErrorBox, Field, Modal, Spinner, cx, inputCls } from '@/components/ui';

const COLORS = ['#2563EB', '#7C3AED', '#0891B2', '#DB2777', '#EA580C', '#16A34A', '#CA8A04', '#4F46E5', '#059669', '#0D9488', '#65A30D', '#DC2626'];

function EmployeeModal({ id, onClose }: { id: string | 'new'; onClose: () => void }) {
  const qc = useQueryClient();
  const emps = useEmployees();
  const departments = useDepartments();
  const e = id === 'new' ? null : emps.data?.find((x) => x.id === id);
  const [f, setF] = useState({
    first_name: e?.first_name ?? '', last_name: e?.last_name ?? '', employee_code: e?.employee_code ?? '',
    default_position: e?.default_position ?? 'helper', departments: e?.departments ?? [], active: e?.active ?? true, employer: e?.employer ?? 'kt',
  });
  const [alias, setAlias] = useState('');
  const aliases = useQuery({
    queryKey: ['aliases', id],
    enabled: id !== 'new',
    queryFn: async () => must(await supabase.from('employee_aliases').select('id, alias, source').eq('employee_id', id)) as { id: string; alias: string; source: string }[],
  });
  const absences = useQuery({
    queryKey: ['absences', id],
    enabled: id !== 'new',
    queryFn: async () => must(await supabase.from('employee_absences').select('id, absence_date, kind, reason').eq('employee_id', id).order('absence_date', { ascending: false }).limit(20)) as {
      id: string; absence_date: string; kind: string; reason: string | null;
    }[],
  });
  const run = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['employees'] }); qc.invalidateQueries({ queryKey: ['aliases', id] }); },
  });
  const save = () =>
    run.mutate(async () => {
      const row = { ...f, last_name: f.last_name || null, employee_code: f.employee_code || null };
      if (id === 'new') must(await supabase.from('employees').insert(row));
      else must(await supabase.from('employees').update(row).eq('id', id));
      onClose();
    });
  return (
    <Modal open onClose={onClose} title={id === 'new' ? 'Add employee' : e?.display_name ?? 'Employee'}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name"><input className={inputCls} value={f.first_name} onChange={(x) => setF({ ...f, first_name: x.target.value })} /></Field>
          <Field label="Last name"><input className={inputCls} value={f.last_name} onChange={(x) => setF({ ...f, last_name: x.target.value })} /></Field>
          <Field label="Payroll ID" hint="Paycom / UKG employee ID"><input className={inputCls} value={f.employee_code} onChange={(x) => setF({ ...f, employee_code: x.target.value })} /></Field>
          <Field label="Employer">
            <select className={inputCls} value={f.employer} onChange={(x) => setF({ ...f, employer: x.target.value as 'kt' | 'fcb' })}>
              <option value="kt">KT Sales and Service</option><option value="fcb">Fiber Care Baths</option>
            </select>
          </Field>
          <Field label="Usually">
            <select className={inputCls} value={f.default_position} onChange={(x) => setF({ ...f, default_position: x.target.value as typeof f.default_position })}>
              <option value="lead">Lead tech</option><option value="helper">Helper</option><option value="driver">Driver</option><option value="other">Other</option>
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          {(departments.data ?? []).map((dd) => { const d = dd.code; return (
            <label key={d} className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={f.departments.includes(d)} onChange={(x) => setF({ ...f, departments: x.target.checked ? [...f.departments, d] : f.departments.filter((y) => y !== d) })} />{deptLabel(dd)}</label>
          ); })}
          <label className="flex items-center gap-2 font-semibold"><input type="checkbox" className="h-5 w-5" checked={f.active} onChange={(x) => setF({ ...f, active: x.target.checked })} />Active</label>
        </div>
        {id !== 'new' && (
          <div className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3 text-sm">
            <b>Other ways the name gets written</b>
            <p className="text-xs text-slate-600">Used to match handwriting on scanned sheets. Confirming a match in Paper Intake adds to this list automatically.</p>
            <div className="flex flex-wrap gap-1.5">
              {(aliases.data ?? []).map((a) => (
                <span key={a.id} className="flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-0.5">
                  {a.alias}
                  <button aria-label={`Remove ${a.alias}`} className="text-red-700" onClick={() => run.mutate(async () => must(await supabase.from('employee_aliases').delete().eq('id', a.id)))}>×</button>
                </span>
              ))}
            </div>
            <form className="flex gap-2" onSubmit={(x) => { x.preventDefault(); if (alias.trim()) run.mutate(async () => { must(await supabase.from('employee_aliases').insert({ employee_id: id, alias: alias.trim() })); setAlias(''); }); }}>
              <input aria-label="New spelling" className={inputCls + ' min-h-9 flex-1'} placeholder="e.g. Naysiso" value={alias} onChange={(x) => setAlias(x.target.value)} />
              <Button size="sm">Add</Button>
            </form>
          </div>
        )}
        {(absences.data?.length ?? 0) > 0 && (
          <div className="text-sm">
            <b>Recent call-outs</b>
            {absences.data!.map((a) => <div key={a.id} className="text-slate-700">{a.absence_date} · {a.kind.replace('_', ' ')}{a.reason ? ` · ${a.reason}` : ''}</div>)}
          </div>
        )}
        <ErrorBox error={run.error} />
        <Button variant="primary" disabled={!f.first_name.trim() || run.isPending} onClick={save}>Save</Button>
      </div>
    </Modal>
  );
}

export default function Crews() {
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const crews = useCrews();
  const emps = useEmployees();
  const [tab, setTab] = useState<'crews' | 'people' | 'callouts'>('crews');
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const departments = useDepartments();
  const [newCrew, setNewCrew] = useState({ name: '', department: 'socal-install' });
  const deptName = (code: string) => deptLabel(departments.data?.find((d) => d.code === code)) || code;
  const [deptFilter, setDeptFilter] = useState('all');
  const [filter, setFilter] = useState('');

  const members = useQuery({
    queryKey: ['crew-defaults'],
    queryFn: async () => must(await supabase.from('crew_default_members').select('crew_id, employee_id, position')) as { crew_id: string; employee_id: string; position: string }[],
  });
  const callouts = useQuery({
    queryKey: ['callouts'],
    enabled: tab === 'callouts',
    queryFn: async () => must(await supabase.from('employee_absences').select('id, absence_date, kind, reason, created_at, employee:employees(display_name)').order('absence_date', { ascending: false }).limit(200)) as unknown as {
      id: string; absence_date: string; kind: string; reason: string | null; created_at: string; employee: { display_name: string };
    }[],
  });
  const run = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crews'] }); qc.invalidateQueries({ queryKey: ['crew-defaults'] }); },
  });
  const empName = (id: string) => emps.data?.find((e) => e.id === id)?.display_name ?? '?';
  const assigned = new Set((members.data ?? []).map((m) => m.employee_id));
  const free = (emps.data ?? []).filter((e) => e.active && !assigned.has(e.id));

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-[22px] font-bold">Crews &amp; people</h1>
        <div role="tablist" className="flex gap-1 rounded-lg bg-slate-200 p-1">
          {([['crews', 'Usual crews'], ['people', 'Employees'], ['callouts', 'Call-outs']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx('min-h-9 rounded-md px-3.5 text-sm font-semibold', tab === k ? 'bg-white shadow-sm' : 'text-slate-600')}>{l}</button>
          ))}
        </div>
      </div>
      <ErrorBox error={run.error || crews.error || emps.error} />

      {tab === 'crews' && (
        <>
          <p className="text-sm text-slate-600">These pairings load onto the dispatch board each day with “Load the usual crews.” Changes on the board only affect that day.</p>
          {crews.isLoading && <Spinner />}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {(crews.data ?? []).map((c) => {
              const ms = (members.data ?? []).filter((m) => m.crew_id === c.id).sort((a, b) => (a.position === 'lead' ? -1 : b.position === 'lead' ? 1 : 0));
              return (
                <Card key={c.id} className={cx('flex flex-col gap-2 p-3', !c.active && 'opacity-60')}>
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Crew color" disabled={!canEdit} value={c.color ?? '#64748B'} onChange={(e) => run.mutate(async () => must(await supabase.from('crews').update({ color: e.target.value }).eq('id', c.id)))} className="h-7 w-7 rounded border-0 p-0" />
                    <input aria-label="Crew name" disabled={!canEdit} defaultValue={c.name} onBlur={(e) => e.target.value !== c.name && run.mutate(async () => must(await supabase.from('crews').update({ name: e.target.value }).eq('id', c.id)))} className="min-h-9 flex-1 rounded border border-transparent px-1 text-base font-bold hover:border-slate-300" />
                    <select aria-label="Department" disabled={!canEdit} value={c.department ?? ''} onChange={(e) => run.mutate(async () => must(await supabase.from('crews').update({ department: e.target.value }).eq('id', c.id)))} className="min-h-9 rounded border border-slate-300 bg-white px-1 text-sm">
                      {(departments.data ?? []).map((d) => <option key={d.code} value={d.code}>{deptLabel(d)}</option>)}
                    </select>
                  </div>
                  {ms.map((m) => (
                    <div key={m.employee_id} className="flex items-center gap-2 text-sm">
                      <span className={cx('flex-1', m.position === 'lead' && 'font-bold')}>{m.position === 'lead' ? '★ ' : ''}{empName(m.employee_id)}</span>
                      {canEdit && (
                        <>
                          <button className="text-xs text-brand-dark underline" onClick={() => run.mutate(async () => {
                            const toLead = m.position !== 'lead';
                            if (toLead) must(await supabase.from('crew_default_members').update({ position: 'helper' }).eq('crew_id', c.id).eq('position', 'lead'));
                            must(await supabase.from('crew_default_members').update({ position: toLead ? 'lead' : 'helper' }).eq('crew_id', c.id).eq('employee_id', m.employee_id));
                            if (toLead) must(await supabase.from('crews').update({ name: empName(m.employee_id) }).eq('id', c.id));
                          })}>
                            make {m.position === 'lead' ? 'helper' : 'lead'}
                          </button>
                          <button aria-label="Remove from crew" className="text-red-700" onClick={() => run.mutate(async () => must(await supabase.from('crew_default_members').delete().eq('crew_id', c.id).eq('employee_id', m.employee_id)))}>×</button>
                        </>
                      )}
                    </div>
                  ))}
                  {canEdit && (
                    <div className="flex items-center gap-2">
                      <select aria-label={`Add to ${c.name}`} value="" onChange={(e) => e.target.value && run.mutate(async () => must(await supabase.from('crew_default_members').insert({ crew_id: c.id, employee_id: e.target.value, position: ms.length ? 'helper' : 'lead' })))} className="min-h-9 flex-1 rounded border border-dashed border-slate-400 bg-white px-2 text-sm">
                        <option value="">+ add someone not on a crew…</option>
                        {free.map((e) => <option key={e.id} value={e.id}>{e.display_name}</option>)}
                      </select>
                      <button className="text-xs text-slate-600 underline" onClick={() => run.mutate(async () => must(await supabase.from('crews').update({ active: !c.active }).eq('id', c.id)))}>{c.active ? 'Retire' : 'Restore'}</button>
                    </div>
                  )}
                </Card>
              );
            })}
            {canEdit && (
              <Card className="flex flex-col gap-2 border-dashed p-3">
                <b className="text-sm">New crew</b>
                <input aria-label="New crew name" className={inputCls} placeholder="Lead’s full name" value={newCrew.name} onChange={(e) => setNewCrew({ ...newCrew, name: e.target.value })} />
                <select aria-label="New crew department" className={inputCls} value={newCrew.department} onChange={(e) => setNewCrew({ ...newCrew, department: e.target.value })}>
                  {(departments.data ?? []).map((d) => <option key={d.code} value={d.code}>{deptLabel(d)}</option>)}
                </select>
                <Button size="sm" variant="primary" disabled={!newCrew.name.trim()} onClick={() => run.mutate(async () => {
                  must(await supabase.from('crews').insert({ ...newCrew, color: COLORS[(crews.data?.length ?? 0) % COLORS.length], sort_order: crews.data?.length ?? 0 }));
                  setNewCrew({ name: '', department: newCrew.department });
                })}>Create crew</Button>
              </Card>
            )}
          </div>
          {free.length > 0 && <p className="text-sm text-slate-600">Not on a usual crew: {free.map((e) => e.display_name).join(', ')}</p>}
        </>
      )}

      {tab === 'people' && (
        <>
          <div className="flex flex-wrap gap-2">
            <input aria-label="Filter employees" className={inputCls + ' max-w-sm flex-1'} placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <select aria-label="Department filter" className={inputCls} value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
              <option value="all">All departments</option>
              {(departments.data ?? []).map((d) => <option key={d.code} value={d.code}>{deptLabel(d)}</option>)}
            </select>
            {canEdit && <Button variant="primary" onClick={() => setEdit('new')}>+ Add employee</Button>}
          </div>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-left text-sm">
              <thead className="border-b border-slate-300 bg-slate-50 text-xs tracking-wider text-slate-600 uppercase"><tr><th className="px-3 py-2.5">Name</th><th className="px-3">Employer</th><th className="px-3">Payroll ID</th><th className="px-3">Usually</th><th className="px-3">Departments</th><th className="px-3">Usual crew</th><th className="px-3" /></tr></thead>
              <tbody>
                {(emps.data ?? []).filter((e) => (!filter || e.display_name.toLowerCase().includes(filter.toLowerCase())) && (deptFilter === 'all' || e.departments.includes(deptFilter))).map((e) => {
                  const crew = crews.data?.find((c) => members.data?.some((m) => m.crew_id === c.id && m.employee_id === e.id));
                  return (
                    <tr key={e.id} className={cx('border-b border-slate-100', !e.active && 'text-slate-400')}>
                      <td className="px-3 py-2.5 font-semibold">{e.display_name}{!e.active && ' (inactive)'}</td>
                      <td className="px-3">{e.employer === 'fcb' ? 'FCB' : 'KT'}</td><td className="px-3 font-mono text-[13px]">{e.employee_code}</td>
                      <td className="px-3 capitalize">{e.default_position}</td>
                      <td className="px-3">{e.departments.map(deptName).join(', ')}</td>
                      <td className="px-3">{crew?.name}</td>
                      <td className="px-3">{canEdit && <button className="text-brand-dark underline" onClick={() => setEdit(e.id)}>Edit</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {tab === 'callouts' && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-slate-300 bg-slate-50 text-xs tracking-wider text-slate-600 uppercase"><tr><th className="px-3 py-2.5">Date</th><th className="px-3">Employee</th><th className="px-3">Type</th><th className="px-3">Reason</th><th className="px-3">Logged</th></tr></thead>
            <tbody>
              {(callouts.data ?? []).map((a) => (
                <tr key={a.id} className="border-b border-slate-100">
                  <td className="px-3 py-2.5">{a.absence_date}</td><td className="px-3 font-semibold">{a.employee.display_name}</td>
                  <td className="px-3 capitalize">{a.kind.replace('_', ' ')}</td><td className="px-3">{a.reason}</td><td className="px-3 text-slate-500">{stamp(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {callouts.data?.length === 0 && <p className="p-4 text-sm text-slate-500">No call-outs logged yet. Marking someone out on the dispatch board records it here.</p>}
        </Card>
      )}
      {edit && <EmployeeModal id={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
