import { describe, expect, it } from 'vitest';
import { CURVE_DURATIONS, meanMax, resample1Hz } from './series';
import { detectIntervals, fatigueCurves, normalizedPower, npCurve, wPrimeBalance, matchesBurned } from './power';
import { fitCp2, fitPowerDuration, ompd } from './models';
import { computePmc, dailyTssForCtl, formZone } from './pmc';
import { bestEfforts, gradeCostFactor } from './running';
import { hrTss } from './heartrate';
import { timeInZones, POWER_ZONES, polarizationIndex } from './zones';
import { toZwo, workoutMetrics } from './workout';
import { generateSeasonPlan, generateWeekWorkouts } from './plan';
import { decodePolyline, encodePolyline } from '../polyline';
import { computeMetrics, normalizeStreams } from './metrics';
import { BUILTIN_WORKOUTS } from '../library';
import { estimateThreshold, limitDeclines } from './thresholds';
import { byEffortDate, classifySession, detectPeaks, effortDate, fitLoadModel, ctlForFtp } from './comeback';
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
const iso = (d: Date) => format(d, 'yyyy-MM-dd');
import type { Thresholds } from '../types';

const TH: Thresholds = {
  date: '2020-01-01',
  ftp: 250,
  wPrime: 20000,
  lthr: 165,
  runLthr: 170,
  maxHr: 190,
  restHr: 50,
  runThresholdSpeed: 4,
  swimCss: 1.3,
  weight: 70,
};

describe('power', () => {
  it('NP of constant power equals that power', () => {
    expect(normalizedPower(new Array(3600).fill(200))).toBeCloseTo(200, 6);
  });
  it('NP is higher than average for variable power', () => {
    const p = Array.from({ length: 3600 }, (_, i) => (Math.floor(i / 60) % 2 ? 350 : 100));
    const np = normalizedPower(p)!;
    expect(np).toBeGreaterThan(225);
    expect(np).toBeLessThan(350);
  });
  it('mean max finds best window', () => {
    const p = new Array(600).fill(100);
    for (let i = 100; i < 160; i++) p[i] = 400;
    const mm = meanMax(p, [1, 60, 120]);
    expect(mm).toEqual([400, 400, 250]);
  });
  it('NP curve ≥ power curve and constant for steady efforts', () => {
    const p = Array.from({ length: 1800 }, (_, i) => (i % 40 < 20 ? 400 : 100));
    const nc = npCurve(p, [300, 1200]);
    const pc = meanMax(p, [300, 1200]);
    nc.forEach((v, i) => expect(v!).toBeGreaterThanOrEqual(Math.floor(pc[i]!)));
    expect(npCurve(new Array(1000).fill(220), [300])[0]).toBe(220);
  });
  it('W′ balance depletes above CP and recovers below', () => {
    const p = [...new Array(120).fill(400), ...new Array(600).fill(100)];
    const wb = wPrimeBalance(p, 250, 20000);
    expect(Math.min(...wb)).toBeCloseTo(20000 - 150 * 120, 0);
    expect(wb[wb.length - 1]).toBeGreaterThan(18000);
    expect(matchesBurned(wb, 20000)).toBe(1);
  });
  it('fatigue curves only include power after the kJ threshold', () => {
    const p = [...new Array(3000).fill(200), ...new Array(600).fill(300)]; // 600 kJ then 180 kJ
    const fc = fatigueCurves(p, [500], [60]);
    expect(fc['500'][0]).toBe(300);
    expect(fatigueCurves(p, [1000], [60])['1000']).toBeUndefined();
  });
  it('detects structured intervals', () => {
    const p: number[] = new Array(600).fill(150);
    for (let r = 0; r < 3; r++) {
      p.push(...new Array(600).fill(245));
      p.push(...new Array(300).fill(140));
    }
    const iv = detectIntervals(p, 250);
    expect(iv.length).toBe(3);
    expect(Math.abs(iv[0].end - iv[0].start - 600)).toBeLessThan(10);
  });
});

