import { Activity, Sparkles, Link2, Upload } from 'lucide-react';
import { http, useAction } from '../lib/api';
import { Button, Card } from '../components/ui';
import { ImportDropzone } from '../components/Import';
import { useStatus } from '../components/Layout';

export function Onboarding() {
  const { data: status } = useStatus();
  const demo = useAction(() => http('/demo', { method: 'POST' }));
  const strava = status?.connections.find((c) => c.provider === 'strava');
  const tp = status?.connections.find((c) => c.provider === 'trainingpeaks');
  const job = status?.job;
  return (
    <div className="mx-auto max-w-4xl py-6">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-white">
          <Activity className="h-7 w-7" strokeWidth={2.5} />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Welcome to Training Analytics</h1>
        <p className="mx-auto mt-2 max-w-xl text-[14px] text-ink-2">
          Every analysis from Strava and TrainingPeaks — and a few they don't have — in one place. Connect a source to sync automatically, import your files, or explore with a
          realistic demo athlete.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><Link2 className="h-4 w-4 text-accent" />Connect Strava</span>} subtitle="Automatic sync via webhooks + background polling">
          {strava?.configured ? (
            <a href="/api/auth/strava/start">
              <Button variant="primary" className="w-full" style={{ background: '#fc4c02' }}>
                Connect with Strava
              </Button>
            </a>
          ) : (
            <p className="text-xs text-muted">
              Add <code className="rounded bg-surface-3 px-1">STRAVA_CLIENT_ID</code> and <code className="rounded bg-surface-3 px-1">STRAVA_CLIENT_SECRET</code> to <code className="rounded bg-surface-3 px-1">.env</code> (create an API app at strava.com/settings/api), then restart.
            </p>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><Link2 className="h-4 w-4 text-accent" />Connect TrainingPeaks</span>} subtitle="Workouts, planned sessions and device files">
          {tp?.configured ? (
            <a href="/api/auth/trainingpeaks/start">
              <Button variant="primary" className="w-full">
                Connect with TrainingPeaks
              </Button>
            </a>
          ) : (
            <p className="text-xs text-muted">
              TrainingPeaks' API requires partner credentials (<code className="rounded bg-surface-3 px-1">TRAININGPEAKS_CLIENT_ID/SECRET</code>). No API access? Export your workouts from TrainingPeaks and import the ZIP below — the analysis is identical.
            </p>
          )}
        </Card>
        <Card title={<span className="flex items-center gap-2"><Upload className="h-4 w-4 text-accent" />Import files</span>} subtitle="Bulk exports welcome">
          <ImportDropzone compact />
        </Card>
        <Card title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" />Explore with demo data</span>} subtitle="18 months of simulated training: power, HR, GPS, races, a season plan">
          <p className="mb-4 text-xs text-ink-2">A physiologically modelled athlete — FTP tests, periodised blocks, races and upcoming planned workouts. Remove it any time from Settings.</p>
          <Button variant="primary" className="w-full" loading={!!job || demo.isPending} onClick={() => demo.mutate(undefined)}>
            {job ? job.message ?? 'Generating…' : 'Load demo athlete'}
          </Button>
        </Card>
      </div>
    </div>
  );
}
