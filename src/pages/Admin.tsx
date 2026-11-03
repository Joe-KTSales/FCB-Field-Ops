import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { ROLE_LABEL, useAuth } from '@/lib/auth';
import { useEmployees } from '@/lib/data';
import { stamp } from '@/lib/dates';
import type { AppRole, Profile } from '@/lib/types';
import { Card, ErrorBox, cx } from '@/components/ui';

const FACILITIES = ['adelanto', 'idaho', 'mexico'];

export default function Admin() {
  const { isAdmin, session } = useAuth();
  const qc = useQueryClient();
  const emps = useEmployees();
  const [tab, setTab] = useState<'users' | 'log'>('users');
  const users = useQuery({
    queryKey: ['profiles'],
    enabled: isAdmin,
    queryFn: async () => must(await supabase.from('profiles').select('*').order('full_name')) as Profile[],
  });
  const log = useQuery({
    queryKey: ['audit'],
    enabled: isAdmin && tab === 'log',
    queryFn: async () =>
      must(await supabase.from('audit_log').select('id, table_name, action, changed_at, changed_fields, changed_by, row_id').order('id', { ascending: false }).limit(300)) as {
        id: number; table_name: string; action: string; changed_at: string; changed_fields: string[] | null; changed_by: string | null; row_id: string | null;
      }[],
  });
  const upd = useMutation({
    mutationFn: async (v: { id: string; patch: Partial<Profile> }) => must(await supabase.from('profiles').update(v.patch).eq('id', v.id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  });
  if (!isAdmin) return <div className="p-6 text-sm text-slate-600">Admins only.</div>;
  const who = (id: string | null) => users.data?.find((u) => u.id === id)?.full_name || users.data?.find((u) => u.id === id)?.email || 'system';

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-[22px] font-bold">Admin</h1>
        <div role="tablist" className="flex gap-1 rounded-lg bg-slate-200 p-1">
          {([['users', 'Users & roles'], ['log', 'Change log']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx('min-h-9 rounded-md px-3.5 text-sm font-semibold', tab === k ? 'bg-white shadow-sm' : 'text-slate-600')}>{l}</button>
          ))}
        </div>
      </div>
      <ErrorBox error={upd.error || users.error || log.error} />
      {tab === 'users' && (
        <>
          <Card className="p-4 text-sm text-slate-700">
            <b>Adding someone:</b> invite them in Supabase (Authentication → Users → Invite user). They’ll show up here as “Read-only manager” — set their role below.
          </Card>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-slate-300 bg-slate-50 text-xs tracking-wider text-slate-600 uppercase">
                <tr><th className="px-3 py-2.5">Person</th><th className="px-3">Role</th><th className="px-3">Facilities</th><th className="px-3">Linked employee</th><th className="px-3">Active</th></tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => {
                  const me = u.id === session?.user.id;
                  return (
                    <tr key={u.id} className="border-b border-slate-100">
                      <td className="px-3 py-2.5">
                        <input aria-label="Name" defaultValue={u.full_name ?? ''} onBlur={(e) => e.target.value !== (u.full_name ?? '') && upd.mutate({ id: u.id, patch: { full_name: e.target.value } })} className="min-h-9 w-full rounded border border-transparent px-1 font-semibold hover:border-slate-300" />
                        <div className="px-1 text-xs text-slate-600">{u.email}{me && ' (you)'}</div>
                      </td>
                      <td className="px-3">
                        <select aria-label="Role" disabled={me} value={u.role} onChange={(e) => upd.mutate({ id: u.id, patch: { role: e.target.value as AppRole } })} className="min-h-9 rounded border border-slate-300 bg-white px-2">
                          {(Object.keys(ROLE_LABEL) as AppRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      </td>
                      <td className="px-3">
                        <div className="flex gap-3">
                          {FACILITIES.map((f) => (
                            <label key={f} className="flex items-center gap-1 capitalize">
                              <input type="checkbox" checked={u.facility_access.includes(f)} onChange={(e) => upd.mutate({ id: u.id, patch: { facility_access: e.target.checked ? [...u.facility_access, f] : u.facility_access.filter((x) => x !== f) } })} />{f}
                            </label>
                          ))}
                        </div>
                      </td>
                      <td className="px-3">
                        <select aria-label="Linked employee" value={u.employee_id ?? ''} onChange={(e) => upd.mutate({ id: u.id, patch: { employee_id: e.target.value || null } })} className="min-h-9 rounded border border-slate-300 bg-white px-2">
                          <option value="">—</option>
                          {(emps.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.display_name}</option>)}
                        </select>
                      </td>
                      <td className="px-3"><input type="checkbox" aria-label="Active" disabled={me} checked={u.active} onChange={(e) => upd.mutate({ id: u.id, patch: { active: e.target.checked } })} className="h-5 w-5" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
      {tab === 'log' && (
        <Card className="p-4 text-sm">
          {(log.data ?? []).map((a) => (
            <div key={a.id} className="flex flex-wrap gap-x-3 border-b border-slate-100 py-1.5">
              <span className="w-36 text-slate-500">{stamp(a.changed_at)}</span>
              <b className="w-44 truncate">{who(a.changed_by)}</b>
              <span>{a.action.toLowerCase()} {a.table_name.replace(/_/g, ' ')}</span>
              {a.changed_fields && <span className="text-slate-600">({a.changed_fields.join(', ')})</span>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
