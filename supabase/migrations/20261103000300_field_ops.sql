-- =====================================================================
-- 0003 FIELD OPS — work orders, crews, daily roster, call-outs,
--                  scan intake, prevailing-wage reporting
-- =====================================================================

-- ---------------------------------------------------------------------
-- Work order types + numbering   IN-26-0412 / ST-26-0188 / FN-26-0057
-- ---------------------------------------------------------------------
create table public.work_order_types (
  code        text primary key,                 -- 'IN' | 'ST' | 'FN'
  name        text not null,
  name_es     text,
  color       text,                             -- UI accent
  sort_order  int not null default 0,
  active      boolean not null default true
);
insert into public.work_order_types (code, name, name_es, color, sort_order) values
  ('IN', 'Installation',    'Instalación',      '#2563eb', 1),
  ('ST', 'Stocking',        'Surtido',          '#16a34a', 2),
  ('FN', 'Finals / Repair', 'Finales / Reparación', '#d97706', 3);

create table public.work_order_counters (
  type_code  text not null references public.work_order_types(code),
  yr         int  not null,
  last_seq   int  not null default 0,
  primary key (type_code, yr)
);

create or replace function public.next_work_order_number(p_type text, p_date date default current_date)
returns text language plpgsql as $$
declare
  v_yr  int := extract(year from p_date)::int % 100;
  v_seq int;
begin
  insert into public.work_order_counters (type_code, yr, last_seq)
  values (p_type, v_yr, 1)
  on conflict (type_code, yr) do update set last_seq = work_order_counters.last_seq + 1
  returning last_seq into v_seq;
  return format('%s-%s-%s', p_type, lpad(v_yr::text, 2, '0'), lpad(v_seq::text, 4, '0'));
end $$;

-- ---------------------------------------------------------------------
-- Work orders
--   One work order = one crew-visit's worth of work.  Partial work spawns
--   a follow-up (parent_id) numbered IN-26-0412-B, -C ...
-- ---------------------------------------------------------------------
create type public.wo_status as enum ('planned', 'started', 'on_hold', 'complete', 'canceled');
create type public.wo_source as enum ('order', 'job_walk', 'shipment', 'follow_up', 'customer_call', 'other');

