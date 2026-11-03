-- =====================================================================
-- 0010 Crews are named by their lead's full name + a work-order overview
--      view that feeds the admin/manager dashboard.
-- =====================================================================

-- Rename each crew to its usual lead's full name ('Gilberto' -> 'Gilberto Arellano')
update public.crews c
   set name = e.display_name
  from public.crew_default_members m
  join public.employees e on e.id = m.employee_id
 where m.crew_id = c.id and m.position = 'lead' and c.name is distinct from e.display_name;

-- One row per work order with everything a dashboard or list needs
create or replace view public.v_work_order_overview with (security_invoker = true) as
select w.id, w.number, w.type_code, w.status, w.status_reason, w.scheduled_date, w.priority,
       w.crew_on_site, w.created_at, w.completed_at, w.parent_id,
       j.id as job_id, j.name as job, j.city, co.name as customer,
       public.is_prevailing_wage(j.id, coalesce(w.scheduled_date, current_date)) as prevailing_wage,
       public.open_flag_count(w.id) as open_flags,
       (select coalesce(max(t.severity), 0) from public.work_order_flags f join public.flag_types t on t.code = f.flag_code
         where f.work_order_id = w.id and f.resolved_at is null) as max_flag_severity,
       (select string_agg(distinct t.label, ', ') from public.work_order_flags f join public.flag_types t on t.code = f.flag_code
         where f.work_order_id = w.id and f.resolved_at is null and t.severity >= 2) as open_flag_labels,
       (select coalesce(cd.label, c.name) from public.crew_day_stops s join public.crew_days cd on cd.id = s.crew_day_id
          left join public.crews c on c.id = cd.crew_id where s.work_order_id = w.id limit 1) as crew_name,
       (select c.department from public.crew_day_stops s join public.crew_days cd on cd.id = s.crew_day_id
          left join public.crews c on c.id = cd.crew_id where s.work_order_id = w.id limit 1) as department,
       exists (select 1 from public.work_order_workers ww where ww.work_order_id = w.id and ww.employee_id is null) as has_unmatched_worker
  from public.work_orders w
  join public.jobs j on j.id = w.job_id
  join public.companies co on co.id = j.customer_id;
