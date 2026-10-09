import type { Activity, ActivityCurves, Sport, Streams, Thresholds, TssMethod } from '../types';
import { encodePolyline, simplifyTrack } from '../polyline';
import {
  CURVE_DURATIONS,
  centeredMean,
  fillGaps,
  hasData,
  maxDefined,
  meanDefined,
  meanMax,
  resample1Hz,
  round,
  toFloat,
} from './series';
import { fatigueCurves, normalizedPower, npCurve, powerCurve, tssFromIf, wPrimeBalance } from './power';
import { decoupling, hrTss, trimp } from './heartrate';
import { bestEfforts, cleanRunSpeed, deriveGrade, distanceFromSpeed, gradeAdjustedSpeed, normalizedGradedSpeed, swimTss } from './running';
import { HR_ZONES, PACE_ZONES, POWER_ZONES, SEILER_HR_BOUNDS, SEILER_ZONES, timeInZones } from './zones';
import { analyzeSession, type SessionAnalysis } from './session';

export interface RawSamples {
  /** seconds from start, ascending */
  time: number[];
  watts?: (number | null)[];
  heartrate?: (number | null)[];
  cadence?: (number | null)[];
  speed?: (number | null)[];
  distance?: (number | null)[];
  altitude?: (number | null)[];
  lat?: (number | null)[];
  lng?: (number | null)[];
  temp?: (number | null)[];
  grade?: (number | null)[];
  moving?: (number | boolean | null)[];
}

const MAX_SECONDS = 36 * 3600;

const r1 = (arr: (number | null)[] | null, d = 1) => (arr ? arr.map((v) => (v == null ? null : round(v, d)))  : null);

/** Resample raw device/API samples onto a uniform 1 Hz grid. */
export function normalizeStreams(raw: RawSamples): Streams | null {
  if (!raw.time?.length) return null;
  const t0 = raw.time[0];
  const time = raw.time.map((t) => t - t0);
  const length = Math.min(MAX_SECONDS, Math.floor(time[time.length - 1]) + 1);
  if (length < 2) return null;
  const rs = (v: (number | null)[] | undefined, o?: Parameters<typeof resample1Hz>[3]) =>
    v && v.some((x) => x != null) ? resample1Hz(time, v, length, o) : null;

  const watts = rs(raw.watts, { gapValue: 0 });
  const heartrate = rs(raw.heartrate, { maxInterpGap: 10 });
  const cadence = rs(raw.cadence, { gapValue: null });
  const altitude = rs(raw.altitude, { maxInterpGap: 30 });
  const lat = rs(raw.lat, { maxInterpGap: 30 });
  const lng = rs(raw.lng, { maxInterpGap: 30 });
  const temp = rs(raw.temp, { maxInterpGap: 120 });
  let distance = rs(raw.distance, { maxInterpGap: 3600 });
  if (distance) {
    const filled = fillGaps(distance);
    distance = filled ? Array.from(filled) : distance;
  }
  let speed = rs(raw.speed, { gapValue: 0 });
  if (!speed && distance) {
    const d = distance as number[];
    const inst = d.map((v, i) => (i === 0 ? 0 : Math.max(0, v - d[i - 1])));
    speed = Array.from(centeredMean(inst, 5));
  }
  let moving: number[] | null = null;
  if (raw.moving?.length) {
    const m = resample1Hz(time, raw.moving.map((v) => (v == null ? null : v ? 1 : 0)), length, { hold: true, gapValue: 0, maxInterpGap: 10 });
    moving = m.map((v) => (v ? 1 : 0));
  } else {
    moving = new Array(length).fill(0);
    for (let i = 0; i < length; i++) {
      const s = speed?.[i] ?? null;
      const p = watts?.[i] ?? 0;
      const c = cadence?.[i] ?? 0;
      if (s != null ? s > 0.4 || p > 0 : p > 0 || c > 0 || heartrate?.[i] != null) moving[i] = 1;
    }
  }
  let grade = rs(raw.grade, { maxInterpGap: 30 });
  if (!grade && altitude && distance) grade = deriveGrade(altitude, distance);

  return {
    time: Array.from({ length }, (_, i) => i),
    watts: watts ? watts.map((v) => Math.max(0, Math.round(v ?? 0))) : null,
    heartrate: heartrate ? heartrate.map((v) => (v == null ? null : Math.round(v))) : null,
    cadence: cadence ? cadence.map((v) => (v == null ? null : Math.round(v))) : null,
    speed: r1(speed, 2),
    distance: r1(distance, 1),
    altitude: r1(altitude, 1),
    lat: r1(lat, 6),
    lng: r1(lng, 6),
    temp: r1(temp, 1),
    grade: r1(grade, 1),
    moving,
  };
}

