import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { clock, shortDate, todayIso } from '@/lib/dates';
import type { WoStatus, WoType } from '@/lib/types';
import { Button, ErrorBox, FlagChip, PwBadge, SectionLabel, Spinner, STATUS_META, TYPE_META, cx } from './ui';

export interface WoFull {
  id: string;
  number: string;
  type_code: WoType;
  status: WoStatus;
  status_reason: string | null;
  scheduled_date: string | null;
  scope: string | null;
  priority: number;
  crew_on_site: boolean;
  time_in: string | null;
  time_out: string | null;
  completion_notes: string | null;
  completion_notes_en: string | null;
  superintendent_name: string | null;
  superintendent_signed: boolean | null;
  parent_id: string | null;
  job: { id: string; name: string; city: string | null; customer: { id: string; name: string } };
  flags: { id: string; flag_code: string; note: string | null; resolved_at: string | null; spawned_work_order_id: string | null; type: { label: string; color: string; offers_action: string | null } }[];
  workers: { id: string; raw_name: string | null; position: string | null; employee: { id: string; display_name: string } | null }[];
  locations: { id: string; label: string | null; area: { name: string } | null; lot: { lot_number: string } | null }[];
}

export const WO_SELECT =
  '*, job:jobs(id, name, city, customer:companies(id, name)), flags:work_order_flags!work_order_flags_work_order_id_fkey(id, flag_code, note, resolved_at, spawned_work_order_id, type:flag_types(label, color, offers_action)), workers:work_order_workers(id, raw_name, position, employee:employees(id, display_name)), locations:work_order_locations(id, label, area:job_areas(name), lot:lots(lot_number))';

export function useWorkOrder(id: string) {
  return useQuery({
    queryKey: ['wo', id],
    queryFn: async () => must(await supabase.from('work_orders').select(WO_SELECT).eq('id', id).single()) as unknown as WoFull,
  });
}

export function usePw(jobId: string | undefined, date: string | null | undefined) {
  return useQuery({
    queryKey: ['pw', jobId, date],
    enabled: !!jobId,
    queryFn: async () => must(await supabase.rpc('is_prevailing_wage', { p_job: jobId!, p_date: date ?? todayIso() })) as boolean,
  });
}

const STATUSES: WoStatus[] = ['planned', 'started', 'on_hold', 'complete', 'canceled'];

export default function WorkOrderDrawer({ id, onClose, onStatus, fullscreen }: { id: string; onClose: () => void; onStatus: (s: WoStatus) => void; fullscreen?: boolean }) {
  const { canEdit } = useAuth();
  const q = useWorkOrder(id);
  const wo = q.data;
  const pw = usePw(wo?.job.id, wo?.scheduled_date);

  return (
    <aside
      aria-label="Work order detail"
      className={fullscreen
        ? 'fixed inset-0 z-50 overflow-y-auto bg-white pb-[env(safe-area-inset-bottom)]'
        : 'max-w-[400px] flex-[1_1_340px] self-start overflow-hidden rounded-[10px] border border-slate-300 bg-white shadow-xl lg:sticky lg:top-4'}
    >
      {!wo ? (
        q.error ? <ErrorBox error={q.error} /> : <Spinner />
      ) : (
        <>
          <div className={cx('flex items-start gap-2 bg-navy px-4 py-3.5 text-white', fullscreen && 'sticky top-0 pt-[max(env(safe-area-inset-top),14px)]')}>
            <div className="flex-1">
              <div className="font-mono text-[13px] text-navy-text">{wo.number} · {TYPE_META[wo.type_code].label}</div>
              <div className="mt-0.5 text-xl font-bold">{wo.job.name}</div>
              <div className="text-[13px] text-navy-text">{wo.job.customer.name}{wo.job.city ? ` · ${wo.job.city}` : ''}</div>
            </div>
            <button onClick={onClose} aria-label="Close detail" className="h-11 w-11 rounded-md bg-navy-2 text-lg">×</button>
          </div>
          <div className="flex flex-col gap-4 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {pw.data && <PwBadge solid />}
              {wo.priority > 0 && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-bold text-red-800">{wo.priority > 1 ? 'URGENT' : 'HIGH'}</span>}
              <span className="text-slate-600">Scheduled {shortDate(wo.scheduled_date)}</span>
            </div>
            <div>
              <SectionLabel>Status</SectionLabel>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {STATUSES.map((s) => (
                  <button
                    key={s}
                    disabled={!canEdit}
                    onClick={() => onStatus(s)}
                    className={cx('min-h-9 rounded-md border px-3 text-[13px] font-semibold', wo.status === s ? 'border-navy bg-navy text-white' : 'border-slate-300 bg-white')}
                  >
                    {STATUS_META[s].label}
                  </button>
                ))}
              </div>
              {wo.status_reason && <p className="mt-2 text-slate-700">{wo.status_reason}</p>}
            </div>
            {wo.scope && (
              <div><SectionLabel>Scope</SectionLabel><p className="mt-1 whitespace-pre-wrap">{wo.scope}</p></div>
            )}
            {wo.locations.length > 0 && (
              <div><SectionLabel>Where</SectionLabel><p className="mt-1">{wo.locations.map((l) => l.label ?? l.lot?.lot_number ?? l.area?.name).join(' · ')}</p></div>
            )}
            {(wo.time_in || wo.time_out) && (
              <div><SectionLabel>Time on sheet</SectionLabel><p className="mt-1">{clock(wo.time_in)} – {clock(wo.time_out)}</p></div>
            )}
            {wo.flags.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>Flags</SectionLabel>
                {wo.flags.map((f) => <div key={f.id}><FlagChip label={f.type.label} color={f.type.color} resolved={!!f.resolved_at} />{f.spawned_work_order_id && <span className="ml-2 text-xs text-slate-600">→ work order created</span>}</div>)}
              </div>
            )}
            {(wo.completion_notes || wo.completion_notes_en) && (
              <div className="flex flex-col gap-1.5">
                <SectionLabel>Crew note</SectionLabel>
                {wo.completion_notes && <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5 text-slate-700 italic">{wo.completion_notes}</div>}
                {wo.completion_notes_en && <p className="px-2.5">{wo.completion_notes_en}</p>}
              </div>
            )}
            {wo.workers.length > 0 && (
              <div>
                <SectionLabel>Who worked</SectionLabel>
                <p className="mt-1">{wo.workers.map((w) => w.employee?.display_name ?? `${w.raw_name} (unmatched)`).join(', ')}</p>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Link to={`/work-orders/${wo.id}`} className="flex-1 rounded-md bg-brand px-3 py-3 text-center font-semibold text-white no-underline">Open work order</Link>
              <Link to={`/jobs/${wo.job.id}`} className="flex-1 rounded-md border border-slate-300 px-3 py-3 text-center font-semibold text-slate-900 no-underline">Job folder</Link>
            </div>
            {!canEdit && <Button variant="ghost" onClick={onClose}>Close</Button>}
          </div>
        </>
      )}
    </aside>
  );
}
