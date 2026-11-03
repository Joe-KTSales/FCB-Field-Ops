-- =====================================================================
-- 0011 Confidence score (0-100) + reasons for prevailing-wage job matches,
--      shown on "Matches to confirm". Also re-points "Monarch at Redwood"
--      to Lovazzano's Monarch Apts. (it was linked to Pace Supply's).
-- Safe to run more than once.
-- =====================================================================

alter table public.prevailing_wage_periods
  add column if not exists match_confidence int check (match_confidence between 0 and 100),
  add column if not exists match_reasons    text[];

-- Monarch at Redwood (Lovazzano): link to Lovazzano's job, not Pace Supply's delivery job
update public.prevailing_wage_periods
   set id = '0010ece7-f8e2-5c10-8e92-2a6418fbc4dc', job_id = 'f5c2a97b-3121-5ccb-a303-3ee7719ae66f',
       match_note = 'PW list says “Lovazzano – MONARCH AT REDWOOD” · matched to “MONARCH APTS.” (Lovazzano Mechanical, Inc)'
 where id = '2e5cd15b-9e45-55b9-9d01-fc9823466e1b' and reviewed_at is null
   and not exists (select 1 from public.prevailing_wage_periods where id = '0010ece7-f8e2-5c10-8e92-2a6418fbc4dc');
delete from public.job_parties where job_id = '7a49d83c-0131-5fc9-b530-d2d22bf56d1e' and company_id = 'aab2ddaa-3917-52b5-b05d-decb2ab41a08' and role = 'contractor' and note = 'From PW list';
update public.job_aliases set job_id = 'f5c2a97b-3121-5ccb-a303-3ee7719ae66f' where job_id = '7a49d83c-0131-5fc9-b530-d2d22bf56d1e' and alias = 'MONARCH AT REDWOOD'
   and not exists (select 1 from public.job_aliases where job_id = 'f5c2a97b-3121-5ccb-a303-3ee7719ae66f' and alias_norm = 'monarch at redwood');

-- Scores
update public.prevailing_wage_periods set match_confidence = 90, match_reasons = '{"Names 73% alike","Same customer","Shipping also marks it prevailing wage","Street address matches (501 Mission)"}' where id = 'bdea851f-bfa0-5fc6-9acc-d5d38fd485f2';
update public.prevailing_wage_periods set match_confidence = 90, match_reasons = '{"Names 100% alike","Same customer","Shipping also marks it prevailing wage"}' where id = '0065519e-4ed1-5d40-beb3-374f7fa91f75';
update public.prevailing_wage_periods set match_confidence = 75, match_reasons = '{"Names 100% alike","Same customer","No location in shipping records to compare"}' where id = '235dbfd6-8231-505a-8cb4-836217738a97';
update public.prevailing_wage_periods set match_confidence = 71, match_reasons = '{"Names 74% alike","Same customer","City matches (Lake Elsinore)"}' where id = 'c77c303e-4045-519c-b7cf-e462ee02fbb1';
update public.prevailing_wage_periods set match_confidence = 67, match_reasons = '{"Names 86% alike","Same customer","No location in shipping records to compare"}' where id = '9deb6a6e-32af-5657-b22d-599fcd95f52c';
update public.prevailing_wage_periods set match_confidence = 90, match_reasons = '{"Names 100% alike","Same customer","Shipping also marks it prevailing wage","No location in shipping records to compare"}' where id = 'c9b1736d-a41d-51c5-a100-8f937b926c49';
update public.prevailing_wage_periods set match_confidence = 99, match_reasons = '{"Names 100% alike","Same customer","Shipping also marks it prevailing wage","Street address matches (316 Washington)"}' where id = '34ea6c09-5ab4-5a57-b7e7-bbedb5638c7e';
update public.prevailing_wage_periods set match_confidence = 75, match_reasons = '{"Names 100% alike","Same customer","No location in shipping records to compare"}' where id = '782344f6-3c69-5fb9-862b-12750bb784d3';
update public.prevailing_wage_periods set match_confidence = 72, match_reasons = '{"Names 67% alike","Same customer","Shipping also marks it prevailing wage"}' where id = '0010ece7-f8e2-5c10-8e92-2a6418fbc4dc';
update public.prevailing_wage_periods set match_confidence = 61, match_reasons = '{"Names 75% alike","Same customer","No location in shipping records to compare"}' where id = '88a8e19d-b64f-5842-b09d-413d3dff3a7e';
update public.prevailing_wage_periods set match_confidence = 99, match_reasons = '{"Names 100% alike","Same customer","Shipping also marks it prevailing wage","Street address matches (1555 Sixth)"}' where id = '874d2129-b051-5782-8131-e1d161a431ab';
update public.prevailing_wage_periods set match_confidence = 70, match_reasons = '{"Names 91% alike","Same customer"}' where id = '4465d1a4-40cf-5aff-b764-d266ce2c069c';
update public.prevailing_wage_periods set match_confidence = 78, match_reasons = '{"Names 61% alike","Same customer","Shipping also marks it prevailing wage","City matches (San Marcos)"}' where id = 'c0349491-eb1c-546e-acea-4b026f43c3ea';
update public.prevailing_wage_periods set match_confidence = 84, match_reasons = '{"Names 62% alike","Same customer","Shipping also marks it prevailing wage","Street address matches (1150 Fashion)"}' where id = '6a8f873e-95ad-5057-b0da-b7f72ee86a74';
update public.prevailing_wage_periods set match_confidence = 88, match_reasons = '{"Names 96% alike","Same customer","Shipping also marks it prevailing wage","No location in shipping records to compare"}' where id = '2952661e-2c6f-5201-a345-ae568f7d0cec';
update public.prevailing_wage_periods set match_confidence = 71, match_reasons = '{"Names 48% alike","Same customer","Shipping also marks it prevailing wage","City matches (Fort Irwin)"}' where id = 'b58f5fa9-cc7b-56ef-945b-3aed4e45fcf5';
update public.prevailing_wage_periods set match_confidence = 76, match_reasons = '{"Names 75% alike","Same customer","Shipping also marks it prevailing wage","No location in shipping records to compare"}' where id = '839ede64-f01b-5012-a6c3-0f9b70390d6b';
update public.prevailing_wage_periods set match_confidence = 90, match_reasons = '{"Names 100% alike","Same customer","Shipping also marks it prevailing wage","No location in shipping records to compare"}' where id = 'fab9b56d-6fc4-5009-8442-ecd66ecace00';
