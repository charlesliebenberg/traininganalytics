import { describe, expect, it } from 'vitest';
import { durWords, parseDuration } from './format';

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
