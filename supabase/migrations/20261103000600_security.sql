-- =====================================================================
-- 0006 SECURITY — Row Level Security + Storage
--
--   Role groups
--     OFFICE_READ  : admin, manager, read_only_manager, dispatcher, shipping_coordinator
--     FIELD_WRITE  : admin, manager, dispatcher          (work orders, crews, jobs, folders)
--     SHIP_WRITE   : admin, manager, shipping_coordinator (scoped by facility_access)
--     ADMIN_ONLY   : admin                               (PW list/reports, audit, users)
--     driver       : own delivery runs/stops only
--     lead_tech / tech : no access yet (future phase) — policies stubbed below
-- =====================================================================

create or replace function public.is_office() returns boolean language sql stable as $$
  select public.has_role('admin','manager','read_only_manager','dispatcher','shipping_coordinator') $$;
create or replace function public.is_field_writer() returns boolean language sql stable as $$
  select public.has_role('admin','manager','dispatcher') $$;
create or replace function public.is_ship_writer() returns boolean language sql stable as $$
  select public.has_role('admin','manager','shipping_coordinator') $$;
create or replace function public.is_admin() returns boolean language sql stable as $$
  select public.has_role('admin') $$;
create or replace function public.my_employee_id() returns uuid language sql stable security definer set search_path = public as $$
  select employee_id from public.profiles where id = auth.uid() $$;

-- Enable RLS on every table in public
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Lookups: anyone signed in can read
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['facilities','work_order_types','flag_types'] loop
    execute format('create policy "%1$s: read" on public.%1$I for select to authenticated using (true)', t);
    execute format('create policy "%1$s: admin write" on public.%1$I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Shared + field tables: office reads, field writers write
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'companies','company_aliases','contacts','jobs','job_aliases','job_parties','job_contacts',
    'job_areas','lots','products','product_aliases',
    'work_orders','work_order_locations','work_order_lines','work_order_flags','work_order_workers',
    'work_order_scans','work_order_counters',
    'crews','crew_default_members','crew_days','crew_day_members','crew_day_stops',
    'employee_absences','employee_aliases']
  loop
    execute format('create policy "%1$s: office read" on public.%1$I for select to authenticated using (public.is_office())', t);
    execute format('create policy "%1$s: field write" on public.%1$I for insert to authenticated with check (public.is_field_writer())', t);
    execute format('create policy "%1$s: field update" on public.%1$I for update to authenticated using (public.is_field_writer()) with check (public.is_field_writer())', t);
    execute format('create policy "%1$s: manager delete" on public.%1$I for delete to authenticated using (public.has_role(''admin'',''manager''))', t);
  end loop;
end $$;

