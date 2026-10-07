import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card } from '../../components/ui';
import { findings } from './findings';
import { peakName, type HrCompareResponse, type Months, type Overview, type PeakCard } from './types';

/** The page's lead: four findings with the evidence behind each, and what to change. */
export function Verdict({ o, peak, hr, months }: { o: Overview; peak: PeakCard; hr: HrCompareResponse | undefined; months: Months | undefined }) {
  const { items, advice } = findings(o, peak, hr, months);
  return (
    <Card className="mt-4" title="What your data says" subtitle={`Compared with ${peakName(peak)}. Pick another peak above to compare with it instead.`}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((f) => (
          <div key={f.key} className="flex flex-col rounded-xl bg-surface-2 p-4">
            <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
              {f.tone === 'good' && <CheckCircle2 className="h-3.5 w-3.5 text-good" aria-label="good" />}
              {f.tone === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-label="warning" />}
              {f.label}
            </div>
            <div className="mt-2 text-3xl font-semibold text-ink">{f.value}</div>
            <div className="mt-0.5 text-xs text-ink-2">{f.caption}</div>
            <p className="mt-3 text-xs leading-relaxed text-muted">{f.detail}</p>
          </div>
        ))}
      </div>
      {advice.length > 0 && (
        <div className="mt-4 rounded-xl border border-line p-4">
          <div className="mb-2 text-xs font-medium text-ink-2">What to change</div>
          <ol className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-ink">
            {advice.map((a, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="tnum mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{i + 1}</span>
                <span>{a}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}
