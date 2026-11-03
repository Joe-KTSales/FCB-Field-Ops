-- Removes ONLY the 10/29-10/30 test-day work orders, their rosters and notes. Everything else stays.
begin;
delete from public.notes where work_order_id in (select id from public.work_orders where legacy_ids ? 'test_day');
delete from public.work_orders where legacy_ids ? 'test_day' and parent_id is not null;
delete from public.work_orders where legacy_ids ? 'test_day';
delete from public.crew_days where work_date in ('2026-10-29', '2026-10-30')
  and not exists (select 1 from public.crew_day_stops s where s.crew_day_id = crew_days.id);
commit;
