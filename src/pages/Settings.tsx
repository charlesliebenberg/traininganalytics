import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, RefreshCw, Unplug, Webhook, Trash2, Sparkles, Calculator } from 'lucide-react';
import type { Preferences, Thresholds } from '../../shared/types';
import { HR_ZONES, PACE_ZONES, POWER_ZONES, zoneBounds } from '../../shared/analytics/zones';
import { http, useAction, useApi } from '../lib/api';
import { fmtDate, fmtPaceSec, iso } from '../lib/format';
import { Badge, Button, Card, Field, Input, PageHeader, Segmented, Select, Tabs } from '../components/ui';
import { ImportDropzone } from '../components/Import';
import { useStatus } from '../components/Layout';

type Tab = 'connections' | 'athlete' | 'import' | 'preferences' | 'data';

const paceToText = (speed: number, per: number) => fmtPaceSec(per / speed);
const textToSpeed = (txt: string, per: number) => {
  const [m, s] = txt.split(':').map(Number);
  const secs = (m || 0) * 60 + (s || 0);
  return secs > 0 ? per / secs : null;
};

function ConnectionCard({ provider }: { provider: 'strava' | 'trainingpeaks' }) {
  const { data: status } = useStatus();
  const c = status?.connections.find((x) => x.provider === provider);
  const sync = useAction(() => http('/sync', { method: 'POST' }));
  const disconnect = useAction(() => http(`/auth/${provider}/disconnect`, { method: 'POST' }));
  const webhook = useAction(() => http('/webhooks/strava/subscribe', { method: 'POST' }));
  const name = provider === 'strava' ? 'Strava' : 'TrainingPeaks';
  const brand = provider === 'strava' ? '#fc4c02' : '#1b6ec2';
  if (!c) return null;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md text-[11px] font-bold text-white" style={{ background: brand }}>
            {name[0]}
          </span>
          {name}
        </span>
      }
      actions={c.connected ? <Badge color="var(--good)">Connected</Badge> : c.configured ? <Badge>Not connected</Badge> : <Badge color="var(--warning)">Not configured</Badge>}
    >
      {c.connected ? (
        <>
          <div className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <div className="text-[11px] text-muted uppercase">Athlete</div>
              {c.athleteName ?? '–'}
            </div>
            <div>
              <div className="text-[11px] text-muted uppercase">Last sync</div>
              {c.lastSyncAt ? fmtDate(c.lastSyncAt, 'd MMM HH:mm') : 'pending'}
            </div>
            <div>
              <div className="text-[11px] text-muted uppercase">Queue</div>
              {c.pending} jobs
            </div>
            {provider === 'strava' && (
              <div>
                <div className="text-[11px] text-muted uppercase">Webhook</div>
                {c.webhook ? 'Active — instant sync' : 'Polling only'}
              </div>
            )}
          </div>
          {c.lastError && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 p-2.5 text-xs">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
              {c.lastError}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={sync.isPending} onClick={() => sync.mutate(undefined)}>
              Sync now
            </Button>
            {provider === 'strava' && !c.webhook && (
              <Button size="sm" icon={<Webhook className="h-3.5 w-3.5" />} loading={webhook.isPending} onClick={() => webhook.mutate(undefined)} title="Requires PUBLIC_URL reachable from the internet">
                Enable webhook
              </Button>
            )}
            <Button size="sm" variant="danger" icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => confirm(`Disconnect ${name}? Synced activities are kept.`) && disconnect.mutate(undefined)}>
              Disconnect
            </Button>
          </div>
          {webhook.error && <p className="mt-2 text-xs text-critical">{(webhook.error as Error).message}</p>}
        </>
      ) : c.configured ? (
        <>
          <p className="mb-3 text-xs text-ink-2">
            {provider === 'strava'
              ? 'Authorise read access to your activities. History is backfilled newest-first within Strava’s rate limits (≈200 activities/hour), then new activities sync automatically.'
              : 'Syncs completed workouts (with device files) and planned workouts from your TrainingPeaks calendar.'}
          </p>
          <a href={`/api/auth/${provider}/start`}>
            <Button variant="primary" style={{ background: brand }}>
              Connect {name}
            </Button>
          </a>
        </>
      ) : provider === 'strava' ? (
        <ol className="list-decimal space-y-1 pl-4 text-xs text-ink-2">
          <li>
            Create an API application at <b>strava.com/settings/api</b>.
          </li>
          <li>
            Set the Authorization Callback Domain to the host of <code className="rounded bg-surface-3 px-1">{status?.publicUrl}</code>.
          </li>
          <li>
            Put <code className="rounded bg-surface-3 px-1">STRAVA_CLIENT_ID</code> and <code className="rounded bg-surface-3 px-1">STRAVA_CLIENT_SECRET</code> in <code className="rounded bg-surface-3 px-1">.env</code> and restart.
          </li>
          <li>For instant sync, expose the app publicly (e.g. a tunnel) and enable the webhook after connecting.</li>
        </ol>
      ) : (
        <div className="space-y-2 text-xs text-ink-2">
          <p>
            TrainingPeaks’ API is limited to approved partners. If you have credentials, set <code className="rounded bg-surface-3 px-1">TRAININGPEAKS_CLIENT_ID</code> / <code className="rounded bg-surface-3 px-1">TRAININGPEAKS_CLIENT_SECRET</code> in <code className="rounded bg-surface-3 px-1">.env</code>.
          </p>
          <p>
            Otherwise: in TrainingPeaks open <b>Settings → Export Data → Export Workout Files</b>, then drop the ZIP on the Import tab — identical analysis, including TSS/IF recalculated with your thresholds.
          </p>
        </div>
      )}
    </Card>
  );
}

