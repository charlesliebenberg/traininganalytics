import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Flag } from 'lucide-react';
import { useApi } from '../lib/api';
import { useTokens } from '../lib/theme';
import { useInspectLink } from '../lib/inspect';
import { fmtDate } from '../lib/format';
import { formColor, fmtForm } from '../lib/form';
import { Menu } from './ui';

export interface Now {
  today: string;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  ramp: number | null;
  form: { id: string; label: string; hint: string } | null;
  ftp: number | null;
  weight: number | null;
  race: { id: number; name: string; date: string; priority: string; days: number } | null;
}

export const useNow = () => useApi<Now>('/now', { staleTime: 60_000, refetchInterval: 5 * 60_000 });

const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

/**
 * Where you stand, on every page: form (with its zone's colour), fitness, and the race ahead.
 * Opens to the numbers behind it.
 */
export function StatusCapsule({ compact = false }: { compact?: boolean }) {
  const t = useTokens();
  const { data: n } = useNow();
  const inspectLink = useInspectLink();
  if (!n || n.tsb == null || n.ctl == null || !n.form) return null;
  const color = formColor(t, n.form.id);
  return (
    <Menu
      label="Where you stand"
      button={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          title={`Form ${fmtForm(n.tsb!)} · ${n.form!.label}`}
          className={clsx('flex h-9 items-center gap-2 rounded-full border border-line bg-surface pr-3 pl-2.5 text-[12.5px] text-ink-2 shadow-sm transition-colors hover:border-line-strong hover:text-ink', open && 'border-line-strong text-ink')}
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
            <span className="absolute inset-0 rounded-full opacity-30" style={{ background: color, transform: 'scale(1.8)' }} />
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
          </span>
          <span className="tnum font-semibold text-ink">{fmtForm(n.tsb!)}</span>
          {!compact && (
            <>
              <span className="hidden text-muted xl:inline">{n.form!.label}</span>
              <span className="hidden h-3.5 w-px bg-line md:block" />
              <span className="tnum hidden md:inline">
                <span className="text-muted">Fitness</span> {Math.round(n.ctl!)}
              </span>
              {n.race && (
                <>
                  <span className="hidden h-3.5 w-px bg-line lg:block" />
                  <span className="hidden max-w-36 items-center gap-1 truncate lg:inline-flex">
                    <Flag className="h-3 w-3 shrink-0 text-muted" />
                    <span className="truncate">{n.race.name}</span>
                    <span className="tnum text-muted">{n.race.days}d</span>
                  </span>
                </>
              )}
            </>
          )}
        </button>
      )}
      className="w-[300px] !p-0"
    >
      <div className="p-4">
        <div className="eyebrow">Form today</div>
        <div className="mt-1.5 flex items-baseline gap-2">
          <span className="figure text-[34px]">{fmtForm(n.tsb)}</span>
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <span className="h-2 w-2 rounded-full" style={{ background: color }} />
            {n.form.label}
          </span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-5 text-muted">{n.form.hint}</p>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
          <Num label="Fitness" value={Math.round(n.ctl).toString()} color={t.ctl} sub={n.ramp != null ? `${signed(n.ramp)} this week` : undefined} />
          <Num label="Fatigue" value={n.atl != null ? Math.round(n.atl).toString() : '–'} color={t.atl} />
          <Num label="FTP" value={n.ftp ? `${n.ftp}` : '–'} color={t.power} sub={n.ftp && n.weight ? `${(n.ftp / n.weight).toFixed(2)} W/kg` : undefined} />
        </div>
      </div>
      {n.race && (
        <Link {...inspectLink('e', n.race.id)} className="flex items-center gap-3 border-t border-line px-4 py-3 hover:bg-surface-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-[12px] font-bold">{n.race.priority}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink">{n.race.name}</span>
            <span className="block text-[12px] text-muted">
              {fmtDate(n.race.date, 'EEE d MMM')} · in {n.race.days} days
            </span>
          </span>
        </Link>
      )}
      <div className="flex gap-1 border-t border-line p-1.5">
        <Link to="/season" className="flex-1 rounded-[10px] px-2.5 py-2 text-center text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
          Season
        </Link>
        <Link to="/performance" className="flex-1 rounded-[10px] px-2.5 py-2 text-center text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
          Performance
        </Link>
      </div>
    </Menu>
  );
}

function Num({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        {label}
      </div>
      <div className="figure mt-1 text-[18px]">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
