import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { jsPDF } from 'jspdf';
import { supabase, must, BUCKET } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { mdy, mondayOf, monthDay, shift, shortDate, stamp, todayIso } from '@/lib/dates';
import JobPicker, { type PickedJob } from '@/components/JobPicker';
import { Button, Card, ErrorBox, Field, Spinner, inputCls } from '@/components/ui';

interface Row { customer: string; job: string; job_id: string; work_date: string; employee: string; employee_code: string | null; employee_id: string | null; work_order_number: string; unmatched: boolean }
interface Period { id: string; effective_from: string; effective_to: string | null; source_note: string | null; needs_review: boolean; match_note: string | null; job: { id: string; name: string; city: string | null; customer: { name: string } } }

function groupRows(rows: Row[]) {
  const m = new Map<string, { title: string; rows: Row[] }>();
  for (const r of rows) {
    const k = r.job_id;
    if (!m.has(k)) m.set(k, { title: `${r.customer} – ${r.job}`, rows: [] });
    // one line per person per day, even if they were on two work orders at the job
    const g = m.get(k)!;
    if (!g.rows.some((x) => x.work_date === r.work_date && x.employee === r.employee)) g.rows.push(r);
  }
  return [...m.values()];
}

function buildPdf(monday: string, groups: ReturnType<typeof groupRows>) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 54;
  let y = M;
  let page = 1;
  const header = () => {
    doc.setFont('helvetica', 'bold').setFontSize(16).text('Prevailing Wage — Weekly Report', M, y);
    doc.setFont('helvetica', 'normal').setFontSize(10).text('KT Sales & Service for Fiber Care Baths, Inc.', W - M, y, { align: 'right' });
    y += 16;
    doc.setFontSize(10).text(`Week of Monday ${mdy(monday)} – Sunday ${mdy(shift(monday, 6))}`, M, y);
    y += 10;
    doc.setLineWidth(1.5).line(M, y, W - M, y);
    y += 22;
  };
  const footer = () => {
    doc.setFontSize(8).setTextColor(90).text(`Generated ${stamp(new Date().toISOString())} from completed work orders`, M, H - 30);
    doc.text(`Page ${page}`, W - M, H - 30, { align: 'right' });
    doc.setTextColor(0);
  };
  const ensure = (need: number) => {
    if (y + need > H - 60) { footer(); doc.addPage(); page += 1; y = M; header(); }
  };
  header();
  if (groups.length === 0) doc.setFontSize(11).text('No prevailing wage work this week.', M, y);
  for (const g of groups) {
    ensure(60);
    doc.setFont('helvetica', 'bold').setFontSize(12).text(g.title, M, y);
    y += 14;
    doc.setLineWidth(0.5).line(M, y, W - M, y);
    y += 12;
    doc.setFont('helvetica', 'bold').setFontSize(9).text('DATE', M, y).text('EMPLOYEE', M + 110, y);
    y += 6;
    doc.line(M, y, W - M, y);
    y += 14;
    doc.setFont('helvetica', 'normal').setFontSize(10.5);
    for (const r of g.rows) {
      ensure(18);
      doc.text(mdy(r.work_date), M, y).text(r.employee, M + 110, y);
      y += 16;
    }
    y += 14;
  }
  footer();
  return doc;
}

