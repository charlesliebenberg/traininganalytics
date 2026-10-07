import { useRef, useState } from 'react';
import { UploadCloud, CheckCircle2, AlertCircle, MinusCircle } from 'lucide-react';
import clsx from 'clsx';
import { useQueryClient } from '@tanstack/react-query';
import { apiUrl } from '../lib/api';

interface Result {
  file: string;
  status: 'imported' | 'duplicate' | 'error' | 'skipped';
  message?: string;
}

export function ImportDropzone({ compact = false }: { compact?: boolean }) {
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    const out: Result[] = [];
    // upload in small batches so large exports show progress
    for (let i = 0; i < list.length; i += 5) {
      const batch = list.slice(i, i + 5);
      setBusy(`Importing ${Math.min(i + 5, list.length)} of ${list.length}…`);
      const fd = new FormData();
      batch.forEach((f) => fd.append('files', f, f.name));
      try {
        const res = await fetch(apiUrl('/import'), { method: 'POST', body: fd, credentials: 'include' });
        out.push(...((await res.json()) as Result[]));
      } catch (e) {
        batch.forEach((f) => out.push({ file: f.name, status: 'error', message: (e as Error).message }));
      }
      setResults([...out]);
    }
    setBusy(null);
    qc.invalidateQueries();
  }

  const counts = results.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          upload(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        className={clsx(
          'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed text-center transition-colors',
          compact ? 'px-4 py-6' : 'px-6 py-10',
          drag ? 'border-accent bg-accent-soft' : 'border-line-strong hover:border-accent hover:bg-surface-2',
        )}
      >
        <UploadCloud className="mb-2 h-7 w-7 text-muted" />
        <div className="text-[13px] font-medium">{busy ?? 'Drop FIT, TCX, GPX or ZIP files'}</div>
        <div className="mt-1 text-xs text-muted">Garmin/Wahoo files, TrainingPeaks “Export Workout Files”, Strava bulk export — .gz supported</div>
        <input ref={input} type="file" multiple accept=".fit,.tcx,.gpx,.zip,.gz" className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
      </div>
      {results.length > 0 && (
        <div className="mt-3">
          <div className="mb-2 flex gap-3 text-xs text-ink-2">
            {Object.entries(counts).map(([k, v]) => (
              <span key={k}>
                {v} {k}
              </span>
            ))}
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {results.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                {r.status === 'imported' ? <CheckCircle2 className="h-3.5 w-3.5 text-good" /> : r.status === 'error' ? <AlertCircle className="h-3.5 w-3.5 text-critical" /> : <MinusCircle className="h-3.5 w-3.5 text-muted" />}
                <span className="truncate">{r.file}</span>
                {r.message && <span className="truncate text-muted">— {r.message}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
