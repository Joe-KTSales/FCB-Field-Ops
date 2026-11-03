-- =====================================================================
-- 0004 RECORDS — notes, files (job folder), audit log
--   Notes and files can hang off a customer, job, area, lot, work order,
--   shipment or delivery stop.  job_id is always filled in (by trigger)
--   for anything under a job, so the job folder is one query.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fill job_id from the most specific target (area/lot/WO/shipment/stop)
-- ---------------------------------------------------------------------
create or replace function public.fill_job_id_from_target()
returns trigger language plpgsql as $$
begin
  if new.job_id is null then
    new.job_id := coalesce(
      (select job_id from public.work_orders where id = new.work_order_id),
      (select job_id from public.lots        where id = new.lot_id),
      (select job_id from public.job_areas   where id = new.area_id),
      (select job_id from public.shipments   where id = new.shipment_id));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Notes — on every level; author + time always recorded; never hard-deleted
-- ---------------------------------------------------------------------
create table public.notes (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references public.companies(id) on delete cascade,
  job_id          uuid references public.jobs(id) on delete cascade,
  area_id         uuid references public.job_areas(id) on delete cascade,
  lot_id          uuid references public.lots(id) on delete cascade,
  work_order_id   uuid references public.work_orders(id) on delete cascade,
  shipment_id     uuid references public.shipments(id) on delete cascade,
  body            text not null,
  body_language   text check (body_language in ('en','es')),
  body_translated text,                         -- auto-translation for the other language
  pinned          boolean not null default false,
  author_id       uuid references public.profiles(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,                  -- soft delete; still visible in admin log
  deleted_by      uuid references public.profiles(id),
  check (num_nonnulls(company_id, job_id, area_id, lot_id, work_order_id, shipment_id) >= 1)
);
create trigger trg_notes_job before insert or update on public.notes
  for each row execute function public.fill_job_id_from_target();
create index notes_job_idx     on public.notes (job_id, created_at desc) where deleted_at is null;
create index notes_company_idx on public.notes (company_id) where deleted_at is null;
create index notes_wo_idx      on public.notes (work_order_id) where deleted_at is null;
create index notes_author_idx  on public.notes (author_id, created_at desc);

-- Keep edit history of notes (who changed what)
create table public.note_revisions (
  id          bigint generated always as identity primary key,
  note_id     uuid not null references public.notes(id) on delete cascade,
  old_body    text not null,
  edited_by   uuid references public.profiles(id),
  edited_at   timestamptz not null default now()
);
create or replace function public.notes_keep_revision()
returns trigger language plpgsql as $$
begin
  if new.body is distinct from old.body then
    insert into public.note_revisions (note_id, old_body, edited_by) values (old.id, old.body, auth.uid());
    new.edited_at := now();
  end if;
  return new;
end $$;
create trigger trg_notes_revision before update of body on public.notes
  for each row execute function public.notes_keep_revision();

-- ---------------------------------------------------------------------
-- Files — photos, video, scans, PDFs, plans, signatures
--   provider lets video move to Cloudflare Stream / R2 later without
--   changing anything else: the row just points somewhere new.
-- ---------------------------------------------------------------------
create type public.file_kind as enum ('photo', 'video', 'scan', 'document', 'plan', 'signature', 'report', 'other');
create type public.file_provider as enum ('supabase', 'cloudflare_stream', 'r2');

create table public.files (
  id                uuid primary key default gen_random_uuid(),
  -- target (any one or more)
  company_id        uuid references public.companies(id) on delete set null,
  job_id            uuid references public.jobs(id) on delete set null,
  area_id           uuid references public.job_areas(id) on delete set null,
  lot_id            uuid references public.lots(id) on delete set null,
  work_order_id     uuid references public.work_orders(id) on delete set null,
  shipment_id       uuid references public.shipments(id) on delete set null,
  delivery_stop_id  uuid references public.delivery_stops(id) on delete set null,
  -- what it is
  kind              public.file_kind not null,
  file_name         text not null,
  mime_type         text,
  size_bytes        bigint,
  caption           text,
  tags              text[] not null default '{}',
  taken_at          timestamptz,                -- from EXIF when available
  duration_seconds  numeric,                    -- video
  width             int,
  height            int,
  -- where it lives
  provider          public.file_provider not null default 'supabase',
  bucket            text default 'job-files',
  storage_path      text,                       -- supabase/r2 object key
  provider_ref      text,                       -- e.g. Cloudflare Stream video uid
  thumbnail_path    text,                       -- small version for grids
  preview_path      text,                       -- screen-size version
  processing_status text not null default 'ready' check (processing_status in ('uploading','processing','ready','failed')),
  uploaded_by       uuid references public.profiles(id) default auth.uid(),
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid references public.profiles(id),
  check (storage_path is not null or provider_ref is not null)
);
create trigger trg_files_job before insert or update on public.files
  for each row execute function public.fill_job_id_from_target();
create index files_job_idx  on public.files (job_id, created_at desc) where deleted_at is null;
create index files_wo_idx   on public.files (work_order_id) where deleted_at is null;
create index files_lot_idx  on public.files (lot_id) where deleted_at is null;
create index files_kind_idx on public.files (job_id, kind) where deleted_at is null;

-- deferred FKs from earlier migrations
alter table public.shipments        add constraint shipments_source_file_fk  foreign key (source_file_id)    references public.files(id) on delete set null;
alter table public.delivery_stops   add constraint delivery_stops_sig_fk     foreign key (signature_file_id) references public.files(id) on delete set null;
alter table public.work_order_scans add constraint wo_scans_file_fk          foreign key (file_id)           references public.files(id) on delete cascade;
alter table public.pw_reports       add constraint pw_reports_file_fk        foreign key (file_id)           references public.files(id) on delete set null;

-- ---------------------------------------------------------------------
-- Audit log — every insert/update/delete on key tables, with who did it
-- ---------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  row_id      uuid,
  action      text not null check (action in ('INSERT','UPDATE','DELETE')),
  changed_by  uuid,                                  -- auth.uid()
  changed_at  timestamptz not null default now(),
  job_id      uuid,                                  -- for "everything that happened on this job"
  old_data    jsonb,
  new_data    jsonb,
  changed_fields text[]
);
create index audit_row_idx  on public.audit_log (table_name, row_id, changed_at desc);
create index audit_job_idx  on public.audit_log (job_id, changed_at desc);
create index audit_user_idx on public.audit_log (changed_by, changed_at desc);

create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changed text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(key) into v_changed
      from jsonb_each(v_new) n
     where n.value is distinct from v_old->n.key
       and key not in ('updated_at');
    if v_changed is null then return null; end if;  -- nothing meaningful changed
  end if;
  insert into public.audit_log (table_name, row_id, action, changed_by, job_id, old_data, new_data, changed_fields)
  values (tg_table_name, (v_row->>'id')::uuid, tg_op, auth.uid(),
          case when tg_table_name = 'jobs' then (v_row->>'id')::uuid
               else nullif(v_row->>'job_id','')::uuid end,
          v_old, v_new, v_changed);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'companies','contacts','jobs','job_parties','job_areas','lots','prevailing_wage_periods',
    'employees','employee_aliases','profiles',
    'shipments','shipment_lines','delivery_runs','delivery_stops','molds',
    'work_orders','work_order_lines','work_order_flags','work_order_workers',
    'crews','crew_default_members','crew_days','crew_day_members','crew_day_stops',
    'employee_absences','notes','files','pw_reports']
  loop
    execute format('create trigger trg_%1$s_audit after insert or update or delete on public.%1$I
                    for each row execute function public.audit_trigger()', t);
  end loop;
end $$;
