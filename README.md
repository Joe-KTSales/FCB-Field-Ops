# FCB Field Ops

Field operations app for Fiber Care Baths / KT Sales & Service. It covers:
- dispatch board
- week and month views
- work orders
- job folders with photos, video and notes
- paper intake: scan the sheets and Claude reads them
- crews and call-outs
- the prevailing wage weekly report

It shares one Supabase database with the shipping app so the two can merge later.

**Stack:** React + Vite + TypeScript + Tailwind, Supabase (database, auth, storage), Vercel (hosting plus one serverless function).

## Deploy

1. **Supabase.** Run every file in `supabase/migrations/` in filename order in the SQL Editor (0001 → 0012). Keep **Authentication → Allow new users to sign up** turned off; new accounts start inactive until an admin switches them on.
2. **Vercel.** Import this repo and add these environment variables:

   | Name | Value | Notes |
   |---|---|---|
   | `VITE_SUPABASE_URL` | `https://<project>.supabase.co` | Project Settings → API |
   | `VITE_SUPABASE_ANON_KEY` | anon public key | Project Settings → API |
   | `ANTHROPIC_API_KEY` | `sk-ant-…` | Lets Paper Intake read scanned sheets. Optional: without it, sheets are entered by hand. |
   | `ANTHROPIC_MODEL` | (optional) | Defaults to `claude-sonnet-5-5` |

3. **Supabase → Authentication → URL Configuration.** Set **Site URL** to the Vercel address and add it under Redirect URLs. Invites and sign-in links will then open the app.
4. **Users.**
   1. Invite people under Authentication → Users → Invite user. They set a password when they first open the link.
   2. Make yourself admin:
      ```sql
      update profiles set role = 'admin' where email = 'you@…';
      ```
   3. After that, set everyone else's role on the app's **Admin** page and tick **Active**. New accounts start inactive.

## Develop

```
cp .env.example .env.local   # fill in the two VITE_ values
npm install
npm run dev
npm run typecheck
npm run build
```

## Screens

| Route | What it does |
|---|---|
| `/` | **Dashboard** (admin and managers): today's crews and call-outs, alerts, next 7 days, weekly stats. Dispatchers land on the dispatch board. |
| `/dispatch` | **Dispatch board.** One card per crew for the day. Click a member to mark them out (logged as a call-out). "+ person" adds or moves someone between crews. Drag work orders from the tray onto a crew. Click a stop for details. |
| `/week` | **Week and month views.** Crews (or jobs) × days. Drag a chip to reschedule. |
| `/work-orders`, `/work-orders/:id` | **Work orders.** Status, scope, returned paperwork, line items, flags (with one-click repair or follow-up work orders), who worked, notes and files. |
| `/jobs`, `/jobs/:id` | **Job folder.** Parties and contacts, phases, buildings and levels, a timeline of visits and shipments, photos, video and documents, notes from every level, and the change log (admin). |
| `/customers/:id` | **Customer.** The customer's jobs and customer-level notes. |
| `/intake` | **Paper intake.** Upload scanned sheets; `/api/extract-scan` reads them with Claude. Review and confirm each sheet into its work order. Name matches teach the employee alias list. |
| `/pw` | **Prevailing wage report (admin).** Weekly Customer – Job / Date – Employee report as a PDF, plus the PW job list with effective dates. |
| `/crews` | **Crews and employees.** Usual crew pairings, employees and the spellings of their names, and the call-out log. |
| `/admin` | **Admin.** Users, roles, facility access and the full change log. |

## Database

| Area | Tables |
|---|---|
| Shared | facilities, companies (+aliases), contacts, jobs (+aliases, parties, contacts), job_areas, lots, products (+aliases), employees (+aliases), profiles |
| Shipping | shipments, shipment_lines, shipment_locations, delivery_runs, delivery_stops, molds, mold_logs |
| Field Ops | work_orders (+lines, locations, flags, workers, scans), crews, crew_default_members, crew_days, crew_day_members, crew_day_stops, employee_absences, prevailing_wage_periods, pw_reports |
| Records | notes (+revisions), files, audit_log |

Useful functions and views:
- `match_employee('Naysiso')`
- `search_jobs('JR Pierce')`
- `pw_week('2026-10-26')`
- `load_default_roster(date)`
- `v_dispatch_board`, `v_unassigned_work_orders`, `v_job_summary`

### Roles

| Role | Access |
|---|---|
| `admin` | Everything |
| `manager` | Everything operational, including employees, and can delete records |
| `dispatcher` | Work orders, crews, job folders, notes |
| `read_only_manager` | Sees everything, changes nothing |
| `shipping_coordinator` | Shipments for the facilities in `facility_access` |
| `driver` | Own delivery runs |
| `lead_tech`, `tech` | Reserved for the field-app phase |

### Files

Everything goes in one private bucket, `job-files`, opened with signed URLs. Photos get a small WebP thumbnail at upload, so galleries stay fast. Each file's `provider` column (`supabase` | `cloudflare_stream` | `r2`) lets video move to Cloudflare later without changing the database.

### Loading data

Run these in the Supabase SQL Editor in order. Each one is safe to run twice.

| File | What it loads |
|---|---|
| `supabase/migrations/…0008_departments.sql` | The 6 departments (dispatch tabs) |
| `supabase/seed/01_customers_jobs_products.sql` | 248 companies, 1,081 jobs, 767 products and molds from the shipping app |
| `supabase/seed/02_shipments_part1–3.sql` | 4,011 shipments and 12,680 line items |
| `supabase/seed/03_employees_crews.sql` | 53 employees with name spellings, and 11 usual crews |
| `supabase/seed/04_prevailing_wage.sql` | 93 PW jobs: 23 matched to existing jobs, 70 created with addresses, all flagged |
| `supabase/seed/05_test_day_oct29_30.sql` | **Test data**: the 10/29–10/30 paperwork as work orders 9001+ |
| `supabase/seed/99_remove_test_day.sql` | Removes only the test-day work orders and rosters |

Review files:
- `company_groups_review.csv`: how the 384 customer spellings were grouped
- `pw_import_review.csv`: how each PW line was matched

To regenerate everything:

```
python3 scripts/build_seed.py <Base44 CSV dir> scripts/transcription_10-29_10-30.json <employees.xlsx> <pw.xlsx> supabase/seed
```
