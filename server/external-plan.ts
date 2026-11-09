/**
 * A training plan kept in another app (TrainerRoad), mirrored into this one's calendar: its
 * workouts as planned workouts and its races as events, so the fitness projection, the week's
 * plan and compliance follow it. The other app is in charge: between the plan's dates, what it no
 * longer has goes, except workouts a ride was already matched to, which stay as the record of
 * what was planned.
 */
import type { EventPriority, Source, Sport, WorkoutStructure } from '../shared/types';
import { q, transaction } from './db';
import { today } from './aggregate';
import { linkPlanned } from './ingest';

export interface ExternalWorkout {
  /** the other app's id for this scheduled workout */
  id: string;
  date: string;
  sport: Sport;
  title: string;
  description: string | null;
  /** seconds */
  duration: number | null;
  tss: number | null;
  if: number | null;
  structure: WorkoutStructure | null;
}

export interface ExternalRace {
  id: string;
  date: string;
  name: string;
  sport: Sport;
  priority: EventPriority;
  description: string | null;
}

export interface ExternalPlan {
  /** the dates it covers, inclusive */
  from: string;
  to: string;
  workouts: ExternalWorkout[];
  races: ExternalRace[];
}

export interface PlanChanges {
  added: number;
  changed: number;
  removed: number;
}

/**
 * Bring the calendar's workouts and races from `source` in line with `plan`. A workout is found
 * again by its id, else by its day and name (one re-created under a new id, or read the other way
 * in), so a ride matched to it stays matched; one moved to another day lets go of its ride.
 */
export function applyExternalPlan(source: Source, plan: ExternalPlan): PlanChanges {
  const counts: PlanChanges = { added: 0, changed: 0, removed: 0 };
  const inPlan = <T extends { date: string }>(xs: T[]) => xs.filter((x) => x.date >= plan.from && x.date <= plan.to);
  transaction(() => {
    const rows = q.all('SELECT * FROM planned_workouts WHERE source = ? AND date BETWEEN ? AND ? ORDER BY date, sort_order', source, plan.from, plan.to);
    const byId = new Map(rows.map((r) => [r.external_id as string, r]));
    const incoming = new Set(plan.workouts.map((w) => w.id));
    const claimed = new Set<number>();
    for (const w of inPlan(plan.workouts)) {
      let r = byId.get(w.id);
      if (r && claimed.has(r.id)) r = undefined;
      r ??= rows.find((x) => !claimed.has(x.id) && !incoming.has(x.external_id) && x.date === w.date && x.title === w.title);
      // intervals that couldn't be read this time stay, while it's the same workout
      const structure = w.structure ? JSON.stringify(w.structure) : r && r.title === w.title ? r.structure : null;
      if (!r) {
        q.run(
          `INSERT INTO planned_workouts(date, sport, title, description, structure, planned_duration, planned_tss, planned_if, source, external_id, sort_order)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM planned_workouts WHERE date = ?))`,
          w.date, w.sport, w.title, w.description, structure, w.duration, w.tss, w.if, source, w.id, w.date,
        );
        counts.added++;
        continue;
      }
      claimed.add(r.id);
      const next = [w.date, w.sport, w.title, w.description, structure, w.duration, w.tss, w.if, w.id];
      const prev = [r.date, r.sport, r.title, r.description, r.structure, r.planned_duration, r.planned_tss, r.planned_if, r.external_id];
      if (next.every((v, i) => v === prev[i])) continue;
      const moved = r.activity_id != null && r.date !== w.date;
      if (moved) q.run('UPDATE activities SET planned_id = NULL WHERE id = ?', r.activity_id);
      q.run(
        `UPDATE planned_workouts SET date = ?, sport = ?, title = ?, description = ?, structure = ?, planned_duration = ?, planned_tss = ?, planned_if = ?,
         external_id = ?, activity_id = ? WHERE id = ?`,
        ...next, moved ? null : r.activity_id, r.id,
      );
      counts.changed++;
    }
    for (const r of rows) {
      if (claimed.has(r.id) || r.activity_id != null) continue;
      q.run('DELETE FROM planned_workouts WHERE id = ?', r.id);
      counts.removed++;
    }

    const events = q.all('SELECT * FROM events WHERE source = ? AND date BETWEEN ? AND ?', source, plan.from, plan.to);
    const kept = new Set<number>();
    for (const e of inPlan(plan.races)) {
      const r = events.find((x) => !kept.has(x.id) && x.external_id === e.id) ?? events.find((x) => !kept.has(x.id) && x.date === e.date && x.name === e.name);
      if (!r) {
        q.run('INSERT INTO events(date, name, sport, priority, description, source, external_id) VALUES(?, ?, ?, ?, ?, ?, ?)', e.date, e.name, e.sport, e.priority, e.description, source, e.id);
        counts.added++;
        continue;
      }
      kept.add(r.id);
      if (r.date === e.date && r.name === e.name && r.sport === e.sport && r.priority === e.priority && r.description === e.description && r.external_id === e.id) continue;
      // a target CTL set here stays
      q.run('UPDATE events SET date = ?, name = ?, sport = ?, priority = ?, description = ?, external_id = ? WHERE id = ?', e.date, e.name, e.sport, e.priority, e.description, e.id, r.id);
      counts.changed++;
    }
    for (const r of events) {
      if (kept.has(r.id)) continue;
      q.run('DELETE FROM events WHERE id = ?', r.id);
      counts.removed++;
    }
  });
  // rides already done on the plan's days, matched to its workouts
  for (const a of q.all('SELECT id FROM activities WHERE local_date BETWEEN ? AND ? AND planned_id IS NULL', plan.from, today())) linkPlanned(a.id);
  return counts;
}
