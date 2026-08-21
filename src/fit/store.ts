import { useSyncExternalStore } from "react";
import type {
  EntryLog,
  Exercise,
  PlanDay,
  PlanItem,
  Session,
  SetLog,
  State,
} from "./types";
import { EXERCISES } from "./data/exercises";
import { DEFAULT_PLAN } from "./data/program";

const KEY = "fit.v1";
const VERSION = 1;

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function initial(): State {
  return {
    v: VERSION,
    plan: structuredClone(DEFAULT_PLAN),
    customEx: [],
    videos: {},
    sessions: [],
    active: null,
    cursor: 0,
    timer: { endsAt: null, total: 0, label: "" },
    settings: { sound: true, vibrate: true, photos: true, autoRest: true },
  };
}

function load(): State {
  if (typeof localStorage === "undefined") return initial();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return initial();
    const parsed = JSON.parse(raw) as Partial<State>;
    // мягкое слияние: новые поля из initial() не ломают старые сохранения
    return { ...initial(), ...parsed, v: VERSION };
  } catch {
    return initial();
  }
}

let state: State = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* приватный режим / переполнение — работаем без сохранения */
  }
}

function set(next: State) {
  state = next;
  persist();
  listeners.forEach((l) => l());
}

/** Точечное обновление: mutate получает уже склонированный стейт. */
function update(mutate: (s: State) => void) {
  const next = structuredClone(state);
  mutate(next);
  set(next);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useFit<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

export function getState(): State {
  return state;
}

// ───────────────────────── упражнения ─────────────────────────

export function allExercises(s: State = state): Exercise[] {
  return [...EXERCISES, ...s.customEx];
}

export function exById(id: string, s: State = state): Exercise | undefined {
  return allExercises(s).find((e) => e.id === id);
}

export function addCustomExercise(ex: Omit<Exercise, "id" | "custom">) {
  const id = "my-" + uid();
  update((s) => {
    s.customEx.push({ ...ex, id, custom: true });
  });
  return id;
}

export function updateCustomExercise(id: string, patch: Partial<Exercise>) {
  update((s) => {
    const i = s.customEx.findIndex((e) => e.id === id);
    if (i >= 0) s.customEx[i] = { ...s.customEx[i], ...patch, id };
  });
}

export function removeCustomExercise(id: string) {
  update((s) => {
    s.customEx = s.customEx.filter((e) => e.id !== id);
    s.plan.forEach((d) => {
      d.items = d.items.filter((it) => it.exId !== id);
    });
  });
}

export function setVideo(exId: string, url: string) {
  update((s) => {
    if (url.trim()) s.videos[exId] = url.trim();
    else delete s.videos[exId];
  });
}

// ───────────────────────── план ─────────────────────────

export function updateDay(dayId: string, patch: Partial<PlanDay>) {
  update((s) => {
    const d = s.plan.find((x) => x.id === dayId);
    if (d) Object.assign(d, patch);
  });
}

export function addDay() {
  update((s) => {
    s.plan.push({
      id: uid(),
      name: `День ${String.fromCharCode(65 + s.plan.length)}`,
      subtitle: "новый день",
      items: [],
    });
  });
}

export function removeDay(dayId: string) {
  update((s) => {
    s.plan = s.plan.filter((d) => d.id !== dayId);
  });
}

export function addItem(dayId: string, exId: string) {
  const ex = exById(exId);
  if (!ex) return;
  update((s) => {
    const d = s.plan.find((x) => x.id === dayId);
    if (!d) return;
    d.items.push({
      exId,
      sets: ex.def.sets,
      reps: ex.def.reps,
      rest: ex.def.rest,
    });
  });
}

export function updateItem(dayId: string, idx: number, patch: Partial<PlanItem>) {
  update((s) => {
    const d = s.plan.find((x) => x.id === dayId);
    if (d?.items[idx]) Object.assign(d.items[idx], patch);
  });
}

export function removeItem(dayId: string, idx: number) {
  update((s) => {
    const d = s.plan.find((x) => x.id === dayId);
    if (d) d.items.splice(idx, 1);
  });
}

export function moveItem(dayId: string, idx: number, dir: -1 | 1) {
  update((s) => {
    const d = s.plan.find((x) => x.id === dayId);
    if (!d) return;
    const j = idx + dir;
    if (j < 0 || j >= d.items.length) return;
    const [it] = d.items.splice(idx, 1);
    d.items.splice(j, 0, it);
  });
}

export function resetPlan() {
  update((s) => {
    s.plan = structuredClone(DEFAULT_PLAN);
  });
}

// ───────────────────────── тренировка ─────────────────────────

function makeSets(n: number, prev?: EntryLog): SetLog[] {
  return Array.from({ length: n }, (_, i) => {
    const p = prev?.sets[i];
    return {
      id: uid(),
      // подставляем прошлый результат как черновик — обычно повторяем его или чуть больше
      weight: p?.weight ?? 0,
      reps: p?.reps ?? 0,
      rpe: null,
      done: false,
      at: null,
    };
  });
}

/** Последняя завершённая запись по упражнению. */
export function lastEntry(exId: string, s: State = state): {
  entry: EntryLog;
  session: Session;
} | null {
  for (let i = s.sessions.length - 1; i >= 0; i--) {
    const ses = s.sessions[i];
    const e = ses.entries.find(
      (x) => x.exId === exId && x.sets.some((st) => st.done),
    );
    if (e) return { entry: e, session: ses };
  }
  return null;
}

/** Какой день предлагать следующим: следующий по кругу после последнего. */
export function nextDay(s: State = state): PlanDay | null {
  if (!s.plan.length) return null;
  const last = s.sessions[s.sessions.length - 1];
  if (!last) return s.plan[0];
  const i = s.plan.findIndex((d) => d.id === last.dayId);
  if (i < 0) return s.plan[0];
  return s.plan[(i + 1) % s.plan.length];
}

export function startSession(dayId: string) {
  const day = state.plan.find((d) => d.id === dayId);
  if (!day) return;
  const entries: EntryLog[] = day.items.map((it) => {
    const prev = lastEntry(it.exId)?.entry;
    return {
      exId: it.exId,
      targetSets: it.sets,
      targetReps: it.reps,
      targetRest: it.rest,
      sets: makeSets(it.sets, prev),
      note: "",
      done: false,
    };
  });
  update((s) => {
    s.active = {
      id: uid(),
      dayId: day.id,
      dayName: `${day.name} · ${day.subtitle}`,
      startedAt: Date.now(),
      finishedAt: null,
      entries,
      note: "",
      feel: null,
    };
    s.cursor = 0;
    s.timer = { endsAt: null, total: 0, label: "" };
  });
}

export function setCursor(i: number) {
  update((s) => {
    s.cursor = Math.max(0, Math.min(i, (s.active?.entries.length ?? 1) - 1));
  });
}

export function patchSet(entryIdx: number, setIdx: number, patch: Partial<SetLog>) {
  update((s) => {
    const st = s.active?.entries[entryIdx]?.sets[setIdx];
    if (st) Object.assign(st, patch);
  });
}

/** Отметить подход выполненным (или снять отметку) и запустить отдых. */
export function toggleSet(entryIdx: number, setIdx: number) {
  const entry = state.active?.entries[entryIdx];
  const st = entry?.sets[setIdx];
  if (!entry || !st) return;
  const willBeDone = !st.done;
  update((s) => {
    const e = s.active!.entries[entryIdx];
    const t = e.sets[setIdx];
    t.done = willBeDone;
    t.at = willBeDone ? Date.now() : null;
    e.done = e.sets.every((x) => x.done);
    if (willBeDone && s.settings.autoRest) {
      const isLast = setIdx === e.sets.length - 1;
      const sec = isLast ? Math.round(e.targetRest * 1.2) : e.targetRest;
      s.timer = {
        endsAt: Date.now() + sec * 1000,
        total: sec,
        label: isLast ? "отдых перед следующим упражнением" : "отдых между подходами",
      };
    }
  });
}

export function addSet(entryIdx: number) {
  update((s) => {
    const e = s.active?.entries[entryIdx];
    if (!e) return;
    const last = e.sets[e.sets.length - 1];
    e.sets.push({
      id: uid(),
      weight: last?.weight ?? 0,
      reps: last?.reps ?? 0,
      rpe: null,
      done: false,
      at: null,
    });
    e.done = false;
  });
}

export function removeSet(entryIdx: number, setIdx: number) {
  update((s) => {
    const e = s.active?.entries[entryIdx];
    if (!e || e.sets.length <= 1) return;
    e.sets.splice(setIdx, 1);
    e.done = e.sets.every((x) => x.done);
  });
}

export function setEntryNote(entryIdx: number, note: string) {
  update((s) => {
    const e = s.active?.entries[entryIdx];
    if (e) e.note = note;
  });
}

/** Ручная отметка «упражнение закончил» — фиксирует и переводит к следующему. */
export function finishEntry(entryIdx: number) {
  update((s) => {
    const e = s.active?.entries[entryIdx];
    if (!e) return;
    e.done = true;
    const next = s.active!.entries.findIndex((x, i) => i > entryIdx && !x.done);
    if (next >= 0) s.cursor = next;
  });
}

export function setSessionMeta(patch: Partial<Pick<Session, "note" | "feel">>) {
  update((s) => {
    if (s.active) Object.assign(s.active, patch);
  });
}

export function finishSession() {
  update((s) => {
    if (!s.active) return;
    const done = structuredClone(s.active);
    done.finishedAt = Date.now();
    // пустые подходы в историю не тащим
    done.entries.forEach((e) => {
      e.sets = e.sets.filter((x) => x.done);
    });
    done.entries = done.entries.filter((e) => e.sets.length > 0);
    if (done.entries.length) s.sessions.push(done);
    s.active = null;
    s.cursor = 0;
    s.timer = { endsAt: null, total: 0, label: "" };
  });
}

export function cancelSession() {
  update((s) => {
    s.active = null;
    s.cursor = 0;
    s.timer = { endsAt: null, total: 0, label: "" };
  });
}

export function removeSession(id: string) {
  update((s) => {
    s.sessions = s.sessions.filter((x) => x.id !== id);
  });
}

// ───────────────────────── таймер ─────────────────────────

export function startRest(sec: number, label = "отдых") {
  update((s) => {
    s.timer = { endsAt: Date.now() + sec * 1000, total: sec, label };
  });
}

export function bumpRest(deltaSec: number) {
  update((s) => {
    if (!s.timer.endsAt) return;
    s.timer.endsAt += deltaSec * 1000;
    s.timer.total = Math.max(5, s.timer.total + deltaSec);
  });
}

export function stopRest() {
  update((s) => {
    s.timer = { endsAt: null, total: 0, label: "" };
  });
}

// ───────────────────────── настройки и данные ─────────────────────────

export function patchSettings(patch: Partial<State["settings"]>) {
  update((s) => Object.assign(s.settings, patch));
}

export function exportJson(): string {
  return JSON.stringify(state, null, 2);
}

export function importJson(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as Partial<State>;
    if (!Array.isArray(parsed.plan) || !Array.isArray(parsed.sessions)) {
      return "Файл не похож на выгрузку тренировок";
    }
    set({ ...initial(), ...parsed, v: VERSION });
    return null;
  } catch (e) {
    return "Не удалось прочитать JSON: " + (e as Error).message;
  }
}

export function wipeAll() {
  set(initial());
}

// ───────────────────────── статистика ─────────────────────────

export function entryVolume(e: EntryLog): number {
  return e.sets.reduce(
    (sum, s) => (s.done ? sum + s.weight * s.reps : sum),
    0,
  );
}

export function sessionVolume(ses: Session): number {
  return ses.entries.reduce((sum, e) => sum + entryVolume(e), 0);
}

export function bestSet(e: EntryLog): SetLog | null {
  const done = e.sets.filter((s) => s.done);
  if (!done.length) return null;
  return done.reduce((a, b) => (b.weight > a.weight ? b : a));
}
