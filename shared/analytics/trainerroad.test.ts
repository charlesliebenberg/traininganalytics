import { describe, expect, it } from 'vitest';
import { compareFtp, progressionLevels, structureFromProfile, valueOn, type ProfilePoint, type TrFtpRecord } from './trainerroad';
import { describe as describeWorkout, flatten, workoutMetrics } from './workout';
import type { WorkoutRepeat, WorkoutStep } from '../types';

/** A profile a second at a time from [seconds, % of FTP at the start, % at the end] pieces. */
function sampled(pieces: [number, number, number?][], unit = 1): ProfilePoint[] {
  const out: ProfilePoint[] = [];
  let t = 0;
  for (const [d, a, b = a] of pieces) for (let i = 0; i < d; i++, t++) out.push({ seconds: t * unit, ftpPercent: a + ((b - a) * i) / d });
  return out;
}

describe('TrainerRoad workout profiles', () => {
  // 10 min warm-up ramp, 3 × (8 min at 105 %, 4 min at 50 %), 5 min ramp down
  const intervals: [number, number, number?][] = [[600, 40, 70], [480, 105], [240, 50], [480, 105], [240, 50], [480, 105], [240, 50], [300, 60, 40]];

  it('reads a second-by-second profile (in milliseconds) as a warm-up, repeats and a cool-down', () => {
    const s = structureFromProfile(sampled(intervals, 1000))!;
    expect(s.target).toBe('power');
    expect(s.blocks).toHaveLength(3);
    const [warm, set, cool] = s.blocks as [WorkoutStep, WorkoutRepeat, WorkoutStep];
    expect(warm).toMatchObject({ intent: 'warmup', ramp: true, duration: 600, low: 0.4 });
    expect(warm.high).toBeCloseTo(0.7, 2);
    expect(set).toMatchObject({ kind: 'repeat', count: 3 });
    expect(set.steps).toMatchObject([
      { intent: 'active', duration: 480, low: 1.05, high: 1.05 },
      { intent: 'recovery', duration: 240, low: 0.5, high: 0.5 },
    ]);
    expect(cool).toMatchObject({ intent: 'cooldown', ramp: true, duration: 300, low: 0.6 });
    expect(workoutMetrics(s).duration).toBe(3060);
    expect(describeWorkout(s)).toContain('3×');
  });

  it('takes a ramp rounded to whole percents for one ramp, not a staircase', () => {
    const pts = sampled([[600, 40, 70], [1800, 70]]).map((p) => ({ ...p, ftpPercent: Math.round(p.ftpPercent) }));
    const segs = flatten(structureFromProfile(pts)!);
    expect(segs).toHaveLength(2);
    // rounded, the ramp reaches 70 % half a percent early
    expect(segs[0]).toMatchObject({ ramp: true, low: 0.4, high: 0.7 });
    expect(Math.abs(segs[0].duration - 600)).toBeLessThanOrEqual(10);
    expect(segs[1]).toMatchObject({ ramp: false, low: 0.7 });
    expect(segs[0].duration + segs[1].duration).toBe(2400);
  });

  it('reads breakpoints: lines between points given twice at a jump, held levels otherwise', () => {
    // a ramp, then a jump to a steady level
    const lines = structureFromProfile([
      { seconds: 0, ftpPercent: 50 },
      { seconds: 600, ftpPercent: 75 },
      { seconds: 600, ftpPercent: 95 },
      { seconds: 1800, ftpPercent: 95 },
    ])!;
    expect(flatten(lines).map((x) => [x.duration, x.low, x.high, x.ramp])).toEqual([
      [600, 0.5, expect.closeTo(0.75, 1), true],
      [1200, 0.95, 0.95, false],
    ]);
    // the level at each point holds until the next: no ramps made up between them
    const held = structureFromProfile([
      { seconds: 0, ftpPercent: 60 },
      { seconds: 300, ftpPercent: 100 },
      { seconds: 900, ftpPercent: 55 },
      { seconds: 1200, ftpPercent: 55 },
    ])!;
    expect(flatten(held).map((x) => [x.duration, x.low, x.ramp])).toEqual([
      [300, 0.6, false],
      [600, 1, false],
      [300, 0.55, false],
    ]);
  });

  it('keeps an endurance ride’s main block as the work, between a warm-up and a cool-down', () => {
    const s = structureFromProfile(sampled([[300, 50, 65], [3000, 65], [300, 50]]))!;
    expect(flatten(s).map((x) => x.intent)).toEqual(['warmup', 'active', 'cooldown']);
  });

  it('gives nothing for a profile it can’t read', () => {
    expect(structureFromProfile([])).toBeNull();
    expect(structureFromProfile([{ seconds: 0, ftpPercent: 50 }])).toBeNull();
    expect(structureFromProfile(sampled([[30, 50]]))).toBeNull();
    expect(structureFromProfile([{ seconds: Number.NaN, ftpPercent: 50 }, { seconds: 10, ftpPercent: Number.NaN }])).toBeNull();
  });
});

