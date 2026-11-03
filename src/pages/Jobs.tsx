import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { shortDate } from '@/lib/dates';
import type { JobSummary } from '@/lib/types';
import { useJobSearch } from '@/components/JobPicker';
import { Button, ErrorBox, PwBadge, Spinner, cx, inputCls } from '@/components/ui';

type View = 'all' | 'recent' | 'pw';
const PAGE = 60;

export default function Jobs() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [view, setView] = useState<View>((params.get('view') as View) || 'all');
  const [limit, setLimit] = useState(PAGE);
  const search = useJobSearch(q);
  const list = useQuery({
    queryKey: ['jobs-list', view, limit],
    queryFn: async () => {
      let r = supabase.from('v_job_summary').select('*', { count: 'exact' }).eq('status', 'active');
      if (view === 'recent') r = r.not('last_visit', 'is', null).order('last_visit', { ascending: false });
      else if (view === 'pw') r = r.eq('prevailing_wage', true).order('name');
      else r = r.order('name');
      const res = await r.range(0, limit - 1);
      return { rows: must(res) as JobSummary[], count: res.count ?? 0 };
    },
  });
  const searching = q.trim().length >= 2;
  const setV = (v: View) => { setView(v); setLimit(PAGE); setParams(v === 'all' ? {} : { view: v }); };

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
      <h1 className="text-[22px] font-bold">Jobs</h1>
      <div className="flex flex-wrap items-center gap-3">
        <input
          aria-label="Search jobs"
          autoFocus
          className={inputCls + ' max-w-xl flex-1'}
          placeholder="Search by job, customer, contractor, builder — misspellings OK"
          value={q}
          onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}); }}
        />
        {!searching && (
          <div role="tablist" className="flex gap-1 rounded-lg bg-slate-200 p-1">
            {([['all', 'All jobs'], ['recent', 'Recent visits'], ['pw', 'Prevailing wage']] as [View, string][]).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={view === k} onClick={() => setV(k)} className={cx('min-h-9 rounded-md px-3.5 text-sm font-semibold', view === k ? 'bg-white shadow-sm' : 'text-slate-600')}>{l}</button>
            ))}
          </div>
        )}
      </div>
      <ErrorBox error={search.error || list.error} />
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
          <div className="text-[13px] text-slate-600">{list.data ? `${list.data.count.toLocaleString()} active jobs` : ''}{view === 'recent' ? ' with a crew visit' : view === 'pw' ? ' on the prevailing wage list' : ''}</div>
          {list.isLoading && <Spinner />}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {(list.data?.rows ?? []).map((j) => (
              <Link key={j.job_id} to={`/jobs/${j.job_id}`} className="flex flex-col gap-1 rounded-[10px] border border-slate-300 bg-white p-3 text-slate-900 no-underline hover:border-brand">
                <div className="flex items-center gap-2"><span className="flex-1 font-semibold">{j.name}</span>{j.prevailing_wage && <PwBadge />}</div>
                <div className="text-[13px] text-slate-600">{j.customer}{j.city ? ` · ${j.city}` : ''}</div>
                <div className="flex flex-wrap gap-x-3 text-xs text-slate-600">
                  {j.last_visit ? <span>Last visit {shortDate(j.last_visit)}</span> : <span>No visits yet</span>}
                  {j.shipments > 0 && <span>{j.shipments} shipments</span>}
                  {j.open_work_orders > 0 && <span>{j.open_work_orders} open WOs</span>}
                  {j.open_flags > 0 && <span className="font-bold text-red-700">{j.open_flags} open flags</span>}
                </div>
              </Link>
            ))}
          </div>
          {list.data && list.data.rows.length === 0 && (
            <p className="text-sm text-slate-500">{view === 'recent' ? 'No crew visits recorded yet.' : 'No jobs here yet.'}</p>
          )}
          {list.data && list.data.rows.length < list.data.count && (
            <Button className="self-center" onClick={() => setLimit(limit + PAGE)}>Show more</Button>
          )}
        </>
      )}
    </div>
  );
}
