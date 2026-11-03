import { cx } from './ui';

export interface DoneLine {
  lot_label: string | null;
  room: string | null;
  raw_product: string | null;
  hand: string | null;
  qty_planned: number;
  qty_done: number | null;
  status: string;
  sort_order: number;
}

const STATUS_TAG: Record<string, { label: string; cls: string }> = {
  stockpiled: { label: 'Stockpiled', cls: 'bg-slate-200 text-slate-800' },
  room_in: { label: 'Room-in', cls: 'bg-blue-100 text-blue-900' },
  returned: { label: 'Returned', cls: 'bg-amber-100 text-amber-900' },
  not_ready: { label: 'Not ready', cls: 'bg-amber-100 text-amber-900' },
  missing: { label: 'Missing', cls: 'bg-amber-100 text-amber-900' },
  skipped: { label: 'Skipped', cls: 'bg-slate-200 text-slate-800' },
  damaged: { label: 'Damaged', cls: 'bg-red-100 text-red-900' },
  pending: { label: 'Not done', cls: 'bg-slate-200 text-slate-800' },
};

/** Work done on a visit as a scannable list: one row per lot, items separated by dots. */
export default function WorkDoneList({ lines, max = 8 }: { lines: DoneLine[]; max?: number }) {
  if (!lines.length) return null;
  const byLot = new Map<string, DoneLine[]>();
  for (const l of [...lines].sort((a, b) => a.sort_order - b.sort_order)) {
    const k = l.lot_label?.trim() || '';
    byLot.set(k, [...(byLot.get(k) ?? []), l]);
  }
  const lots = [...byLot.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const items = lines.reduce((n, l) => n + (l.qty_done ?? l.qty_planned ?? 1), 0);
  const named = lots.filter(([k]) => k).length;

  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
        Work done · {items} item{items === 1 ? '' : 's'}{named ? ` · ${named} lot${named === 1 ? '' : 's'}` : ''}
      </div>
      <ul className="flex flex-col gap-0.5 text-sm">
        {lots.slice(0, max).map(([lot, ls]) => (
          <li key={lot || 'none'} className="flex gap-2">
            <span aria-hidden="true" className="text-slate-400">•</span>
            <span className="min-w-0">
              <b className="font-semibold">{lot ? `Lot ${lot}` : 'No lot'}</b>
              {ls.map((l, i) => {
                const tag = STATUS_TAG[l.status];
                const qty = l.qty_done ?? l.qty_planned;
                return (
                  <span key={i}>
                    <span className="text-slate-400"> · </span>
                    <span className="font-mono text-[13px]">{l.raw_product || 'item'}</span>
                    {l.hand && <span className="font-semibold"> {l.hand}</span>}
                    {l.room && <span className="text-slate-600"> ({l.room.replace(/^bath(\d)$/i, 'Bath $1').replace(/^master$/i, 'Master')})</span>}
                    {qty > 1 && <span className="text-slate-700"> ×{qty}</span>}
                    {tag && <span className={cx('ml-1 rounded px-1 py-px text-[11px] font-semibold', tag.cls)}>{tag.label}</span>}
                  </span>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
      {lots.length > max && <div className="pl-4 text-[13px] text-slate-600">+ {lots.length - max} more lots — open the work order to see all</div>}
    </div>
  );
}