describe('TrainerRoad’s FTP beside this app’s', () => {
  const app = [
    { date: '2026-09-01', value: 305 },
    { date: '2026-10-06', value: 308 },
  ];

  it('reads the FTP in effect on a day', () => {
    expect(valueOn(app, '2026-08-31')).toBeNull();
    expect(valueOn(app, '2026-09-01')).toBe(305);
    expect(valueOn(app, '2026-10-05')).toBe(305);
    expect(valueOn(app, '2027-01-01')).toBe(308);
  });

  it('sets each of TrainerRoad’s records against this app’s FTP that day, and the two day by day', () => {
    const applied = [
      { date: '2026-10-01', value: 300 },
      { date: '2026-10-11', value: 310 },
    ];
    const others: TrFtpRecord[] = [
      // AI FTP Detection's own record of the change applied on the 11th
      { date: '2026-10-11', value: 310, kind: 'applied', source: 3, lowConfidence: null },
      { date: '2026-10-15', value: 312, kind: 'detected', source: 3, lowConfidence: true },
      { date: '2026-11-30', value: 320, kind: 'predicted', source: 5, lowConfidence: null },
    ];
    const { events, agreement } = compareFtp(applied, others, app, '2026-10-20');
    expect(events.map((e) => [e.date, e.kind, e.value, e.app, e.diff])).toEqual([
      ['2026-10-01', 'applied', 300, 305, -5],
      ['2026-10-11', 'applied', 310, 308, 2],
      ['2026-10-15', 'detected', 312, 308, 4],
      ['2026-11-30', 'predicted', 320, null, null],
    ]);
    expect(events[2].lowConfidence).toBe(true);
    // 1–5 Oct 300 against 305, 6–10 Oct 300 against 308, 11–20 Oct 310 against 308
    expect(agreement!.days).toBe(20);
    expect(agreement!.mean).toBeCloseTo((5 * -5 + 5 * -8 + 10 * 2) / 20, 10);
    expect(agreement!.meanAbs).toBeCloseTo((5 * 5 + 5 * 8 + 10 * 2) / 20, 10);
    expect(agreement!.meanPct).toBeCloseTo((5 * (-5 / 305) + 5 * (-8 / 308) + 10 * (2 / 308)) / 20, 10);
    // nothing to set side by side without both
    expect(compareFtp([], [], app, '2026-10-20').agreement).toBeNull();
    expect(compareFtp(applied, [], [], '2026-10-20').agreement).toBeNull();
  });

  it('compares over TrainerRoad’s current stretch: an FTP left a year or more before it is left out', () => {
    const applied = [
      { date: '2019-06-01', value: 345 },
      { date: '2026-10-01', value: 300 },
      // two changes on a day, in the order made: the later held
      { date: '2026-10-11', value: 303 },
      { date: '2026-10-11', value: 310 },
    ];
    const { events, agreement, since } = compareFtp(applied, [], app, '2026-10-20');
    expect(since).toBe('2026-10-01');
    // as above: 1–5 Oct 300 against 305, 6–10 Oct 300 against 308, 11–20 Oct 310 against 308
    expect(agreement!.days).toBe(20);
    expect(agreement!.mean).toBeCloseTo((5 * -5 + 5 * -8 + 10 * 2) / 20, 10);
    // the old one's still listed
    expect(events[0]).toMatchObject({ date: '2019-06-01', kind: 'applied', value: 345, app: null, diff: null });
    // under a year between changes: one stretch, from the first
    expect(compareFtp([{ date: '2025-11-01', value: 290 }, ...applied.slice(1)], [], app, '2026-10-20').since).toBe('2025-11-01');
    expect(compareFtp([], [], app, '2026-10-20').since).toBeNull();
  });

  it('lists the progression levels in TrainerRoad’s order of zones, with what AI FTP Detection would do to them', () => {
    const levels = progressionLevels(
      { levels: { 99: { recent: 1 }, 85: { recent: 3.1, predicted: 5.4, changeEvent: { date: '2026-11-06T10:00:00', reason: 'workout', level: { from: 2.8, to: 3.1 } } }, 33: { recent: 6.2 } } },
      { currentProgressionLevels: [{ progressionId: 85, previousDisplayLevel: 3.1 }], projectedProgressionLevels: [{ progressionId: 85, displayFinalLevel: 2.7 }] },
    );
    expect(levels.map((l) => l.zone)).toEqual(['Endurance', 'VO2 Max', 'Progression 99']);
    expect(levels[1]).toEqual({ id: 85, zone: 'VO2 Max', level: 3.1, predicted: 5.4, changed: { date: '2026-11-06', from: 2.8, to: 3.1, reason: 'workout' }, ai: { from: 3.1, to: 2.7 } });
    expect(levels[0]).toMatchObject({ predicted: null, changed: null, ai: null });
    expect(progressionLevels(null, null)).toEqual([]);
  });
});
