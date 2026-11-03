import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { stamp } from '@/lib/dates';
import type { NoteRow } from '@/lib/types';
import { Button, ErrorBox, cx, inputCls } from './ui';

type Target = { job_id?: string; company_id?: string; area_id?: string; lot_id?: string; work_order_id?: string };

/**
 * Notes for one record. With `rollup` on a job, shows notes on the job AND everything
 * under it (work orders, lots, areas), labelled with where they were left.
 */
export default function NotesPanel({ target, rollup, title = 'Notes' }: { target: Target; rollup?: boolean; title?: string }) {
  const { canNote, session, isAdmin } = useAuth();
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const key = ['notes', target, rollup];

  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      let req = supabase
        .from('notes')
        .select('*, author:profiles!notes_author_id_fkey(full_name, email), work_order:work_orders(number), lot:lots(lot_number), area:job_areas(name)')
        .is('deleted_at', null)
        .order('pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(200);
      const [k, v] = Object.entries(target)[0];
      req = req.eq(k, v as string);
      if (!rollup) {
        // only notes left directly on this record
        for (const other of ['area_id', 'lot_id', 'work_order_id'] as const) if (other !== k) req = req.is(other, null);
      }
      return must(await req) as (NoteRow & { work_order: { number: string } | null; lot: { lot_number: string } | null; area: { name: string } | null })[];
    },
  });

  const add = useMutation({
    mutationFn: async () => must(await supabase.from('notes').insert({ ...target, body: body.trim() })),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['notes'] }); },
  });
  const update = useMutation({
    mutationFn: async (v: { id: string; patch: Record<string, unknown> }) => must(await supabase.from('notes').update(v.patch).eq('id', v.id)),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['notes'] }); },
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center"><h2 className="flex-1 text-base font-bold">{title}</h2><span className="text-xs text-slate-500">pinned first</span></div>
      {canNote && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(); }}
        >
          <label className="sr-only" htmlFor={`note-${key.join()}`}>Add a note</label>
          <textarea
            id={`note-${key.join()}`}
            className={cx(inputCls, 'py-2')}
            rows={3}
            placeholder="Add a note — your name and the time are saved with it"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <ErrorBox error={add.error} />
          <Button size="sm" variant="primary" className="self-start" disabled={!body.trim() || add.isPending}>Add note</Button>
        </form>
      )}
      {(q.data ?? []).map((n) => {
        const mine = n.author_id === session?.user.id;
        const where = n.work_order?.number ?? (n.lot ? `Lot ${n.lot.lot_number}` : n.area?.name);
        return (
          <div key={n.id} className={cx('rounded-lg border p-3', n.pinned ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50')}>
            <div className="flex flex-wrap gap-x-2 text-xs text-slate-600">
              <b className="text-slate-900">{n.author?.full_name || n.author?.email || 'Unknown'}</b>
              <span>{stamp(n.created_at)}{n.edited_at ? ' · edited' : ''}</span>
              <span className="flex-1" />
              {rollup && where && <span className="font-mono">{where}</span>}
            </div>
            {editing === n.id ? (
              <div className="mt-2 flex flex-col gap-2">
                <textarea className={cx(inputCls, 'py-2')} rows={3} value={editBody} onChange={(e) => setEditBody(e.target.value)} />
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => update.mutate({ id: n.id, patch: { body: editBody } })}>Save</Button>
                  <Button size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-1 text-sm whitespace-pre-wrap">{n.body}</p>
                {n.body_translated && <p className="mt-1 text-sm text-slate-700 italic">{n.body_translated}</p>}
              </>
            )}
            {(mine || isAdmin) && editing !== n.id && (
              <div className="mt-2 flex gap-3 text-xs">
                <button className="text-brand-dark underline" onClick={() => { setEditing(n.id); setEditBody(n.body); }}>Edit</button>
                <button className="text-brand-dark underline" onClick={() => update.mutate({ id: n.id, patch: { pinned: !n.pinned } })}>{n.pinned ? 'Unpin' : 'Pin'}</button>
                <button className="text-red-700 underline" onClick={() => update.mutate({ id: n.id, patch: { deleted_at: new Date().toISOString(), deleted_by: session?.user.id } })}>Remove</button>
              </div>
            )}
          </div>
        );
      })}
      {q.data && q.data.length === 0 && <p className="text-sm text-slate-500">No notes yet.</p>}
      <ErrorBox error={q.error} />
    </div>
  );
}
