/**
 * A structured workout as a FIT workout file, the format Garmin devices load workouts from
 * (copy it to the device's GARMIN/NewFiles folder). Targets are a share of FTP (or of
 * threshold heart rate), so the device works them out from the threshold set on it.
 */
import type { Sport, WorkoutStep, WorkoutStructure } from '../types';

// FIT base types
const ENUM = 0x00;
const UINT16 = 0x84;
const UINT32 = 0x86;
const STRING = 0x07;

const STEP_NAME = 16;
const WORKOUT_NAME = 40;
/** seconds from the Unix epoch to FIT's (31 Dec 1989) */
const FIT_EPOCH = 631065600;

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
function crc16(bytes: Uint8Array, crc = 0): number {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

type Field = [num: number, size: number, type: number];

class Writer {
  bytes: number[] = [];
  u8(x: number) {
    this.bytes.push(x & 0xff);
  }
  u16(x: number) {
    this.u8(x);
    this.u8(x >> 8);
  }
  u32(x: number) {
    this.u16(x & 0xffff);
    this.u16(Math.floor(x / 0x10000));
  }
  str(s: string, size: number) {
    // null-terminated, cut at a whole character
    let b = new TextEncoder().encode(s);
    while (b.length > size - 1) b = new TextEncoder().encode((s = s.slice(0, -1)));
    for (let i = 0; i < size; i++) this.u8(b[i] ?? 0);
  }
  define(local: number, global: number, fields: Field[]) {
    this.u8(0x40 | local);
    this.u8(0); // reserved
    this.u8(0); // little-endian
    this.u16(global);
    this.u8(fields.length);
    for (const [n, s, t] of fields) this.u8(n), this.u8(s), this.u8(t);
  }
}

/** FIT's step intensities */
const INTENSITY: Record<WorkoutStep['intent'], number> = { active: 0, rest: 1, recovery: 1, warmup: 2, cooldown: 3 };

interface FitStep {
  name: string;
  seconds: number;
  /** % of threshold */
  low: number;
  high: number;
  intensity: number;
}

/** A step as the device will hold it: a ramp becomes a staircase of steady steps, a minute or more each. */
function steady(s: WorkoutStep): FitStep[] {
  const pct = (x: number) => Math.round(x * 100);
  const name = s.label ?? (s.intent === 'active' ? 'Interval' : s.intent[0].toUpperCase() + s.intent.slice(1));
  // a steady target: ±2% about it, so the device has a range to hold
  const band = (p: number) => ({ low: Math.max(1, p - 2), high: p + 2 });
  if (!s.ramp || s.low === s.high) {
    const mid = pct((s.low + s.high) / 2);
    return [{ name, seconds: s.duration, ...(s.low === s.high ? band(mid) : { low: pct(s.low), high: pct(s.high) }), intensity: INTENSITY[s.intent] }];
  }
  const n = Math.max(1, Math.min(6, Math.floor(s.duration / 60)));
  const out: FitStep[] = [];
  let done = 0;
  for (let i = 0; i < n; i++) {
    const end = Math.round((s.duration * (i + 1)) / n);
    out.push({ name, seconds: end - done, ...band(pct(s.low + ((s.high - s.low) * (i + 0.5)) / n)), intensity: INTENSITY[s.intent] });
    done = end;
  }
  return out;
}

export function toFitWorkout(name: string, structure: WorkoutStructure, sport: Sport = 'ride', created = new Date()): Uint8Array {
  // FIT's targets: 4 power, 1 heart rate; for a pace target there's no share of threshold, so it's open
  const target = structure.target === 'power' ? 4 : structure.target === 'hr' ? 1 : 2;
  type Row = { step: FitStep } | { repeatFrom: number; count: number };
  const rows: Row[] = [];
  for (const b of structure.blocks) {
    if (b.kind === 'step') for (const s of steady(b)) rows.push({ step: s });
    else {
      const from = rows.length;
      for (const s of b.steps) for (const x of steady(s)) rows.push({ step: x });
      if (b.count > 1) rows.push({ repeatFrom: from, count: b.count });
    }
  }

  const w = new Writer();
  w.define(0, 0, [
    [0, 1, ENUM], // type
    [1, 2, UINT16], // manufacturer
    [2, 2, UINT16], // product
    [4, 4, UINT32], // time created
  ]);
  w.u8(0);
  w.u8(5); // a workout
  w.u16(255); // development
  w.u16(0);
  w.u32(Math.floor(created.getTime() / 1000) - FIT_EPOCH);

  w.define(1, 26, [
    [4, 1, ENUM], // sport
    [6, 2, UINT16], // steps
    [8, WORKOUT_NAME, STRING],
  ]);
  w.u8(1);
  w.u8(sport === 'run' ? 1 : sport === 'swim' ? 5 : 2);
  w.u16(rows.length);
  w.str(name, WORKOUT_NAME);

  w.define(2, 27, [
    [254, 2, UINT16], // message index
    [0, STEP_NAME, STRING],
    [1, 1, ENUM], // duration type
    [2, 4, UINT32], // duration value
    [3, 1, ENUM], // target type
    [4, 4, UINT32], // target value
    [5, 4, UINT32], // custom target low
    [6, 4, UINT32], // custom target high
    [7, 1, ENUM], // intensity
  ]);
  rows.forEach((r, i) => {
    w.u8(2);
    w.u16(i);
    if ('step' in r) {
      const s = r.step;
      w.str(s.name, STEP_NAME);
      w.u8(0); // by time
      w.u32(Math.round(s.seconds * 1000));
      w.u8(target);
      w.u32(0); // a custom range
      // power: 0–1000 is % of FTP; heart rate: 0–100 is % of threshold
      w.u32(target === 2 ? 0 : s.low);
      w.u32(target === 2 ? 0 : s.high);
      w.u8(s.intensity);
    } else {
      w.str('Repeat', STEP_NAME);
      w.u8(6); // repeat until the steps are done…
      w.u32(r.repeatFrom); // …from this step
      w.u8(2); // open
      w.u32(r.count); // this many times
      w.u32(0);
      w.u32(0);
      w.u8(0);
    }
  });

  const data = Uint8Array.from(w.bytes);
  const header = new Uint8Array(14);
  const hv = new DataView(header.buffer);
  header[0] = 14;
  header[1] = 0x20; // protocol 2.0
  hv.setUint16(2, 2132, true); // profile 21.32
  hv.setUint32(4, data.length, true);
  header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  hv.setUint16(12, crc16(header.subarray(0, 12)), true);
  const out = new Uint8Array(14 + data.length + 2);
  out.set(header);
  out.set(data, 14);
  const crc = crc16(out.subarray(0, 14 + data.length));
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = crc >> 8;
  return out;
}