describe('models', () => {
  it('recovers CP and W′ from an ideal hyperbolic curve', () => {
    const pts = [180, 300, 600, 900, 1200].map((t) => ({ t, p: 20000 / t + 280 }));
    const m = fitCp2(pts)!;
    expect(m.cp).toBeCloseTo(280, 3);
    expect(m.wPrime).toBeCloseTo(20000, 0);
  });
  it('fits the OmPD model to a synthetic curve', () => {
    const truth = { cp: 270, wPrime: 18000, pmax: 1100, a: 30 };
    const curve = CURVE_DURATIONS.filter((t) => t <= 14400).map((t) => ompd(t, truth));
    const m = fitPowerDuration(curve)!;
    expect(m).not.toBeNull();
    expect(Math.abs(m.cp - 270)).toBeLessThan(8);
    expect(Math.abs(m.p60 - ompd(3600, truth))).toBeLessThan(6);
    expect(m.eftp).toBe(m.cp);
    expect(m.error).toBeLessThan(0.03);
  });
});

describe('pmc', () => {
  it('converges to steady daily load', () => {
    const days = Array.from({ length: 400 }, (_, i) => ({ date: String(i), tss: 80 }));
    const pmc = computePmc(days);
    const last = pmc[pmc.length - 1];
    expect(last.ctl).toBeCloseTo(80, 0);
    expect(last.atl).toBeCloseTo(80, 3);
    expect(Math.abs(last.tsb)).toBeLessThan(1);
  });
  it('dailyTssForCtl hits the target', () => {
    const x = dailyTssForCtl(50, 55, 7);
    const pmc = computePmc(Array.from({ length: 7 }, (_, i) => ({ date: String(i), tss: x })), { startCtl: 50 });
    expect(pmc[6].ctl).toBeCloseTo(55, 6);
  });
  it('classifies form', () => {
    expect(formZone(-12, 60).id).toBe('optimal');
    expect(formZone(10, 60).id).toBe('fresh');
  });
});

describe('running & hr', () => {
  it('grade cost is 1 on flat and higher uphill', () => {
    expect(gradeCostFactor(0)).toBeCloseTo(1, 6);
    expect(gradeCostFactor(0.1)).toBeGreaterThan(1.4);
  });
  it('finds best efforts', () => {
    const d = Array.from({ length: 2000 }, (_, i) => i * 3 + (i > 1000 && i < 1400 ? (i - 1000) * 1 : i >= 1400 ? 400 : 0));
    const be = bestEfforts(d);
    expect(be['1k']).toBeCloseTo(250, 0);
  });
  it('hrTSS is ~100 for an hour at LTHR', () => {
    expect(hrTss(new Array(3600).fill(165), 165, 50, 190)).toBeCloseTo(100, 3);
  });
});

describe('zones', () => {
  it('buckets time', () => {
    const z = timeInZones([100, 150, 200, 250, 290, 350, 900], 250, POWER_ZONES);
    expect(z).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(polarizationIndex([80, 5, 15])).toBeGreaterThan(2);
  });
});

describe('workouts & plans', () => {
  it('1h at FTP is 100 TSS', () => {
    const m = workoutMetrics({ target: 'power', blocks: [{ kind: 'step', id: 'a', intent: 'active', duration: 3600, low: 1, high: 1 }] });
    expect(m.tss).toBeCloseTo(100, 6);
    expect(m.if).toBeCloseTo(1, 6);
  });
  it('exports zwo', () => {
    const w = BUILTIN_WORKOUTS.find((w) => w.key === 'vo2-5x5')!;
    expect(toZwo(w.name, w.description, w.structure)).toContain('<IntervalsT Repeat="5"');
  });
  it('generates a periodised season plan that builds fitness', () => {
    const weeks = generateSeasonPlan({
      startDate: '2026-01-05',
      raceDate: '2026-06-14',
      startCtl: 45,
      startAtl: 45,
      targetCtl: 85,
      maxRamp: 5,
      pattern: '3:1',
      taperWeeks: 2,
      maxWeeklyHours: 14,
      sport: 'ride',
    });
    expect(weeks[weeks.length - 1].phase).toBe('Race');
    expect(weeks.some((w) => w.recovery)).toBe(true);
    const peak = Math.max(...weeks.map((w) => w.ctl));
    expect(peak).toBeGreaterThan(70);
    expect(weeks[weeks.length - 1].tsb).toBeGreaterThan(0);
    const wk = generateWeekWorkouts(weeks[6]);
    const total = wk.reduce((a, w) => a + w.tss, 0);
    expect(Math.abs(total - weeks[6].tss) / weeks[6].tss).toBeLessThan(0.25);
  });
});

