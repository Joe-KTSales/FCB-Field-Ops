import { addDays, format, parseISO, startOfWeek } from 'date-fns';

/** Local calendar date as YYYY-MM-DD (never UTC-shifted). */
export const iso = (d: Date) => format(d, 'yyyy-MM-dd');
export const todayIso = () => iso(new Date());
export const parse = (s: string) => parseISO(s);
export const shift = (s: string, days: number) => iso(addDays(parseISO(s), days));
export const mondayOf = (s: string) => iso(startOfWeek(parseISO(s), { weekStartsOn: 1 }));

export const longDate = (s: string) => format(parseISO(s), 'EEEE, MMMM d, yyyy');
export const shortDate = (s: string | null | undefined) => (s ? format(parseISO(s), 'M/d/yyyy') : '—');
export const mdy = (s: string) => format(parseISO(s), 'MM/dd/yyyy');
export const dayLabel = (s: string) => format(parseISO(s), 'EEE');
export const monthDay = (s: string) => format(parseISO(s), 'MMM d');

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shift(monday, i));
}

export function stamp(ts: string | null | undefined): string {
  if (!ts) return '';
  return format(parseISO(ts), 'M/d/yy h:mm a');
}

/** '13:30:00' -> '1:30p' */
export function clock(t: string | null | undefined): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'p' : 'a';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')}${suffix}`;
}