export default function PWReport() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [monday, setMonday] = useState(mondayOf(shift(todayIso(), -7)));
  const [addJob, setAddJob] = useState<PickedJob | null>(null);
  const [addFrom, setAddFrom] = useState(todayIso());
  const [addNote, setAddNote] = useState('');

  const rows = useQuery({
    queryKey: ['pw-week', monday],
    queryFn: async () => must(await supabase.rpc('pw_week', { p_week_start: monday })) as Row[],
  });
  const periods = useQuery({
    queryKey: ['pw-periods'],
    queryFn: async () =>
      must(await supabase.from('prevailing_wage_periods').select('id, effective_from, effective_to, source_note, needs_review, match_note, job:jobs(id, name, city, customer:companies(name))').order('effective_from', { ascending: false })) as unknown as Period[],
  });
  const history = useQuery({
    queryKey: ['pw-history'],
    queryFn: async () => must(await supabase.from('pw_reports').select('id, week_start, generated_at, file:files(storage_path)').order('generated_at', { ascending: false }).limit(20)) as unknown as {
      id: string; week_start: string; generated_at: string; file: { storage_path: string } | null;
    }[],
  });
  const run = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['pw-periods'] }); qc.invalidateQueries({ queryKey: ['pw-week'] }); qc.invalidateQueries({ queryKey: ['pw-history'] }); },
  });

  const groups = useMemo(() => groupRows(rows.data ?? []), [rows.data]);
  const toConfirm = (periods.data ?? []).filter((p) => p.needs_review);
  const [listFilter, setListFilter] = useState('');
  const { session } = useAuth();
  const unmatched = (rows.data ?? []).filter((r) => r.unmatched);
  const people = new Set((rows.data ?? []).map((r) => r.employee)).size;

  if (!isAdmin) return <div className="p-6 text-sm text-slate-600">The prevailing wage report is admin-only.</div>;

  const download = () => buildPdf(monday, groups).save(`PW-report-${monday}.pdf`);
  const saveHistory = () =>
    run.mutate(async () => {
      const blob = buildPdf(monday, groups).output('blob');
      const path = `reports/pw/${monday}-${Date.now()}.pdf`;
      const up = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'application/pdf' });
      if (up.error) throw up.error;
      const f = must(await supabase.from('files').insert({ kind: 'report', file_name: `PW-report-${monday}.pdf`, mime_type: 'application/pdf', size_bytes: blob.size, storage_path: path }).select('id').single()) as { id: string };
      must(await supabase.from('pw_reports').insert({ week_start: monday, snapshot: groups, file_id: f.id }));
    });

  return (
    <div className="flex flex-wrap items-start gap-6 px-4 py-6 sm:px-6">
      <aside className="flex max-w-[440px] flex-[1_1_320px] flex-col gap-4">
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-base font-bold">Week</h2>
          <div className="flex items-center gap-2">
            <button aria-label="Previous week" onClick={() => setMonday(shift(monday, -7))} className="h-11 w-11 rounded-md border border-slate-300 bg-white text-lg">‹</button>
            <div className="flex-1 text-center font-bold">Mon {monthDay(monday)} – Sun {monthDay(shift(monday, 6))}</div>
            <button aria-label="Next week" onClick={() => setMonday(shift(monday, 7))} className="h-11 w-11 rounded-md border border-slate-300 bg-white text-lg">›</button>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-slate-50 p-2.5"><div className="text-[22px] font-bold">{groups.length}</div><div className="text-xs text-slate-600">PW jobs</div></div>
            <div className="rounded-lg bg-slate-50 p-2.5"><div className="text-[22px] font-bold">{people}</div><div className="text-xs text-slate-600">employees</div></div>
            <div className="rounded-lg bg-slate-50 p-2.5"><div className={unmatched.length ? 'text-[22px] font-bold text-red-700' : 'text-[22px] font-bold'}>{unmatched.length}</div><div className="text-xs text-slate-600">unmatched</div></div>
          </div>
        </Card>
        {unmatched.length > 0 && (
          <Card className="flex flex-col gap-1.5 border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <b>Fix before you send</b>
            {unmatched.map((u, i) => <div key={i}>“{u.employee.replace(' (unmatched)', '')}” on <Link to={`/work-orders?q=${u.work_order_number}`}>{u.work_order_number}</Link> isn’t matched to an employee.</div>)}
          </Card>
        )}
        <p className="text-[13px] text-slate-600">
          Includes every work order at a PW job that was started, done, on hold, or canceled with the crew on site. Uncheck “Crew went to the site” on a canceled work order to leave it off.
        </p>
        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" onClick={download}>Download PDF</Button>
          <Button className="flex-1" disabled={run.isPending} onClick={saveHistory}>Save to history</Button>
        </div>
        <ErrorBox error={rows.error || run.error} />

        {toConfirm.length > 0 && (
          <Card className="flex flex-col gap-3 border-amber-300 p-4">
            <h2 className="text-base font-bold">Matches to confirm · {toConfirm.length}</h2>
            <p className="text-[13px] text-slate-600">These PW list lines were linked to an existing job by a similar name. Confirm each one, or unlink it and add the right job below.</p>
            {toConfirm.map((p) => (
              <div key={p.id} className="flex flex-col gap-2 rounded-lg bg-amber-50 p-3 text-sm">
                <div><Link to={`/jobs/${p.job.id}`} className="font-semibold text-slate-900">{p.job.name}</Link> <span className="text-slate-600">· {p.job.customer.name}{p.job.city ? ` · ${p.job.city}` : ''}</span></div>
                {p.match_note && <div className="text-[13px] text-slate-700">{p.match_note}</div>}
                <div className="flex gap-2">
                  <Button size="sm" variant="success" onClick={() => run.mutate(async () => must(await supabase.from('prevailing_wage_periods').update({ needs_review: false, reviewed_at: new Date().toISOString(), reviewed_by: session?.user.id }).eq('id', p.id)))}>Correct</Button>
                  <Button size="sm" variant="danger" onClick={() => { if (confirm(`Unlink "${p.job.name}" from the PW list? It will no longer count as prevailing wage.`)) run.mutate(async () => must(await supabase.from('prevailing_wage_periods').delete().eq('id', p.id))); }}>Wrong job — unlink</Button>
                </div>
              </div>
            ))}
          </Card>
        )}

        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-base font-bold">PW job list · {(periods.data ?? []).filter((p) => !p.effective_to).length} active</h2>
          <input aria-label="Filter PW jobs" className={inputCls} placeholder="Filter by job or customer…" value={listFilter} onChange={(e) => setListFilter(e.target.value)} />
          {(periods.data ?? []).filter((p) => !listFilter || `${p.job.name} ${p.job.customer.name} ${p.job.city ?? ''}`.toLowerCase().includes(listFilter.toLowerCase())).map((p) => (
            <div key={p.id} className="flex items-center gap-2 border-b border-slate-100 pb-2 text-sm">
              {p.needs_review && <span title="Match not confirmed yet" className="rounded bg-amber-100 px-1 text-[11px] font-bold text-amber-800">?</span>}
              <div className="flex-1">
                <Link to={`/jobs/${p.job.id}`} className="font-semibold text-slate-900">{p.job.name}</Link>
                <div className="text-xs text-slate-600">{p.job.customer.name} · from {shortDate(p.effective_from)}{p.effective_to ? ` to ${shortDate(p.effective_to)}` : ''}{p.source_note ? ` · ${p.source_note}` : ''}</div>
              </div>
              {p.effective_to ? <span className="text-xs font-bold text-slate-500">Ended</span> : (
                <button className="text-xs font-semibold text-brand-dark underline" onClick={() => { const d = prompt('Last prevailing wage day (YYYY-MM-DD)', todayIso()); if (d) run.mutate(async () => must(await supabase.from('prevailing_wage_periods').update({ effective_to: d }).eq('id', p.id))); }}>End</button>
              )}
            </div>
          ))}
          <div className="flex flex-col gap-2 rounded-lg bg-slate-50 p-3">
            <b className="text-sm">Add a job to the PW list</b>
            <JobPicker value={addJob} onChange={setAddJob} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="PW starts"><input type="date" className={inputCls} value={addFrom} onChange={(e) => setAddFrom(e.target.value)} /></Field>
              <Field label="Note"><input className={inputCls} placeholder="e.g. from 11/2026 list" value={addNote} onChange={(e) => setAddNote(e.target.value)} /></Field>
            </div>
            <Button size="sm" variant="primary" className="self-start" disabled={!addJob}
              onClick={() => run.mutate(async () => { must(await supabase.from('prevailing_wage_periods').insert({ job_id: addJob!.id, effective_from: addFrom, source_note: addNote || null })); setAddJob(null); setAddNote(''); })}>
              Add to PW list
            </Button>
          </div>
        </Card>
        {(history.data?.length ?? 0) > 0 && (
          <Card className="flex flex-col gap-1.5 p-4 text-sm">
            <h2 className="text-base font-bold">Saved reports</h2>
            {history.data!.map((h) => (
              <button key={h.id} className="text-left text-brand-dark underline" onClick={async () => {
                if (!h.file) return;
                const { data } = await supabase.storage.from(BUCKET).createSignedUrl(h.file.storage_path, 600);
                if (data) window.open(data.signedUrl, '_blank');
              }}>Week of {shortDate(h.week_start)} · saved {stamp(h.generated_at)}</button>
            ))}
          </Card>
        )}
      </aside>

      <section className="flex min-w-0 flex-[999_1_560px] justify-center">
        <div className="box-border flex min-h-[860px] w-full max-w-[680px] flex-col gap-5 bg-white px-[52px] py-12 shadow-xl">
          <div className="flex items-start gap-4 border-b-2 border-slate-900 pb-3.5">
            <div className="flex-1">
              <div className="text-[22px] font-semibold">Prevailing Wage — Weekly Report</div>
              <div className="mt-1 text-[13px] text-slate-700">Week of Monday {mdy(monday)} – Sunday {mdy(shift(monday, 6))}</div>
            </div>
            <div className="text-right text-xs text-slate-700">KT Sales &amp; Service<br />for Fiber Care Baths, Inc.</div>
          </div>
          {rows.isLoading && <Spinner />}
          {groups.map((g) => (
            <div key={g.title}>
              <div className="py-2 text-[15px] font-bold">{g.title}</div>
              <div className="grid grid-cols-[140px_1fr] border-y border-slate-400 py-1.5 text-xs font-bold tracking-wide text-slate-700 uppercase"><div>Date</div><div>Employee</div></div>
              {g.rows.map((r, i) => (
                <div key={i} className="grid grid-cols-[140px_1fr] border-b border-slate-200 py-1.5 text-sm">
                  <div className="font-mono text-[13px]">{mdy(r.work_date)}</div>
                  <div className={r.unmatched ? 'font-semibold text-red-700' : ''}>{r.employee}</div>
                </div>
              ))}
            </div>
          ))}
          {rows.data && groups.length === 0 && <p className="text-sm text-slate-600">No prevailing wage work this week.</p>}
        </div>
      </section>
    </div>
  );
}
