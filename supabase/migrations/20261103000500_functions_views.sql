-- =====================================================================
-- 0005 FUNCTIONS & VIEWS — search, name matching, dispatch board,
--                          job folder summary, PW weekly report
-- =====================================================================

-- ---------------------------------------------------------------------
-- Product name parsing:  'WT60-30 HC LH' -> series WT, base 'WT60-30 HC', hand L
-- ---------------------------------------------------------------------
create or replace function public.parse_product_name(p_name text,
  out series text, out base_model text, out hand text)
language plpgsql immutable as $$
declare v text := upper(btrim(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g')));
begin
  series := substring(v from '^([A-Z]+)');
  hand := case when v ~ '\m(LH|L/H)\M' then 'L'
               when v ~ '\m(RH|R/H)\M' then 'R' end;
  base_model := btrim(regexp_replace(v, '\s*\m(LH|RH|L/H|R/H)\M\s*', ' ', 'g'));
end $$;

-- Resolve any raw product string to a product (exact norm match on name or alias)
create or replace function public.resolve_product(p_raw text)
returns uuid language sql stable as $$
  select coalesce(
    (select id from public.products where name_norm = public.norm_name(p_raw)),
    (select product_id from public.product_aliases where alias_norm = public.norm_name(p_raw)))
$$;

-- Resolve a raw company name via aliases (exact), else null
create or replace function public.resolve_company(p_raw text)
returns uuid language sql stable as $$
  select coalesce(
    (select company_id from public.company_aliases where alias_norm = public.norm_name(p_raw)),
    (select id from public.companies where name_norm = public.norm_name(p_raw) limit 1))
$$;

-- ---------------------------------------------------------------------
-- Employee name matching for scanned sheets.
--   select * from match_employee('Naysiso');
-- Returns best candidates; UI auto-accepts >= 0.85, asks otherwise.
-- ---------------------------------------------------------------------
create or replace function public.match_employee(p_raw text, p_limit int default 5)
returns table (employee_id uuid, display_name text, matched_on text, score real)
language sql stable as $$
  with q as (select public.norm_name(p_raw) as n),
  candidates as (
    select e.id, e.display_name, e.display_name as matched_on,
           greatest(extensions.similarity(public.norm_name(e.display_name), q.n),
                    extensions.similarity(public.norm_name(e.first_name), q.n),
                    extensions.word_similarity(q.n, public.norm_name(e.display_name))) as score
      from public.employees e, q where e.active
    union all
    select e.id, e.display_name, a.alias,
           case when a.alias_norm = q.n then 1.0 else extensions.similarity(a.alias_norm, q.n) end
      from public.employee_aliases a join public.employees e on e.id = a.employee_id, q
     where e.active
  )
  select id, display_name, (array_agg(matched_on order by score desc))[1], max(score)::real
    from candidates
   group by id, display_name
  having max(score) > 0.25
   order by max(score) desc
   limit p_limit
$$;

-- Confirming a match teaches the alias list (so 'Naysiso' auto-matches next time)
create or replace function public.confirm_worker_match(p_worker uuid, p_employee uuid)
returns void language plpgsql as $$
declare v_raw text;
begin
  update public.work_order_workers
     set employee_id = p_employee, confirmed_by = auth.uid(), confirmed_at = now(), match_confidence = 1
   where id = p_worker
  returning raw_name into v_raw;
  if v_raw is not null then
    insert into public.employee_aliases (employee_id, alias, source, created_by)
    values (p_employee, v_raw, 'scan_confirmed', auth.uid())
    on conflict (employee_id, alias_norm) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Search jobs by any name anyone uses: job, job alias, customer,
-- contractor/builder, or any of their aliases.
-- ---------------------------------------------------------------------
create or replace function public.search_jobs(p_q text, p_limit int default 25)
returns table (job_id uuid, job_name text, customer_name text, city text, status public.job_status,
               matched_on text, score real)
language sql stable as $$
  with q as (select public.norm_name(p_q) as n),
  hits as (
    select j.id, j.name as matched_on, extensions.word_similarity(q.n, j.name_norm) as s from public.jobs j, q
    union all
    select a.job_id, a.alias, extensions.word_similarity(q.n, a.alias_norm) from public.job_aliases a, q
    union all
    select j.id, c.name, extensions.word_similarity(q.n, c.name_norm) * 0.9
      from public.jobs j join public.companies c on c.id = j.customer_id, q
    union all
    select p.job_id, c.name, extensions.word_similarity(q.n, c.name_norm) * 0.9
      from public.job_parties p join public.companies c on c.id = p.company_id, q
    union all
    select j.id, ca.alias, extensions.word_similarity(q.n, ca.alias_norm) * 0.85
      from public.jobs j join public.company_aliases ca on ca.company_id = j.customer_id, q
  ),
  best as (
    select id, (array_agg(matched_on order by s desc))[1] as matched_on, max(s) as s
      from hits where s > 0.3 group by id
  )
  select j.id, j.name, c.name, j.city, j.status, b.matched_on, b.s::real
    from best b join public.jobs j on j.id = b.id join public.companies c on c.id = j.customer_id
   order by b.s desc, j.status = 'active' desc, j.updated_at desc
   limit p_limit
$$;

-- ---------------------------------------------------------------------
-- Workers: when a WO completes and nobody's recorded yet, copy the roster
-- of every crew that had this WO as a stop that day.
-- ---------------------------------------------------------------------
create or replace function public.sync_workers_from_roster(p_wo uuid)
returns int language plpgsql as $$
declare v int;
begin
  insert into public.work_order_workers (work_order_id, employee_id, position, source)
  select distinct on (m.employee_id) p_wo, m.employee_id, m.position, 'roster'
    from public.crew_day_stops s
    join public.crew_day_members m on m.crew_day_id = s.crew_day_id
   where s.work_order_id = p_wo
     and m.status in ('scheduled','present','left_early')
  on conflict do nothing;
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function public.work_orders_after_status()
returns trigger language plpgsql as $$
begin
  if new.status in ('complete','canceled') and old.status is distinct from new.status
     and not exists (select 1 from public.work_order_workers where work_order_id = new.id) then
    perform public.sync_workers_from_roster(new.id);
  end if;
  return null;
end $$;
create trigger trg_work_orders_after_status
  after update of status on public.work_orders
  for each row execute function public.work_orders_after_status();

-- ---------------------------------------------------------------------
-- Dispatch board: one row per crew-day with members + stops as JSON
--   select * from v_dispatch_board where work_date = '2026-10-29';
-- ---------------------------------------------------------------------
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
             'open_flags', (select count(*) from public.work_order_flags f
                             where f.work_order_id = w.id and f.resolved_at is null))
           order by s.sequence)
      from public.crew_day_stops s
      join public.work_orders w on w.id = s.work_order_id
      join public.jobs j on j.id = w.job_id
      join public.companies co on co.id = j.customer_id
     where s.crew_day_id = cd.id), '[]')          as stops
