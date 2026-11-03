import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must, signedUrl, BUCKET } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { stamp } from '@/lib/dates';
import type { FileRow } from '@/lib/types';
import { Button, ErrorBox, Modal, cx } from './ui';

type Target = { job_id?: string; work_order_id?: string; lot_id?: string; company_id?: string };

function kindFor(f: File): FileRow['kind'] {
  if (f.type.startsWith('image/')) return 'photo';
  if (f.type.startsWith('video/')) return 'video';
  return 'document';
}

/** Small WebP thumbnail so grids stay fast no matter how many photos a job has. */
async function makeThumb(file: File, max = 480): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b), 'image/webp', 0.78));
  } catch {
    return null;
  }
}

export async function uploadFile(file: File, target: Target, kind?: FileRow['kind'], folder?: string) {
  const id = crypto.randomUUID();
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const now = new Date();
  const base = folder ?? `jobs/${target.job_id ?? 'unfiled'}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
  const path = `${base}/${id}.${ext}`;
  const k = kind ?? kindFor(file);
  const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (up.error) throw up.error;
  let thumbnail_path: string | null = null;
  if (k === 'photo') {
    const t = await makeThumb(file);
    if (t) {
      const tp = `${base}/thumbs/${id}.webp`;
      const tu = await supabase.storage.from(BUCKET).upload(tp, t, { contentType: 'image/webp' });
      if (!tu.error) thumbnail_path = tp;
    }
  }
  return must(
    await supabase
      .from('files')
      .insert({ id, ...target, kind: k, file_name: file.name, mime_type: file.type || null, size_bytes: file.size, storage_path: path, thumbnail_path })
      .select('*')
      .single(),
  ) as FileRow;
}

function Thumb({ f, onOpen }: { f: FileRow; onOpen: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (f.kind === 'photo') signedUrl(f.thumbnail_path ?? f.storage_path).then((u) => live && setUrl(u));
    return () => { live = false; };
  }, [f]);
  return (
    <button onClick={onOpen} className="group flex flex-col overflow-hidden rounded-md border border-slate-200 bg-white text-left" title={f.file_name}>
      <div className={cx('flex aspect-[4/3] w-full items-center justify-center text-xs', f.kind === 'video' ? 'bg-navy text-white' : 'bg-slate-100 text-slate-600')}>
        {f.kind === 'photo' && url ? <img src={url} alt={f.caption ?? f.file_name} loading="lazy" className="h-full w-full object-cover" /> : f.kind === 'video' ? '▶ Video' : f.kind === 'scan' ? 'Scanned sheet' : (f.file_name.split('.').pop() ?? '').toUpperCase()}
      </div>
      <div className="truncate px-2 py-1 text-xs text-slate-700">{f.caption || f.file_name}</div>
    </button>
  );
}

function Viewer({ f, onClose }: { f: FileRow | null; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (f) signedUrl(f.storage_path).then(setUrl);
  }, [f]);
  return (
    <Modal open={!!f} onClose={onClose} title={f?.file_name ?? ''} wide>
      {f && (
        <div className="flex flex-col gap-3">
          {!url && <p className="text-sm text-slate-600">Loading…</p>}
          {url && f.kind === 'photo' && <img src={url} alt={f.caption ?? f.file_name} className="max-h-[60vh] w-full object-contain" />}
          {url && f.kind === 'video' && <video src={url} controls preload="metadata" className="max-h-[60vh] w-full bg-black" />}
          {url && (f.mime_type === 'application/pdf') && <iframe title={f.file_name} src={url} className="h-[60vh] w-full" />}
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
            <span>{stamp(f.created_at)}</span>
            {f.size_bytes && <span>{(f.size_bytes / 1024 / 1024).toFixed(1)} MB</span>}
            <span className="flex-1" />
            {url && <a className="font-semibold" href={url} download={f.file_name} target="_blank" rel="noreferrer">Download</a>}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function FilesPanel({ target, rollup, title = 'Photos, video & documents' }: { target: Target; rollup?: boolean; title?: string }) {
  const { canNote } = useAuth();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState<FileRow | null>(null);
  const [filter, setFilter] = useState<'all' | 'photo' | 'video' | 'docs'>('all');

  const q = useQuery({
    queryKey: ['files', target, rollup],
    queryFn: async () => {
      const [k, v] = Object.entries(target)[0];
      let req = supabase.from('files').select('*').is('deleted_at', null).eq(k, v as string).order('created_at', { ascending: false }).limit(500);
      if (!rollup && k === 'job_id') req = req.is('work_order_id', null).is('lot_id', null);
      return must(await req) as FileRow[];
    },
  });

  async function onPick(files: FileList | null) {
    if (!files?.length) return;
    setErr(null);
    try {
      let i = 0;
      for (const f of Array.from(files)) {
        i += 1;
        setBusy(`Uploading ${i} of ${files.length}…`);
        await uploadFile(f, target);
      }
      qc.invalidateQueries({ queryKey: ['files'] });
      qc.invalidateQueries({ queryKey: ['job-summary'] });
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  }

  const rows = (q.data ?? []).filter((f) =>
    filter === 'all' ? true : filter === 'photo' ? f.kind === 'photo' : filter === 'video' ? f.kind === 'video' : !['photo', 'video'].includes(f.kind),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-base font-bold">{title}</h2>
        <select aria-label="Filter files" className="min-h-9 rounded-md border border-slate-300 bg-white px-2 text-sm" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All</option><option value="photo">Photos</option><option value="video">Video</option><option value="docs">Documents &amp; scans</option>
        </select>
        {canNote && (
          <>
            <input ref={input} type="file" multiple className="hidden" onChange={(e) => onPick(e.target.files)} accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv" />
            <Button size="sm" variant="primary" disabled={!!busy} onClick={() => input.current?.click()}>{busy ?? 'Upload'}</Button>
          </>
        )}
      </div>
      <ErrorBox error={err || q.error} />
      {rows.length === 0 && !q.isLoading && <p className="text-sm text-slate-500">Nothing here yet.</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2">
        {rows.map((f) => <Thumb key={f.id} f={f} onOpen={() => setOpen(f)} />)}
      </div>
      <Viewer f={open} onClose={() => setOpen(null)} />
    </div>
  );
}
