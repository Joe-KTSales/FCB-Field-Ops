-- =====================================================================
-- 0012 Fixes from code review. Safe to run more than once.
-- =====================================================================

-- 1. New sign-ups start switched OFF. An admin turns them on (Admin page) and sets the role.
--    (Also keep "Allow new users to sign up" off in Supabase → Authentication.)
alter table public.profiles alter column active set default false;

-- 2. Dispatchers can undo their own operational changes (unassign, move crews, fix lines/workers).
--    Before this, only admin/manager could delete and RLS silently ignored everyone else.
do $$
declare t text;
begin
  foreach t in array array['crew_day_stops','crew_day_members','crew_days','work_order_lines','work_order_workers',
                           'work_order_locations','work_order_flags','crew_default_members','employee_aliases','employee_absences']
  loop
    execute format('drop policy if exists "%1$s: field delete" on public.%1$I', t);
    execute format('create policy "%1$s: field delete" on public.%1$I for delete to authenticated using (public.is_field_writer())', t);
  end loop;
end $$;

-- 3. Editing a note failed: its history trigger couldn't write note_revisions under RLS.
create or replace function public.notes_keep_revision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.body is distinct from old.body then
    insert into public.note_revisions (note_id, old_body, edited_by) values (old.id, old.body, auth.uid());
    new.edited_at := now();
  end if;
  return new;
end $$;

-- 4. Call-outs: log when someone is added already out, and remove the log when they're marked back in.
create or replace function public.crew_day_members_log_absence()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_kind public.absence_kind;
begin
  if new.status in ('called_out', 'no_show', 'left_early')
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    v_kind := case new.status when 'called_out' then 'call_out'::public.absence_kind
                              when 'no_show'    then 'no_show'::public.absence_kind
                              else 'left_early'::public.absence_kind end;
    insert into public.employee_absences (employee_id, absence_date, kind, reason, reported_at, logged_by)
    values (new.employee_id, new.work_date, v_kind, new.note, now(), auth.uid())
    on conflict (employee_id, absence_date, kind) do update set reason = coalesce(excluded.reason, employee_absences.reason);
  elsif tg_op = 'UPDATE' and old.status in ('called_out', 'no_show', 'left_early')
        and new.status in ('scheduled', 'present') then
    delete from public.employee_absences
     where employee_id = new.employee_id and absence_date = new.work_date
       and kind in ('call_out', 'no_show', 'left_early');
  end if;
  return new;
end $$;
drop trigger if exists trg_cdm_absence on public.crew_day_members;
create trigger trg_cdm_absence
  after insert or update of status on public.crew_day_members
  for each row execute function public.crew_day_members_log_absence();

-- 5. Prevailing wage data is admin-only in the database too, not just in the app.
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
   where public.is_admin()
     and w.scheduled_date between p_week_start and p_week_start + 6
     and w.crew_on_site
     and w.status in ('started','on_hold','complete','canceled')
     and public.is_prevailing_wage(j.id, w.scheduled_date)
   order by co.name, j.name, w.scheduled_date, 5
$$;

drop policy if exists "files: read" on public.files;
create policy "files: read" on public.files for select to authenticated using (
  (public.is_office() and (kind <> 'report' or public.is_admin())) or uploaded_by = auth.uid());

drop policy if exists "job-files: office read" on storage.objects;
create policy "job-files: office read" on storage.objects for select to authenticated
  using (bucket_id = 'job-files' and public.is_office() and (name not like 'reports/%' or public.is_admin()));

-- 6. A lot number can't repeat on a job when no building/phase is set (NULLs slipped past the unique rule).
create unique index if not exists lots_job_lot_no_area_uidx on public.lots (job_id, lot_number) where area_id is null;
