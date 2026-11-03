-- =====================================================================
-- 0009 Employer on employees (KT Sales and Service / Fiber Care Baths)
--      + human confirmation for prevailing-wage job matches.
-- Safe to run before or after the data files.
-- =====================================================================

alter table public.employees
  add column if not exists employer text not null default 'kt' check (employer in ('kt', 'fcb'));
comment on column public.employees.employer is 'kt = KT Sales and Service, fcb = Fiber Care Baths';

alter table public.prevailing_wage_periods
  add column if not exists needs_review boolean not null default false,
  add column if not exists match_note   text,
  add column if not exists reviewed_by  uuid references public.profiles(id),
  add column if not exists reviewed_at  timestamptz;

create index if not exists pw_needs_review_idx on public.prevailing_wage_periods (needs_review) where needs_review;

-- PW list lines that were matched to an existing job by a close-but-not-exact name.
-- They appear under "Matches to confirm" on the PW report page.
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “2020 Plumbing – PRISMA ARTIST''S LOFTS, 501 E Mission Blvd, Pomona, CA 91766” · matched to “Prisma Lofts” (20/20 Plumbing & Heating Inc) · named match (check)' where id = 'bdea851f-bfa0-5fc6-9acc-d5d38fd485f2' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “2020 Plumbing – THE 101 APARTMENTS” · matched to “101 Apartments” (20/20 Plumbing & Heating Inc) · same customer · 80%' where id = '0065519e-4ed1-5d40-beb3-374f7fa91f75' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Aphaia Mechanical Corp – THE GARVEY, 1434 W Compton Blvd, Compton, CA 90220” · matched to “GARVEY” (APHAIA MECHANICAL) · same customer · 75%' where id = '235dbfd6-8231-505a-8cb4-836217738a97' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “ICG (Intergration Construction) – CAMBERN AVE APTS, 29366 & 29377 3rd St, Lake Elsinore, CA 92532” · matched to “3rd and Cambern Avenue Apartments” (ICG Incorporated) · named match (check)' where id = 'c77c303e-4045-519c-b7cf-e462ee02fbb1' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Imperial T & S Plumbing – 20th STREET APARTMENTS, 1634 20th Street, Santa Monica, CA 90404” · matched to “20th St. Apts.” (Imperial T&S Plumbing, Inc) · same customer · 86%' where id = '9deb6a6e-32af-5657-b22d-599fcd95f52c' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Imperial T & S Plumbing – LINCOLN BEACH, 208 South Beach Blvd, Anaheim, CA 92805” · matched to “Lincoln Beach PREV. WAGE/TURNKEY” (Imperial T&S Plumbing, Inc) · same customer · 72%' where id = 'c9b1736d-a41d-51c5-a100-8f937b926c49' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Imperial T & S Plumbing – PEAK PLAZA APTS, 316 E Washington Blvd, Los Angeles CA 90015” · matched to “Peak Plaza” (Imperial T&S Plumbing, Inc) · same customer · 80%' where id = '34ea6c09-5ab4-5a57-b7e7-bbedb5638c7e' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “James Plumbing – HARBOR VIEW PLACE, 326-327 King Ave, Los Angeles CA 90744” · matched to “Harbor View Place Apts.” (James Plumbing) · same customer · 87%' where id = '782344f6-3c69-5fb9-862b-12750bb784d3' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Lovazzano – MONARCH AT REDWOOD” · matched to “Monarch Apts.” (Pace Supply Corp) · named match (check)' where id = '2e5cd15b-9e45-55b9-9d01-fc9823466e1b' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “MG Plumbing – FOUNTAIN STREET APARTMENTS, 4151 E Fountain St & 4220 E Wehrle Ct, Long Beach , CA” · matched to “FOUNTAIN VALLEY APARTMENTS” (MG PLUMBING) · named match (check)' where id = '88a8e19d-b64f-5842-b09d-413d3dff3a7e' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Ocean Park Mechanical – KINDRED,  1555 Sixth Ave, San Diego, CA 92101” · matched to “KINDRED APTS.” (Ocean Park Mechanical) · same customer · 74%' where id = '874d2129-b051-5782-8131-e1d161a431ab' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Pace Supply – CSUS STUDENT HOUSING III” · matched to “CSUS Student Housing” (Pace Supply Corp) · same customer · 91%' where id = '4465d1a4-40cf-5aff-b764-d266ce2c069c' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Sherwood Mechanical – NORTH CITY BLOCK F PHASE A, San Marcos” · matched to “North City PREV. WAGE/TURNKEY” (Sherwood Mechanical Inc) · named match (check)' where id = 'c0349491-eb1c-546e-acea-4b026f43c3ea' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Sherwood Mechanical – WAKELAND, 1150 Fashion Valley Rd, San Diego, CA 92108 (kt sales will do work)” · matched to “Wakeland Riverwalk” (Sherwood Mechanical Inc) · same customer · 62%' where id = '6a8f873e-95ad-5057-b0da-b7f72ee86a74' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “Springwater Plumbing – ROSA''S PLACE, 448 S San Pedro St, Los Angeles, CA” · matched to “ROSAS PLACE” (Springwater Plumbing) · same customer · 96%' where id = '2952661e-2c6f-5201-a345-ae568f7d0cec' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “SSW Mechanical – FORT IRWIN APARTMENTS, Pork Chop Hill & 5th St, Fort Irwin, CA 92310” · matched to “Tiefort View PRE. WAGE/TURNKEY Fort Irwin, CA” (SSW Mechanical) · named match (check)' where id = 'b58f5fa9-cc7b-56ef-945b-3aed4e45fcf5' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “SSW Mechanical – JFM SENIOR VILLAS APARTMENTS, 45-135 Van Buren St, Indio, CA 92201” · matched to “JFM VILLAS SR. APTS.” (SSW Mechanical) · named match (check)' where id = '839ede64-f01b-5012-a6c3-0f9b70390d6b' and reviewed_at is null;
update public.prevailing_wage_periods set needs_review = true, match_note = 'PW list says “SSW Mechanical – PALM VILLAS AT MILLENIUM, 74699 Technology Dr, Palm Desert, CA 92211” · matched to “Palm Villas @ Millenium” (SSW Mechanical) · same customer · 93%' where id = 'fab9b56d-6fc4-5009-8442-ecd66ecace00' and reviewed_at is null;
