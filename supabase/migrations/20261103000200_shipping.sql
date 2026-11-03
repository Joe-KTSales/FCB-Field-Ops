-- =====================================================================
-- 0002 SHIPPING — migrated shape of the Base44 shipping scheduler
--   ShippingOrder     -> shipments          (job_id is now a real FK;
--                                            the old "job_id" = QB order #)
--   OrderLineItem     -> shipment_lines     (product_id FK + raw name kept)
--   DriverAssignment  -> delivery_runs + delivery_stops
--                        (JSON maps of photos/signatures/notes become rows)
--   Mold / MoldLog    -> molds / mold_logs
-- =====================================================================

create type public.shipment_status as enum
  ('scheduled', 'shipped', 'delivered', 'partial', 'backordered', 'canceled');

create table public.shipments (
  id                 uuid primary key default gen_random_uuid(),
  order_number       text,                        -- QuickBooks order #, e.g. '10-28-0091' (repeats on splits/backorders)
  job_id             uuid references public.jobs(id),
  customer_id        uuid references public.companies(id),
  facility_code      text not null references public.facilities(code),
  ship_date          date,                        -- null = not scheduled yet
  status             public.shipment_status not null default 'scheduled',
  backorder_of_id    uuid references public.shipments(id),   -- 'BACKORDER FROM 11/4'
  notes              text,                        -- often holds phase/bldg/lot info
  raw_customer_name  text,                        -- exactly as on the PDF
  raw_job_name       text,
  source_file_id     uuid,                        -- FK added in records migration
  legacy_ids         jsonb not null default '{}',
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.shipments'); end $$;
create index shipments_job_idx on public.shipments (job_id);
create index shipments_date_idx on public.shipments (facility_code, ship_date);
create index shipments_order_idx on public.shipments (order_number);
create unique index shipments_base44_uidx on public.shipments ((legacy_ids->>'base44'))
  where legacy_ids ? 'base44';

create table public.shipment_lines (
  id                uuid primary key default gen_random_uuid(),
  shipment_id       uuid not null references public.shipments(id) on delete cascade,
  product_id        uuid references public.products(id),
  raw_product_name  text not null,
  quantity          numeric not null check (quantity >= 0),
  delivered_qty     numeric check (delivered_qty >= 0),
  backordered_qty   numeric check (backordered_qty >= 0),
  legacy_ids        jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.shipment_lines'); end $$;
create index shipment_lines_shipment_idx on public.shipment_lines (shipment_id);

-- Which buildings/lots a shipment is for (parsed from notes like 'PH10 LOTS 1381-1387')
create table public.shipment_locations (
  id           uuid primary key default gen_random_uuid(),
  shipment_id  uuid not null references public.shipments(id) on delete cascade,
  area_id      uuid references public.job_areas(id) on delete cascade,
  lot_id       uuid references public.lots(id) on delete cascade,
  check (area_id is not null or lot_id is not null)
);

-- ----- Deliveries (same "assignment -> stops" pattern as crews) -------
create table public.delivery_runs (
  id                  uuid primary key default gen_random_uuid(),
  run_date            date not null,
  facility_code       text not null references public.facilities(code),
  driver_employee_id  uuid not null references public.employees(id),
  truck               text,
  notes               text,
  legacy_ids          jsonb not null default '{}',
  created_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.delivery_runs'); end $$;
create index delivery_runs_date_idx on public.delivery_runs (run_date);

create type public.stop_status as enum ('pending', 'done', 'partial', 'not_done');

create table public.delivery_stops (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.delivery_runs(id) on delete cascade,
  shipment_id         uuid not null references public.shipments(id),
  sequence            int not null default 0,
  status              public.stop_status not null default 'pending',
  completed_at        timestamptz,
  signer_name         text,
  signature_file_id   uuid,                       -- FK added in records migration
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (run_id, shipment_id)
);
do $$ begin perform public.add_updated_at_trigger('public.delivery_stops'); end $$;

-- ----- Molds (manufacturing — carried over as-is) ---------------------
create type public.mold_condition as enum ('Excellent', 'Good', 'Fair', 'Poor', 'Damaged');
create type public.mold_status    as enum ('Active', 'Needs Repair', 'In Repair', 'Retired');

create table public.molds (
  id                     uuid primary key default gen_random_uuid(),
  mold_name              text not null,
  mold_number            text,
  position               text,                   -- R1, R2, L1 ...
  product_id             uuid references public.products(id),
  raw_product_name       text not null,
  current_facility       text references public.facilities(code),
  cavity_count           int,
  condition              public.mold_condition not null default 'Good',
  status                 public.mold_status not null default 'Active',
  flagged_for_repair     boolean not null default false,
  last_maintenance_date  date,
  next_maintenance_due   date,
  notes                  text,
  legacy_ids             jsonb not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
do $$ begin perform public.add_updated_at_trigger('public.molds'); end $$;

create type public.mold_log_type as enum ('Damage', 'Repair', 'Maintenance', 'Inspection', 'Transfer', 'Note');

create table public.mold_logs (
  id             uuid primary key default gen_random_uuid(),
  mold_id        uuid not null references public.molds(id) on delete cascade,
  log_type       public.mold_log_type not null,
  description    text,
  from_facility  text references public.facilities(code),
  to_facility    text references public.facilities(code),
  log_date       date not null default current_date,
  logged_by      uuid references public.profiles(id),
  created_at     timestamptz not null default now()
);
