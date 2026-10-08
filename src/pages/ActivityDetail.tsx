import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ExternalLink, Pencil, Trash2, Check } from 'lucide-react';
import type { ActivityDetail as Detail, PlannedWorkout, Sport } from '../../shared/types';
import { http, useAction, useApi } from '../lib/api';
import { useTokens } from '../lib/theme';
import { Badge, Button, Card, Input, Segmented, Spinner, SportIcon, Stat, Empty, Select } from '../components/ui';
import { RouteMap, type RouteMapHandle } from '../components/RouteMap';
import { MiniProfile } from '../components/charts';
import { StreamsChart, buildChannels, isPaceSport, type ChannelKey } from './activity/StreamsChart';
import { ActivityCurveCard, BestEffortsCard, DecouplingCard, DistributionCard, QuadrantCard, SegmentsCard, SelectionStats, ZonesCard, findBest } from './activity/panels';
import { fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNum, fmtPace, fmtSpeed, fmtTemp, SPORT_LABEL, TSS_METHOD_LABEL } from '../lib/format';

type DetailResponse = Detail & { nav: { prev: number | null; next: number | null }; planned: PlannedWorkout | null };

const SMOOTH = [
  { value: 1, label: '1s' },
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
];

function Compliance({ planned, actual }: { planned: PlannedWorkout; actual: { duration: number; tss: number | null } }) {
  const ratio = planned.plannedTss && actual.tss ? actual.tss / planned.plannedTss : planned.plannedDuration ? actual.duration / planned.plannedDuration : null;
  const color = ratio == null ? 'var(--muted)' : ratio >= 0.8 && ratio <= 1.2 ? 'var(--good)' : ratio >= 0.5 && ratio <= 1.5 ? 'var(--warning)' : 'var(--critical)';
  const label = ratio == null ? '' : ratio >= 0.8 && ratio <= 1.2 ? 'On plan' : ratio < 0.8 ? 'Under plan' : 'Over plan';
  return (
    <div className="card flex flex-wrap items-center gap-5 px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
        <span className="text-[13px] font-medium">Planned: {planned.title}</span>
        {label && <Badge>{label}</Badge>}
      </div>
      <div className="flex gap-5 text-xs text-ink-2">
        <span>
          Duration {fmtDuration(actual.duration, { short: true })} / {fmtDuration(planned.plannedDuration, { short: true })}
        </span>
        <span>
          TSS {fmtNum(actual.tss)} / {fmtNum(planned.plannedTss)}
        </span>
        {ratio != null && <span className="tnum font-medium text-ink">{Math.round(ratio * 100)}% compliance</span>}
      </div>
      {planned.structure && (
        <div className="ml-auto w-48">
          <MiniProfile structure={planned.structure} height={24} />
        </div>
      )}
    </div>
  );
}