create table public.work_orders (
  id                    uuid primary key default gen_random_uuid(),
  number                text not null unique,
  type_code             text not null references public.work_order_types(code),
  job_id                uuid not null references public.jobs(id),
  status                public.wo_status not null default 'planned',
  status_reason         text,                     -- 'Not ready — Edgar said come back Tuesday'
  scheduled_date        date,                     -- null = unscheduled (sits in the tray)
  scope                 text,                     -- what needs doing (dispatcher-written)
  source                public.wo_source not null default 'order',
  source_shipment_id    uuid references public.shipments(id),
  parent_id             uuid references public.work_orders(id),
  follow_up_suffix      text,                     -- 'B', 'C' ...
  priority              smallint not null default 0, -- 0 normal, 1 high, 2 urgent
  crew_on_site          boolean not null default true, -- false if crew never went (affects PW report)
  -- returned paperwork
  time_in               time,                     -- as written on the sheet (info only; payroll is elsewhere)
  time_out              time,
  completion_notes      text,                     -- crew notes, original language
  completion_notes_en   text,                     -- translation
  superintendent_name   text,
  superintendent_signed boolean,
  signed_at             date,
  completed_at          timestamptz,
  legacy_ids            jsonb not null default '{}',
  created_by            uuid references public.profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.work_orders'); end $$;
create index work_orders_job_idx  on public.work_orders (job_id);
create index work_orders_date_idx on public.work_orders (scheduled_date);
create index work_orders_open_idx on public.work_orders (status) where status <> 'complete';

-- Assign number automatically (or follow-up suffix of the parent)
create or replace function public.work_orders_assign_number()
returns trigger language plpgsql as $$
declare v_parent_number text; v_next text;
begin
  if new.number is not null and new.number <> '' then
    return new;
  end if;
  if new.parent_id is null then
    new.number := public.next_work_order_number(new.type_code, coalesce(new.scheduled_date, current_date));
  else
    -- root number of the chain + next letter
    select regexp_replace(number, '-[A-Z]$', '') into v_parent_number
      from public.work_orders where id = new.parent_id;
    select chr(ascii(coalesce(max(follow_up_suffix), 'A')) + 1) into v_next
      from public.work_orders
     where number like v_parent_number || '-_';
    new.follow_up_suffix := v_next;
    new.number := v_parent_number || '-' || v_next;
    new.source := 'follow_up';
  end if;
  return new;
end $$;

create trigger trg_work_orders_number
  before insert on public.work_orders
  for each row execute function public.work_orders_assign_number();

-- Stamp completed_at
create or replace function public.work_orders_status_stamp()
returns trigger language plpgsql as $$
begin
  if new.status = 'complete' and (old.status is distinct from 'complete') then
    new.completed_at := coalesce(new.completed_at, now());
  elsif new.status <> 'complete' then
    new.completed_at := null;
  end if;
  return new;
end $$;
create trigger trg_work_orders_status
  before update of status on public.work_orders
  for each row execute function public.work_orders_status_stamp();

-- Where the work happens: any mix of areas and lots, across phases/buildings
create table public.work_order_locations (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references public.work_orders(id) on delete cascade,
  area_id        uuid references public.job_areas(id) on delete cascade,
  lot_id         uuid references public.lots(id) on delete cascade,
  label          text,                            -- free text when lots aren't set up: '213 to 216'
  check (area_id is not null or lot_id is not null or label is not null)
);
create index wo_locations_wo_idx on public.work_order_locations (work_order_id);

-- Line items: the grid on the paper forms (lot x room x product x hand)
-- stocking adds: stockpiled (left in garage/staging), room_in (moved from stockpile into bath), returned (taken back)
create type public.line_status as enum ('pending', 'done', 'stockpiled', 'room_in', 'returned', 'not_ready', 'missing', 'skipped', 'damaged');

create table public.work_order_lines (
  id              uuid primary key default gen_random_uuid(),
  work_order_id   uuid not null references public.work_orders(id) on delete cascade,
  lot_id          uuid references public.lots(id),
  area_id         uuid references public.job_areas(id),
  lot_label       text,                           -- as written, when no lot record yet
  room            text,                           -- 'Master', 'Bath 2', 'Bath 3', 'Option'
  product_id      uuid references public.products(id),
  raw_product     text,
  hand            text check (hand in ('L','R')),
  qty_planned     numeric not null default 1,
  qty_done        numeric,
  status          public.line_status not null default 'pending',
  codes           text[] not null default '{}',   -- finals codes e.g. {'B/P','WSB'} (definitions TBD)
  note            text,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.work_order_lines'); end $$;
create index wo_lines_wo_idx on public.work_order_lines (work_order_id);
create index wo_lines_lot_idx on public.work_order_lines (lot_id);

-- ---------------------------------------------------------------------
-- Flags — exceptions surfaced at a glance instead of buried in notes
-- ---------------------------------------------------------------------
create table public.flag_types (
  code        text primary key,
  label       text not null,
  label_es    text,
  color       text not null default '#64748b',
  severity    smallint not null default 1,          -- 1 info, 2 attention, 3 urgent
  offers_action text,                               -- 'create_repair_wo' | 'create_follow_up' | null
  sort_order  int not null default 0,
  active      boolean not null default true
);
insert into public.flag_types (code, label, label_es, color, severity, offers_action, sort_order) values
  ('not_ready',      'Site not ready',      'No estaba listo',        '#d97706', 2, 'create_follow_up', 1),
  ('partial',        'Partial — return',    'Parcial — regresar',     '#d97706', 2, 'create_follow_up', 2),
  ('repair_needed',  'Repair needed',       'Necesita reparación',    '#dc2626', 3, 'create_repair_wo', 3),
  ('damage',         'Damage found',        'Daño encontrado',        '#dc2626', 3, 'create_repair_wo', 4),
  ('wrong_hand',     'Wrong hand (L/R)',    'Mano equivocada',        '#dc2626', 3, 'create_repair_wo', 5),
  ('missing_parts',  'Missing parts',       'Faltan piezas',          '#d97706', 2, null,               6),
  ('not_ordered',    'Material not ordered/delivered', 'Material no pedido', '#d97706', 2, null,      7),
  ('no_signature',   'No super signature',  'Sin firma',              '#64748b', 1, null,               8),
  ('photos_offline', 'Photos sent by text', 'Fotos por mensaje',      '#64748b', 1, null,               9),
  ('other',          'Other',               'Otro',                   '#64748b', 1, null,              99);

create table public.work_order_flags (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references public.work_orders(id) on delete cascade,
  flag_code      text not null references public.flag_types(code),
  lot_id         uuid references public.lots(id),
  note           text,
  spawned_work_order_id uuid references public.work_orders(id),  -- "Create repair order?" -> yes
  resolved_at    timestamptz,
  resolved_by    uuid references public.profiles(id),
  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now()
);
create index wo_flags_open_idx on public.work_order_flags (work_order_id) where resolved_at is null;

-- ---------------------------------------------------------------------
-- Crews: default pairings + the daily roster
-- ---------------------------------------------------------------------
create table public.crews (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                    -- usually the lead's name: 'Daniel'
  department  text,                             -- 'install' | 'stocking' | 'finals'
  color       text,
  active      boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.crews'); end $$;

-- Who is normally on the crew (loads into each day's roster)
create table public.crew_default_members (
  crew_id      uuid not null references public.crews(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  position     public.crew_position not null default 'helper',
  primary key (crew_id, employee_id)
);
-- an employee belongs to at most one default crew
create unique index crew_default_member_once on public.crew_default_members (employee_id);

-- A crew on a specific day
create table public.crew_days (
  id          uuid primary key default gen_random_uuid(),
  crew_id     uuid references public.crews(id) on delete set null,  -- null = ad-hoc crew
  work_date   date not null,
  label       text,                              -- override display name for ad-hoc crews
  notes       text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (crew_id, work_date)
);
do $$ begin perform public.add_updated_at_trigger('public.crew_days'); end $$;
create index crew_days_date_idx on public.crew_days (work_date);

create type public.roster_status as enum ('scheduled', 'present', 'called_out', 'no_show', 'left_early');

create table public.crew_day_members (
  id           uuid primary key default gen_random_uuid(),
  crew_day_id  uuid not null references public.crew_days(id) on delete cascade,
  work_date    date not null,                    -- denormalized for the one-crew-per-day rule
  employee_id  uuid not null references public.employees(id),
  position     public.crew_position not null default 'helper',
  status       public.roster_status not null default 'scheduled',
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (work_date, employee_id)                -- nobody on two crews the same day
);
do $$ begin perform public.add_updated_at_trigger('public.crew_day_members'); end $$;

create or replace function public.crew_day_members_fill_date()
returns trigger language plpgsql as $$
begin
  select work_date into new.work_date from public.crew_days where id = new.crew_day_id;
  return new;
end $$;
create trigger trg_cdm_fill_date
  before insert or update of crew_day_id on public.crew_day_members
  for each row execute function public.crew_day_members_fill_date();

-- Stops: which work orders a crew handles that day, in order
create table public.crew_day_stops (
  id             uuid primary key default gen_random_uuid(),
  crew_day_id    uuid not null references public.crew_days(id) on delete cascade,
  work_order_id  uuid not null references public.work_orders(id) on delete cascade,
  sequence       int not null default 0,
  planned_time   time,
  note           text,                            -- 'call Orlando before arriving'
  created_at     timestamptz not null default now(),
  unique (crew_day_id, work_order_id)
);
create index crew_day_stops_wo_idx on public.crew_day_stops (work_order_id);

-- Build a day's roster from default pairings (idempotent)
create or replace function public.load_default_roster(p_date date)
returns int language plpgsql as $$
declare v_count int := 0;
begin
  insert into public.crew_days (crew_id, work_date)
  select c.id, p_date from public.crews c where c.active
  on conflict (crew_id, work_date) do nothing;

  insert into public.crew_day_members (crew_day_id, work_date, employee_id, position)
  select cd.id, p_date, m.employee_id, m.position
    from public.crew_days cd
    join public.crew_default_members m on m.crew_id = cd.crew_id
    join public.employees e on e.id = m.employee_id and e.active
   where cd.work_date = p_date
  on conflict (work_date, employee_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- Attendance / call-outs (its own record, for patterns + payroll)
-- ---------------------------------------------------------------------
create type public.absence_kind as enum ('call_out', 'no_show', 'pto', 'left_early', 'other');

create table public.employee_absences (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.employees(id),
  absence_date date not null,
  kind         public.absence_kind not null default 'call_out',
  reason       text,
  reported_at  timestamptz,
  logged_by    uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  unique (employee_id, absence_date, kind)
);

-- Marking someone called_out / no_show on the roster logs the absence
create or replace function public.crew_day_members_log_absence()
returns trigger language plpgsql as $$
begin
  if new.status in ('called_out', 'no_show', 'left_early')
     and new.status is distinct from old.status then
    insert into public.employee_absences (employee_id, absence_date, kind, reason, reported_at, logged_by)
    values (new.employee_id, new.work_date,
            case new.status when 'called_out' then 'call_out'::public.absence_kind
                            when 'no_show'    then 'no_show'::public.absence_kind
                            else 'left_early'::public.absence_kind end,
            new.note, now(), auth.uid())
    on conflict (employee_id, absence_date, kind) do nothing;
  end if;
  return new;
end $$;
create trigger trg_cdm_absence
  after update of status on public.crew_day_members
  for each row execute function public.crew_day_members_log_absence();

-- ---------------------------------------------------------------------
-- Who actually worked a work order (feeds the PW report).
-- Pre-filled from the roster; corrected from the scanned sheet.
-- ---------------------------------------------------------------------
create table public.work_order_workers (
  id                uuid primary key default gen_random_uuid(),
  work_order_id     uuid not null references public.work_orders(id) on delete cascade,
  employee_id       uuid references public.employees(id),   -- null until matched
  raw_name          text,                       -- as written on the sheet: 'Naysiso'
  position          public.crew_position,
  source            text not null default 'roster',  -- 'roster' | 'scan' | 'manual'
  match_confidence  numeric,                    -- 0..1 from name matcher
  confirmed_by      uuid references public.profiles(id),
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now(),
  check (employee_id is not null or raw_name is not null)
);
create unique index wo_workers_unique on public.work_order_workers (work_order_id, employee_id)
  where employee_id is not null;

-- ---------------------------------------------------------------------
-- Paper intake: scanned/photographed sheets -> AI extraction -> review
-- ---------------------------------------------------------------------
create type public.scan_status as enum ('uploaded', 'processing', 'needs_review', 'confirmed', 'failed', 'discarded');

create table public.work_order_scans (
  id               uuid primary key default gen_random_uuid(),
  file_id          uuid not null,                 -- FK added in records migration
  page_number      int not null default 1,
  work_order_id    uuid references public.work_orders(id) on delete set null, -- matched WO (may be null at first)
  status           public.scan_status not null default 'uploaded',
  extracted        jsonb,                         -- raw AI output (lines, names, notes, flags)
  extraction_model text,
  confidence       numeric,
  error            text,
  reviewed_by      uuid references public.profiles(id),
  reviewed_at      timestamptz,
  uploaded_by      uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.work_order_scans'); end $$;
create index wo_scans_status_idx on public.work_order_scans (status) where status in ('uploaded','processing','needs_review');

-- ---------------------------------------------------------------------
-- Prevailing wage weekly reports (Mon–Sun, PDF)
-- ---------------------------------------------------------------------
create table public.pw_reports (
  id            uuid primary key default gen_random_uuid(),
  week_start    date not null check (extract(isodow from week_start) = 1),  -- Monday
  week_end      date generated always as (week_start + 6) stored,
  snapshot      jsonb not null,                -- rows exactly as printed (audit-proof)
  file_id       uuid,                          -- the PDF (FK added in records migration)
  generated_by  uuid references public.profiles(id),
  generated_at  timestamptz not null default now()
);
create index pw_reports_week_idx on public.pw_reports (week_start);
