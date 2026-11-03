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
import { PDFDocument } from 'pdf-lib';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const FLAG_CODES = ['not_ready', 'partial', 'repair_needed', 'damage', 'wrong_hand', 'missing_parts', 'not_ordered', 'no_signature', 'photos_offline', 'other'];
const LINE_STATUSES = ['done', 'stockpiled', 'room_in', 'returned', 'not_ready', 'missing', 'damaged'];

const PROMPT = `You are reading scanned paper work orders from KT Sales & Service, the field crew for Fiber Care Baths (fiberglass tubs, showers and wall sets).
Forms are INSTALLATION, STOCKING (stocked vs stock-piled), or FINALS / REPAIR work orders, filled in by hand, often in Spanish crew shorthand.
Each page is usually one work order. Some pages may be schedules or blank — mark those form_type "other".

Record what you read by calling the record_sheets tool once, with one entry per page. Field guide:
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

const PAGES_PER_BATCH = 3;
const CONCURRENCY = 4;

const str = { type: ['string', 'null'] };
const SHEET_SCHEMA = {
  type: 'object',
  properties: {
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          form_type: { type: 'string', enum: ['installation', 'stocking', 'finals', 'other'] },
          date: str, customer: str, job_name: str, city: str, area: str,
          prevailing_wage_marked: { type: 'boolean' },
          time_in: str, time_out: str, lead: str,
          helpers: { type: 'array', items: { type: 'string' } },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                lot: str, room: str, product: str, hand: str, qty: { type: ['number', 'null'] },
                status: { type: 'string', enum: LINE_STATUSES }, uncertain: { type: 'boolean' },
              },
            },
          },
          notes_original: str, notes_english: str,
          flags: { type: 'array', items: { type: 'string', enum: FLAG_CODES } },
          flag_details: { type: 'object', additionalProperties: { type: 'string' } },
          superintendent_name: str, superintendent_signed: { type: 'boolean' },
          totals_written: str,
          uncertain_fields: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['page', 'form_type'],
      },
    },
  },
  required: ['sheets'],
};

type Block =
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; data: string } };

/** One Claude call. Forced tool use means the answer always comes back as structured JSON. */
async function readBlock(anthropic: Anthropic, block: Block, firstPage: number, pageCount: number) {
  const where =
    pageCount === 1
      ? `This is page ${firstPage} of the scan. Use page ${firstPage}.`
      : `These are pages ${firstPage}–${firstPage + pageCount - 1} of the scan. Number them ${firstPage} to ${firstPage + pageCount - 1}.`;
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 12000,
    tools: [{ name: 'record_sheets', description: 'Record the work order sheets read from the scan.', input_schema: SHEET_SCHEMA as Anthropic.Tool.InputSchema }],
    // Some models reject a forced tool_choice, so ask for the tool and fall back to JSON in the text.
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [block, { type: 'text', text: `${PROMPT}\n\n${where}\nCall record_sheets now — do not answer in text.` }] }],
  });
  const use = msg.content.find((c) => c.type === 'tool_use');
  let sheets = (use && (use.input as { sheets?: unknown }).sheets) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(sheets)) sheets = jsonSheets(msg.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
  if (msg.stop_reason === 'max_tokens' || !Array.isArray(sheets)) {
    const said = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('').slice(0, 160);
    throw new Error(`Reading pages ${firstPage}–${firstPage + pageCount - 1} stopped early (${msg.stop_reason})${said ? `: ${said}` : ''}`);
  }
  return sheets;
}

function jsonSheets(text: string): Record<string, unknown>[] | undefined {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v?.sheets) ? v.sheets : undefined;
  } catch { return undefined; }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function pdfSlice(src: PDFDocument, from: number, count: number) {
  const doc = await PDFDocument.create();
  const pages = await doc.copyPages(src, Array.from({ length: count }, (_, k) => from + k));
  pages.forEach((p) => doc.addPage(p));
  return Buffer.from(await doc.save()).toString('base64');
}

/** Splits a PDF into small batches, reads them in parallel, and retries a failed batch one page at a time. */
async function readScan(anthropic: Anthropic, bytes: Buffer, mime: string) {
  if (mime !== 'application/pdf') {
    const media = (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime) ? mime : 'image/jpeg') as 'image/jpeg';
    return readBlock(anthropic, { type: 'image', source: { type: 'base64', media_type: media, data: bytes.toString('base64') } }, 1, 1);
  }
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  const batches: { from: number; count: number }[] = [];
  for (let p = 0; p < total; p += PAGES_PER_BATCH) batches.push({ from: p, count: Math.min(PAGES_PER_BATCH, total - p) });
  const pdfBlock = (data: string): Block => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });

  const results = await pool(batches, CONCURRENCY, async (b) => {
    try {
      return await readBlock(anthropic, pdfBlock(await pdfSlice(src, b.from, b.count)), b.from + 1, b.count);
    } catch (e) {
      if (b.count === 1) throw e;
      const one: Record<string, unknown>[] = [];
      for (let k = 0; k < b.count; k++) {
        const page = b.from + k + 1;
        try {
          one.push(...(await readBlock(anthropic, pdfBlock(await pdfSlice(src, b.from + k, 1)), page, 1)));
        } catch (e2) {
          // Leave a blank sheet for this page so it can be entered by hand instead of failing the whole scan.
          one.push({ page, form_type: 'unknown', lines: [], helpers: [], uncertain_fields: ['whole page'], confidence: 0,
            read_error: e2 instanceof Error ? e2.message : String(e2) });
        }
      }
      return one;
    }
  });
  const sheets = results.flat();
  if (sheets.length && sheets.every((s) => s.read_error)) throw new Error(String(sheets[0].read_error));
  return sheets.sort((a, b) => Number(a.page ?? 0) - Number(b.page ?? 0));
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
    .select('id, status, extracted, file:files!wo_scans_file_fk(id, storage_path, mime_type, bucket, size_bytes)')
    .eq('id', scanId)
    .single();
  if (error || !scan) return res.status(404).json({ error: error?.message || 'Scan not found' });
  const s0 = scan as unknown as {
    status: string; extracted: { sheets?: { confirmed_work_order_id?: string }[] } | null;
    file: { storage_path: string; mime_type: string | null; bucket: string | null; size_bytes: number | null } | null;
  };
  const file = s0.file;
  if (!file) return res.status(404).json({ error: 'The scanned file is missing' });
  if (s0.status === 'confirmed' || s0.extracted?.sheets?.some((x) => x.confirmed_work_order_id)) {
    return res.status(409).json({ error: 'Some sheets in this scan are already confirmed, so it can’t be re-read.' });
  }
  if ((file.size_bytes ?? 0) > 40 * 1024 * 1024) return res.status(413).json({ error: 'Scan is over 40 MB — split it into smaller files.' });
  // Only people who can edit work orders may trigger reading (it spends API credit). RLS decides:
  const claim = await sb.from('work_order_scans').update({ error: null }).eq('id', scanId).select('id');
  if (claim.error || !claim.data?.length) return res.status(403).json({ error: 'You don’t have permission to process scans.' });

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
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const all = await readScan(anthropic, bytes, mime);
    const sheets = all.filter((s) => s.form_type !== 'other');

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