export function ActivityDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const t = useTokens();
  const { data: a, isLoading, error } = useApi<DetailResponse>(`/activities/${id}`);
  const prefs = useApi<{ crankLength: number }>('/preferences');
  const mapRef = useRef<RouteMapHandle>(null);
  const [xMode, setXMode] = useState<'time' | 'distance'>('time');
  const [smooth, setSmooth] = useState(5);
  const [hidden, setHidden] = useState<Set<ChannelKey>>(new Set(['temp']));
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [hoverRange, setHoverRange] = useState<[number, number] | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  const update = useAction((b: Record<string, unknown>) => http(`/activities/${id}`, { method: 'PATCH', json: b }));
  const del = useAction(() => http(`/activities/${id}`, { method: 'DELETE' }), { onSuccess: () => nav('/activities') });

  const allChannels = useMemo(() => (a?.streams ? buildChannels(a.streams, a.sport, a.thresholds, t, smooth) : []), [a, t, smooth]);
  const channels = useMemo(() => allChannels.filter((c) => !hidden.has(c.key)), [allChannels, hidden]);
  const highlight = hoverRange ?? selection;

  if (isLoading) return <Spinner />;
  if (error || !a) return <Empty title="Activity not found" />;

  const th = a.thresholds;
  const pace = isPaceSport(a.sport);
  const s = a.streams;
  const hasGps = !!(s?.lat && s.lat.some((v) => v != null));
  const wkg = a.avgPower ? a.avgPower / th.weight : null;
  const pick = (r: [number, number]) => {
    setSelection(r);
    setZoom(null);
  };

  const metrics: { label: string; value: React.ReactNode; unit?: string; sub?: React.ReactNode; accent?: string; title?: string }[] = [
    { label: 'Moving time', value: fmtDuration(a.movingTime), sub: `Elapsed ${fmtDuration(a.elapsedTime)}` },
    ...(a.distance ? [{ label: 'Distance', value: fmtDistance(a.distance, a.sport === 'swim' ? 0 : 2, a.sport) }] : []),
    ...(a.elevationGain ? [{ label: 'Elevation', value: fmtElevation(a.elevationGain) }] : []),
    { label: TSS_METHOD_LABEL[a.tssMethod] ?? 'TSS', value: fmtNum(a.tss), sub: a.intensity ? `IF ${a.intensity.toFixed(2)}` : undefined, title: 'Training Stress Score' },
    ...(a.np ? [{ label: 'Normalized power', value: a.np, unit: 'W', accent: t.power, sub: `VI ${fmtNum(a.vi, 2)}` }] : []),
    ...(a.avgPower ? [{ label: 'Avg power', value: a.avgPower, unit: 'W', accent: t.power, sub: `${fmtNum(wkg, 2)} W/kg · max ${a.maxPower}` }] : []),
    ...(a.work ? [{ label: 'Work', value: fmtNum(a.work), unit: 'kJ', sub: `${fmtNum(a.calories)} kcal` }] : []),
    ...(a.avgHr ? [{ label: 'Heart rate', value: a.avgHr, unit: 'bpm', accent: t.hr, sub: `max ${a.maxHr}` }] : []),
    ...(a.avgSpeed ? [{ label: pace ? 'Avg pace' : 'Avg speed', value: pace ? fmtPace(a.avgSpeed, a.sport, false) : fmtSpeed(a.avgSpeed), accent: t.speed, sub: pace ? undefined : `max ${fmtSpeed(a.maxSpeed)}` }] : []),
    ...(a.avgCadence ? [{ label: 'Cadence', value: a.sport === 'run' ? a.avgCadence * 2 : a.avgCadence, unit: a.sport === 'run' ? 'spm' : 'rpm', accent: t.cadence }] : []),
    ...(a.ef ? [{ label: 'Efficiency factor', value: a.ef.toFixed(2), title: 'NP (or NGP) per heartbeat' }] : []),
    ...(a.decoupling != null ? [{ label: 'Decoupling', value: `${a.decoupling.toFixed(1)}%` }] : []),
    ...(a.wbalMin != null ? [{ label: "W′ bal min", value: (a.wbalMin / 1000).toFixed(1), unit: 'kJ', accent: t.wbal, sub: `${Math.max(0, Math.round((1 - a.wbalMin / th.wPrime) * 100))}% of W′ used` }] : []),
    ...(a.trimp ? [{ label: 'TRIMP', value: fmtNum(a.trimp) }] : []),
    ...(a.avgTemp != null ? [{ label: 'Temperature', value: fmtTemp(a.avgTemp) }] : []),
  ];

  return (
    <div>
      {/* header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted">
            <Link to="/activities" className="hover:text-ink">
              Activities
            </Link>
            <span>/</span>
            <span>{fmtDate(a.startTime, 'EEEE d MMMM yyyy · HH:mm')}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <SportIcon sport={a.sport} className="h-6 w-6" />
            {editing ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  update.mutate({ name });
                  setEditing(false);
                }}
              >
                <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="w-80" />
                <Button type="submit" variant="primary" icon={<Check className="h-4 w-4" />} />
              </form>
            ) : (
              <h1 className="truncate text-[22px] font-semibold tracking-tight">{a.name}</h1>
            )}
            {!editing && (
              <button
                onClick={() => {
                  setName(a.name);
                  setEditing(true);
                }}
                className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink"
                aria-label="Rename"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge>{SPORT_LABEL[a.sport]}</Badge>
            {a.trainer && <Badge>Indoor</Badge>}
            <Badge>{a.source === 'strava' ? 'Strava' : a.source === 'demo' ? 'Demo' : 'File'}</Badge>
            {a.device && <Badge>{a.device}</Badge>}
            {a.sport === 'ride' && a.ftpUsed && <Badge>FTP {a.ftpUsed} W</Badge>}
            {a.sport === 'run' && th.runThresholdSpeed > 0 && <Badge>Threshold {fmtPace(th.runThresholdSpeed, 'run')}</Badge>}
            {a.sport === 'swim' && th.swimCss > 0 && <Badge>CSS {fmtPace(th.swimCss, 'swim')}</Badge>}
            {!a.detailed && <Badge color={t.warning}>Summary only — streams pending</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={a.rpe ?? ''} onChange={(e) => update.mutate({ rpe: e.target.value ? Number(e.target.value) : null })} title="Rate of perceived exertion">
            <option value="">RPE –</option>
            {Array.from({ length: 10 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                RPE {i + 1}
              </option>
            ))}
          </Select>
          <Select value={a.sport} onChange={(e) => update.mutate({ sport: e.target.value as Sport })} title="Change sport (recalculates)">
            {Object.entries(SPORT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          {a.source === 'strava' && a.externalId && (
            <a href={`https://www.strava.com/activities/${a.externalId}`} target="_blank" rel="noreferrer">
              <Button icon={<ExternalLink className="h-4 w-4" />}>Strava</Button>
            </a>
          )}
          <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => confirm('Delete this activity?') && del.mutate(undefined)} />
          <div className="flex">
            <Button variant="ghost" disabled={!a.nav.prev} onClick={() => nav(`/activities/${a.nav.prev}`)} icon={<ChevronLeft className="h-4 w-4" />} title="Previous" />
            <Button variant="ghost" disabled={!a.nav.next} onClick={() => nav(`/activities/${a.nav.next}`)} icon={<ChevronRight className="h-4 w-4" />} title="Next" />
          </div>
        </div>
      </div>

      {/* key metrics */}
      <div className="card grid grid-cols-2 gap-x-6 gap-y-4 p-5 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
        {metrics.map((m) => (
          <Stat key={m.label} {...m} />
        ))}
      </div>

      {a.planned && (
        <div className="mt-4">
          <Compliance planned={a.planned} actual={{ duration: a.movingTime, tss: a.tss }} />
        </div>
      )}

      {a.description && <p className="mt-4 text-[13px] whitespace-pre-line text-ink-2">{a.description}</p>}

      {!s ? (
        <Card className="mt-4">
          <Empty title="No stream data">This activity only has summary data{a.source === 'strava' ? ' — detailed streams will appear once the sync queue reaches it' : ''}.</Empty>
        </Card>
      ) : (
        <>
          <div className={`mt-4 grid gap-4 ${hasGps ? 'xl:grid-cols-[minmax(0,1fr)_420px]' : ''}`}>
            <Card
              pad={false}
              title="Data streams"
              subtitle="Drag across the chart to analyse a range · scroll to zoom"
              actions={
                <>
                  <div className="hidden flex-wrap gap-1 md:flex">
                    {allChannels.map((c) => (
                      <button
                        key={c.key}
                        onClick={() => {
                          const n = new Set(hidden);
                          n.has(c.key) ? n.delete(c.key) : n.add(c.key);
                          setHidden(n);
                        }}
                        className="flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[11px]"
                        style={{ opacity: hidden.has(c.key) ? 0.45 : 1 }}
                      >
                        <span className="h-2 w-2 rounded-sm" style={{ background: c.color }} />
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <Segmented size="sm" value={smooth} onChange={setSmooth} options={SMOOTH} />
                  {s.distance && <Segmented size="sm" value={xMode} onChange={setXMode} options={[{ value: 'time', label: 'Time' }, { value: 'distance', label: 'Distance' }]} />}
                </>
              }
            >
              <div className="px-2 pt-2 pb-3">
                <StreamsChart streams={s} channels={channels} xMode={xMode} highlight={highlight} zoom={zoom} onHover={(i) => mapRef.current?.setHover(i)} onSelect={(r) => setSelection(r)} />
              </div>
            </Card>
            {hasGps && (
              <div className="flex flex-col gap-4">
                <div className="card overflow-hidden p-1.5">
                  <RouteMap ref={mapRef} lat={s.lat!} lng={s.lng!} highlight={highlight} height={selection ? 300 : 420} color={`var(--sport-${a.sport})`} />
                </div>
                {selection && <SelectionStats streams={s} range={selection} sport={a.sport} th={th} onClear={() => setSelection(null)} onZoom={() => setZoom(selection)} />}
              </div>
            )}
          </div>
          {!hasGps && selection && (
            <div className="mt-4">
              <SelectionStats streams={s} range={selection} sport={a.sport} th={th} onClear={() => setSelection(null)} onZoom={() => setZoom(selection)} />
            </div>
          )}

          <div className="mt-4">
            <SegmentsCard streams={s} laps={a.laps} sport={a.sport} th={th} onHover={setHoverRange} onPick={pick} active={selection} />
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {a.curves && (
              <ActivityCurveCard
                curves={a.curves}
                date={a.localDate}
                th={th}
                sport={a.sport}
                onPick={(d) => {
                  const r = findBest(s, s.watts ? 'watts' : s.speed && pace ? 'speed' : 'heartrate', d);
                  if (r) pick(r);
                }}
              />
            )}
            {a.zones && <ZonesCard zones={a.zones} th={th} sport={a.sport} />}
            {a.bestEfforts && <BestEffortsCard efforts={a.bestEfforts} />}
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            {/* bike power: zones and pedalling forces are on the bike's FTP scale */}
            {a.sport === 'ride' && s.watts && a.hasPower && <DistributionCard streams={s} th={th} />}
            {a.sport === 'ride' && s.watts && a.hasPower && s.cadence && <QuadrantCard streams={s} th={th} crank={prefs.data?.crankLength ?? 172.5} />}
            {a.hasHr && ((a.sport === 'ride' && a.hasPower) || a.sport === 'run' || a.sport === 'walk' || a.sport === 'hike') && a.movingTime > 1200 && <DecouplingCard streams={s} sport={a.sport} decoupling={a.decoupling} />}
          </div>
          {a.tss != null && (a.tssMethod === 'power' || a.tssMethod === 'pace') && a.intensity != null && (
            <p className="mt-4 text-xs text-muted">
              {a.tssMethod === 'power'
                ? `TSS ${fmtNum(a.tss)} = ${fmtDuration(a.movingTime)} moving × IF² (${fmtNum(a.intensity, 3)}) × 100 at FTP ${th.ftp} W`
                : `rTSS ${fmtNum(a.tss)} = ${fmtDuration(a.movingTime)} moving × IF² (${fmtNum(a.intensity, 3)}) × 100, where IF = normalized grade-adjusted pace ÷ threshold pace ${fmtPace(th.runThresholdSpeed, 'run')}`}
              {a.elapsedTime - a.movingTime >= 300 ? ` · stops of 20 s or more (${fmtDuration(a.elapsedTime - a.movingTime)} in all) don't count` : ''}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
