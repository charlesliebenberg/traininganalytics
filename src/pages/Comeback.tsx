import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Mountain } from 'lucide-react';
import type { BuildSummary } from '../../shared/analytics/comeback';
import { qs, useApi } from '../lib/api';
import { Card, Empty, PageHeader, Spinner } from '../components/ui';
import { PeakCards, PinForm } from './comeback/Peaks';
import { Verdict } from './comeback/Verdict';
import { Story } from './comeback/Story';
import { Gap } from './comeback/Gap';
import { Year } from './comeback/Year';
import { BuildSection, RecipeTable } from './comeback/Build';
import { WayBack } from './comeback/WayBack';
import { PlanSection } from './comeback/Plan';
import { peakName, type HrCompareResponse, type Months, type Overview } from './comeback/types';

function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mt-0.5 text-xs text-muted">{sub}</p>
      {children}
    </section>
  );
}

const clampTph = (x: number) => Math.max(35, Math.min(90, x));

export function Comeback() {
  const { data, isLoading } = useApi<Overview>('/comeback/overview');
  const [selected, setSelected] = useState<string | null>(null);
  const [weeks, setWeeks] = useState(16);
  const [weeklyTss, setWeeklyTss] = useState<number | null>(null);
  const peaks = data?.peaks ?? [];
  // compare with the fittest peak by default: highest capacity, else FTP
  const best = useMemo(() => [...peaks].sort((a, b) => (b.capacity ?? b.ftp ?? 0) - (a.capacity ?? a.ftp ?? 0))[0], [peaks]);
  const peak = peaks.find((p) => p.date === selected) ?? best;
  const hr = useApi<HrCompareResponse>(peak ? `/comeback/hr-profile${qs({ date: peak.date })}` : null);
  const months = useApi<Months>(peak ? `/comeback/months${qs({ date: peak.date })}` : null);
  const build = useApi<BuildSummary>(peak ? `/comeback/build${qs({ date: peak.date, weeks })}` : null);
  useEffect(() => {
    if (data && weeklyTss == null) setWeeklyTss(Math.max(200, Math.round(data.now.weeklyTss / 10) * 10));
  }, [data, weeklyTss]);

  if (isLoading || !data) return <Spinner />;
  const load = weeklyTss ?? 500;
  const recentTph = data.now.weeklyHours > 0.5 ? clampTph(data.now.weeklyTss / data.now.weeklyHours) : 60;
  const buildTph = build.data && build.data.avgHours > 1 ? clampTph(build.data.avgTss / build.data.avgHours) : null;

  return (
    <div>
      <PageHeader title="Comeback" subtitle="How your best seasons were built, where you stand now, and what it takes to get back" />
      {!peaks.length || !peak ? (
        <Card>
          <Empty icon={<Mountain className="h-8 w-8" />} title="No peaks found yet">
            Peaks come from your weekly FTP estimates, which need rides with power. If your history is still syncing from Strava, check back once it finishes (Settings → Connections), or pin a date you know you were flying below.
          </Empty>
          <div className="flex justify-center pb-6">
            <PinForm />
          </div>
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="text-xs text-muted">Your peaks: the best sets of efforts at least 4 months apart, dated to when you rode them. Pick one to compare with.</div>
            <PinForm />
          </div>
          <PeakCards peaks={peaks} selected={peak.date} onSelect={setSelected} />
          <Verdict o={data} peak={peak} hr={hr.data} months={months.data} />
          <Story peaks={peaks} selected={peak.date} onSelect={setSelected} />

          <Section title="Where you are" sub={`Your power now against ${peakName(peak)}, duration by duration and heartbeat by heartbeat.`}>
            <Gap peak={peak} hr={hr.data} />
          </Section>

          <Section title={`How ${peakName(peak)} was built`} sub="The training behind the peak: the year, the final weeks, and what your peaks had in common.">
            <Year peak={peak} months={months.data} />
            <BuildSection peak={peak} weeks={weeks} setWeeks={setWeeks} />
            {peaks.length >= 2 && <RecipeTable peaks={peaks} weeks={weeks} />}
          </Section>

          <Section title="The way back" sub="How long a steady load takes to rebuild your capacity, and a plan to do it.">
            <WayBack o={data} peak={peak} months={months.data} weeklyTss={load} setWeeklyTss={setWeeklyTss} />
            <PlanSection peak={peak} weeklyTss={load} setWeeklyTss={setWeeklyTss} mix={build.data?.mix ?? null} buildTssPerHour={buildTph} recentTssPerHour={recentTph} />
          </Section>
        </>
      )}
    </div>
  );
}
