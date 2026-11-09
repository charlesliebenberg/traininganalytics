import { describe, expect, it } from 'vitest';
import { structureFromProfile, type ProfilePoint } from './trainerroad';
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
