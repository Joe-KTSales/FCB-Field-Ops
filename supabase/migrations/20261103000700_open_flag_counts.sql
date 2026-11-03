-- =====================================================================
-- 0007 Count only flags that need action (severity >= 2) as "open flags".
--   "No super signature" and "Photos sent by text" are informational —
--   they stay on the work order but no longer inflate the counters.
-- =====================================================================

create or replace function public.open_flag_count(p_work_order uuid)
returns bigint language sql stable as $$
  select count(*) from public.work_order_flags f
    join public.flag_types t on t.code = f.flag_code
   where f.work_order_id = p_work_order and f.resolved_at is null and t.severity >= 2
$$;

create or replace view public.v_dispatch_board with (security_invoker = true) as
select
  cd.id                          as crew_day_id,
  cd.work_date,
  cd.crew_id,
  coalesce(cd.label, c.name)     as crew_name,
  c.department,
  c.color,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'employee_id', e.id, 'name', e.display_name,
             'position', m.position, 'status', m.status, 'note', m.note)
           order by m.position, e.display_name)
      from public.crew_day_members m join public.employees e on e.id = m.employee_id
     where m.crew_day_id = cd.id), '[]')          as members,
  exists (select 1 from public.crew_day_members m
           where m.crew_day_id = cd.id and m.status in ('called_out','no_show')) as has_callout,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'stop_id', s.id, 'sequence', s.sequence, 'planned_time', s.planned_time,
             'work_order_id', w.id, 'number', w.number, 'type', w.type_code,
             'status', w.status, 'scope', w.scope,
             'job_id', j.id, 'job', j.name, 'city', j.city, 'customer', co.name,
             'prevailing_wage', public.is_prevailing_wage(j.id, cd.work_date),
             'open_flags', public.open_flag_count(w.id))
           order by s.sequence)
      from public.crew_day_stops s
      join public.work_orders w on w.id = s.work_order_id
      join public.jobs j on j.id = w.job_id
      join public.companies co on co.id = j.customer_id
     where s.crew_day_id = cd.id), '[]')          as stops
from public.crew_days cd
left join public.crews c on c.id = cd.crew_id;

create or replace view public.v_job_summary with (security_invoker = true) as
select j.id as job_id, j.name, j.status, j.city, co.name as customer,
       public.is_prevailing_wage(j.id, current_date)                      as prevailing_wage,
       (select count(*) from public.work_orders w where w.job_id = j.id)  as work_orders,
       (select count(*) from public.work_orders w where w.job_id = j.id and w.status not in ('complete','canceled')) as open_work_orders,
       (select coalesce(sum(public.open_flag_count(w.id)), 0) from public.work_orders w where w.job_id = j.id)::bigint as open_flags,
       (select count(*) from public.shipments s where s.job_id = j.id)    as shipments,
       (select count(*) from public.files f where f.job_id = j.id and f.deleted_at is null and f.kind = 'photo') as photos,
       (select count(*) from public.files f where f.job_id = j.id and f.deleted_at is null and f.kind = 'video') as videos,
       (select count(*) from public.files f where f.job_id = j.id and f.deleted_at is null and f.kind not in ('photo','video')) as documents,
       (select count(*) from public.notes n where n.job_id = j.id and n.deleted_at is null) as notes,
       (select max(w.scheduled_date) from public.work_orders w where w.job_id = j.id and w.status <> 'canceled') as last_visit
  from public.jobs j join public.companies co on co.id = j.customer_id;
