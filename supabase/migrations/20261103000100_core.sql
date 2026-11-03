-- =====================================================================
-- FCB Field Ops + Shipping — shared backbone
-- 0001 CORE: extensions, helpers, facilities, people, companies, jobs,
--            job structure, products, prevailing wage
-- =====================================================================
-- Conventions
--   * uuid primary keys (gen_random_uuid)
--   * every table: created_at / updated_at (+ created_by where a person acts)
--   * legacy_ids jsonb holds ids from systems we import from
--       e.g. {"base44": "6ae9...", "qb": "10-28-0091"}  -> upsert-friendly
--   * "*_aliases" tables map messy real-world spellings to one record
--   * soft delete via active=false / archived_at; hard deletes are rare
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm  with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Normalize a name for matching: lowercase, strip accents/punctuation,
-- collapse whitespace.  'Lennar ---Inland Regional.' -> 'lennar inland regional'
create or replace function public.norm_name(txt text)
returns text language sql immutable parallel safe as $$
  select nullif(
    btrim(regexp_replace(
      regexp_replace(lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(txt,''))),
                     '[^a-z0-9]+', ' ', 'g'),
      '\s+', ' ', 'g')),
    '')
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Attach the updated_at trigger to a table (used by every migration)
create or replace function public.add_updated_at_trigger(tbl regclass)
returns void language plpgsql as $$
begin
  execute format(
    'create trigger trg_%s_updated_at before update on %s
       for each row execute function public.touch_updated_at()',
    replace(tbl::text, '.', '_'), tbl);
end $$;

-- ---------------------------------------------------------------------
-- Facilities (Adelanto / Idaho / Mexico)
-- ---------------------------------------------------------------------
create table public.facilities (
  code        text primary key,               -- 'adelanto' | 'idaho' | 'mexico'
  name        text not null,
  timezone    text not null default 'America/Los_Angeles',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.facilities (code, name, timezone) values
  ('adelanto', 'Adelanto, CA', 'America/Los_Angeles'),
  ('idaho',    'Idaho',        'America/Boise'),
  ('mexico',   'Mexico',       'America/Tijuana');

-- ---------------------------------------------------------------------
-- Roles & profiles (one profile per login; linked to auth.users)
-- ---------------------------------------------------------------------
-- Role = what you do.  facility_access = which facilities you can see.
-- (Base44 mixed these: 'adelanto','idaho','mexico' were roles.)
create type public.app_role as enum (
  'admin',                 -- everything, incl. PW, audit log, settings
  'manager',               -- field manager: everything operational
  'read_only_manager',     -- sees everything, changes nothing
  'dispatcher',            -- work orders, crews, schedule, job folders
  'shipping_coordinator',  -- shipping orders for their facilities
  'driver',                -- (shipping) own delivery runs
  'lead_tech',             -- (future) own crew's work orders
  'tech'                   -- (future) read own schedule
);

create table public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  email            text,
  full_name        text,
  role             public.app_role not null default 'read_only_manager',
  facility_access  text[] not null default '{adelanto,idaho,mexico}',
  employee_id      uuid,                         -- FK added after employees
  preferred_language text not null default 'en' check (preferred_language in ('en','es')),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.profiles'); end $$;

-- Auto-create a profile when someone signs up / is invited
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role helpers used by RLS policies
create or replace function public.my_role()
returns public.app_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create or replace function public.has_role(variadic roles public.app_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = any(roles) from public.profiles
                   where id = auth.uid() and active), false)
$$;

create or replace function public.can_access_facility(fac text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select fac is null or fac = any(facility_access)
                   from public.profiles where id = auth.uid() and active), false)
$$;

-- ---------------------------------------------------------------------
-- Employees (everyone who works — with or without a login)
-- ---------------------------------------------------------------------
create type public.crew_position as enum ('lead', 'helper', 'driver', 'other');

