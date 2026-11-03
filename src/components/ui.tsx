import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { WoStatus, WoType } from '@/lib/types';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'; size?: 'sm' | 'md' };
export function Button({ variant = 'secondary', size = 'md', className, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors',
        size === 'sm' ? 'min-h-9 px-3 text-[13px]' : 'min-h-11 px-4 text-sm',
        variant === 'primary' && 'bg-brand text-white hover:bg-brand-dark',
        variant === 'success' && 'bg-green-600 text-white hover:bg-green-700',
        variant === 'secondary' && 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50',
        variant === 'danger' && 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
        variant === 'ghost' && 'text-slate-700 hover:bg-slate-100',
        className,
      )}
    />
  );
}

export const TYPE_META: Record<WoType, { label: string; pill: string; tint: string }> = {
  IN: { label: 'Install', pill: 'bg-blue-100 text-blue-800', tint: 'bg-blue-100 text-blue-950' },
  ST: { label: 'Stock', pill: 'bg-green-100 text-green-800', tint: 'bg-green-100 text-green-950' },
  FN: { label: 'Finals', pill: 'bg-amber-100 text-amber-800', tint: 'bg-amber-100 text-amber-950' },
};

export function TypePill({ type }: { type: WoType }) {
  const m = TYPE_META[type] ?? TYPE_META.IN;
  return <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-bold', m.pill)}>{m.label}</span>;
}

export const STATUS_META: Record<WoStatus, { label: string; cls: string }> = {
  planned: { label: 'Planned', cls: 'text-blue-800' },
  started: { label: 'Started', cls: 'text-blue-800' },
  on_hold: { label: 'On hold', cls: 'text-amber-800' },
  complete: { label: 'Done', cls: 'text-green-800' },
  canceled: { label: 'Canceled', cls: 'text-slate-500' },
};

export function StatusText({ status }: { status: WoStatus }) {
  const m = STATUS_META[status];
  return <span className={cx('text-xs font-bold', m.cls)}>{m.label}</span>;
}

export function PwBadge({ solid }: { solid?: boolean }) {
  return (
    <span className={cx('rounded px-1.5 py-0.5 text-[11px] font-bold', solid ? 'bg-violet-800 text-white' : 'bg-violet-100 text-violet-800')}>
      PW
    </span>
  );
}

const FLAG_TONE: Record<string, string> = {
  '#dc2626': 'bg-red-100 text-red-800',
  '#d97706': 'bg-amber-100 text-amber-800',
  '#64748b': 'bg-slate-200 text-slate-700',
};
export function FlagChip({ label, color, resolved }: { label: string; color?: string; resolved?: boolean }) {
  return (
    <span className={cx('rounded px-2 py-0.5 text-xs font-semibold', resolved ? 'bg-slate-100 text-slate-500 line-through' : FLAG_TONE[(color ?? '').toLowerCase()] ?? 'bg-slate-200 text-slate-700')}>
      {label}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-[10px] border border-slate-300 bg-white', className)}>{children}</div>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs font-bold tracking-wider text-slate-600 uppercase">{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-600" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand" />
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-300 bg-white/60 p-6 text-center text-sm text-slate-600">{children}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-semibold text-slate-800">{label}</span>
      {children}
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls = 'min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20';

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className={cx('m-auto w-[calc(100%-32px)] rounded-xl p-0 shadow-2xl backdrop:bg-slate-900/40', wide ? 'max-w-3xl' : 'max-w-lg')}
    >
      {open && (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-slate-200 px-5 py-3">
            <h2 className="flex-1 text-lg font-bold">{title}</h2>
            <button aria-label="Close" onClick={onClose} className="h-10 w-10 rounded-md text-xl hover:bg-slate-100">×</button>
          </div>
          <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}
