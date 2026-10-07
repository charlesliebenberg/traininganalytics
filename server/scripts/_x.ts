import { pmc } from '../aggregate';
import { storedSeries } from '../estimates';
const all = new Map(pmc('2016-01-01', '2026-10-07').map((p) => [p.date, p]));
const ride = new Map(pmc('2016-01-01', '2026-10-07', 'ride').map((p) => [p.date, p]));
for (const e of storedSeries('ride').filter((_, i) => i % 4 === 0)) {
  const last = e.points.map((p) => p.date).sort().pop();
  console.log(e.date, Math.round(e.raw), Math.round(e.threshold), 'ctl', Math.round(all.get(e.date)?.ctl ?? -1), 'ride', Math.round(ride.get(e.date)?.ctl ?? -1), 'lastEffort', last);
}