-- Shipping coordinators also maintain customers/jobs/products (they create them from PDFs)
do $$
declare t text;
begin
  foreach t in array array['companies','company_aliases','jobs','job_aliases','products','product_aliases'] loop
    execute format('create policy "%1$s: ship write" on public.%1$I for insert to authenticated with check (public.is_ship_writer())', t);
    execute format('create policy "%1$s: ship update" on public.%1$I for update to authenticated using (public.is_ship_writer()) with check (public.is_ship_writer())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Employees: office reads; admin/manager maintain
-- ---------------------------------------------------------------------
create policy "employees: office read" on public.employees for select to authenticated using (public.is_office());
create policy "employees: self read"   on public.employees for select to authenticated using (id = public.my_employee_id());
create policy "employees: manage"      on public.employees for all to authenticated
  using (public.has_role('admin','manager')) with check (public.has_role('admin','manager'));

-- ---------------------------------------------------------------------
-- Profiles: everyone reads their own; office sees names; admin manages
-- ---------------------------------------------------------------------
create policy "profiles: self"         on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles: office read"  on public.profiles for select to authenticated using (public.is_office());
create policy "profiles: admin manage" on public.profiles for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Prevailing wage: office can see the flag; only admin edits list & reports
-- ---------------------------------------------------------------------
create policy "pw periods: office read" on public.prevailing_wage_periods for select to authenticated using (public.is_office());
create policy "pw periods: admin write" on public.prevailing_wage_periods for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "pw reports: admin"       on public.pw_reports for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Shipping: facility-scoped
-- ---------------------------------------------------------------------
create policy "shipments: read" on public.shipments for select to authenticated using (
  public.has_role('admin','manager','read_only_manager','dispatcher')
  or (public.has_role('shipping_coordinator') and public.can_access_facility(facility_code))
  or (public.has_role('driver') and exists (
        select 1 from public.delivery_stops s join public.delivery_runs r on r.id = s.run_id
         where s.shipment_id = shipments.id and r.driver_employee_id = public.my_employee_id())));
create policy "shipments: write" on public.shipments for all to authenticated
  using (public.is_ship_writer() and public.can_access_facility(facility_code))
  with check (public.is_ship_writer() and public.can_access_facility(facility_code));

create policy "shipment_lines: read" on public.shipment_lines for select to authenticated using (
  exists (select 1 from public.shipments s where s.id = shipment_id));   -- inherits shipments RLS
create policy "shipment_lines: write" on public.shipment_lines for all to authenticated
  using (exists (select 1 from public.shipments s where s.id = shipment_id and public.is_ship_writer() and public.can_access_facility(s.facility_code)))
  with check (exists (select 1 from public.shipments s where s.id = shipment_id and public.is_ship_writer() and public.can_access_facility(s.facility_code)));

create policy "shipment_locations: read"  on public.shipment_locations for select to authenticated using (exists (select 1 from public.shipments s where s.id = shipment_id));
create policy "shipment_locations: write" on public.shipment_locations for all to authenticated using (public.is_ship_writer()) with check (public.is_ship_writer());

create policy "delivery_runs: read" on public.delivery_runs for select to authenticated using (
  public.is_office() or driver_employee_id = public.my_employee_id());
create policy "delivery_runs: write" on public.delivery_runs for all to authenticated
  using (public.is_ship_writer() and public.can_access_facility(facility_code))
  with check (public.is_ship_writer() and public.can_access_facility(facility_code));

create policy "delivery_stops: read" on public.delivery_stops for select to authenticated using (
  exists (select 1 from public.delivery_runs r where r.id = run_id));
create policy "delivery_stops: office write" on public.delivery_stops for all to authenticated
  using (public.is_ship_writer()) with check (public.is_ship_writer());
create policy "delivery_stops: driver completes" on public.delivery_stops for update to authenticated
  using (exists (select 1 from public.delivery_runs r where r.id = run_id and r.driver_employee_id = public.my_employee_id()))
  with check (exists (select 1 from public.delivery_runs r where r.id = run_id and r.driver_employee_id = public.my_employee_id()));

create policy "molds: read"  on public.molds for select to authenticated using (public.is_office());
create policy "molds: write" on public.molds for all to authenticated using (public.has_role('admin','manager')) with check (public.has_role('admin','manager'));
create policy "mold_logs: read"  on public.mold_logs for select to authenticated using (public.is_office());
create policy "mold_logs: write" on public.mold_logs for insert to authenticated with check (public.is_ship_writer());

-- ---------------------------------------------------------------------
-- Notes: anyone in the office can add; you edit your own; nobody hard-deletes.
-- ---------------------------------------------------------------------
create policy "notes: read"   on public.notes for select to authenticated using (public.is_office());
create policy "notes: add"    on public.notes for insert to authenticated
  with check (public.is_office() and not public.has_role('read_only_manager') and author_id = auth.uid());
create policy "notes: edit own" on public.notes for update to authenticated
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());
create policy "note_revisions: admin" on public.note_revisions for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- Files: office reads + uploads; drivers upload to their stops
-- ---------------------------------------------------------------------
create policy "files: read" on public.files for select to authenticated using (
  public.is_office() or uploaded_by = auth.uid());
create policy "files: upload" on public.files for insert to authenticated with check (
  (public.is_office() and not public.has_role('read_only_manager'))
  or (public.has_role('driver') and delivery_stop_id is not null));
create policy "files: edit" on public.files for update to authenticated
  using (uploaded_by = auth.uid() or public.is_field_writer() or public.is_ship_writer())
  with check (uploaded_by = auth.uid() or public.is_field_writer() or public.is_ship_writer());

-- ---------------------------------------------------------------------
-- Audit log: admin read-only (written by trigger only)
-- ---------------------------------------------------------------------
create policy "audit: admin read" on public.audit_log for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- STORAGE — one private bucket for everything in job folders.
--   Object key convention:
--     jobs/{job_id}/{yyyy}/{mm}/{file_id}.{ext}
--     jobs/{job_id}/thumbs/{file_id}.webp
--     scans/{yyyy-mm-dd}/{file_id}.pdf        (before matched to a job)
--     shipments/{facility}/{shipment_id}/{file_id}.{ext}
--   Access is always through signed URLs created after checking the
--   files row (RLS above), so bucket policies stay simple.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('job-files', 'job-files', false, 5368709120)   -- 5 GB per object (video)
on conflict (id) do nothing;

create policy "job-files: office read" on storage.objects for select to authenticated
  using (bucket_id = 'job-files' and public.is_office());
create policy "job-files: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'job-files'
              and (public.is_field_writer() or public.is_ship_writer() or public.has_role('driver','dispatcher','manager','admin')));
create policy "job-files: owner update" on storage.objects for update to authenticated
  using (bucket_id = 'job-files' and owner = auth.uid());