export function elevationGain(altitude: (number | null)[] | null | undefined): number | null {
  const a = altitude ? fillGaps(altitude) : null;
  if (!a) return null;
  const s = centeredMean(a, 7);
  let gain = 0;
  let ref = s[0];
  // hysteresis to suppress barometric noise
  for (let i = 1; i < s.length; i++) {
    if (s[i] > ref + 1) {
      gain += s[i] - ref;
      ref = s[i];
    } else if (s[i] < ref - 1) ref = s[i];
  }
  return gain;
}

/** VAM curve: best climbing rate (m/h) over each duration ≥ 60 s. */
export function vamCurve(altitude: (number | null)[] | null | undefined, durations = CURVE_DURATIONS): (number | null)[] | null {
  const a = altitude ? fillGaps(altitude) : null;
  if (!a || a.length < 120) return null;
  const s = centeredMean(a, 15);
  return durations.map((d) => {
    if (d < 60 || d >= s.length) return null;
    let best = 0;
    for (let i = 0; i + d < s.length; i++) {
      const g = s[i + d] - s[i];
      if (g > best) best = g;
    }
    return best > 0 ? Math.round((best * 3600) / d) : null;
  });
}

export type ComputedMetrics = Pick<
  Activity,
  | 'elapsedTime'
  | 'movingTime'
  | 'distance'
  | 'elevationGain'
  | 'avgPower'
  | 'maxPower'
  | 'np'
  | 'intensity'
  | 'tss'
  | 'tssMethod'
  | 'vi'
  | 'ef'
  | 'decoupling'
  | 'work'
  | 'calories'
  | 'avgHr'
  | 'maxHr'
  | 'avgCadence'
  | 'avgSpeed'
  | 'maxSpeed'
  | 'trimp'
  | 'avgTemp'
  | 'wbalMin'
  | 'hasPower'
  | 'hasHr'
  | 'hasGps'
  | 'zones'
  | 'bestEfforts'
  | 'ftpUsed'
> & { curves: ActivityCurves; polyline: string | null; session: SessionAnalysis | null };

const DEFAULT_TSS_PER_HOUR: Partial<Record<Sport, number>> = {
  ride: 50,
  run: 60,
  swim: 55,
  walk: 20,
  hike: 35,
  strength: 35,
  ski: 55,
  row: 55,
  other: 40,
};

/** A stop shorter than this keeps its samples (traffic lights, coasting without data). */
const STOP_MIN_S = 20;

/**
 * Which samples count as moving. Power, cadence or speed means activity; only stretches of
 * 20+ s with none of them count as stopped, so café stops and pauses drop out while coasting
 * and traffic lights stay in (as they would on a device without auto-pause). The device's
 * own "moving" flag is used only when there are no such channels: it marks indoor rides
 * without a speed sensor as stationary even while the rider holds 250 W.
 */
export function movingMask(s: Pick<Streams, 'time' | 'watts' | 'cadence' | 'speed' | 'moving' | 'heartrate'>): number[] {
  const n = s.time.length;
  const channels = !!(s.watts || s.cadence || s.speed);
  const active = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    active[i] = channels
      ? (s.watts?.[i] ?? 0) > 0 || (s.cadence?.[i] ?? 0) > 0 || (s.speed?.[i] ?? 0) > 0.5
        ? 1
        : 0
      : s.moving
        ? (s.moving[i] ? 1 : 0)
        : s.heartrate?.[i] != null
          ? 1
          : 0;
  }
  const out = new Array<number>(n).fill(1);
  for (let i = 0; i < n; ) {
    if (active[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !active[j]) j++;
    if (j - i >= STOP_MIN_S) out.fill(0, i, j);
    i = j;
  }
  return out;
}

