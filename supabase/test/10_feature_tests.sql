\echo '--- 1. Name matching: handwriting -> employee'
select 'Naysiso' raw, display_name, matched_on, round(score::numeric,2) from match_employee('Naysiso') limit 2;
select 'Godiner' raw, display_name, matched_on, round(score::numeric,2) from match_employee('Godiner') limit 2;
select 'Doro' raw, display_name, matched_on, round(score::numeric,2) from match_employee('Doro') limit 2;
\echo '--- 2. Unmatched names waiting for dispatcher review'
select w.number, ww.raw_name from work_order_workers ww join work_orders w on w.id=ww.work_order_id where ww.employee_id is null;
\echo '--- 3. Search finds Shea Portola by contractor, builder, supply house'
select 'pierce' q, job_name, customer_name, matched_on from search_jobs('JR Pierce') limit 1;
select 'shea portola' q, job_name, customer_name, matched_on from search_jobs('shea portola') limit 1;
select 'fountain valley' q, job_name, customer_name, matched_on from search_jobs('fountain valley apts') limit 2;
select 'pace suppy (typo)' q, resolve_company('Pace Suppy Corp.') is not null as resolves;
\echo '--- 4. PW weekly report, week of Mon 10/26'
select customer, job, work_date, employee, work_order_number from pw_week('2026-10-26');
\echo '--- 5. Dispatch board 10/29 (crew, members, stops)'
select crew_name, jsonb_array_length(members) people, has_callout,
       (select string_agg(s->>'number' || ' ' || (s->>'job'), ' -> ' order by (s->>'sequence')::int) from jsonb_array_elements(stops) s) stops
  from v_dispatch_board where work_date='2026-10-29' order by crew_name;
\echo '--- 6. Follow-up numbering + auto numbering'
insert into work_orders (type_code, job_id, scheduled_date, scope, parent_id)
select 'IN', job_id, '2026-11-10', 'Second return', id from work_orders where number='IN-26-9004' returning number;
insert into work_orders (type_code, job_id, scheduled_date, scope)
select 'FN', job_id, '2026-11-05', 'Repair units 412 and 146 (ASAP)' from work_orders where number='IN-26-9001' returning number;
\echo '--- 7. Roster: load defaults for 11/3, Fernando calls out -> absence logged'
select load_default_roster('2026-11-03') as members_loaded;
update crew_day_members set status='called_out', note='Called at 6:10am' where work_date='2026-11-03'
   and employee_id=(select id from employees where display_name='Fernando Garcia');
select e.display_name, a.absence_date, a.kind, a.reason from employee_absences a join employees e on e.id=a.employee_id;
select crew_name, has_callout from v_dispatch_board where work_date='2026-11-03' and has_callout;
\echo '--- 8. Unassigned tray'
select number, job, scheduled_date from v_unassigned_work_orders order by scheduled_date;
\echo '--- 9. Job folder summary (Del Amo)'
select name, customer, work_orders, open_flags, shipments, notes from v_job_summary where name ilike 'del amo%';
