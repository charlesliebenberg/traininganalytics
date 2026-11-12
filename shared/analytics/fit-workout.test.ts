import { describe, expect, it } from 'vitest';
import FitParser from 'fit-file-parser';
import { toFitWorkout } from './fit-workout';
import { repeat, step } from './workout';
import type { WorkoutStructure } from '../types';

const parse = (bytes: Uint8Array) =>
  new Promise<any>((resolve, reject) => new FitParser({ force: false, mode: 'list' }).parse(Buffer.from(bytes), (err: unknown, data: unknown) => (err ? reject(err) : resolve(data))));

describe('FIT workout', () => {
  it('writes a workout a FIT reader takes: steps by time, power as % of FTP, the intervals as a repeat', async () => {
    const structure: WorkoutStructure = {
      target: 'power',
      blocks: [step('warmup', 10, 0.5, 0.7, { ramp: true }), repeat(4, [step('active', 5, 1.1), step('recovery', 10, 0.5)]), step('cooldown', 5, 0.5)],
    };
    const bytes = toFitWorkout('Sunny Hay', structure, 'ride');
    const fit = await parse(bytes);
    expect(fit.messages.file_id[0]).toMatchObject({ type: 'workout' });
    expect(fit.messages.workout[0]).toMatchObject({ sport: 'cycling', wkt_name: 'Sunny Hay', num_valid_steps: 10 });
    const steps = fit.messages.workout_step;
    // 6 for the ramp, 2 in the set, its repeat, the cooldown
    expect(steps.map((x: any) => x.duration_type)).toEqual([...Array(8).fill('time'), 'repeat_until_steps_cmplt', 'time']);
    expect(steps[0]).toMatchObject({ intensity: 'warmup', duration_value: 100000, target_type: 'power', custom_target_value_low: 50, custom_target_value_high: 54 });
    expect(steps[6]).toMatchObject({ intensity: 'active', duration_value: 300000, custom_target_value_low: 108, custom_target_value_high: 112 });
    expect(steps[7]).toMatchObject({ intensity: 'rest', duration_value: 600000, custom_target_value_low: 48, custom_target_value_high: 52 });
    // back to the first step of the set, four times in all
    expect(steps[8]).toMatchObject({ duration_value: 6, target_value: 4 });
    expect(steps[9]).toMatchObject({ intensity: 'cooldown', duration_value: 300000 });
  });
});
