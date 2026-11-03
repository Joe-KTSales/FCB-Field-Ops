/**
 * POST /api/extract-scan   { scanId }   Authorization: Bearer <user's Supabase access token>
 *
 * Reads one uploaded scan (PDF or photo of the paper work orders) with Claude and stores
 * a structured draft on work_order_scans.extracted for a dispatcher to review.
 * Runs with the caller's own Supabase session, so Row Level Security still applies —
 * no service-role key is needed or used.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const FLAG_CODES = ['not_ready', 'partial', 'repair_needed', 'damage', 'wrong_hand', 'missing_parts', 'not_ordered', 'no_signature', 'photos_offline', 'other'];
const LINE_STATUSES = ['done', 'stockpiled', 'room_in', 'returned', 'not_ready', 'missing', 'damaged'];

const PROMPT = `You are reading scanned paper work orders from KT Sales & Service, the field crew for Fiber Care Baths (fiberglass tubs, showers and wall sets).
Forms are INSTALLATION, STOCKING (stocked vs stock-piled), or FINALS / REPAIR work orders, filled in by hand, often in Spanish crew shorthand.
Each page is usually one work order. Some pages may be schedules or blank — mark those form_type "other".

Return ONLY a JSON object, no prose, shaped exactly like:
{"sheets":[{
  "page": 1,
  "form_type": "installation" | "stocking" | "finals" | "other",
  "date": "YYYY-MM-DD" | null,
  "customer": string | null,          // builder / plumber / contractor written on the form
  "job_name": string | null,
  "city": string | null,
  "area": string | null,              // phase / building / level written on the form
  "prevailing_wage_marked": boolean,  // true if PREV WAGE / prevailing wage is written anywhere
  "time_in": "HH:MM" | null,          // 24-hour; infer AM/PM from context (crews start 6-9am)
  "time_out": "HH:MM" | null,
  "lead": string | null,              // exactly as written
  "helpers": [string],                // exactly as written
  "lines": [{"lot": string, "room": "Master"|"Bath 2"|"Bath 3"|"Option"|"Garage"|null, "product": string, "hand": "L"|"R"|null, "qty": number,
             "status": ${LINE_STATUSES.map((s) => `"${s}"`).join('|')}, "uncertain": boolean}],
  "notes_original": string | null,    // crew notes exactly as written
  "notes_english": string | null,     // faithful English translation
  "flags": [${FLAG_CODES.map((s) => `"${s}"`).join('|')}],
  "flag_details": {"<flag code>": "which lots/units and what"},
  "superintendent_name": string | null,
  "superintendent_signed": boolean,
  "totals_written": string | null,
  "uncertain_fields": [string],       // anything you are unsure of
  "confidence": number                // 0..1 for the whole sheet
}]}

Rules:
- Copy names exactly as written, misspellings included ("Naysiso" stays "Naysiso"). Office initials typed on the form (e.g. "CN") are not crew.
- One line per item per lot. Crews often reuse columns (MISSING, DONE, BATH#3) for other things — read what they meant.
- "stockpiled" = left in garage/staging; "room_in" = moved from stockpile into the bathroom; "returned" = taken back.
- Use flags for: site not ready, partial work / come back, repairs, damage, wrong hand (tub backwards), missing parts or valves,
  material not ordered / delivery refused, no superintendent signature, photos sent by text.
- Never invent data. Use null and list the field in uncertain_fields when you cannot read it.`;

function extractJson(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('Model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const scanId = (req.body && (req.body as { scanId?: string }).scanId) || '';
  if (!token || !scanId) return res.status(400).json({ error: 'Missing token or scanId' });
  if (!SUPABASE_URL || !SUPABASE_ANON) return res.status(500).json({ error: 'Supabase env vars missing on the server' });

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const fail = async (status: number, message: string) => {
    await sb.from('work_order_scans').update({ status: 'failed', error: message }).eq('id', scanId);
    return res.status(status).json({ error: message });
  };


  const { data: scan, error } = await sb
    .from('work_order_scans')
    .select('id, file:files!wo_scans_file_fk(id, storage_path, mime_type, bucket)')
    .eq('id', scanId)
    .single();
  if (error || !scan) return res.status(404).json({ error: error?.message || 'Scan not found' });
  const file = (scan as unknown as { file: { storage_path: string; mime_type: string | null; bucket: string | null } }).file;

  if (!process.env.ANTHROPIC_API_KEY) {
    // No AI key yet: go straight to hand entry (one blank sheet per PDF page) instead of reporting a failure.
    let pages = 1;
    if ((file.mime_type || '').includes('pdf') || file.storage_path.endsWith('.pdf')) {
      const dl = await sb.storage.from(file.bucket || 'job-files').download(file.storage_path);
      if (dl.data) {
        const raw = Buffer.from(await dl.data.arrayBuffer()).toString('latin1');
        pages = Math.min(60, Math.max(1, (raw.match(/\/Type\s*\/Page(?![s\w])/g) || []).length));
      }
    }
    const sheets = Array.from({ length: pages }, (_, i) => ({ page: i + 1, lines: [], helpers: [] }));
    await sb.from('work_order_scans').update({ status: 'needs_review', extracted: { manual: true, sheets }, error: null }).eq('id', scanId);
    return res.status(200).json({ ok: true, manual: true, sheets: pages });
  }

  await sb.from('work_order_scans').update({ status: 'processing', error: null }).eq('id', scanId);

  try {
    const dl = await sb.storage.from(file.bucket || 'job-files').download(file.storage_path);
    if (dl.error || !dl.data) throw new Error(dl.error?.message || 'Could not download the scan');
    const bytes = Buffer.from(await dl.data.arrayBuffer());
    const mime = file.mime_type || (file.storage_path.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    const data = bytes.toString('base64');

    const block =
      mime === 'application/pdf'
        ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
        : { type: 'image' as const, source: { type: 'base64' as const, media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data } };

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
    });
    const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    const parsed = extractJson(text) as { sheets: Record<string, unknown>[] };
    const sheets = (parsed.sheets || []).filter((s) => s.form_type !== 'other');

    // Enrich each sheet with suggestions the reviewer can accept in one click.
    for (const s of sheets) {
      const q = [s.job_name, s.customer].filter(Boolean).join(' ');
      const jobs = q ? ((await sb.rpc('search_jobs', { p_q: q, p_limit: 5 })).data ?? []) : [];
      s.job_candidates = jobs;
      const ids = (jobs as { job_id: string }[]).map((j) => j.job_id);
      if (s.date && ids.length) {
        const { data: wos } = await sb
          .from('work_orders')
          .select('id, number, type_code, status, job_id')
          .eq('scheduled_date', s.date as string)
          .in('job_id', ids);
        s.work_order_candidates = wos ?? [];
      } else s.work_order_candidates = [];
      const names = [s.lead, ...((s.helpers as string[]) || [])].filter(Boolean) as string[];
      s.name_matches = await Promise.all(
        names.map(async (n, i) => ({
          raw: n,
          position: i === 0 ? 'lead' : 'helper',
          candidates: (await sb.rpc('match_employee', { p_raw: n.replace(/\?/g, ''), p_limit: 3 })).data ?? [],
        })),
      );
    }

    const confidence = sheets.length ? Math.min(...sheets.map((s) => Number(s.confidence ?? 0.5))) : 0;
    await sb
      .from('work_order_scans')
      .update({ status: 'needs_review', extracted: { sheets }, extraction_model: MODEL, confidence, error: null })
      .eq('id', scanId);
    return res.status(200).json({ ok: true, sheets: sheets.length });
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
}