describe('streams', () => {
  it('polyline round-trips', () => {
    const pts: [number, number][] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts);
  });
  it('resamples with gaps', () => {
    const r = resample1Hz([0, 2, 20], [100, 200, 300], 21, { gapValue: 0 });
    expect(r[1]).toBe(150);
    expect(r[10]).toBe(0);
    expect(r[20]).toBe(300);
  });
  it('computes activity metrics end to end', () => {
    const n = 3600;
    const time = Array.from({ length: n }, (_, i) => i);
    const s = normalizeStreams({
      time,
      watts: time.map(() => 200),
      heartrate: time.map(() => 140),
      speed: time.map(() => 9),
      distance: time.map((t) => t * 9),
      altitude: time.map((t) => 100 + Math.sin(t / 300) * 50),
    })!;
    const m = computeMetrics(s, 'ride', TH);
    expect(m.np).toBe(200);
    expect(m.tss).toBeCloseTo(64, 0);
    expect(m.tssMethod).toBe('power');
    expect(m.distance).toBeCloseTo(3599 * 9, 0);
    expect(m.elevationGain!).toBeGreaterThan(160);
    expect(m.curves.power![CURVE_DURATIONS.indexOf(60)]).toBe(200);
    expect(m.decoupling).toBeCloseTo(0, 1);
  });
});

describe('threshold estimation', () => {
  const meta = { date: '2026-01-05', windowFrom: '2025-07-07', windowTo: '2026-01-04', activities: 20 };
  it('recovers CP / W′ from maximal efforts and ignores sub-maximal ones', () => {
    const values = CURVE_DURATIONS.map((t) => {
      const v = 280 + 20000 / t;
      // the athlete never went all-out between 7 and 15 minutes or beyond 25 minutes
      if (t > 420 && t < 900) return v * 0.85;
      if (t > 1500) return v * 0.8;
      return v;
    });
    const e = estimateThreshold('ride', { values }, meta)!;
    expect(e.points).toHaveLength(3);
    expect(e.cp).toBeCloseTo(280, 0);
    expect(e.wPrime).toBeCloseTo(20000, -2);
    expect(e.threshold).toBeCloseTo(280 * 0.96, 0);
    expect(e.points.every((p) => p.score > 0.99)).toBe(true);
  });
  it('estimates critical speed for running', () => {
    const values = CURVE_DURATIONS.map((t) => 4.2 + 200 / t);
    const e = estimateThreshold('run', { values }, meta)!;
    expect(e.cp).toBeCloseTo(4.2, 2);
    expect(e.wPrime).toBeCloseTo(200, 0);
  });
  it('needs enough data', () => {
    const values = CURVE_DURATIONS.map((t) => (t <= 300 ? 300 + 20000 / t : null));
    expect(estimateThreshold('ride', { values }, meta)).toBeNull();
    expect(estimateThreshold('ride', { values: CURVE_DURATIONS.map((t) => 280 + 20000 / t) }, { ...meta, activities: 1 })).toBeNull();
  });
});

describe('threshold history', () => {
  it('limits declines but applies rises immediately', () => {
    const s = limitDeclines([
      { date: '2026-01-05', raw: 300, threshold: 300 },
      { date: '2026-01-12', raw: 250, threshold: 250 },
      { date: '2026-01-19', raw: 320, threshold: 320 },
    ]);
    expect(s[1].threshold).toBeCloseTo(297, 0);
    expect(s[2].threshold).toBe(320);
  });
  it('skips points copied from longer efforts', () => {
    const values = CURVE_DURATIONS.map((t) => 280 + 20000 / t);
    const filled = CURVE_DURATIONS.map((t) => t > 300 && t < 1200);
    const e = estimateThreshold('ride', { values, filled }, { date: '2026-01-05', windowFrom: '', windowTo: '', activities: 10 })!;
    expect(e.points.every((p) => p.t <= 300 || p.t >= 1200)).toBe(true);
  });
});

