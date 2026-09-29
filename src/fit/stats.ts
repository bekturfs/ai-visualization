import type { DeltHead, Session, State } from "./types";
import { allExercises } from "./store";

const DAY = 86400000;

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Понедельник той недели, в которую попадает ts. */
export function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts));
  const shift = (d.getDay() + 6) % 7;
  return d.getTime() - shift * DAY;
}

export function doneSets(ses: Session): number {
  return ses.entries.reduce(
    (n, e) => n + e.sets.filter((s) => s.done).length,
    0,
  );
}

export function tonnage(ses: Session): number {
  return ses.entries.reduce(
    (sum, e) =>
      sum + e.sets.reduce((s, x) => (x.done ? s + x.weight * x.reps : s), 0),
    0,
  );
}

/** Длительность; у незавершённой тренировки — сколько идёт прямо сейчас. */
export function duration(ses: Session): number {
  return Math.max(0, ((ses.finishedAt ?? Date.now()) - ses.startedAt) / 1000);
}

/** Сколько тренировок за последние n дней. */
export function recentCount(sessions: Session[], days = 7): number {
  const from = Date.now() - days * DAY;
  return sessions.filter((s) => s.startedAt >= from).length;
}

export type WeekBucket = {
  start: number;
  label: string;
  tonnage: number;
  sessions: number;
  sets: number;
};

/** Тоннаж по неделям, от старых к новым, включая пустые недели. */
export function weeklyTonnage(sessions: Session[], weeks = 8): WeekBucket[] {
  const thisWeek = startOfWeek(Date.now());
  const out: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = thisWeek - i * 7 * DAY;
    const end = start + 7 * DAY;
    const inWeek = sessions.filter(
      (s) => s.startedAt >= start && s.startedAt < end,
    );
    const d = new Date(start);
    out.push({
      start,
      label: `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`,
      tonnage: inWeek.reduce((n, s) => n + tonnage(s), 0),
      sessions: inWeek.length,
      sets: inWeek.reduce((n, s) => n + doneSets(s), 0),
    });
  }
  return out;
}

export type DeltBalance = Record<DeltHead, number>;

/**
 * Сколько рабочих подходов пришлось на каждый пучок дельты.
 * Подход упражнения на два пучка засчитывается обоим — так и есть в жизни.
 */
export function deltBalance(
  sessions: Session[],
  state: State,
  days = 30,
): DeltBalance {
  const from = Date.now() - days * DAY;
  // с архивными: удалённое своё упражнение всё равно грузило дельты
  const byId = new Map(allExercises(state, true).map((e) => [e.id, e]));
  const out: DeltBalance = { front: 0, side: 0, rear: 0 };
  for (const ses of sessions) {
    if (ses.startedAt < from) continue;
    for (const e of ses.entries) {
      const ex = byId.get(e.exId);
      if (!ex?.heads?.length) continue;
      const n = e.sets.filter((s) => s.done).length;
      for (const h of ex.heads) out[h] += n;
    }
  }
  return out;
}

export type ExPoint = {
  ts: number;
  topWeight: number;
  topReps: number;
  volume: number;
};

/** История одного упражнения: лучший подход и объём за каждую тренировку. */
export function exerciseHistory(sessions: Session[], exId: string): ExPoint[] {
  const out: ExPoint[] = [];
  for (const ses of sessions) {
    const e = ses.entries.find((x) => x.exId === exId);
    if (!e) continue;
    const done = e.sets.filter((s) => s.done);
    if (!done.length) continue;
    const top = done.reduce((a, b) => (b.weight > a.weight ? b : a));
    out.push({
      ts: ses.startedAt,
      topWeight: top.weight,
      topReps: top.reps,
      volume: done.reduce((n, s) => n + s.weight * s.reps, 0),
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Упражнения, по которым вообще есть история — для выпадающего списка. */
export function trackedExercises(sessions: Session[]): string[] {
  const seen = new Set<string>();
  for (const s of sessions) {
    for (const e of s.entries) {
      if (e.sets.some((x) => x.done && x.weight > 0)) seen.add(e.exId);
    }
  }
  return [...seen];
}

/** Предыдущая тренировка того же дня программы — для сравнения «было / стало». */
export function previousSameDay(
  sessions: Session[],
  ses: Session,
): Session | null {
  const earlier = sessions.filter(
    (s) => s.dayId === ses.dayId && s.startedAt < ses.startedAt,
  );
  return earlier.length ? earlier[earlier.length - 1] : null;
}
