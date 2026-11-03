import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must, signedUrl } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useEmployees, useFlagTypes } from '@/lib/data';
import { stamp, todayIso } from '@/lib/dates';
import { uploadFile } from '@/components/FilesPanel';
import JobPicker, { type PickedJob } from '@/components/JobPicker';
import { Button, Card, ErrorBox, Field, SectionLabel, Spinner, cx, inputCls } from '@/components/ui';

interface SheetLine { lot: string; room: string | null; product: string; hand: 'L' | 'R' | null; qty: number; status: string; uncertain?: boolean }
interface Sheet {
  page?: number; form_type?: string; date?: string | null; customer?: string | null; job_name?: string | null; city?: string | null; area?: string | null;
  prevailing_wage_marked?: boolean; time_in?: string | null; time_out?: string | null; lead?: string | null; helpers?: string[];
  lines?: SheetLine[]; notes_original?: string | null; notes_english?: string | null; flags?: string[]; flag_details?: Record<string, string>;
  superintendent_name?: string | null; superintendent_signed?: boolean; uncertain_fields?: string[]; confidence?: number;
  job_candidates?: { job_id: string; job_name: string; customer_name: string; city: string | null }[];
  work_order_candidates?: { id: string; number: string; type_code: string; status: string; job_id: string }[];
  name_matches?: { raw: string; position: string; candidates: { employee_id: string; display_name: string; score: number }[] }[];
  confirmed_work_order_id?: string; confirmed_number?: string;
}
interface Scan {
  id: string; status: string; created_at: string; error: string | null; confidence: number | null; work_order_id: string | null;
  extracted: { sheets: Sheet[] } | null;
  file: { id: string; file_name: string; storage_path: string; mime_type: string | null };
}

async function callExtract(scanId: string) {
  const { data } = await supabase.auth.getSession();
  const r = await fetch('/api/extract-scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify({ scanId }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `Reading failed (${r.status})`);
  }
}

const TYPE_FROM_FORM: Record<string, string> = { installation: 'IN', stocking: 'ST', finals: 'FN' };