from public.crew_days cd
left join public.crews c on c.id = cd.crew_id;

-- Unassigned tray: scheduled for a date (or undated) but on no crew
create or replace view public.v_unassigned_work_orders with (security_invoker = true) as
select w.id, w.number, w.type_code, w.status, w.scheduled_date, w.scope, w.priority,
       j.id as job_id, j.name as job, j.city, co.name as customer,
       public.is_prevailing_wage(j.id, coalesce(w.scheduled_date, current_date)) as prevailing_wage
  from public.work_orders w
  join public.jobs j on j.id = w.job_id
  join public.companies co on co.id = j.customer_id
 where w.status in ('planned','on_hold')
   and not exists (
     select 1 from public.crew_day_stops s join public.crew_days cd on cd.id = s.crew_day_id
      where s.work_order_id = w.id and cd.work_date = w.scheduled_date);

-- ---------------------------------------------------------------------
-- Job folder header: counts for the tabs
-- ---------------------------------------------------------------------
create or replace view public.v_job_summary with (security_invoker = true) as
select j.id as job_id, j.name, j.status, j.city, co.name as customer,
       public.is_prevailing_wage(j.id, current_date)                      as prevailing_wage,
       (select count(*) from public.work_orders w where w.job_id = j.id)  as work_orders,
       (select count(*) from public.work_orders w where w.job_id = j.id and w.status not in ('complete','canceled')) as open_work_orders,
       (select count(*) from public.work_order_flags f join public.work_orders w on w.id = f.work_order_id
         where w.job_id = j.id and f.resolved_at is null)                 as open_flags,
       (select count(*) from public.shipments s where s.job_id = j.id)    as shipments,
       (select count(*) from public.files f where f.job_id = j.id and f.deleted_at is null and f.kind = 'photo') as photos,
       (select count(*) from public.files f where f.job_id = j.id and f.deleted_at is null and f.kind = 'video') as videos,
       (select count(*) from public.files f where f.job_id = j.id and f.deleted_at is null and f.kind not in ('photo','video')) as documents,
       (select count(*) from public.notes n where n.job_id = j.id and n.deleted_at is null) as notes,
       (select max(w.scheduled_date) from public.work_orders w where w.job_id = j.id and w.status <> 'canceled') as last_visit
  from public.jobs j join public.companies co on co.id = j.customer_id;

-- ---------------------------------------------------------------------
-- PREVAILING WAGE weekly report (Mon–Sun)
--   Customer – Job  /  Date – Employee
--   Counts visits where the crew was on site (incl. 'canceled' visits
--   where the crew showed up and the site wasn't ready, if crew_on_site).
-- ---------------------------------------------------------------------
create or replace function public.pw_week(p_week_start date)
returns table (customer text, job text, job_id uuid, work_date date,
               employee text, employee_code text, employee_id uuid,
               work_order_number text, unmatched boolean)
language sql stable as $$
  select co.name, j.name, j.id, w.scheduled_date,
         coalesce(e.display_name, ww.raw_name || ' (unmatched)'),
         e.employee_code, e.id, w.number, ww.employee_id is null
    from public.work_orders w
    join public.jobs j       on j.id = w.job_id
    join public.companies co on co.id = j.customer_id
    join public.work_order_workers ww on ww.work_order_id = w.id
    left join public.employees e on e.id = ww.employee_id
   where w.scheduled_date between p_week_start and p_week_start + 6
     and w.crew_on_site
     and w.status in ('started','on_hold','complete','canceled')
     and public.is_prevailing_wage(j.id, w.scheduled_date)
   order by co.name, j.name, w.scheduled_date, 5
$$;
