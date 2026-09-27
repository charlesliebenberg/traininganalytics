import type { Sport, WorkoutStructure } from '../../shared/types';
import { toErg, toMrc, toZwo } from '../../shared/analytics/workout';

export function download(filename: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safe = (s: string) => s.replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '_') || 'workout';

export function exportWorkout(format: 'zwo' | 'erg' | 'mrc' | 'json', w: { name: string; description?: string | null; sport: Sport; structure: WorkoutStructure }, ftp: number) {
  const name = safe(w.name);
  if (format === 'zwo') download(`${name}.zwo`, toZwo(w.name, w.description ?? '', w.structure, w.sport), 'application/xml');
  else if (format === 'erg') download(`${name}.erg`, toErg(w.name, w.structure, ftp));
  else if (format === 'mrc') download(`${name}.mrc`, toMrc(w.name, w.structure));
  else download(`${name}.json`, JSON.stringify(w, null, 2), 'application/json');
}