/**
 * A temperature stream worth reading: within what weather allows, and not a sensor stuck on
 * one value (some head units report −7 °C throughout, bar a stray reading or two, when they
 * have no working sensor). Over five minutes or more, a real sensor moves.
 */
export function usableTemp(temp: (number | null)[] | null | undefined): boolean {
  if (!temp) return false;
  const counts = new Map<number, number>();
  let lo = Infinity,
    hi = -Infinity,
    n = 0;
  for (const v of temp) {
    if (v == null) continue;
    n++;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!n || lo < -40 || hi > 60) return false;
  return !(n >= 300 && Math.max(...counts.values()) / n >= 0.98);
}

export function isBike(sport: Sport) {
  return sport === 'ride';
}
export function isFoot(sport: Sport) {
  return sport === 'run' || sport === 'walk' || sport === 'hike';
}

/** Compute every derived metric for an activity from its 1 Hz streams. */
export function computeMetrics(s: Streams, sport: Sport, th: Thresholds): ComputedMetrics {
  const n = s.time.length;
  const mask = movingMask(s);
  const movingTime = mask.reduce((a, b) => a + b, 0);
  const hasPower = hasData(s.watts, 30);
  const hasHr = hasData(s.heartrate, 30);
  // position fixes, not positive values: south of the equator latitudes are negative
  let fixes = 0;
  if (s.lat && s.lng) for (let i = 0; i < s.lat.length && fixes < 10; i++) if (s.lat[i] != null && s.lng[i] != null && (s.lat[i] !== 0 || s.lng[i] !== 0)) fixes++;
  const hasGps = fixes >= 10;
  const lastDist = s.distance ? maxDefined(s.distance) : null;
  const distance = lastDist && lastDist > 0 ? lastDist : null;
  const lthr = sport === 'run' ? th.runLthr || th.lthr : th.lthr;

  let np: number | null = null,
    avgPower: number | null = null,
    maxPower: number | null = null,
    work: number | null = null,
    vi: number | null = null,
    wbalMin: number | null = null;
  const curves: ActivityCurves = {};
  const zones: NonNullable<Activity['zones']> = {};

  if (hasPower && s.watts) {
    // NP and average power over moving time: a café stop is not 40 minutes of zero watts
    const moving = s.watts.filter((_, i) => mask[i]);
    np = normalizedPower(moving);
    avgPower = moving.length ? moving.reduce((a, b) => a + (b ?? 0), 0) / moving.length : null;
    maxPower = maxDefined(s.watts);
    work = s.watts.reduce((a, b) => a + (b ?? 0), 0) / 1000;
    vi = np && avgPower ? np / avgPower : null;
    curves.power = powerCurve(s.watts);
    curves.np = npCurve(s.watts);
    curves.fatigue = fatigueCurves(s.watts);
    // zones and W′ balance use the bike FTP / CP: meaningless for running power
    if (isBike(sport)) {
      zones.power = timeInZones(s.watts, th.ftp, POWER_ZONES, mask);
      // W′ balance is a critical-power model: it needs CP, not FTP
      const wb = wPrimeBalance(s.watts, th.cp ?? th.ftp, th.wPrime);
      wbalMin = Math.min(...wb);
    }
  }
  if (hasHr && s.heartrate) {
    const hrFilled = fillGaps(s.heartrate);
    if (hrFilled) curves.hr = meanMax(hrFilled).map((v) => round(v, 0));
    zones.hr = timeInZones(s.heartrate, lthr, HR_ZONES, mask);
  }

  const avgHr = hasHr ? meanDefined(s.heartrate!, mask) : null;
  const maxHr = hasHr ? maxDefined(s.heartrate!) : null;
  const avgSpeed = distance && movingTime ? distance / movingTime : null;
  const maxSpeed = s.speed ? maxDefined(centeredMean(toFloat(s.speed), 3)) : null;
  const cadNonZero = s.cadence ? s.cadence.filter((c) => c != null && c > 0) : [];
  const avgCadence = cadNonZero.length > 30 ? meanDefined(cadNonZero) : null;
  const avgTemp = usableTemp(s.temp) ? meanDefined(s.temp!) : null;

  // running: grade adjusted pace
  let gap: number[] | null = null;
  let ngs: number | null = null;
  // runs: GPS glitches out of the speed used for pace, curves and best efforts
  const runSpeed = sport === 'run' && s.speed ? cleanRunSpeed(s.speed) : null;
  if (isFoot(sport) && s.speed && distance) {
    const speed = runSpeed ?? s.speed.map((v) => v ?? 0);
    gap = s.grade ? gradeAdjustedSpeed(speed, s.grade) : speed;
    ngs = normalizedGradedSpeed(gap, mask);
    curves.speed = meanMax(Float64Array.from(speed)).map((v) => round(v, 2));
    if (th.runThresholdSpeed) zones.pace = timeInZones(gap, th.runThresholdSpeed, PACE_ZONES, mask);
  }
  if (sport === 'swim' && s.speed) curves.speed = meanMax(toFloat(s.speed)).map((v) => round(v, 2));
  if ((isBike(sport) || isFoot(sport)) && s.altitude) {
    const vc = vamCurve(s.altitude);
    if (vc && vc.some((v) => v != null)) curves.vam = vc;
  }

  // Seiler 3-zone distribution: power for bikes, HR otherwise
  if (zones.power && isBike(sport)) zones.seiler = timeInZones(s.watts!, th.ftp, SEILER_ZONES, mask);
  else if (hasHr) zones.seiler = timeInZones(s.heartrate!, lthr, SEILER_HR_BOUNDS, mask);

  // TSS with method priority: power → pace → swim → HR → estimate
  let tss: number | null = null;
  let intensity: number | null = null;
  let method: TssMethod = 'none';
  if (isBike(sport) && np && th.ftp) {
    intensity = np / th.ftp;
    tss = tssFromIf(movingTime, intensity);
    method = 'power';
  } else if (sport === 'run' && ngs && th.runThresholdSpeed) {
    intensity = ngs / th.runThresholdSpeed;
    tss = tssFromIf(movingTime, intensity);
    method = 'pace';
  } else if (sport === 'swim' && avgSpeed && th.swimCss) {
    tss = swimTss(movingTime, avgSpeed, th.swimCss);
    intensity = avgSpeed / th.swimCss;
    method = 'swim';
  } else if (!isBike(sport) && np && th.ftp) {
    intensity = np / th.ftp;
    tss = tssFromIf(movingTime, intensity);
    method = 'power';
  }
  if (tss == null && hasHr) {
    tss = hrTss(s.heartrate!, lthr, th.restHr, th.maxHr, mask);
    if (tss != null) {
      method = 'hr';
      intensity = Math.sqrt(tss / 100 / (movingTime / 3600));
    }
  }
  if (tss == null) {
    tss = ((DEFAULT_TSS_PER_HOUR[sport] ?? 40) * movingTime) / 3600;
    method = 'estimate';
  }

  // efficiency & decoupling — Pw:HR / Pa:HR drift only means something for a steady hour or
  // so: on intervals, or across a long stop, it measures the session's shape, not the athlete
  let ef: number | null = null;
  let dec: number | null = null;
  if (hasHr && avgHr) {
    if (np && isBike(sport)) {
      ef = np / avgHr;
      if (movingTime >= 3600 && (vi ?? 9) <= 1.25) dec = decoupling(s.watts!, s.heartrate!, mask);
    } else if (ngs && gap) {
      ef = (ngs * 60) / avgHr; // metres per minute per beat
      if (movingTime >= 2700) dec = decoupling(gap, s.heartrate!, mask);
    }
  }

  let calories: number | null = null;
  if (work) calories = work * 1.0; // ~24% gross efficiency ⇒ kcal ≈ kJ
  else if (isFoot(sport) && distance) calories = (distance / 1000) * th.weight * (sport === 'run' ? 1.0 : 0.6);
  else if (avgHr) calories = (movingTime / 60) * ((-55.0969 + 0.6309 * avgHr + 0.1988 * th.weight + 0.2017 * 35) / 4.184);

  const polyline = hasGps ? encodePolyline(simplifyTrack(s.lat!, s.lng!, 500)) : null;

  // what the session was: bike power against FTP, grade-adjusted pace against threshold
  let session: SessionAnalysis | null = null;
  if (isBike(sport) && hasPower && th.ftp && intensity != null) session = analyzeSession({ sport: 'ride', output: s.watts!, hr: hasHr ? s.heartrate : null, moving: mask, thr: th.ftp, intensity, vi });
  else if (sport === 'run' && gap && th.runThresholdSpeed && intensity != null && method === 'pace') session = analyzeSession({ sport: 'run', output: gap, hr: hasHr ? s.heartrate : null, moving: mask, thr: th.runThresholdSpeed, intensity, vi: null });

  return {
    elapsedTime: n,
    movingTime,
    distance: round(distance, 1),
    elevationGain: round(elevationGain(s.altitude), 0),
    avgPower: round(avgPower, 0),
    maxPower: round(maxPower, 0),
    np: round(np, 0),
    intensity: round(intensity, 3),
    tss: round(tss, 1),
    tssMethod: method,
    vi: round(vi, 3),
    ef: round(ef, 3),
    decoupling: round(dec, 1),
    work: round(work, 0),
    calories: round(calories, 0),
    avgHr: round(avgHr, 0),
    maxHr: round(maxHr, 0),
    avgCadence: round(avgCadence, 0),
    avgSpeed: round(avgSpeed, 3),
    maxSpeed: round(maxSpeed, 2),
    trimp: round(hasHr ? trimp(s.heartrate!, th.restHr, th.maxHr, mask) : null, 1),
    avgTemp: round(avgTemp, 1),
    wbalMin: round(wbalMin, 0),
    hasPower,
    hasHr,
    hasGps,
    zones: Object.keys(zones).length ? zones : null,
    bestEfforts: runSpeed ? bestEfforts(distanceFromSpeed(runSpeed)) : isFoot(sport) && s.distance ? bestEfforts(s.distance) : null,
    ftpUsed: hasPower ? th.ftp : null,
    curves,
    polyline,
    session,
  };
}

