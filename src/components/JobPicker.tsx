import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { Button, ErrorBox, Field, inputCls } from './ui';

export interface PickedJob { id: string; name: string; customer: string; city: string | null }

interface SearchHit { job_id: string; job_name: string; customer_name: string; city: string | null; status: string; matched_on: string }

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function useJobSearch(q: string) {
  const dq = useDebounced(q.trim());
  return useQuery({
    queryKey: ['search_jobs', dq],
    enabled: dq.length >= 2,
    queryFn: async () => must(await supabase.rpc('search_jobs', { p_q: dq, p_limit: 12 })) as SearchHit[],
  });
}

function NewJobForm({ initialName, onCreated, onCancel }: { initialName: string; onCreated: (j: PickedJob) => void; onCancel: () => void }) {
  const [name, setName] = useState(initialName);
  const [city, setCity] = useState('');
  const [custQ, setCustQ] = useState('');
  const [cust, setCust] = useState<{ id: string; name: string } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const dq = useDebounced(custQ.trim());
  const companies = useQuery({
    queryKey: ['company-search', dq],
    enabled: dq.length >= 2 && !cust,
    queryFn: async () => {
      // match on canonical name or any alias
      const [a, b] = await Promise.all([
        supabase.from('companies').select('id, name').ilike('name', `%${dq}%`).eq('active', true).limit(8),
        supabase.from('company_aliases').select('company:companies(id, name)').ilike('alias', `%${dq}%`).limit(8),
      ]);
      const out = new Map<string, string>();
      (a.data ?? []).forEach((c) => out.set(c.id, c.name));
      ((b.data ?? []) as unknown as { company: { id: string; name: string } | null }[]).forEach((r) => r.company && out.set(r.company.id, r.company.name));
      return [...out].map(([id, name]) => ({ id, name }));
    },
  });

  async function save() {
    setErr(null);
    try {
      let customerId = cust?.id;
      if (!customerId) {
        if (!custQ.trim()) throw new Error('Pick or type a customer.');
        const c = must(await supabase.from('companies').insert({ name: custQ.trim() }).select('id').single()) as { id: string };
        customerId = c.id;
      }
      const j = must(
        await supabase.from('jobs').insert({ name: name.trim(), city: city.trim() || null, customer_id: customerId }).select('id, name, city').single(),
      ) as { id: string; name: string; city: string | null };
      onCreated({ id: j.id, name: j.name, city: j.city, customer: cust?.name ?? custQ.trim() });
    } catch (x) {
      setErr(x);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-300 bg-slate-50 p-3">
      <div className="text-sm font-bold">New job</div>
      <Field label="Job name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Customer" hint={cust ? undefined : 'Pick an existing customer, or keep typing to add a new one'}>
        {cust ? (
          <div className="flex items-center gap-2">
            <span className="font-semibold">{cust.name}</span>
            <button type="button" className="text-sm text-brand-dark underline" onClick={() => setCust(null)}>change</button>
          </div>
        ) : (
          <>
            <input className={inputCls} value={custQ} onChange={(e) => setCustQ(e.target.value)} />
            {(companies.data ?? []).map((c) => (
              <button type="button" key={c.id} onClick={() => setCust(c)} className="rounded px-2 py-1.5 text-left text-sm hover:bg-white">
                {c.name}
              </button>
            ))}
          </>
        )}
      </Field>
      <Field label="City"><input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} /></Field>
      <ErrorBox error={err} />
      <div className="flex gap-2">
        <Button type="button" variant="primary" disabled={!name.trim()} onClick={save}>Create job</Button>
        <Button type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

export default function JobPicker({ value, onChange }: { value: PickedJob | null; onChange: (j: PickedJob | null) => void }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const hits = useJobSearch(q);

  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-slate-300 bg-white px-3 py-2">
        <div className="flex-1">
          <div className="font-semibold">{value.name}</div>
          <div className="text-xs text-slate-600">{value.customer}{value.city ? ` · ${value.city}` : ''}</div>
        </div>
        <button type="button" className="text-sm text-brand-dark underline" onClick={() => onChange(null)}>change</button>
      </div>
    );
  }
  if (creating) return <NewJobForm initialName={q} onCreated={(j) => { setCreating(false); onChange(j); }} onCancel={() => setCreating(false)} />;

  return (
    <div className="flex flex-col gap-1">
      <input className={inputCls} placeholder="Type a job, customer, contractor…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {hits.isFetching && <div className="px-1 text-xs text-slate-500">Searching…</div>}
      {(hits.data ?? []).map((h) => (
        <button
          type="button"
          key={h.job_id}
          onClick={() => onChange({ id: h.job_id, name: h.job_name, customer: h.customer_name, city: h.city })}
          className="flex flex-col rounded-md px-2 py-2 text-left hover:bg-slate-100"
        >
          <span className="font-semibold">{h.job_name}</span>
          <span className="text-xs text-slate-600">
            {h.customer_name}{h.city ? ` · ${h.city}` : ''}{h.matched_on !== h.job_name && h.matched_on !== h.customer_name ? ` · matched “${h.matched_on}”` : ''}
          </span>
        </button>
      ))}
      {q.trim().length >= 2 && (
        <button type="button" className="mt-1 self-start text-sm font-semibold text-brand-dark underline" onClick={() => setCreating(true)}>
          + Create a new job “{q.trim()}”
        </button>
      )}
    </div>
  );
}
