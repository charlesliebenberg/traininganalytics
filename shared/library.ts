import type { Sport, WorkoutStructure } from './types';
import { repeat, step } from './analytics/workout';

export interface LibraryWorkout {
  key: string;
  name: string;
  sport: Sport;
  category: string;
  description: string;
  structure: WorkoutStructure;
}

const bike = (blocks: WorkoutStructure['blocks']): WorkoutStructure => ({ target: 'power', blocks });
const run = (blocks: WorkoutStructure['blocks']): WorkoutStructure => ({ target: 'pace', blocks });

const wu = (m = 10) => step('warmup', m, 0.45, 0.72, { ramp: true, label: 'Warm up' });
const cd = (m = 10) => step('cooldown', m, 0.65, 0.4, { ramp: true, label: 'Cool down' });

export const BUILTIN_WORKOUTS: LibraryWorkout[] = [
  {
    key: 'recovery-spin',
    name: 'Recovery Spin',
    sport: 'ride',
    category: 'Recovery',
    description: 'Very easy spinning to promote recovery. Keep it genuinely easy; high cadence, no pressure on the pedals.',
    structure: bike([step('active', 45, 0.45, 0.55, { cadence: 95 })]),
  },
  {
    key: 'endurance-2h',
    name: 'Endurance 2h',
    sport: 'ride',
    category: 'Endurance',
    description: 'Steady zone 2 endurance ride. Builds aerobic base, fat oxidation and mitochondrial density.',
    structure: bike([wu(10), step('active', 100, 0.65, 0.72, { label: 'Zone 2' }), cd(10)]),
  },
  {
    key: 'long-ride',
    name: 'Long Endurance Ride',
    sport: 'ride',
    category: 'Endurance',
    description: 'Long aerobic ride with a tempo block in the final hour to train durability.',
    structure: bike([wu(15), step('active', 150, 0.62, 0.72, { label: 'Zone 2' }), step('active', 30, 0.8, 0.85, { label: 'Tempo finish' }), cd(10)]),
  },
  {
    key: 'tempo-3x15',
    name: 'Tempo 3×15',
    sport: 'ride',
    category: 'Tempo',
    description: 'Three 15-minute blocks in upper zone 3. Muscular endurance at a sustainable, repeatable effort.',
    structure: bike([wu(15), repeat(3, [step('active', 15, 0.83, 0.87), step('recovery', 5, 0.55)]), cd(10)]),
  },
  {
    key: 'sweetspot-3x15',
    name: 'Sweet Spot 3×15',
    sport: 'ride',
    category: 'Sweet Spot',
    description: 'The classic time-efficient FTP builder: 88–93% FTP delivers high training stimulus with manageable fatigue.',
    structure: bike([wu(12), repeat(3, [step('active', 15, 0.88, 0.93), step('recovery', 5, 0.55)]), cd(10)]),
  },
  {
    key: 'sweetspot-2x30',
    name: 'Sweet Spot 2×30',
    sport: 'ride',
    category: 'Sweet Spot',
    description: 'Extended sweet-spot intervals to push time-in-zone and muscular endurance.',
    structure: bike([wu(15), repeat(2, [step('active', 30, 0.88, 0.92), step('recovery', 8, 0.55)]), cd(10)]),
  },
  {
    key: 'threshold-2x20',
    name: 'Threshold 2×20',
    sport: 'ride',
    category: 'Threshold',
    description: 'The gold-standard FTP workout. Hold 95–100% FTP; the second interval should feel hard but controlled.',
    structure: bike([wu(15), repeat(2, [step('active', 20, 0.95, 1.0), step('recovery', 8, 0.55)]), cd(10)]),
  },
  {
    key: 'threshold-4x10',
    name: 'Threshold 4×10',
    sport: 'ride',
    category: 'Threshold',
    description: 'Threshold volume broken into manageable chunks, slightly above FTP.',
    structure: bike([wu(15), repeat(4, [step('active', 10, 0.98, 1.03), step('recovery', 4, 0.55)]), cd(10)]),
  },
  {
    key: 'over-unders',
    name: 'Over-Unders 3×(4×2/1)',
    sport: 'ride',
    category: 'Threshold',
    description: 'Alternate 2 min at 95% with 1 min at 110% FTP. Trains lactate clearance and surge tolerance.',
    structure: bike([
      wu(15),
      repeat(4, [step('active', 2, 0.95, 0.95, { label: 'Under' }), step('active', 1, 1.1, 1.1, { label: 'Over' })]),
      step('recovery', 6, 0.5),
      repeat(4, [step('active', 2, 0.95, 0.95, { label: 'Under' }), step('active', 1, 1.1, 1.1, { label: 'Over' })]),
      step('recovery', 6, 0.5),
      repeat(4, [step('active', 2, 0.95, 0.95, { label: 'Under' }), step('active', 1, 1.1, 1.1, { label: 'Over' })]),
      cd(10),
    ]),
  },
  {
    key: 'vo2-5x5',
    name: 'VO2max 5×5',
    sport: 'ride',
    category: 'VO2max',
    description: 'Five 5-minute efforts at 106–118% FTP with equal recovery. Raises aerobic ceiling.',
    structure: bike([wu(15), repeat(5, [step('active', 5, 1.08, 1.15), step('recovery', 5, 0.5)]), cd(10)]),
  },
  {
    key: 'vo2-30-30',
    name: '30/30s 3×(10×30s)',
    sport: 'ride',
    category: 'VO2max',
    description: 'Short-short intervals (Rønnestad). Accumulates lots of time near VO2max with lower perceived effort.',
    structure: bike([
      wu(15),
      repeat(10, [step('active', 0.5, 1.2, 1.3), step('recovery', 0.5, 0.5)]),
      step('recovery', 5, 0.5),
      repeat(10, [step('active', 0.5, 1.2, 1.3), step('recovery', 0.5, 0.5)]),
      step('recovery', 5, 0.5),
      repeat(10, [step('active', 0.5, 1.2, 1.3), step('recovery', 0.5, 0.5)]),
      cd(10),
    ]),
  },
  {
    key: 'anaerobic-8x1',
    name: 'Anaerobic 8×1',
    sport: 'ride',
    category: 'Anaerobic',
    description: 'One-minute efforts at 130–150% FTP. Builds anaerobic capacity and W\'.',
    structure: bike([wu(15), repeat(8, [step('active', 1, 1.3, 1.5), step('recovery', 3, 0.45)]), cd(10)]),
  },
  {
    key: 'sprints',
    name: 'Sprint Power',
    sport: 'ride',
    category: 'Neuromuscular',
    description: 'Maximal 10-second sprints with full recovery on an endurance ride.',
    structure: bike([wu(15), repeat(6, [step('active', 1 / 6, 2.0, 2.5, { label: 'Sprint' }), step('recovery', 5, 0.55)]), step('active', 20, 0.65, 0.7), cd(10)]),
  },
  {
    key: 'ftp-test-20',
    name: 'FTP Test (20 min)',
    sport: 'ride',
    category: 'Test',
    description: 'Standard 20-minute test protocol. FTP ≈ 95% of 20-minute average power.',
    structure: bike([
      wu(20),
      repeat(3, [step('active', 1, 1.0, 1.0, { cadence: 100 }), step('recovery', 1, 0.5)]),
      step('recovery', 5, 0.5),
      step('active', 5, 1.1, 1.15, { label: 'Blow-out' }),
      step('recovery', 10, 0.5),
      step('active', 20, 1.02, 1.08, { label: '20 min test' }),
      cd(15),
    ]),
  },
  {
    key: 'ramp-test',
    name: 'Ramp Test',
    sport: 'ride',
    category: 'Test',
    description: 'One-minute steps increasing ~6% FTP until failure. FTP ≈ 75% of best 1-minute power.',
    structure: bike([
      step('warmup', 5, 0.4, 0.4),
      ...Array.from({ length: 15 }, (_, i) => step('active', 1, 0.45 + i * 0.07, 0.45 + i * 0.07)),
      cd(5),
    ]),
  },
  // Running
  {
    key: 'run-easy',
    name: 'Easy Run',
    sport: 'run',
    category: 'Endurance',
    description: 'Conversational pace aerobic run.',
    structure: run([step('active', 45, 0.72, 0.8)]),
  },
  {
    key: 'run-long',
    name: 'Long Run',
    sport: 'run',
    category: 'Endurance',
    description: 'Long aerobic run building endurance and running economy.',
    structure: run([step('warmup', 10, 0.68, 0.72), step('active', 80, 0.75, 0.82), step('cooldown', 10, 0.7, 0.7)]),
  },
  {
    key: 'run-tempo',
    name: 'Tempo Run 3×10',
    sport: 'run',
    category: 'Tempo',
    description: 'Comfortably-hard tempo segments.',
    structure: run([step('warmup', 15, 0.72, 0.78), repeat(3, [step('active', 10, 0.9, 0.93), step('recovery', 2, 0.7)]), step('cooldown', 10, 0.7)]),
  },
  {
    key: 'run-threshold',
    name: 'Cruise Intervals 5×1k',
    sport: 'run',
    category: 'Threshold',
    description: 'Threshold-pace repeats with short jog recoveries.',
    structure: run([step('warmup', 15, 0.72, 0.78), repeat(5, [step('active', 3.5, 0.99, 1.02), step('recovery', 1, 0.65)]), step('cooldown', 10, 0.7)]),
  },
  {
    key: 'run-vo2',
    name: 'VO2 Intervals 6×800',
    sport: 'run',
    category: 'VO2max',
    description: 'Fast 800 m repeats around 3–5 km race pace.',
    structure: run([step('warmup', 15, 0.72, 0.78), repeat(6, [step('active', 2.75, 1.06, 1.1), step('recovery', 2, 0.6)]), step('cooldown', 10, 0.7)]),
  },
  {
    key: 'run-strides',
    name: 'Easy + Strides',
    sport: 'run',
    category: 'Neuromuscular',
    description: 'Easy run finishing with relaxed fast strides.',
    structure: run([step('active', 35, 0.72, 0.8), repeat(6, [step('active', 1 / 3, 1.2, 1.25, { label: 'Stride' }), step('recovery', 1, 0.6)]), step('cooldown', 5, 0.7)]),
  },
];
