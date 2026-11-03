import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase, must } from '@/lib/supabase';
import { assignWorkOrder, useCrews } from '@/lib/data';
import type { WoType } from '@/lib/types';
import JobPicker, { type PickedJob } from './JobPicker';
import { Button, ErrorBox, Field, Modal, TYPE_META, cx, inputCls } from './ui';

export default function NewWorkOrder({
  open, onClose, defaultDate, defaultJob, defaultCrewId,
}: { open: boolean; onClose: () => void; defaultDate?: string; defaultJob?: PickedJob | null; defaultCrewId?: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const crews = useCrews();
  const [type, setType] = useState<WoType>('IN');
  const [job, setJob] = useState<PickedJob | null>(defaultJob ?? null);
  const [date, setDate] = useState(defaultDate ?? '');
  const [crewId, setCrewId] = useState(defaultCrewId ?? '');
  const [scope, setScope] = useState('');
  const [where, setWhere] = useState('');
  const [source, setSource] = useState('order');
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function save(openAfter: boolean) {
    if (!job) return setErr(new Error('Pick a job.'));
    setBusy(true);
    setErr(null);
    try {
      const wo = must(
        await supabase
          .from('work_orders')
          .insert({ type_code: type, job_id: job.id, scheduled_date: date || null, scope: scope || null, source, priority })
          .select('id, number')
          .single(),
      ) as { id: string; number: string };
      if (where.trim()) must(await supabase.from('work_order_locations').insert({ work_order_id: wo.id, label: where.trim() }));
      if (crewId && date) await assignWorkOrder(wo.id, crewId, date);
      await qc.invalidateQueries();
      onClose();
      if (openAfter) nav(`/work-orders/${wo.id}`);
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New work order" wide>
      <div className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Type" className="flex flex-wrap gap-2">
          {(Object.keys(TYPE_META) as WoType[]).map((t) => (
            <button
              type="button"
              role="radio"
              aria-checked={type === t}
              key={t}
              onClick={() => setType(t)}
              className={cx('min-h-11 rounded-md border px-4 text-sm font-semibold', type === t ? 'border-brand bg-blue-50 text-blue-900' : 'border-slate-300 bg-white')}
            >
              {t === 'FN' ? 'Finals / Repair' : t === 'ST' ? 'Stocking' : 'Installation'}
            </button>
          ))}
        </div>
        <Field label="Job"><JobPicker value={job} onChange={setJob} /></Field>
        <Field label="What needs doing" hint="Written for the crew — lots, units, products, anything they should know">
          <textarea className={cx(inputCls, 'py-2')} rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
        </Field>
        <Field label="Where (buildings / levels / lots)" hint="e.g. Bldg 2, units 213–216 · PH10 lots 1381–1387">
          <input className={inputCls} value={where} onChange={(e) => setWhere(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" hint="Leave empty to keep it in the “needs scheduling” tray">
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Crew">
            <select className={inputCls} value={crewId} onChange={(e) => setCrewId(e.target.value)} disabled={!date}>
              <option value="">— not assigned —</option>
              {(crews.data ?? []).filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Came from">
            <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="order">Order</option>
              <option value="job_walk">Job walk</option>
              <option value="customer_call">Customer call</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Priority">
            <select className={inputCls} value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              <option value={0}>Normal</option>
              <option value={1}>High</option>
              <option value={2}>Urgent</option>
            </select>
          </Field>
        </div>
        <ErrorBox error={err} />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || !job} onClick={() => save(false)}>Create</Button>
          <Button disabled={busy || !job} onClick={() => save(true)}>Create &amp; open</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
