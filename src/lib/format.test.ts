import { describe, expect, it } from 'vitest';
import { durWords, fmtPace, fmtPaceSec, parseDuration, setUnits } from './format';

describe('pace rounding', () => {
  it('carries rounded seconds into minutes', () => {
    setUnits('metric');
    expect(fmtPace(1000 / 299.6, 'run')).toBe('5:00 /km');
    expect(fmtPaceSec(299.6)).toBe('5:00');
    expect(fmtPace(100 / 119.8, 'swim')).toBe('2:00 /100m');
    expect(fmtPaceSec(299.4)).toBe('4:59');
  });
  it('formats imperial pace and missing or nonfinite values', () => {
    setUnits('imperial');
    expect(fmtPace(1609.344 / 479.9, 'run')).toBe('8:00 /mi');
    setUnits('metric');
    expect(fmtPace(NaN)).toBe('–');
    expect(fmtPace(Infinity)).toBe('–');
    expect(fmtPaceSec(NaN)).toBe('–');
  });
});

describe('durations typed by hand', () => {
  it('reads clock times, units and bare minutes', () => {
    expect(parseDuration('7:30')).toBe(450);
    expect(parseDuration('1:05:00')).toBe(3900);
    expect(parseDuration('45s')).toBe(45);
    expect(parseDuration('20m')).toBe(1200);
    expect(parseDuration('20 min')).toBe(1200);
    expect(parseDuration('1h20')).toBe(4800);
    expect(parseDuration('1h 20m')).toBe(4800);
    expect(parseDuration('1.5h')).toBe(5400);
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration('20')).toBe(1200);
    expect(parseDuration('0.5')).toBe(30);
  });

  it('refuses what it cannot read', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('fast')).toBeNull();
    expect(parseDuration('0')).toBeNull();
    expect(parseDuration('0:00')).toBeNull();
    expect(parseDuration('7:3x')).toBeNull();
  });

  it('says it back in words', () => {
    expect(durWords(450)).toBe('7 min 30 s');
    expect(durWords(4800)).toBe('1 h 20 min');
    expect(durWords(45)).toBe('45 s');
    expect(durWords(3600)).toBe('1 h');
  });
});
