import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import NotesPanel from '@/components/NotesPanel';
import { Card, ErrorBox, Spinner } from '@/components/ui';

export default function Customer() {
  const { id = '' } = useParams();
  const c = useQuery({
    queryKey: ['company', id],
    queryFn: async () =>
      must(await supabase.from('companies').select('*, aliases:company_aliases(alias)').eq('id', id).single()) as {
        id: string; name: string; kinds: string[]; phone: string | null; email: string | null; city: string | null; aliases: { alias: string }[];
      },
  });
  const jobs = useQuery({
    queryKey: ['company-jobs', id],
    queryFn: async () =>
      must(await supabase.from('jobs').select('id, name, city, status, updated_at').eq('customer_id', id).order('status').order('name')) as {
        id: string; name: string; city: string | null; status: string;
      }[],
  });
  const asParty = useQuery({
    queryKey: ['company-party', id],
    queryFn: async () =>
      must(await supabase.from('job_parties').select('role, job:jobs(id, name, city)').eq('company_id', id)) as unknown as { role: string; job: { id: string; name: string; city: string | null } }[],
  });
  if (!c.data) return c.error ? <div className="p-6"><ErrorBox error={c.error} /></div> : <Spinner />;
  return (
    <div className="flex flex-wrap items-start gap-4 px-4 py-4 sm:px-6">
      <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-3">
        <div className="text-[13px] text-slate-600"><Link to="/jobs">Jobs</Link> › {c.data.name}</div>
        <h1 className="text-[28px] font-bold">{c.data.name}</h1>
        {c.data.kinds.length > 0 && <div className="text-sm text-slate-600 capitalize">{c.data.kinds.join(', ').replace('_', ' ')}</div>}
        {c.data.aliases.length > 1 && <div className="text-xs text-slate-500">Also written as: {c.data.aliases.map((a) => a.alias).filter((a) => a !== c.data!.name).join(' · ')}</div>}
        <Card className="divide-y divide-slate-100">
          {(jobs.data ?? []).map((j) => (
            <Link key={j.id} to={`/jobs/${j.id}`} className="flex items-center gap-3 px-4 py-3 text-slate-900 no-underline hover:bg-blue-50">
              <span className="flex-1 font-semibold">{j.name}</span>
              <span className="text-sm text-slate-600">{j.city}</span>
              <span className="text-xs text-slate-500 capitalize">{j.status}</span>
            </Link>
          ))}
          {jobs.data?.length === 0 && <p className="p-4 text-sm text-slate-500">No jobs as customer.</p>}
        </Card>
        {(asParty.data?.length ?? 0) > 0 && (
          <>
            <h2 className="mt-2 text-base font-bold">Also on these jobs</h2>
            <Card className="divide-y divide-slate-100">
              {asParty.data!.map((p) => (
                <Link key={p.job.id + p.role} to={`/jobs/${p.job.id}`} className="flex gap-3 px-4 py-3 text-slate-900 no-underline hover:bg-blue-50">
                  <span className="flex-1 font-semibold">{p.job.name}</span><span className="text-sm text-slate-600 capitalize">as {p.role}</span>
                </Link>
              ))}
            </Card>
          </>
        )}
      </div>
      <aside className="flex max-w-[360px] flex-[1_1_280px] flex-col">
        <Card className="p-4"><NotesPanel target={{ company_id: id }} title="Customer notes" /></Card>
      </aside>
    </div>
  );
}
