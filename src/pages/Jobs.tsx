import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { shortDate } from '@/lib/dates';
import type { JobSummary } from '@/lib/types';
import { useJobSearch } from '@/components/JobPicker';
import { ErrorBox, PwBadge, Spinner, inputCls } from '@/components/ui';

export default function Jobs() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const search = useJobSearch(q);
  const recent = useQuery({
    queryKey: ['jobs-recent'],
    queryFn: async () =>
      must(
        await supabase.from('v_job_summary').select('*').eq('status', 'active').not('last_visit', 'is', null).order('last_visit', { ascending: false }).limit(40),
      ) as JobSummary[],
  });
  const searching = q.trim().length >= 2;

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
      <h1 className="text-[22px] font-bold">Jobs</h1>
      <input
        aria-label="Search jobs"
        autoFocus
        className={inputCls + ' max-w-xl'}
        placeholder="Search by job, customer, contractor, builder — misspellings OK"
        value={q}
        onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}); }}
      />
      <ErrorBox error={search.error || recent.error} />
      {searching ? (
        <div className="flex flex-col gap-2">
          {search.isFetching && <Spinner label="Searching…" />}
          {(search.data ?? []).map((h) => (
            <Link key={h.job_id} to={`/jobs/${h.job_id}`} className="flex flex-col rounded-lg border border-slate-300 bg-white p-3 text-slate-900 no-underline hover:border-brand">
              <span className="font-semibold">{h.job_name}</span>
              <span className="text-[13px] text-slate-600">
                {h.customer_name}{h.city ? ` · ${h.city}` : ''} · {h.status}
                {h.matched_on !== h.job_name && h.matched_on !== h.customer_name && <> · matched “{h.matched_on}”</>}
              </span>
            </Link>
          ))}
          {search.data && search.data.length === 0 && <p className="text-sm text-slate-500">No jobs found.</p>}
        </div>
      ) : (
        <>
          <div className="text-xs font-bold tracking-wider text-slate-600 uppercase">Active jobs with recent visits</div>
          {recent.isLoading && <Spinner />}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {(recent.data ?? []).map((j) => (
              <Link key={j.job_id} to={`/jobs/${j.job_id}`} className="flex flex-col gap-1 rounded-[10px] border border-slate-300 bg-white p-3 text-slate-900 no-underline hover:border-brand">
                <div className="flex items-center gap-2"><span className="flex-1 font-semibold">{j.name}</span>{j.prevailing_wage && <PwBadge />}</div>
                <div className="text-[13px] text-slate-600">{j.customer}{j.city ? ` · ${j.city}` : ''}</div>
                <div className="flex flex-wrap gap-x-3 text-xs text-slate-600">
                  <span>Last visit {shortDate(j.last_visit)}</span>
                  <span>{j.open_work_orders} open WOs</span>
                  {j.open_flags > 0 && <span className="font-bold text-red-700">{j.open_flags} open flags</span>}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
