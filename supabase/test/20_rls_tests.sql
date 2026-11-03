insert into auth.users (id,email) values
 ('00000000-0000-0000-0000-00000000000a','admin@test'),('00000000-0000-0000-0000-00000000000d','dispatch@test'),
 ('00000000-0000-0000-0000-00000000000e','ro@test'),('00000000-0000-0000-0000-00000000000f','idaho@test');
update profiles set role='admin' where email='admin@test';
update profiles set role='dispatcher' where email='dispatch@test';
update profiles set role='read_only_manager' where email='ro@test';
update profiles set role='shipping_coordinator', facility_access='{idaho}' where email='idaho@test';
grant all on all tables in schema public to authenticated; grant usage on all sequences in schema public to authenticated;

\echo '--- dispatcher: sees WOs, can edit, cannot see PW report table or audit log'
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000d',false);
select count(*) as wos_visible from work_orders;
update work_orders set priority=1 where number='IN-26-9001';
select count(*) as audit_visible from audit_log;
select count(*) as pw_reports_visible from pw_reports;
insert into notes (job_id, body) select job_id, 'Call Orlando before arriving' from work_orders where number='IN-26-9001' returning 'note added by dispatcher' ok;
reset role;
\echo '--- read-only manager: sees everything, update silently affects 0 rows, note insert blocked'
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000e',false);
select count(*) as wos_visible from work_orders;
with u as (update work_orders set priority=2 where number='IN-26-9001' returning 1) select count(*) as rows_changed from u;
\set ON_ERROR_STOP 0
insert into notes (job_id, body) select job_id, 'should fail' from work_orders where number='IN-26-9001';
\set ON_ERROR_STOP 1
reset role;
\echo '--- Idaho shipping coordinator: only Idaho shipments'
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000f',false);
select facility_code, count(*) from shipments group by 1;
reset role;
\echo '--- admin: audit log shows who changed what'
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select a.table_name, a.action, p.email, a.changed_fields from audit_log a left join profiles p on p.id=a.changed_by where a.changed_by is not null order by a.id;
reset role;