function SheetReview({ scan, idx, sheet, onDone }: { scan: Scan; idx: number; sheet: Sheet; onDone: () => void }) {
  const emps = useEmployees();
  const flagTypes = useFlagTypes();
  const qc = useQueryClient();
  const firstWo = sheet.work_order_candidates?.[0];
  const [woId, setWoId] = useState<string>(firstWo?.id ?? '');
  const [newJob, setNewJob] = useState<PickedJob | null>(
    sheet.job_candidates?.[0] ? { id: sheet.job_candidates[0].job_id, name: sheet.job_candidates[0].job_name, customer: sheet.job_candidates[0].customer_name, city: sheet.job_candidates[0].city } : null,
  );
  const [date, setDate] = useState(sheet.date ?? todayIso());
  const [type, setType] = useState(TYPE_FROM_FORM[sheet.form_type ?? ''] ?? 'IN');
  const [canceled, setCanceled] = useState(!(sheet.lines?.length) && (sheet.flags ?? []).includes('not_ready'));
  const [workers, setWorkers] = useState(
    (sheet.name_matches ?? [{ raw: sheet.lead ?? '', position: 'lead', candidates: [] }]).filter((m) => m.raw).map((m) => ({
      raw: m.raw, position: m.position, employee_id: m.candidates[0] && m.candidates[0].score >= 0.6 ? m.candidates[0].employee_id : '', candidates: m.candidates,
    })),
  );
  const [lines, setLines] = useState<SheetLine[]>(sheet.lines ?? []);
  const [flags, setFlags] = useState<string[]>(sheet.flags ?? []);
  const [timeIn, setTimeIn] = useState(sheet.time_in ?? '');
  const [timeOut, setTimeOut] = useState(sheet.time_out ?? '');
  const [notesEs, setNotesEs] = useState(sheet.notes_original ?? '');
  const [notesEn, setNotesEn] = useState(sheet.notes_english ?? '');
  const [signed, setSigned] = useState(!!sheet.superintendent_signed);
  const [superName, setSuperName] = useState(sheet.superintendent_name ?? '');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (sheet.confirmed_work_order_id) {
    return (
      <Card className="flex items-center gap-3 p-4 text-sm">
        <span className="rounded bg-green-100 px-2 py-1 text-xs font-bold text-green-800">CONFIRMED</span>
        <span>Saved to <Link to={`/work-orders/${sheet.confirmed_work_order_id}`} className="font-mono">{sheet.confirmed_number}</Link></span>
      </Card>
    );
  }

  async function confirm() {
    setErr(null);
    setBusy(true);
    try {
      let targetId = woId;
      let targetNumber = sheet.work_order_candidates?.find((w) => w.id === woId)?.number ?? '';
      if (!targetId) {
        if (!newJob) throw new Error('Pick the job this sheet belongs to.');
        const created = must(
          await supabase.from('work_orders').insert({ type_code: type, job_id: newJob.id, scheduled_date: date, scope: sheet.area ? `From paper — ${sheet.area}` : 'From paper', source: 'other' }).select('id, number').single(),
        ) as { id: string; number: string };
        targetId = created.id;
        targetNumber = created.number;
      }
      must(
        await supabase.from('work_orders').update({
          status: canceled ? 'canceled' : flags.includes('partial') ? 'complete' : 'complete',
          status_reason: canceled ? notesEn || notesEs || 'Not ready' : null,
          crew_on_site: true,
          time_in: timeIn || null, time_out: timeOut || null,
          completion_notes: notesEs || null, completion_notes_en: notesEn || null,
          superintendent_signed: signed, superintendent_name: superName || null,
        }).eq('id', targetId),
      );
      // the sheet is the record of who was there — replace roster-derived names
      must(await supabase.from('work_order_workers').delete().eq('work_order_id', targetId));
      const wrows = workers.filter((w) => w.raw || w.employee_id).map((w) => ({
        work_order_id: targetId, employee_id: w.employee_id || null, raw_name: w.raw, position: w.position, source: 'scan',
        match_confidence: w.employee_id ? 1 : null,
      }));
      if (wrows.length) must(await supabase.from('work_order_workers').insert(wrows));
      // teach the alias list
      const aliasRows = workers
        .filter((w) => w.employee_id && w.raw && !emps.data?.some((e) => e.id === w.employee_id && e.display_name.toLowerCase() === w.raw.toLowerCase()))
        .map((w) => ({ employee_id: w.employee_id, alias: w.raw.replace(/\?/g, '').trim(), source: 'scan_confirmed' }));
      if (aliasRows.length) await supabase.from('employee_aliases').upsert(aliasRows, { onConflict: 'employee_id,alias_norm', ignoreDuplicates: true });
      if (lines.length) {
        must(await supabase.from('work_order_lines').insert(lines.map((l, i) => ({
          work_order_id: targetId, lot_label: l.lot || null, room: l.room, raw_product: l.product || null, hand: l.hand,
          qty_planned: l.qty || 1, qty_done: ['done', 'room_in', 'stockpiled'].includes(l.status) ? l.qty || 1 : null, status: l.status, sort_order: i + 1,
        }))));
      }
      if (flags.length) {
        must(await supabase.from('work_order_flags').insert(flags.map((code) => ({ work_order_id: targetId, flag_code: code, note: sheet.flag_details?.[code] ?? null }))));
      }
      // attach the scan to the work order (one file row per work order, same stored object)
      if (idx === 0 && !scan.work_order_id) {
        must(await supabase.from('files').update({ work_order_id: targetId, caption: `Scanned sheet${sheet.page ? ` · page ${sheet.page}` : ''}` }).eq('id', scan.file.id));
        must(await supabase.from('work_order_scans').update({ work_order_id: targetId }).eq('id', scan.id));
      } else {
        must(await supabase.from('files').insert({
          work_order_id: targetId, kind: 'scan', file_name: scan.file.file_name, mime_type: scan.file.mime_type, storage_path: scan.file.storage_path,
          caption: `Scanned sheet${sheet.page ? ` · page ${sheet.page}` : ''}`,
        }));
      }
      const sheets = [...(scan.extracted?.sheets ?? [])];
      sheets[idx] = { ...sheet, confirmed_work_order_id: targetId, confirmed_number: targetNumber };
      const allDone = sheets.every((s) => s.confirmed_work_order_id);
      must(await supabase.from('work_order_scans').update({
        extracted: { sheets }, status: allDone ? 'confirmed' : 'needs_review', reviewed_at: allDone ? new Date().toISOString() : null,
      }).eq('id', scan.id));
      qc.invalidateQueries();
      onDone();
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  }

  const uncertain = new Set(sheet.uncertain_fields ?? []);
  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <b>Page {sheet.page ?? idx + 1}</b>
          <span className="text-slate-600">{sheet.customer} · {sheet.job_name} · {sheet.city}{sheet.area ? ` · ${sheet.area}` : ''}</span>
          {sheet.prevailing_wage_marked && <span className="rounded bg-violet-100 px-1.5 text-xs font-bold text-violet-800">“PW” written on sheet</span>}
          {typeof sheet.confidence === 'number' && <span className={cx('ml-auto text-xs font-semibold', sheet.confidence < 0.7 ? 'text-amber-800' : 'text-slate-500')}>read confidence {Math.round(sheet.confidence * 100)}%</span>}
        </div>
        <Field label="Which work order is this?">
          <select className={inputCls} value={woId} onChange={(e) => setWoId(e.target.value)}>
            {(sheet.work_order_candidates ?? []).map((w) => <option key={w.id} value={w.id}>{w.number} · scheduled that day</option>)}
            <option value="">Create a new work order from this sheet…</option>
          </select>
        </Field>
        {!woId && (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <Field label="Job"><JobPicker value={newJob} onChange={setNewJob} /></Field>
            <Field label="Date"><input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Type">
              <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}><option value="IN">Install</option><option value="ST">Stocking</option><option value="FN">Finals</option></select>
            </Field>
          </div>
        )}
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" className="h-5 w-5" checked={canceled} onChange={(e) => setCanceled(e.target.checked)} /> Visit canceled — crew went but couldn’t work</label>
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <h3 className="text-[15px] font-bold">Who worked <span className="text-[13px] font-normal text-slate-600">· feeds the PW report</span></h3>
        {workers.map((w, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1.5 text-sm">
            <span className="w-28 font-mono text-[13px] text-slate-600">“{w.raw}”</span>
            <span aria-hidden="true">→</span>
            <select aria-label={`Employee for ${w.raw}`} className={cx(inputCls, 'min-h-9 flex-1', !w.employee_id && 'border-amber-400 bg-amber-50')} value={w.employee_id}
              onChange={(e) => setWorkers(workers.map((x, j) => (j === i ? { ...x, employee_id: e.target.value } : x)))}>
              <option value="">— not matched (pick someone) —</option>
              {w.candidates.map((c) => <option key={'c' + c.employee_id} value={c.employee_id}>{c.display_name} · {Math.round(c.score * 100)}% match</option>)}
              <optgroup label="Everyone">
                {(emps.data ?? []).filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.display_name}</option>)}
              </optgroup>
            </select>
            <span className="text-xs text-slate-500">{w.position}</span>
            <button aria-label="Remove" className="text-red-700" onClick={() => setWorkers(workers.filter((_, j) => j !== i))}>×</button>
          </div>
        ))}
        <Button size="sm" className="self-start" onClick={() => setWorkers([...workers, { raw: '', position: 'helper', employee_id: '', candidates: [] }])}>+ Add person</Button>
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="flex-1 text-[15px] font-bold">Lines · {lines.length}</h3>
          <label className="text-xs font-semibold">In <input type="time" className="ml-1 min-h-9 rounded border border-slate-300 px-1" value={timeIn} onChange={(e) => setTimeIn(e.target.value)} /></label>
          <label className="text-xs font-semibold">Out <input type="time" className="ml-1 min-h-9 rounded border border-slate-300 px-1" value={timeOut} onChange={(e) => setTimeOut(e.target.value)} /></label>
        </div>
        {(uncertain.has('time_in') || uncertain.has('time_out')) && <p className="text-xs text-amber-800">Times were hard to read — check them.</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b border-slate-300 text-left text-xs tracking-wider text-slate-600 uppercase"><tr><th className="py-1.5">Lot</th><th>Room</th><th>Product</th><th>Hand</th><th>Qty</th><th>Status</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const set = (p: Partial<SheetLine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...p } : x)));
                return (
                  <tr key={i} className={cx('border-b border-slate-100', l.uncertain && 'bg-amber-50')}>
                    <td className="py-1 pr-1"><input aria-label="Lot" className="min-h-8 w-16 rounded border border-slate-300 px-1" value={l.lot} onChange={(e) => set({ lot: e.target.value })} /></td>
                    <td className="pr-1"><input aria-label="Room" className="min-h-8 w-20 rounded border border-slate-300 px-1" value={l.room ?? ''} onChange={(e) => set({ room: e.target.value || null })} /></td>
                    <td className="pr-1"><input aria-label="Product" className="min-h-8 w-full rounded border border-slate-300 px-1 font-mono text-[13px]" value={l.product} onChange={(e) => set({ product: e.target.value })} /></td>
                    <td className="pr-1"><select aria-label="Hand" className="min-h-8 rounded border border-slate-300" value={l.hand ?? ''} onChange={(e) => set({ hand: (e.target.value || null) as SheetLine['hand'] })}><option value="">—</option><option>L</option><option>R</option></select></td>
                    <td className="pr-1"><input aria-label="Qty" type="number" className="min-h-8 w-14 rounded border border-slate-300 px-1" value={l.qty} onChange={(e) => set({ qty: Number(e.target.value) })} /></td>
                    <td className="pr-1"><select aria-label="Status" className="min-h-8 rounded border border-slate-300" value={l.status} onChange={(e) => set({ status: e.target.value })}>{['done', 'stockpiled', 'room_in', 'returned', 'not_ready', 'missing', 'damaged'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></td>
                    <td><button aria-label="Remove line" className="text-red-700" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button size="sm" className="self-start" onClick={() => setLines([...lines, { lot: '', room: null, product: '', hand: null, qty: 1, status: 'done' }])}>+ Add line</Button>
        {lines.some((l) => l.uncertain) && <p className="text-xs text-amber-800">Highlighted lines were hard to read — check them against the sheet.</p>}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h3 className="text-[15px] font-bold">Crew note</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="As written"><textarea rows={3} className={inputCls + ' py-2'} value={notesEs} onChange={(e) => setNotesEs(e.target.value)} /></Field>
          <Field label="English"><textarea rows={3} className={inputCls + ' py-2'} value={notesEn} onChange={(e) => setNotesEn(e.target.value)} /></Field>
        </div>
        <SectionLabel>Flags</SectionLabel>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {(flagTypes.data ?? []).map((t) => (
            <label key={t.code} className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" className="h-5 w-5" checked={flags.includes(t.code)} onChange={(e) => setFlags(e.target.checked ? [...flags, t.code] : flags.filter((x) => x !== t.code))} />
              {t.label}{sheet.flag_details?.[t.code] && <span className="text-xs text-slate-600">— {sheet.flag_details[t.code]}</span>}
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Superintendent"><input className={inputCls} value={superName} onChange={(e) => setSuperName(e.target.value)} /></Field>
          <label className="flex items-end gap-2 pb-3 text-sm font-semibold"><input type="checkbox" className="h-5 w-5" checked={signed} onChange={(e) => setSigned(e.target.checked)} /> Signed</label>
        </div>
      </Card>
      <ErrorBox error={err} />
      <Button variant="success" disabled={busy} onClick={confirm}>{busy ? 'Saving…' : 'Confirm & save to work order'}</Button>
    </div>
  );
}

function ScanPreview({ scan }: { scan: Scan }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { setUrl(null); signedUrl(scan.file.storage_path).then(setUrl); }, [scan.file.storage_path]);
  if (!url) return <Spinner />;
  return scan.file.mime_type === 'application/pdf'
    ? <iframe title={scan.file.file_name} src={url} className="h-[80vh] w-full" />
    : <img src={url} alt={`Scan ${scan.file.file_name}`} className="w-full" />;
}

export default function Intake() {
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [uploading, setUploading] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const scans = useQuery({
    queryKey: ['scans', showDone],
    refetchInterval: (q) => ((q.state.data as Scan[] | undefined)?.some((s) => s.status === 'processing' || s.status === 'uploaded') ? 4000 : false),
    queryFn: async () => {
      let r = supabase.from('work_order_scans').select('*, file:files!wo_scans_file_fk(id, file_name, storage_path, mime_type)').order('created_at', { ascending: false }).limit(100);
      if (!showDone) r = r.in('status', ['uploaded', 'processing', 'needs_review', 'failed']);
      return must(await r) as unknown as Scan[];
    },
  });
  const sel = useMemo(() => scans.data?.find((s) => s.id === selId) ?? null, [scans.data, selId]);

  const read = useMutation({
    mutationFn: callExtract,
    onSettled: () => qc.invalidateQueries({ queryKey: ['scans'] }),
  });
  const run = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: () => qc.invalidateQueries({ queryKey: ['scans'] }) });

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    try {
      let i = 0;
      for (const f of Array.from(files)) {
        i += 1;
        setUploading(`Uploading ${i} of ${files.length}…`);
        const row = await uploadFile(f, {}, 'scan', `scans/${todayIso()}`);
        const scan = must(await supabase.from('work_order_scans').insert({ file_id: row.id, status: 'uploaded' }).select('id').single()) as { id: string };
        read.mutate(scan.id);
        if (i === 1) setSelId(scan.id);
      }
    } finally {
      setUploading(null);
      if (input.current) input.current.value = '';
      qc.invalidateQueries({ queryKey: ['scans'] });
    }
  }

  const sheets = sel?.extracted?.sheets ?? [];
  return (
    <div className="flex flex-wrap items-start gap-4 px-4 py-4 sm:px-6">
      <aside aria-label="Scan queue" className="flex max-w-[280px] flex-[1_1_240px] flex-col gap-2.5">
        {canEdit && (
          <button
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onPick(e.dataTransfer.files); }}
            className="flex flex-col items-center gap-1.5 rounded-[10px] border-2 border-dashed border-slate-400 bg-white px-3.5 py-5 text-center"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1D4ED8" strokeWidth="2" aria-hidden="true"><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v4h16v-4" /></svg>
            <span className="text-[15px] font-bold">{uploading ?? 'Drop the day’s sheets'}</span>
            <span className="text-[13px] text-slate-600">PDF from the scanner or phone photos · many at once</span>
          </button>
        )}
        <input ref={input} type="file" multiple accept="application/pdf,image/*" className="hidden" onChange={(e) => onPick(e.target.files)} />
        <div className="flex items-center"><SectionLabel>Queue</SectionLabel><span className="flex-1" /><label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show confirmed</label></div>
        {scans.isLoading && <Spinner />}
        {(scans.data ?? []).map((s) => {
          const n = s.extracted?.sheets?.length ?? 0;
          const done = s.extracted?.sheets?.filter((x) => x.confirmed_work_order_id).length ?? 0;
          return (
            <button key={s.id} onClick={() => { setSelId(s.id); setSheetIdx(0); }} className={cx('flex flex-col gap-0.5 rounded-lg p-2.5 text-left', selId === s.id ? 'border-2 border-brand bg-blue-50' : 'border border-slate-300 bg-white')}>
              <span className="truncate text-sm font-bold">{s.file.file_name}</span>
              <span className="text-xs text-slate-600">{stamp(s.created_at)}</span>
              <span className={cx('text-xs font-semibold', s.status === 'failed' ? 'text-red-700' : s.status === 'confirmed' ? 'text-green-800' : 'text-amber-800')}>
                {s.status === 'processing' || s.status === 'uploaded' ? 'Reading…' : s.status === 'failed' ? 'Couldn’t read — open to retry or enter by hand' : s.status === 'confirmed' ? 'Confirmed' : `${done} of ${n} sheets confirmed`}
              </span>
            </button>
          );
        })}
        {scans.data?.length === 0 && <p className="text-sm text-slate-500">Nothing waiting. Upload the day’s sheets to start.</p>}
      </aside>

      {sel ? (
        <>
          <section aria-label="Scanned sheet" className="max-w-[560px] flex-[1_1_420px] overflow-hidden rounded-[10px] border border-slate-300 bg-white">
            <div className="border-b border-slate-200 px-3 py-2.5 text-[13px] font-bold">{sel.file.file_name}</div>
            <ScanPreview scan={sel} />
          </section>
          <main className="flex min-w-0 flex-[999_1_420px] flex-col gap-3">
            <ErrorBox error={read.error || run.error} />
            {(sel.status === 'processing' || sel.status === 'uploaded') && <Spinner label="Reading the sheets — about 10–60 seconds…" />}
            {sel.status === 'failed' && (
              <Card className="flex flex-col gap-3 p-4">
                <p className="text-sm text-red-800">{sel.error}</p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => read.mutate(sel.id)} disabled={read.isPending}>Try reading again</Button>
                  <Button onClick={() => run.mutate(async () => must(await supabase.from('work_order_scans').update({ status: 'needs_review', extracted: { sheets: [{ page: 1, lines: [], helpers: [] }] } }).eq('id', sel.id)))}>Enter by hand</Button>
                </div>
              </Card>
            )}
            {sheets.length > 0 && sel.status !== 'processing' && (
              <>
                <div role="tablist" className="flex flex-wrap gap-1">
                  {sheets.map((s, i) => (
                    <button key={i} role="tab" aria-selected={sheetIdx === i} onClick={() => setSheetIdx(i)} className={cx('min-h-9 rounded-md px-3 text-sm font-semibold', sheetIdx === i ? 'bg-navy text-white' : 'border border-slate-300 bg-white')}>
                      {s.confirmed_work_order_id ? '✓ ' : ''}{s.job_name ?? `Sheet ${i + 1}`}
                    </button>
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => run.mutate(async () => must(await supabase.from('work_order_scans').update({ extracted: { sheets: [...sheets, { page: sheets.length + 1, lines: [], helpers: [] }] } }).eq('id', sel.id)))}>+ sheet</Button>
                </div>
                {sheets[sheetIdx] && (
                  <SheetReview key={`${sel.id}-${sheetIdx}`} scan={sel} idx={sheetIdx} sheet={sheets[sheetIdx]} onDone={() => setSheetIdx(Math.min(sheetIdx + 1, sheets.length - 1))} />
                )}
              </>
            )}
            {sel.status === 'needs_review' && sheets.length === 0 && <p className="text-sm text-slate-600">No work orders were found in this file.</p>}
            {canEdit && (
              <Button variant="ghost" className="self-start text-red-700" onClick={() => { if (confirm('Remove this scan from the queue? The file stays in storage.')) run.mutate(async () => { must(await supabase.from('work_order_scans').update({ status: 'discarded' }).eq('id', sel.id)); setSelId(null); }); }}>
                Discard from queue
              </Button>
            )}
          </main>
        </>
      ) : (
        <div className="flex-[999_1_420px] p-6 text-sm text-slate-600">Pick a scan from the queue, or upload new sheets.</div>
      )}
    </div>
  );
}
