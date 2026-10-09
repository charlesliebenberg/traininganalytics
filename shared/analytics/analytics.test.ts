import { describe, expect, it } from 'vitest';
import { CURVE_DURATIONS, meanMax, resample1Hz } from './series';
import { detectIntervals, fatigueCurves, normalizedPower, npCurve, wPrimeBalance, matchesBurned } from './power';
import { fitCp2, fitPowerDuration, ompd } from './models';
import { computePmc, dailyTssForCtl, formZone } from './pmc';
import { bestEfforts, cleanRunSpeed, distanceFromSpeed, gradeCostFactor } from './running';
import { decoupling, hrTss } from './heartrate';
import { timeInZones, POWER_ZONES, polarizationIndex } from './zones';
import { toZwo, workoutMetrics } from './workout';
import { generateSeasonPlan, generateWeekWorkouts, planReach } from './plan';
import { decodePolyline, encodePolyline } from '../polyline';
import { computeMetrics, movingMask, normalizeStreams } from './metrics';
import { BUILTIN_WORKOUTS } from '../library';
import { estimateHrThresholds, estimateThreshold, limitDeclines } from './thresholds';
import { byEffortDate, classifySession, detectPeaks, effortDate } from './comeback';
import { daysToTarget, fitCapacity, loadForTarget, ltlSeries, projectCapacity, quantileLine, type CapacityDay } from './capacity';
import { compareHrProfiles, hrPowerWindows, hrProfile } from './hrprofile';
import { curveHr, fitAerobic, fitnessChange, kineticBins, outputAt, steadyWindows, WINDOW_SPECS, type AerobicActivity, type SteadyWindow } from './aerobic';
import { rideEffortFindings, runEffortFindings, verdict } from './insights';
import { analyzeSession, comparableSets, progression, setLabel, type SetSummary } from './session';
import { reviewPeriod, type ReviewActivity, type ReviewInput } from './review';
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
  const race = { startDate: '2026-10-05', raceDate: '2027-01-28', startCtl: 87, startAtl: 80, targetCtl: 102, maxRamp: 5, pattern: '3:1', taperWeeks: 2, maxWeeklyHours: 0, sport: 'ride', tssPerHour: 55 } as const;
  it('lands race-day fitness on the target, building past it to pay for the taper', () => {
    const weeks = generateSeasonPlan(race);
    const raceDay = weeks[weeks.length - 1].ctl;
    expect(raceDay).toBeGreaterThanOrEqual(102);
    expect(raceDay).toBeLessThan(103.5);
    expect(Math.max(...weeks.map((w) => w.ctl))).toBeGreaterThan(110);
    expect(planReach(race)).toBeNull();
  });
  it('says what limits a plan that cannot reach its target', () => {
    // 12 h a week at 55 TSS/h cannot even hold CTL 87 through recovery weeks and a taper
    const hours = planReach({ ...race, maxWeeklyHours: 12 })!;
    expect(hours.achieved).toBeLessThan(90);
    expect(hours.hoursNeeded).toBeGreaterThan(14);
    expect(hours.hoursNeeded).toBeLessThan(20);
    expect(generateSeasonPlan({ ...race, maxWeeklyHours: hours.hoursNeeded! }).at(-1)!.ctl).toBeGreaterThanOrEqual(101);
    // six weeks is too short at +5 CTL a week, whatever the hours
    const ramp = planReach({ ...race, raceDate: '2026-11-19' })!;
    expect(ramp.hoursNeeded).toBeNull();
    expect(ramp.rampNeeded).toBeGreaterThan(5);
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
    // a maximal 20 min on the CP curve: FTP is CP (95 % of 20 min, capped at CP)
    expect(e.threshold).toBeCloseTo(280, 0);
    expect(e.basis).toBe('20min');
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
  it('dates estimates by their efforts and ignores stale repeats of them', () => {
    // a rolling estimate that keeps reporting March efforts for months after riding stopped
    const pts = (d: string) => [{ t: 300, value: 400, activityId: 1, date: d, score: 1, band: 0 }];
    const stale = ['2020-03-23', '2020-05-04', '2020-08-17'].map((date) => ({ date, raw: 357, points: pts('2020-03-15') }));
    expect(effortDate(stale[2])).toBe('2020-03-16');
    expect(byEffortDate(stale)).toEqual([{ date: '2020-03-16', value: 357 }]);
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

describe('capacity model', () => {
  // deterministic pseudo-random numbers
  const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

  it('fits the upper envelope with an exact quantile line', () => {
    const r = rng(7);
    const x = Array.from({ length: 300 }, () => r() * 80);
    // true capacity 200 + 2x; most observations fall short of it
    const y = x.map((v) => 200 + 2 * v - (r() < 0.8 ? r() * 40 : 0));
    const { a, b } = quantileLine(x, y, 0.85);
    expect(b).toBeGreaterThan(1.8);
    expect(b).toBeLessThan(2.2);
    expect(a).toBeGreaterThan(190);
    expect(a).toBeLessThan(205);
  });

  it('learns a long time constant from a comeback and beats CTL on it', () => {
    const r = rng(11);
    const start = parseISO('2016-01-04');
    const n = 365 * 6;
    // 3 years of training, 2.5 years off, then a comeback
    const loads = Array.from({ length: n }, (_, i) => (i < 1100 ? 40 + (i / 1100) * 50 : i < 2000 ? 0 : 85) * (r() < 0.6 ? 1.6 : 0.1));
    const ltl = ltlSeries(loads, 365);
    const days: CapacityDay[] = loads.map((load, i) => ({
      date: iso(addDays(start, i)),
      load,
      best: load > 0 && r() < 0.5 ? 250 + 2 * (i ? ltl[i - 1] : 0) - (r() < 0.75 ? r() * 30 : 0) : null,
    }));
    const m = fitCapacity(days, { holdoutFrom: iso(addDays(start, 2000)) })!;
    expect(m).not.toBeNull();
    expect(m.tau).toBeGreaterThanOrEqual(180);
    expect(m.fits.find((f) => f.tau === 365)!.plausible).toBe(true);
    expect(m.validation!.mae).toBeLessThan(m.validation!.maeCtl);
  });

  it('projects consistently: time to target and load for target invert each other', () => {
    const m = { a: 250, b: 2 };
    const tau = 365;
    const target = 350; // needs LTL 50
    const d = daysToTarget(m, tau, 20, 90, target);
    const path = projectCapacity(m, tau, 20, Array(d).fill(90));
    expect(path[d - 1]).toBeGreaterThanOrEqual(target - 1e-9);
    expect(path[d - 2]).toBeLessThan(target);
    expect(loadForTarget(m, tau, 20, target, d)).toBeLessThanOrEqual(90);
    expect(loadForTarget(m, tau, 20, target, d - 1)).toBeGreaterThan(90);
    expect(daysToTarget(m, tau, 20, 50, target)).toBe(Infinity);
    expect(daysToTarget(m, tau, 60, 0, target)).toBe(0);
  });
});

describe('heart-rate power profile', () => {
  // 50 min easy at 200 W / ~140 bpm, then 30 min at 300 W / ~170 bpm
  const time = Array.from({ length: 4800 }, (_, i) => i);
  const watts = time.map((t) => (t < 3000 ? 200 + ((t * 7) % 11) - 5 : 300 + ((t * 5) % 9) - 4));
  const heartrate = time.map((t) => (t < 3000 ? 140 : t < 3120 ? 140 + ((t - 3000) / 120) * 30 : 170));
  const bins = hrPowerWindows({ time, watts, heartrate });

  it('pairs steady power with settled heart rate', () => {
    expect(Math.abs(bins['140'][0] - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(bins['170'][0] - 300)).toBeLessThanOrEqual(2);
    // windows straddling the change are not steady
    expect(Object.keys(bins).sort()).toEqual(['140', '170']);
  });

  it('compares two periods bin by bin', () => {
    const then = hrProfile([bins, bins]);
    const faster = Object.fromEntries(Object.entries(bins).map(([k, v]) => [k, v.map((p) => p * 0.9)]));
    const now = hrProfile([faster, faster]);
    const c = compareHrProfiles(then, now);
    expect(c.ratio).toBeCloseTo(0.9, 2);
    expect(c.thenTop!.hr).toBe(170);
  });
});

describe('metrics on real-world recordings', () => {
  const time = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('excludes long stops from NP, average power and TSS, but keeps short ones', () => {
    // 1 h at 250 W, a 45-min café stop recorded as zeros, 1 h at 250 W with a 10-s coast
    const watts = [...new Array(3600).fill(250), ...new Array(2700).fill(0), ...new Array(1800).fill(250), ...new Array(10).fill(0), ...new Array(1790).fill(250)];
    const n = watts.length;
    const speed = watts.map((w) => (w ? 9 : 0));
    const m = computeMetrics({ time: time(n), watts, speed, moving: null }, 'ride', { ...TH, ftp: 250 });
    expect(m.movingTime).toBe(7200);
    expect(m.np).toBeGreaterThan(247);
    expect(m.avgPower).toBeGreaterThan(248);
    // two hours at FTP — not almost three
    expect(m.tss).toBeGreaterThan(195);
    expect(m.tss).toBeLessThan(205);
  });

  it('finds GPS south of the equator and west of Greenwich', () => {
    const n = 600;
    const sydney = computeMetrics({ time: time(n), speed: new Array(n).fill(8), lat: Array.from({ length: n }, (_, i) => -33.86 - i * 1e-4), lng: Array.from({ length: n }, (_, i) => 151.2 + i * 1e-4) }, 'ride', TH);
    expect(sydney.hasGps).toBe(true);
    expect(decodePolyline(sydney.polyline!)[0][0]).toBeCloseTo(-33.86, 4);
    const nyc = computeMetrics({ time: time(n), speed: new Array(n).fill(8), lat: new Array(n).fill(40.7), lng: new Array(n).fill(-74) }, 'ride', TH);
    expect(nyc.hasGps).toBe(true);
    const none = computeMetrics({ time: time(n), speed: new Array(n).fill(8), lat: new Array(n).fill(0), lng: new Array(n).fill(0) }, 'ride', TH);
    expect(none.hasGps).toBe(false);
  });

  it('counts an indoor ride without a speed sensor as moving', () => {
    const n = 3600;
    const mask = movingMask({ time: time(n), watts: new Array(n).fill(200), speed: new Array(n).fill(0), cadence: new Array(n).fill(85), moving: new Array(n).fill(0), heartrate: null });
    expect(mask.reduce((a, b) => a + b, 0)).toBe(n);
  });

  it('uses CP, not FTP, for W′ balance', () => {
    const n = 3600;
    // 20 min at 307 W: above an FTP of 286, but inside what CP 298 / W′ 22 kJ allows
    const watts = [...new Array(600).fill(180), ...new Array(1200).fill(307), ...new Array(1800).fill(180)];
    const m = computeMetrics({ time: time(n), watts, speed: new Array(n).fill(9) }, 'ride', { ...TH, ftp: 286, cp: 298, wPrime: 22000 });
    expect(m.wbalMin!).toBeGreaterThan(0);
  });

  it('only reports decoupling when both halves are ridden alike', () => {
    const n = 5400;
    const hr = Array.from({ length: n }, (_, i) => 140 + (i / n) * 8);
    const steadyW = new Array(n).fill(200);
    expect(decoupling(steadyW, hr)).not.toBeNull();
    // hard first half, easy second half: the drift would only describe the session
    const shaped = Array.from({ length: n }, (_, i) => (i < n / 2 ? 260 : 160));
    expect(decoupling(shaped, hr)).toBeNull();
    // even 7 % easier: heart rate doesn't fall in proportion, so it would read as drift
    expect(decoupling(Array.from({ length: n }, (_, i) => (i < n / 2 ? 200 : 186)), hr)).toBeNull();
  });

  it('removes GPS glitches from running speed but keeps genuine surges', () => {
    // a 20-min run at 3 m/s, with a jerky 60-s GPS glitch at the start and a real 5-min surge
    const base = new Array(1200).fill(3);
    for (let i = 5; i < 65; i++) base[i] = [6, 15, 4, 11, 7, 13][i % 6];
    for (let i = 600; i < 900; i++) base[i] = 4.6;
    const clean = cleanRunSpeed(base);
    expect(Math.max(...clean.slice(5, 65))).toBeLessThanOrEqual(4.6);
    expect(clean.slice(600, 900).every((v) => v === 4.6)).toBe(true);
    const be = bestEfforts(distanceFromSpeed(clean));
    // the best 400 m is the surge (≈ 87 s), not a glitch
    expect(be['400m']).toBeGreaterThan(85);
  });
});

describe('threshold floors and heart-rate thresholds', () => {
  it('never puts FTP below 95 % of the best 20 minutes or the best hour', () => {
    // a curve whose short efforts are weak relative to a strong 20 min (no all-out 3–10 min)
    const values = CURVE_DURATIONS.map((t) => (t < 180 ? 600 : t <= 1800 ? 300 + 4000 / t : t <= 3600 ? 295 : null));
    const e = estimateThreshold('ride', { values }, { date: '2026-10-05', windowFrom: '2026-04-06', windowTo: '2026-10-04', activities: 40 })!;
    const p20 = values[CURVE_DURATIONS.indexOf(1200)]!;
    expect(e.threshold).toBeGreaterThanOrEqual(Math.min(p20 * 0.95, e.cp) - 1e-9);
    expect(e.threshold).toBeGreaterThanOrEqual(295);
    expect(e.threshold).toBeGreaterThan(e.cp * 0.96);
    expect(['20min', '60min']).toContain(e.basis);
  });

  it('takes LTHR from sustained efforts, robust to one bad reading', () => {
    const e = estimateHrThresholds([180, 199, 176, 150, 172], [160, 158, 155, 150], [195, 194, 210, 190, 188]);
    expect(e.lthr).toBe(180); // second highest: the 199 strap glitch doesn't set it
    expect(e.runLthr).toBe(180); // easy-only running doesn't drag run LTHR below the bike value
    expect(e.maxHr).toBe(195);
  });
});

describe('aerobic fitness from heart rate', () => {
  // deterministic noise
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const gauss = (r: () => number) => () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  /** rides every other day for 200 days: fitness improves 10 bpm, weather and fatigue vary */
  function synth(extra: Record<number, number> = {}): AerobicActivity[] {
    const r = rng(7);
    const g = gauss(r);
    const acts: AerobicActivity[] = [];
    for (let d = 0; d < 200; d += 2) {
      const fitness = 5 - (10 * d) / 200;
      const temp = 18 + 7 * Math.sin(d / 25) + 4 * g();
      const tsb = -10 + 12 * g();
      const day = 2.5 * g() + (extra[d] ?? 0);
      const windows: SteadyWindow[] = [];
      const n = 4 + Math.floor(r() * 16);
      for (let i = 0; i < n; i++) {
        const out = 160 + 130 * r();
        windows.push({ t: 600 + i * 60, out, hr: 70 + 0.35 * out + fitness + 0.6 * (temp - 15) + 0.15 * tsb + day + 1.5 * g(), temp });
      }
      acts.push({ id: d + 1, date: format(addDays(new Date(2026, 0, 5), d), 'yyyy-MM-dd'), indoor: false, tsb, windows });
    }
    return acts;
  }

  it('learns heat and fatigue from the data and follows a fitness trend through them', () => {
    const fit = fitAerobic(synth(), 'ride')!;
    expect(fit.model.heat).toBeGreaterThan(0.4);
    expect(fit.model.heat).toBeLessThan(0.8);
    expect(fit.model.fatigue).toBeGreaterThan(0.08);
    expect(fit.model.fatigue).toBeLessThan(0.22);
    // first and last 20 days (true difference 9 bpm): the very ends of a smoother are its noisiest
    const avg = (ps: typeof fit.points) => ps.reduce((t, p) => t + p.smooth.fitness.mean, 0) / ps.length;
    const first = avg(fit.points.slice(0, 10));
    const last = avg(fit.points.slice(-10));
    expect(first - last).toBeGreaterThan(7);
    expect(first - last).toBeLessThan(11.5);
    // fitter = more output at the reference heart rate
    expect(outputAt(fit.model, last)).toBeGreaterThan(outputAt(fit.model, first) + 15);
    // a change over six weeks is known better than either level (shared evidence), and covers the truth
    const j = fit.points.length - 1;
    const i = j - 21;
    const ch = fitnessChange(fit, i, j)!;
    const indep = Math.hypot(fit.points[i].smooth.fitness.sd, fit.points[j].smooth.fitness.sd);
    expect(ch.sd).toBeLessThan(indep);
    const truth = -(10 * (fit.points[j].id - fit.points[i].id)) / 200;
    expect(Math.abs(ch.diff - truth)).toBeLessThan(2.5 * ch.sd + 1);
    // most rides are unremarkable
    const zs = fit.points.map((p) => p.z).filter((z): z is number => z != null);
    expect(zs.filter((z) => Math.abs(z) > 2.5).length).toBeLessThan(zs.length * 0.05);
  });

  it('flags a ride that cost far less heart rate than its history predicted', () => {
    const fit = fitAerobic(synth({ 150: -12 }), 'ride')!;
    const p = fit.points.find((x) => x.id === 151)!;
    expect(p.z!).toBeLessThan(-2);
    // one ride moves the estimate, but only part of the way: it could be a good day
    expect(p.post.fitness.mean).toBeLessThan(p.prior!.fitness.mean);
    expect(p.prior!.fitness.mean - p.post.fitness.mean).toBeLessThan(12 * 0.6);
  });

  it('reads a ride with no steady stretch from heart rate lagging power', () => {
    const n = 5400;
    // 2 minutes on, 2 minutes off: nothing steady for 10 minutes
    const out = Array.from({ length: n }, (_, i) => (Math.floor(i / 120) % 2 ? 260 : 170));
    // heart rate responds to power over ~40 s, settling 3 bpm under the curve
    const curve: [number, number][] = [[150, 128], [200, 146], [250, 164], [300, 182]];
    let h = 120;
    const hr = out.map((p) => (h += (curveHr(curve, p) - 3 - h) * (1 - Math.exp(-1 / 40))));
    expect(steadyWindows(out, hr, null, WINDOW_SPECS.ride)).toHaveLength(0);
    const bins = kineticBins(out, hr, null, { tau: 40, skip: 600, bin: 10, out: [120, 330], hr: [100, 175] });
    const sec = bins.reduce((t, b) => t + b.sec, 0);
    const cost = bins.reduce((t, b) => t + (b.hr - curveHr(curve, b.out)) * b.sec, 0) / sec;
    expect(sec).toBeGreaterThan(3600);
    expect(Math.abs(cost + 3)).toBeLessThan(0.5);
  });

  it('extracts steady stretches with the heart rate they settled at', () => {
    const n = 3600;
    const out = Array.from({ length: n }, (_, i) => (i < 1800 ? 200 : 260));
    const hr = Array.from({ length: n }, (_, i) => (i < 1800 ? 140 : 160));
    const w = steadyWindows(out, hr, null, WINDOW_SPECS.ride);
    expect(w.length).toBeGreaterThan(20);
    // a window straddling the change isn't steady (one that only clips it is)
    expect(w.some((x) => x.out > 215 && x.out < 245)).toBe(false);
    expect(w.find((x) => x.out === 260)!.hr).toBe(160);
  });
});

describe('efforts in context', () => {
  const curve = (p: Record<number, number>) => CURVE_DURATIONS.map((d) => p[d] ?? null);
  const history = [
    { date: '2026-01-10', power: curve({ 60: 520, 300: 380, 1200: 330, 3600: 300 }), fatigue: { '2000': curve({ 300: 300, 1200: 260 }) } },
    { date: '2026-08-01', power: curve({ 60: 480, 300: 340, 1200: 300, 3600: 260 }), fatigue: { '2000': curve({ 300: 240, 1200: 190 }) } },
    { date: '2026-08-20', power: curve({ 60: 470, 300: 345, 1200: 305, 3600: 255 }), fatigue: { '2000': curve({ 300: 230, 1200: 185 }) } },
    { date: '2026-09-10', power: curve({ 60: 490, 300: 350, 1200: 310, 3600: 262 }), fatigue: { '2000': curve({ 300: 244, 1200: 191 }) } },
  ];

  it('finds the best of 90 days, close calls and durability, without an all-time best', () => {
    const cur = { date: '2026-10-01', power: curve({ 60: 485, 300: 355, 1200: 309, 3600: 294 }), fatigue: { '2000': curve({ 300: 287, 1200: 248 }) } };
    const f = rideEffortFindings(cur, history, null);
    expect(f.find((x) => x.duration === 3600)).toMatchObject({ kind: 'best90', value: 294, ref: 262 });
    expect(f.find((x) => x.kind === 'durability')).toMatchObject({ duration: 1200, kj: 2000, value: 248, ref: 191 });
    expect(f.some((x) => x.kind === 'pb')).toBe(false);
    expect(verdict(null, f).title).toBe('Best of the last 90 days');
  });

  it('flags efforts beyond the current model and all-time bests first', () => {
    const cur = { date: '2026-10-01', power: curve({ 60: 530, 300: 372, 1200: 312 }) };
    const f = rideEffortFindings(cur, history, { cp: 300, wPrime: 20000 });
    expect(f[0]).toMatchObject({ kind: 'pb', duration: 60 });
    expect(f.find((x) => x.kind === 'model')).toMatchObject({ duration: 300, ref: 367 });
  });

  it('weighs heart-rate evidence both ways', () => {
    expect(verdict({ z: -0.5, zFitness: -1.7 }, []).tone).toBe('up');
    expect(verdict({ z: 1.9, zFitness: 0.6 }, []).title).toBe('Heart rate ran high for the effort');
    expect(verdict({ z: 0.2, zFitness: -0.4 }, []).title).toBe('In line with your fitness');
    expect(verdict(null, []).tone).toBe('none');
  });

  it('compares run distances by time', () => {
    const f = runEffortFindings({ date: '2026-10-01', efforts: { '5k': 1290, '10k': 2700 } }, [
      { date: '2026-08-01', efforts: { '5k': 1300, '10k': 2650 } },
      { date: '2019-05-01', efforts: { '5k': 1250 } },
    ]);
    expect(f.find((x) => x.meters === 5000)).toMatchObject({ kind: 'best90' });
    expect(f.find((x) => x.meters === 10000)).toMatchObject({ kind: 'near' });
  });
});

describe('session analysis', () => {
  // blocks of [seconds, output], with seeded noise like a power meter on the road
  const build = (blocks: [number, number][], amp = 0, seed = 7) => {
    let r = seed;
    return blocks.flatMap(([sec, w]) =>
      Array.from({ length: sec }, () => {
        r = (r * 16807) % 2147483647;
        return Math.max(0, w + (r / 2147483647 - 0.5) * 2 * amp);
      }),
    );
  };
  // heart rate chasing output with a 30 s lag, drifting up with the work done above 250 W
  const heart = (p: number[]) => {
    let h = 100;
    let drift = 0;
    return p.map((w) => {
      if (w > 250) drift += 0.004;
      h += (95 + 0.22 * w + drift - h) / 30;
      return Math.round(h);
    });
  };

  it('finds 3 × 10 minutes at threshold as the main set and reads its execution', () => {
    const p = build([[900, 170], [600, 300], [300, 150], [600, 303], [300, 150], [600, 297], [900, 170]], 25);
    const a = analyzeSession({ sport: 'ride', output: p, hr: heart(p), thr: 300 })!;
    expect(a.type).toBe('threshold');
    expect(a.main).toMatchObject({ kind: 'reps' });
    expect(a.main!.reps).toHaveLength(3);
    for (const r of a.main!.reps) {
      expect(Math.abs(r.end - r.start - 600)).toBeLessThanOrEqual(6);
      expect(Math.abs(r.out - 300)).toBeLessThan(6);
    }
    expect(a.main!.rest).toBeGreaterThan(280);
    expect(Math.abs(a.execution!.fade!)).toBeLessThan(0.03);
    // heart rate ends each rep higher than the one before, and falls back between them
    expect(a.execution!.hrRise!).toBeGreaterThan(1);
    expect(a.execution!.hrDrop![0]).toBeGreaterThan(5);
  });

  it('reads 5 × 3 minutes at 115 % as VO2max work and 30/30s as short reps', () => {
    const vo2 = build([[900, 160], ...Array.from({ length: 5 }, () => [[180, 345], [180, 140]] as [number, number][]).flat(), [600, 160]], 20);
    expect(analyzeSession({ sport: 'ride', output: vo2, thr: 300 })).toMatchObject({ type: 'vo2', main: { kind: 'reps', reps: expect.arrayContaining([]) } });
    expect(analyzeSession({ sport: 'ride', output: vo2, thr: 300 })!.main!.reps).toHaveLength(5);
    const thirty = build([[900, 160], ...Array.from({ length: 10 }, () => [[30, 420], [30, 150]] as [number, number][]).flat(), [900, 160]], 15);
    const a = analyzeSession({ sport: 'ride', output: thirty, thr: 300 })!;
    expect(a.type).toBe('anaerobic');
    expect(a.main!.reps.length).toBeGreaterThanOrEqual(9);
    expect(a.main!.dur).toBeLessThan(40);
  });

  it('keeps short rises in an endurance ride from becoming a set', () => {
    const p = build([[1800, 190], [200, 265], [600, 190], [220, 262], [2400, 195]], 30);
    const a = analyzeSession({ sport: 'ride', output: p, thr: 300 })!;
    expect(a.type).toBe('endurance');
    expect(a.main).toBeNull();
    expect(a.efforts.length).toBeGreaterThanOrEqual(1);
  });

  it('reads one long steady effort, and a pyramid as one block', () => {
    const hour = build([[900, 170], [3600, 298], [900, 160]], 20);
    expect(analyzeSession({ sport: 'ride', output: hour, thr: 300 })).toMatchObject({ type: 'threshold', main: { kind: 'single' } });
    const pyramid = build([[900, 170], [1200, 282], [300, 150], [900, 305], [300, 150], [600, 320], [900, 160]], 20);
    const a = analyzeSession({ sport: 'ride', output: pyramid, thr: 300 })!;
    expect(a.main!.kind).toBe('ladder');
    expect(a.main!.reps).toHaveLength(3);
  });

  it('calls a surging bunch ride a race, unless a set of reps carried it', () => {
    // irregular surges (10–60 s at 120–180 %) between soft-pedalling and tempo, for 90 minutes
    let r = 11;
    const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
    const surges = (k: number): [number, number][] => Array.from({ length: k }, () => [[Math.round(10 + rnd() * 50), Math.round(360 + rnd() * 180)], [Math.round(30 + rnd() * 120), 120], [Math.round(30 + rnd() * 90), 255]] as [number, number][]).flat();
    const bunch = build([[600, 180], ...surges(34), [600, 170]], 40);
    expect(analyzeSession({ sport: 'ride', output: bunch, thr: 300 })!.type).toBe('race');
    const withSet = build([[600, 180], ...surges(14), [600, 305], [300, 150], [600, 305], [300, 150], [600, 300], [600, 170]], 40);
    expect(analyzeSession({ sport: 'ride', output: withSet, thr: 300 })!.type).toBe('threshold');
  });

  it('does not turn strides at the end of an easy run into intervals', () => {
    const run = build([[1800, 2.9], ...Array.from({ length: 6 }, () => [[20, 4.6], [70, 2.2]] as [number, number][]).flat(), [300, 2.6]], 0.15);
    const a = analyzeSession({ sport: 'run', output: run, thr: 3.6 })!;
    expect(a.type).toBe('endurance');
    expect(a.main).toBeNull();
    const reps = build([[900, 2.8], ...Array.from({ length: 6 }, () => [[180, 3.9], [120, 2.3]] as [number, number][]).flat(), [600, 2.7]], 0.12);
    expect(analyzeSession({ sport: 'run', output: reps, thr: 3.6 })).toMatchObject({ type: 'vo2', main: { kind: 'reps' } });
  });
});

describe('session progression', () => {
  const set = (id: number, date: string, o: Partial<SetSummary>): SetSummary => ({ id, date, type: 'threshold', kind: 'reps', reps: 3, dur: 600, out: 300, hrEnd: 175, temp: 18, kjBefore: 200, ...o });

  it('compares like with like: same kind, similar dose and output', () => {
    const base = set(1, '2026-09-01', {});
    expect(comparableSets(base, set(2, '2026-09-08', { reps: 2 }))).toBe(true);
    expect(comparableSets(base, set(2, '2026-09-08', { dur: 720 }))).toBe(true);
    // 2 × 10 against 3 × 12: both more reps and longer ones
    expect(comparableSets(set(1, '2026-09-01', { reps: 2 }), set(2, '2026-09-08', { reps: 3, dur: 720 }))).toBe(false);
    expect(comparableSets(base, set(2, '2026-09-08', { type: 'tempo', out: 260 }))).toBe(false);
    expect(comparableSets(base, set(2, '2026-09-08', { kind: 'single', reps: 1, dur: 2400 }))).toBe(false);
  });

  it('reads the change on the last comparable set and the rank over the year', () => {
    const past = [set(1, '2025-08-01', { out: 330 }), set(2, '2026-06-01', { out: 285 }), set(3, '2026-08-01', { out: 296, hrEnd: 178 }), set(4, '2026-08-20', { type: 'tempo', out: 250 })];
    const p = progression(set(5, '2026-09-10', { out: 305, hrEnd: 176 }), past)!;
    // the 2025 set is over a year old, the tempo set is a different workout
    expect(p.series.map((s) => s.id)).toEqual([2, 3, 5]);
    expect(p.last!.id).toBe(3);
    expect(p.change!).toBeCloseTo(305 / 296 - 1, 6);
    expect(p.hrChange).toBe(-2);
    expect(p).toMatchObject({ rank: 1, of: 3 });
    expect(progression(set(6, '2026-09-10', {}), [])).toBeNull();
    expect(setLabel({ kind: 'reps', reps: 3, dur: 600 })).toBe('3 × 10 min');
    expect(setLabel({ kind: 'reps', reps: 8, dur: 150 })).toBe('8 × 2.5 min');
    expect(setLabel({ kind: 'single', reps: 1, dur: 2400 })).toBe('40 min');
  });
});

describe('training review', () => {
  const act = (id: number, date: string, o: Partial<ReviewActivity> = {}): ReviewActivity => ({ id, date, sport: 'ride', name: 'Ride', moving: 5400, tss: 90, type: 'endurance', long: false, set: null, findings: [], zFitness: null, z: null, seiler: [4800, 500, 100], ...o });
  const base = { weeks: 4, tss: 500, hours: 9, sessions: 6, hard: 1.5, long: 1, intensity: 0.12, restDays: 1.5 };
  const input = (o: Partial<ReviewInput>): ReviewInput => ({ from: '2026-09-28', to: '2026-10-04', weeks: 1, days: 7, acts: [], baseline: base, ctl: [60, 61], atl: 65, tsb: -5, aerobic: null, ftp: null, longStreak: 0, ...o });

  it('reads a week of normal load with its progress', () => {
    const better = act(2, '2026-09-30', { type: 'threshold', tss: 110, set: { id: 2, date: '2026-09-30', type: 'threshold', kind: 'reps', reps: 3, dur: 600, out: 306, hrEnd: 176, temp: null, kjBefore: 150, change: 0.025, hrChange: -1, rank: 1, of: 4, lastDate: '2026-09-15', lastOut: 298 } });
    const r = reviewPeriod(input({ acts: [act(1, '2026-09-28'), better, act(3, '2026-10-02'), act(4, '2026-10-04', { long: true, moving: 12600, tss: 200 })], ctl: [60, 62] }));
    expect(r.title).toBe('build');
    expect(r.tone).toBe('up');
    expect(r.signals[0]).toMatchObject({ kind: 'set', tone: 'up' });
    expect(r.notes[0]).toMatchObject({ kind: 'load', tss: 490 });
    expect(r.notes.find((n) => n.kind === 'mix')).toMatchObject({ hard: [{ id: 2 }] });
    expect(r.notes.find((n) => n.kind === 'long')).toBeTruthy();
    expect(r.stats).toMatchObject({ sessions: 4, hard: 1, long: 1, restDays: 3 });
  });

  it('tells a recovery week from a jump in load, and flags heart rate running high', () => {
    const easy = reviewPeriod(input({ acts: [act(1, '2026-09-29', { tss: 60 }), act(2, '2026-10-01', { tss: 70, type: 'recovery' }), act(3, '2026-10-03', { tss: 80 })], ctl: [62, 58] }));
    expect(easy.title).toBe('recovery');
    expect(easy.notes.find((n) => n.kind === 'mix')).toMatchObject({ hard: [] });
    const jump = reviewPeriod(input({ acts: [1, 2, 3, 4, 5, 6, 7].map((d) => act(d, `2026-10-0${Math.min(d, 4)}`.replace('2026-10-0', d <= 3 ? '2026-09-2' : '2026-10-0').slice(0, 10), { tss: 120, type: d % 2 ? 'threshold' : 'endurance', z: d === 3 || d === 5 ? 1.8 : null })), ctl: [60, 70], tsb: -32 }));
    expect(jump.title).toBe('spike');
    expect(jump.tone).toBe('warn');
    expect(jump.notes.find((n) => n.kind === 'hrHigh')).toMatchObject({ tone: 'warn' });
    expect(jump.notes.find((n) => n.kind === 'form')).toMatchObject({ tone: 'warn' });
  });

  it('judges a week under way by its pace, and says nothing about missing long rides until it ends', () => {
    // 320 TSS in three days is on course for ~750 against a usual 500
    const r = reviewPeriod(input({ days: 3, acts: [act(1, '2026-09-28', { tss: 160 }), act(2, '2026-09-30', { tss: 160 })], longStreak: 5 }));
    expect(r.partial).toBe(true);
    expect(r.stats.perWeek.tss).toBeCloseTo((320 * 7) / 3, 6);
    expect(r.title).toBe('big');
    expect(r.notes.some((n) => n.kind === 'noLong')).toBe(false);
    expect(reviewPeriod(input({ acts: [act(1, '2026-09-28')], longStreak: 5 })).notes.some((n) => n.kind === 'noLong')).toBe(true);
    expect(reviewPeriod(input({ acts: [] })).title).toBe('rest');
  });
});