describe('comeback analytics', () => {
  const act = (o: Partial<import('../types').Activity>) => ({ id: 1, sport: 'ride', name: 'Ride', movingTime: 3600, intensity: 0.7, zones: null, tss: 50, localDate: '2026-01-01', ...o }) as import('../types').Activity;
  it('classifies sessions from time in zones', () => {
    const z = (m: number[]) => ({ power: m.map((x) => x * 60) });
    expect(classifySession(act({ zones: z([10, 40, 5, 0, 10, 1, 0]) }))).toBe('vo2');
    expect(classifySession(act({ zones: z([10, 20, 10, 20, 0, 0, 0]) }))).toBe('threshold');
    expect(classifySession(act({ zones: z([10, 20, 25, 5, 0, 0, 0]) }))).toBe('tempo');
    expect(classifySession(act({ zones: z([20, 40, 0, 0, 0, 0, 0]), intensity: 0.55, movingTime: 2400 }))).toBe('recovery');
    expect(classifySession(act({ name: 'Spring Road Race', intensity: 0.85, movingTime: 3 * 3600 }))).toBe('race');
    expect(classifySession(act({ zones: z([30, 150, 10, 0, 0, 0, 0]), movingTime: 4 * 3600 }))).toBe('endurance');
  });
  it('detects separated peaks', () => {
    const series = Array.from({ length: 300 }, (_, i) => ({ date: iso(addDays(parseISO('2019-01-07'), i * 7)), value: 250 + 50 * Math.sin((i / 52) * 2 * Math.PI) }));
    const p = detectPeaks(series, { minGapDays: 180 });
    expect(p.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < p.length; i++) expect(differenceInCalendarDays(parseISO(p[i].date), parseISO(p[i - 1].date))).toBeGreaterThanOrEqual(180);
  });
  it('learns FTP vs load', () => {
    const est = Array.from({ length: 120 }, (_, i) => ({ date: iso(addDays(parseISO('2020-01-06'), i * 7)), raw: 0 }));
    const ctl = (d: string) => 40 + 40 * Math.sin(differenceInCalendarDays(parseISO(d), parseISO('2020-01-01')) / 120);
    est.forEach((e) => (e.raw = 180 + 1.2 * ctl(e.date)));
    const m = fitLoadModel(est, ctl)!;
    expect(m.b).toBeGreaterThan(0.8);
    expect(ctlForFtp(m, m.a + m.b * 70).ctl).toBeCloseTo(70, 3);
  });
  it('dates estimates by their efforts and ignores stale repeats of them', () => {
    // a rolling estimate that keeps reporting March efforts for months after riding stopped
    const pts = (d: string) => [{ t: 300, value: 400, activityId: 1, date: d, score: 1, band: 0 }];
    const stale = ['2020-03-23', '2020-05-04', '2020-08-17'].map((date) => ({ date, raw: 357, points: pts('2020-03-15') }));
    expect(effortDate(stale[2])).toBe('2020-03-16');
    expect(byEffortDate(stale)).toEqual([{ date: '2020-03-16', value: 357 }]);
    // CTL collapses after March: stale reports must not pair 357 W with a CTL near zero
    const fresh = Array.from({ length: 8 }, (_, i) => ({ date: iso(addDays(parseISO('2019-06-03'), i * 21)), raw: 280 + i * 10, points: pts(iso(addDays(parseISO('2019-06-01'), i * 21))) }));
    const ctlRamp = (d: string) => (d < '2020-04-01' ? 20 + differenceInCalendarDays(parseISO(d), parseISO('2019-04-01')) / 6 : 5);
    const m = fitLoadModel([...fresh, ...stale], ctlRamp)!;
    expect(m.points.every((p) => p.ctl > 15)).toBe(true);
    expect(m.b).toBeGreaterThan(0);
  });
  it('builds a gentle comeback plan that reaches the target without a race taper', () => {
    const weeks = generateSeasonPlan({ startDate: '2026-01-05', raceDate: '2026-06-01', startCtl: 25, startAtl: 25, targetCtl: 75, maxRamp: 5, initialRamp: 3, initialWeeks: 4, pattern: '3:1', taperWeeks: 2, maxWeeklyHours: 16, sport: 'ride', goal: 'fitness' });
    expect(weeks.some((w) => w.phase === 'Race' || w.phase === 'Taper')).toBe(false);
    expect(weeks[1].ctl - weeks[0].ctl).toBeLessThanOrEqual(3.6);
    expect(weeks[weeks.length - 1].ctl).toBeGreaterThan(70);
    const wk = generateWeekWorkouts(weeks[8], { quality: 2, vo2Share: 0.5, longRides: 1, days: 5 });
    expect(wk.length).toBe(5);
    expect(wk.some((w) => w.title.startsWith('Long'))).toBe(true);
  });
});
