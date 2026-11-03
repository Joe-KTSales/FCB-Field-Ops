-- =====================================================================
-- 0008 DEPARTMENTS — region + department (e.g. Southern California / Finals).
--   Each department gets its own tab on the dispatch board.
--   crews.department and employees.departments now hold department codes.
-- =====================================================================

create table public.departments (
  code        text primary key,               -- 'socal-install'
  region      text not null,                  -- 'Southern California'
  name        text not null,                  -- 'Installation'
  work_type   text references public.work_order_types(code),  -- default WO type for new work orders
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.departments (code, region, name, work_type, sort_order) values
  ('socal-install',  'Southern California', 'Installation',     'IN', 1),
  ('socal-stocking', 'Southern California', 'Stocking',         'ST', 2),
  ('socal-finals',   'Southern California', 'Finals',           'FN', 3),
  ('socal-cs',       'Southern California', 'Customer Service', 'FN', 4),
  ('norcal-install', 'Northern California', 'Installation',     'IN', 5),
  ('lv-install',     'Las Vegas',           'Installation',     'IN', 6);

-- move the original short codes onto the new departments
update public.crews set department = case department
  when 'install'  then 'socal-install'
  when 'stocking' then 'socal-stocking'
  when 'finals'   then 'socal-finals'
  else department end;

update public.employees set departments = array(
  select case d when 'install' then 'socal-install' when 'stocking' then 'socal-stocking' when 'finals' then 'socal-finals' else d end
  from unnest(departments) d);

update public.crews set department = null
 where department is not null and department not in (select code from public.departments);

alter table public.crews
  add constraint crews_department_fk foreign key (department) references public.departments(code) on update cascade;

alter table public.departments enable row level security;
create policy "departments: read" on public.departments for select to authenticated using (true);
create policy "departments: admin write" on public.departments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create trigger trg_departments_audit after insert or update or delete on public.departments
  for each row execute function public.audit_trigger();