export interface SummaryInput {
  sport: Sport;
  elapsedTime: number;
  movingTime: number;
  distance?: number | null;
  avgPower?: number | null;
  weightedPower?: number | null;
  avgHr?: number | null;
  avgSpeed?: number | null;
}

/** Metrics for activities that only have summary data (no streams yet). */
export function metricsFromSummary(a: SummaryInput, th: Thresholds): { tss: number; intensity: number | null; method: TssMethod; ef: number | null } {
  const lthr = a.sport === 'run' ? th.runLthr || th.lthr : th.lthr;
  if (a.weightedPower && th.ftp && a.sport === 'ride') {
    const i = a.weightedPower / th.ftp;
    return { tss: tssFromIf(a.movingTime, i), intensity: i, method: 'power', ef: a.avgHr ? a.weightedPower / a.avgHr : null };
  }
  if (a.sport === 'run' && a.avgSpeed && th.runThresholdSpeed) {
    const i = (a.avgSpeed * 1.03) / th.runThresholdSpeed;
    return { tss: tssFromIf(a.movingTime, i), intensity: i, method: 'pace', ef: a.avgHr ? (a.avgSpeed * 60) / a.avgHr : null };
  }
  if (a.sport === 'swim' && a.avgSpeed && th.swimCss) {
    return { tss: swimTss(a.movingTime, a.avgSpeed, th.swimCss) ?? 0, intensity: a.avgSpeed / th.swimCss, method: 'swim', ef: null };
  }
  if (a.avgHr && lthr > th.restHr) {
    const hrr = (a.avgHr - th.restHr) / (lthr - th.restHr);
    const i = Math.max(0.3, Math.min(1.2, 0.2 + 0.8 * hrr));
    return { tss: tssFromIf(a.movingTime, i), intensity: i, method: 'hr', ef: null };
  }
  return { tss: ((DEFAULT_TSS_PER_HOUR[a.sport] ?? 40) * a.movingTime) / 3600, intensity: null, method: 'estimate', ef: null };
}