function SyncLog() {
  const { data } = useApi<{ id: number; at: string; provider: string | null; level: string; message: string }[]>('/sync/log', { refetchInterval: 10000 });
  return (
    <Card title="Sync log" pad={false}>
      <div className="max-h-72 overflow-y-auto px-5 pb-4 font-mono text-[11px]">
        {!data?.length && <p className="py-4 text-muted">Nothing yet.</p>}
        {data?.map((l) => (
          <div key={l.id} className="flex gap-3 border-b border-line/60 py-1 last:border-0">
            <span className="shrink-0 text-muted">{l.at.slice(5, 16)}</span>
            <span className={l.level === 'error' ? 'text-critical' : l.level === 'warn' ? 'text-warning' : 'text-ink-2'}>
              {l.provider ? `[${l.provider}] ` : ''}
              {l.message}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function AthleteTab() {
  const { data } = useApi<{ history: Thresholds[]; current: Thresholds; defaults: Thresholds }>('/thresholds');
  const [form, setForm] = useState<Thresholds | null>(null);
  const [runPace, setRunPace] = useState('');
  const [css, setCss] = useState('');
  useEffect(() => {
    if (data && !form) {
      setForm({ ...data.current, date: iso(new Date()) });
      setRunPace(paceToText(data.current.runThresholdSpeed, 1000));
      setCss(paceToText(data.current.swimCss, 100));
    }
  }, [data, form]);
  const save = useAction(() => http('/thresholds', { method: 'PUT', json: { ...form, runThresholdSpeed: textToSpeed(runPace, 1000) ?? form!.runThresholdSpeed, swimCss: textToSpeed(css, 100) ?? form!.swimCss } }));
  const del = useAction((date: string) => http(`/thresholds/${date}`, { method: 'DELETE' }));
  const recalc = useAction(() => http('/recalculate', { method: 'POST', json: {} }));
  if (!form || !data) return null;
  const num = (k: keyof Thresholds) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) });
  const cur = data.current;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Thresholds" subtitle="Entries apply from their date onwards, so historical TSS stays correct as you get fitter">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Effective from">
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="FTP (W)">
            <Input type="number" value={form.ftp} onChange={num('ftp')} />
          </Field>
          <Field label="W′ (J)" hint="anaerobic capacity">
            <Input type="number" value={form.wPrime} onChange={num('wPrime')} />
          </Field>
          <Field label="Weight (kg)">
            <Input type="number" step={0.1} value={form.weight} onChange={num('weight')} />
          </Field>
          <Field label="LTHR bike (bpm)">
            <Input type="number" value={form.lthr} onChange={num('lthr')} />
          </Field>
          <Field label="LTHR run (bpm)">
            <Input type="number" value={form.runLthr} onChange={num('runLthr')} />
          </Field>
          <Field label="Max HR">
            <Input type="number" value={form.maxHr} onChange={num('maxHr')} />
          </Field>
          <Field label="Resting HR">
            <Input type="number" value={form.restHr} onChange={num('restHr')} />
          </Field>
          <Field label="Run threshold pace" hint="min:sec per km">
            <Input value={runPace} onChange={(e) => setRunPace(e.target.value)} />
          </Field>
          <Field label="Swim CSS" hint="min:sec per 100 m">
            <Input value={css} onChange={(e) => setCss(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save thresholds
          </Button>
          <Button icon={<Calculator className="h-4 w-4" />} loading={recalc.isPending} onClick={() => recalc.mutate(undefined)} title="Recompute TSS, zones and curves for every activity">
            Recalculate all activities
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted">After changing thresholds, recalculate so TSS, IF and zones reflect the new values.</p>
        {data.history.length > 0 && (
          <table className="tnum mt-5 w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-[11px] text-muted uppercase">
                <th className="py-1.5 font-medium">From</th>
                <th className="font-medium">FTP</th>
                <th className="font-medium">LTHR</th>
                <th className="font-medium">Run pace</th>
                <th className="font-medium">Weight</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...data.history].reverse().map((h) => (
                <tr key={h.date} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5">{fmtDate(h.date, 'd MMM yyyy')}</td>
                  <td>{h.ftp} W</td>
                  <td>{h.lthr}</td>
                  <td>{paceToText(h.runThresholdSpeed, 1000)}/km</td>
                  <td>{h.weight} kg</td>
                  <td className="text-right">
                    <button onClick={() => del.mutate(h.date)} className="rounded p-1 text-muted hover:text-critical" aria-label="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Current zones">
        <div className="grid gap-5 sm:grid-cols-2">
          <ZoneTable title={`Power · FTP ${cur.ftp} W`} rows={zoneBounds(cur.ftp, POWER_ZONES).map((z) => [z.id, z.name, `${Math.round(z.low)}–${Number.isFinite(z.high) ? Math.round(z.high) : '∞'} W`])} />
          <ZoneTable title={`Heart rate · LTHR ${cur.lthr}`} rows={zoneBounds(cur.lthr, HR_ZONES).map((z) => [z.id, z.name, `${Math.round(z.low)}–${Number.isFinite(z.high) ? Math.round(z.high) : '∞'}`])} />
          <ZoneTable
            title={`Run pace · ${paceToText(cur.runThresholdSpeed, 1000)}/km`}
            rows={zoneBounds(cur.runThresholdSpeed, PACE_ZONES).map((z) => [z.id, z.name, !z.low ? `slower than ${paceToText(z.high, 1000)}` : Number.isFinite(z.high) ? `${paceToText(z.low, 1000)} – ${paceToText(z.high, 1000)}` : `faster than ${paceToText(z.low, 1000)}`])}
          />
        </div>
      </Card>
    </div>
  );
}

function ZoneTable({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-ink-2">{title}</div>
      <table className="tnum w-full text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]} className="border-b border-line/60 last:border-0">
              <td className="py-1 pr-2 font-medium">{r[0]}</td>
              <td className="pr-2 text-ink-2">{r[1]}</td>
              <td className="text-right">{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreferencesTab() {
  const { data } = useApi<Preferences>('/preferences');
  const save = useAction((p: Partial<Preferences>) => http('/preferences', { method: 'PUT', json: p }));
  if (!data) return null;
  return (
    <Card title="Preferences" className="max-w-2xl">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Name">
          <Input defaultValue={data.athleteName} onBlur={(e) => save.mutate({ athleteName: e.target.value })} />
        </Field>
        <Field label="Units">
          <Segmented value={data.units} onChange={(units) => save.mutate({ units })} options={[{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }]} />
        </Field>
        <Field label="Fitness (CTL) time constant" hint="days — 42 is the TrainingPeaks default">
          <Input type="number" defaultValue={data.ctlDays} onBlur={(e) => save.mutate({ ctlDays: Number(e.target.value) })} />
        </Field>
        <Field label="Fatigue (ATL) time constant" hint="days — 7 is standard">
          <Input type="number" defaultValue={data.atlDays} onBlur={(e) => save.mutate({ atlDays: Number(e.target.value) })} />
        </Field>
        <Field label="Week starts on">
          <Select value={data.weekStart} onChange={(e) => save.mutate({ weekStart: Number(e.target.value) as 0 | 1 })}>
            <option value={1}>Monday</option>
            <option value={0}>Sunday</option>
          </Select>
        </Field>
        <Field label="Crank length (mm)" hint="used for quadrant analysis">
          <Input type="number" step={0.5} defaultValue={data.crankLength} onBlur={(e) => save.mutate({ crankLength: Number(e.target.value) })} />
        </Field>
      </div>
    </Card>
  );
}

function DataTab() {
  const { data: status } = useStatus();
  const load = useAction(() => http('/demo', { method: 'POST' }));
  const clear = useAction(() => http('/demo', { method: 'DELETE' }));
  const recalc = useAction(() => http('/recalculate', { method: 'POST', json: {} }));
  return (
    <div className="grid max-w-4xl gap-4 md:grid-cols-2">
      <Card title="Demo athlete" subtitle="18 months of simulated training for exploring the app">
        <div className="flex flex-wrap gap-2">
          <Button icon={<Sparkles className="h-4 w-4" />} loading={load.isPending || status?.job?.kind === 'demo'} onClick={() => load.mutate(undefined)}>
            {status?.demo ? 'Regenerate demo data' : 'Load demo data'}
          </Button>
          {status?.demo && (
            <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} loading={clear.isPending} onClick={() => confirm('Remove all demo activities, plans and events?') && clear.mutate(undefined)}>
              Remove demo data
            </Button>
          )}
        </div>
        {status?.job && <p className="mt-2 text-xs text-muted">{status.job.message}</p>}
      </Card>
      <Card title="Recalculate" subtitle="Recompute every metric, curve and zone with current thresholds">
        <Button icon={<Calculator className="h-4 w-4" />} loading={recalc.isPending || status?.job?.kind === 'recalculate'} onClick={() => recalc.mutate(undefined)}>
          Recalculate {status?.activityCount} activities
        </Button>
        {status?.job?.kind === 'recalculate' && <p className="mt-2 text-xs text-muted">{status.job.message}</p>}
      </Card>
    </div>
  );
}

export function Settings() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'connections');
  const connected = params.get('connected');
  const error = params.get('error');
  return (
    <div>
      <PageHeader title="Settings & Sync" subtitle="Data sources, athlete thresholds and preferences" />
      {(connected || error) && (
        <div className={`card mb-4 flex items-center gap-2 px-4 py-3 text-[13px] ${error ? 'text-critical' : ''}`}>
          {error ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-good" />}
          {error ? `Connection failed: ${error}` : `Connected to ${connected === 'strava' ? 'Strava' : 'TrainingPeaks'} — your history is syncing in the background.`}
          <button className="ml-auto text-xs text-muted hover:text-ink" onClick={() => setParams({})}>
            Dismiss
          </button>
        </div>
      )}
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'connections', label: 'Connections' },
            { value: 'athlete', label: 'Athlete & zones' },
            { value: 'import', label: 'Import files' },
            { value: 'preferences', label: 'Preferences' },
            { value: 'data', label: 'Data' },
          ]}
        />
      </div>
      {tab === 'connections' && (
        <div className="grid gap-4 xl:grid-cols-3">
          <ConnectionCard provider="strava" />
          <ConnectionCard provider="trainingpeaks" />
          <SyncLog />
        </div>
      )}
      {tab === 'athlete' && <AthleteTab />}
      {tab === 'import' && (
        <Card title="Import activity files" className="max-w-3xl">
          <ImportDropzone />
        </Card>
      )}
      {tab === 'preferences' && <PreferencesTab />}
      {tab === 'data' && <DataTab />}
    </div>
  );
}
