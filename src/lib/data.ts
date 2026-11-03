import { useQuery } from '@tanstack/react-query';
import { supabase, must } from './supabase';
import { todayIso } from './dates';
import type { Crew, Department, Employee, FlagType } from './types';

export function useCrews() {
  return useQuery({
    queryKey: ['crews'],
    queryFn: async () => must(await supabase.from('crews').select('*').order('sort_order').order('name')) as Crew[],
  });
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => must(await supabase.from('departments').select('*').eq('active', true).order('sort_order')) as Department[],
  });
}

const REGION_SHORT: Record<string, string> = { 'Southern California': 'SoCal', 'Northern California': 'NorCal', 'Las Vegas': 'Vegas' };
export const deptLabel = (d: Department | undefined) => (d ? `${REGION_SHORT[d.region] ?? d.region} ${d.name}` : '');

export function useEmployees() {
  return useQuery({
    queryKey: ['employees'],
    queryFn: async () =>
      must(await supabase.from('employees').select('*').order('first_name').order('last_name')) as Employee[],
  });
}

export function useFlagTypes() {
  return useQuery({
    queryKey: ['flag_types'],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => must(await supabase.from('flag_types').select('*').eq('active', true).order('sort_order')) as FlagType[],
  });
}

/** Get (or create) a crew's day, loading its default members if new. */
export async function ensureCrewDay(crewId: string, date: string): Promise<string> {
  const existing = must(
    await supabase.from('crew_days').select('id').eq('crew_id', crewId).eq('work_date', date).maybeSingle(),
  ) as { id: string } | null;
  if (existing) return existing.id;
  const created = must(
    await supabase.from('crew_days').insert({ crew_id: crewId, work_date: date }).select('id').single(),
  ) as { id: string };
  const defaults = must(
    await supabase.from('crew_default_members').select('employee_id, position').eq('crew_id', crewId),
  ) as { employee_id: string; position: string }[];
  if (defaults.length) {
    const taken = must(
      await supabase.from('crew_day_members').select('employee_id').eq('work_date', date).in('employee_id', defaults.map((d) => d.employee_id)),
    ) as { employee_id: string }[];
    const takenSet = new Set(taken.map((t) => t.employee_id));
    const rows = defaults
      .filter((d) => !takenSet.has(d.employee_id))
      .map((d) => ({ crew_day_id: created.id, work_date: date, employee_id: d.employee_id, position: d.position }));
    if (rows.length) must(await supabase.from('crew_day_members').insert(rows));
  }
  return created.id;
}

/** Put a work order on a crew for a date (moves it if it was elsewhere). */
export async function assignWorkOrder(workOrderId: string, crewId: string, date: string) {
  const crewDayId = await ensureCrewDay(crewId, date);
  // Move it off any crew for that date or later; past days stay as history (who went, for payroll/PW).
  const existing = must(
    await supabase.from('crew_day_stops').select('id, crew_day:crew_days(work_date)').eq('work_order_id', workOrderId),
  ) as unknown as { id: string; crew_day: { work_date: string } | null }[];
  const today = todayIso();
  const drop = existing.filter((s) => !s.crew_day || s.crew_day.work_date === date || s.crew_day.work_date >= today).map((s) => s.id);
  if (drop.length) must(await supabase.from('crew_day_stops').delete().in('id', drop));
  const last = must(
    await supabase.from('crew_day_stops').select('sequence').eq('crew_day_id', crewDayId).order('sequence', { ascending: false }).limit(1),
  ) as { sequence: number }[];
  must(
    await supabase.from('crew_day_stops').insert({ crew_day_id: crewDayId, work_order_id: workOrderId, sequence: (last[0]?.sequence ?? 0) + 1 }),
  );
  must(await supabase.from('work_orders').update({ scheduled_date: date }).eq('id', workOrderId));
}

export async function unassignStop(stopId: string) {
  must(await supabase.from('crew_day_stops').delete().eq('id', stopId));
}

/** Put someone on a crew for a day; moves them if they're on another crew that day. */
export async function putMemberOnCrewDay(employeeId: string, crewDayId: string, date: string, position: string) {
  const existing = must(
    await supabase.from('crew_day_members').select('id').eq('work_date', date).eq('employee_id', employeeId).maybeSingle(),
  ) as { id: string } | null;
  if (existing) {
    must(await supabase.from('crew_day_members').update({ crew_day_id: crewDayId, position, status: 'present' }).eq('id', existing.id));
  } else {
    must(await supabase.from('crew_day_members').insert({ crew_day_id: crewDayId, work_date: date, employee_id: employeeId, position, status: 'present' }));
  }
}

/** Create a follow-up (same type) or repair (FN) work order from an existing one. */
export async function spawnWorkOrder(opts: {
  from: { id: string; job_id: string; type_code: string };
  kind: 'follow_up' | 'repair';
  scope: string;
  flagId?: string;
}) {
  const row: Record<string, unknown> =
    opts.kind === 'follow_up'
      ? { type_code: opts.from.type_code, job_id: opts.from.job_id, parent_id: opts.from.id, scope: opts.scope, status: 'planned' }
      : { type_code: 'FN', job_id: opts.from.job_id, scope: opts.scope, source: 'follow_up', priority: 1, status: 'planned' };
  const created = must(await supabase.from('work_orders').insert(row).select('id, number').single()) as { id: string; number: string };
  if (opts.flagId) {
    must(await supabase.from('work_order_flags').update({ spawned_work_order_id: created.id }).eq('id', opts.flagId));
  }
  return created;
}