create table public.employees (
  id               uuid primary key default gen_random_uuid(),
  first_name       text not null,
  last_name        text,
  display_name     text generated always as (btrim(first_name || ' ' || coalesce(last_name,''))) stored,
  employee_code    text unique,                 -- payroll ID (Paycom/UKG) — key for PW report
  default_position public.crew_position not null default 'helper',
  departments      text[] not null default '{}', -- {'install','stocking','finals','shipping'}
  home_facility    text references public.facilities(code),
  phone            text,
  active           boolean not null default true,
  hired_on         date,
  separated_on     date,
  legacy_ids       jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.employees'); end $$;

alter table public.profiles
  add constraint profiles_employee_fk foreign key (employee_id)
  references public.employees(id) on delete set null;

-- Every way a name has been written on paper: 'Naysiso' -> Narciso X
create table public.employee_aliases (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references public.employees(id) on delete cascade,
  alias        text not null,
  alias_norm   text generated always as (public.norm_name(alias)) stored,
  source       text not null default 'manual',  -- 'manual' | 'scan_confirmed' | 'import'
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  unique (employee_id, alias_norm)
);
create index employee_aliases_trgm on public.employee_aliases using gin (alias_norm extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Companies (customers, contractors, builders, supply houses)
-- ---------------------------------------------------------------------
create table public.companies (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  name_norm        text generated always as (public.norm_name(name)) stored,
  kinds            text[] not null default '{}',  -- builder | contractor | supply_house | plumber | gc | other
  qb_customer_ref  text unique,                   -- QuickBooks customer id (future import key)
  phone            text,
  email            text,
  address          text,
  city             text,
  state            text,
  active           boolean not null default true,
  legacy_ids       jsonb not null default '{}',
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.companies'); end $$;
create index companies_name_trgm on public.companies using gin (name_norm extensions.gin_trgm_ops);

create table public.company_aliases (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  alias       text not null,
  alias_norm  text generated always as (public.norm_name(alias)) stored,
  source      text not null default 'manual',
  created_at  timestamptz not null default now(),
  unique (alias_norm)                            -- a spelling points to exactly one company
);
create index company_aliases_trgm on public.company_aliases using gin (alias_norm extensions.gin_trgm_ops);

create table public.contacts (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete set null,
  name        text not null,
  title       text,                              -- 'Superintendent', 'PM', ...
  phone       text,
  email       text,
  notes       text,
  active      boolean not null default true,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.contacts'); end $$;

-- ---------------------------------------------------------------------
-- Jobs — the "folder".  Customer -> Job is the only hard hierarchy.
-- ---------------------------------------------------------------------
create type public.job_status as enum ('active', 'on_hold', 'complete', 'archived');

create table public.jobs (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  name_norm        text generated always as (public.norm_name(name)) stored,
  customer_id      uuid not null references public.companies(id),  -- the one required party (bill-to)
  status           public.job_status not null default 'active',
  address          text,
  city             text,
  state            text default 'CA',
  facility_code    text references public.facilities(code),  -- which plant usually supplies it
  qb_job_ref       text,
  description      text,
  legacy_ids       jsonb not null default '{}',
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  archived_at      timestamptz
);
do $$ begin perform public.add_updated_at_trigger('public.jobs'); end $$;
create index jobs_customer_idx on public.jobs (customer_id);
create index jobs_name_trgm on public.jobs using gin (name_norm extensions.gin_trgm_ops);

create table public.job_aliases (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  alias       text not null,
  alias_norm  text generated always as (public.norm_name(alias)) stored,
  source      text not null default 'manual',
  created_at  timestamptz not null default now(),
  unique (job_id, alias_norm)
);
create index job_aliases_trgm on public.job_aliases using gin (alias_norm extensions.gin_trgm_ops);

-- Optional extra parties ("Add party" in the UI). Customer stays on jobs.
create type public.party_role as enum ('contractor', 'builder', 'gc', 'bill_to_alt', 'other');

create table public.job_parties (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  company_id  uuid not null references public.companies(id),
  role        public.party_role not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (job_id, company_id, role)
);

create table public.job_contacts (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  role        text,                               -- 'Superintendent', 'Site contact'
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (job_id, contact_id)
);

-- Phases / buildings / sections / levels.  Free-form tree inside a job.
-- Work orders and shipments can touch many of these at once.
create type public.area_kind as enum ('phase', 'building', 'section', 'level', 'tract', 'other');

create table public.job_areas (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  parent_id   uuid references public.job_areas(id) on delete cascade,
  kind        public.area_kind not null default 'other',
  name        text not null,                      -- 'PH10', 'BLDG 2', 'Section 1 / Level 1-5'
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.job_areas'); end $$;
create index job_areas_job_idx on public.job_areas (job_id);

create table public.lots (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  area_id     uuid references public.job_areas(id) on delete set null,
  lot_number  text not null,                      -- '309', '1381', 'Unit 213', 'MDL 47'
  plan        text,
  address     text,
  sort_key    int,                                -- numeric part, for ordering 9 < 10 < 100
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (job_id, area_id, lot_number)
);
do $$ begin perform public.add_updated_at_trigger('public.lots'); end $$;
create index lots_job_idx on public.lots (job_id);

-- ---------------------------------------------------------------------
-- Prevailing wage — by job, with effective dates (list changes over time)
-- ---------------------------------------------------------------------
create table public.prevailing_wage_periods (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  effective_from  date not null,
  effective_to    date,                           -- null = still PW
  source_note     text,                           -- 'Added from PW list 11/2026'
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index pw_job_idx on public.prevailing_wage_periods (job_id, effective_from);

create or replace function public.is_prevailing_wage(p_job uuid, p_date date)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.prevailing_wage_periods
    where job_id = p_job and effective_from <= p_date
      and (effective_to is null or effective_to >= p_date))
$$;

-- ---------------------------------------------------------------------
-- Products (shared with shipping / inventory / molds)
-- ---------------------------------------------------------------------
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                      -- canonical: 'WT60-30 HC LH'
  name_norm   text generated always as (public.norm_name(name)) stored unique,
  series      text,                               -- 'WT', 'ET', 'ES', 'PR' ... (parsed)
  base_model  text,                               -- 'WT60-30 HC' (name without hand)
  hand        text check (hand in ('L','R')),     -- parsed from LH/RH
  category    text,                               -- 'tub', 'shower', 'wall set', ...
  sku         text unique,
  active      boolean not null default true,
  legacy_ids  jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.products'); end $$;
create index products_base_model_idx on public.products (base_model);

create table public.product_aliases (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  alias       text not null,
  alias_norm  text generated always as (public.norm_name(alias)) stored unique,
  created_at  timestamptz not null default now()
);
