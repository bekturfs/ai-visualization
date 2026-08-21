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
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
    return normalize(JSON.parse(raw));
  } catch {
    return initial();
  }
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, def = ""): string => (typeof x === "string" ? x : def);
const num = (x: unknown, def = 0): number =>
  typeof x === "number" && Number.isFinite(x) ? x : def;
const bool = (x: unknown, def: boolean): boolean =>
  typeof x === "boolean" ? x : def;
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

function normSet(x: unknown): SetLog {
  const o = isObj(x) ? x : {};
  return {
    id: str(o.id) || uid(),
    weight: num(o.weight),
    reps: num(o.reps),
    rpe: typeof o.rpe === "number" ? o.rpe : null,
    done: bool(o.done, false),
    at: typeof o.at === "number" ? o.at : null,
  };
}

function normEntry(x: unknown): EntryLog {
  const o = isObj(x) ? x : {};
  const sets = arr(o.sets).map(normSet);
  return {
    exId: str(o.exId),
    targetSets: num(o.targetSets, sets.length),
    targetReps: str(o.targetReps),
    targetRest: num(o.targetRest, 90),
    planNote: str(o.planNote),
    sets: sets.length ? sets : [normSet({})],
    note: str(o.note),
    done: bool(o.done, false),
  };
}

function normSession(x: unknown): Session {
  const o = isObj(x) ? x : {};
  return {
    id: str(o.id) || uid(),
    dayId: str(o.dayId),
    dayName: str(o.dayName, "тренировка"),
    startedAt: num(o.startedAt, Date.now()),
    finishedAt: typeof o.finishedAt === "number" ? o.finishedAt : null,
    entries: arr(o.entries).map(normEntry),
    note: str(o.note),
    feel: typeof o.feel === "number" ? o.feel : null,
  };
}

function normDay(x: unknown): PlanDay {
  const o = isObj(x) ? x : {};
  return {
    id: str(o.id) || uid(),
    name: str(o.name, "день"),
    subtitle: str(o.subtitle),
    items: arr(o.items).map((it) => {
      const i = isObj(it) ? it : {};
      return {
        exId: str(i.exId),
        sets: num(i.sets, 3),
        reps: str(i.reps, "8–12"),
        rest: num(i.rest, 90),
        note: str(i.note) || undefined,
      };
    }),
  };
}

/**
 * Приводит что угодно к валидному состоянию. Чужой или битый JSON не должен
 * укладывать приложение белым экраном, который переживёт перезагрузку.
 */
function normalize(parsed: unknown): State {
  const base = initial();
  if (!isObj(parsed)) return base;
  const settings = isObj(parsed.settings) ? parsed.settings : {};
  const timer = isObj(parsed.timer) ? parsed.timer : {};
  const endsAt = typeof timer.endsAt === "number" ? timer.endsAt : null;
  const videos: Record<string, string> = {};
  if (isObj(parsed.videos)) {
    for (const [k, v] of Object.entries(parsed.videos)) {
      if (typeof v === "string") videos[k] = v;
    }
  }
  return {
    v: VERSION,
    plan: arr(parsed.plan).map(normDay),
    customEx: arr(parsed.customEx).filter(isObj).map((e) => ({
      id: str(e.id) || uid(),
      name: str(e.name, "упражнение"),
      en: str(e.en),
      group: (str(e.group, "shoulders") as Exercise["group"]),
      heads: Array.isArray(e.heads)
        ? (e.heads.filter((h) => typeof h === "string") as Exercise["heads"])
        : undefined,
      equipment: str(e.equipment, "dumbbell") as Exercise["equipment"],
      motion: str(e.motion, "lateralRaise"),
      photo: typeof e.photo === "string" ? e.photo : undefined,
      cues: arr(e.cues).filter((c): c is string => typeof c === "string"),
      mistakes: Array.isArray(e.mistakes)
        ? e.mistakes.filter((c): c is string => typeof c === "string")
        : undefined,
      def: isObj(e.def)
        ? {
            sets: num(e.def.sets, 3),
            reps: str(e.def.reps, "8–12"),
            rest: num(e.def.rest, 90),
          }
        : { sets: 3, reps: "8–12", rest: 90 },
      custom: true,
      archived: bool(e.archived, false),
    })),
    videos,
    sessions: arr(parsed.sessions).map(normSession),
    active: isObj(parsed.active) ? normSession(parsed.active) : null,
    cursor: num(parsed.cursor),
    // просроченный отдых не оживляем: иначе через сутки приложение встретит гудком
    timer:
      endsAt && endsAt > Date.now()
        ? { endsAt, total: num(timer.total, 60), label: str(timer.label) }
        : base.timer,
    settings: {
      sound: bool(settings.sound, base.settings.sound),
      vibrate: bool(settings.vibrate, base.settings.vibrate),
      photos: bool(settings.photos, base.settings.photos),
      autoRest: bool(settings.autoRest, base.settings.autoRest),
    },
  };
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
  return () => {
    listeners.delete(l);
  };
}

export function getState(): State {
  return state;
}

/**
 * Селектор применяется при рендере, а useSyncExternalStore получает стабильную
 * ссылку на state. Иначе селектор вида `s => s.plan.map(...)` возвращал бы
 * каждый раз новый объект, и React ругался бы на некешированный снапшот.
 */
// другая вкладка того же браузера пишет в тот же ключ: перечитываем, иначе
// одна вкладка молча затрёт правки другой
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || e.newValue === null) return;
    try {
      state = normalize(JSON.parse(e.newValue));
      listeners.forEach((l) => l());
    } catch {
      /* мусор из другой вкладки игнорируем */
    }
  });
}

export function useFit<T>(selector: (s: State) => T): T {
  const snap = useSyncExternalStore(subscribe, getState, getState);
  return selector(snap);
}

// ───────────────────────── упражнения ─────────────────────────

// список склеивается на каждый рендер, а страницы держат на нём useMemo —
// без кэша по ссылке на customEx мемоизация не работала бы вовсе
// два слота: exById ходит с архивными, страницы — без, и один общий слот
// сбрасывался бы на каждом вызове
const exCache: Record<"all" | "visible", { src: Exercise[]; out: Exercise[] } | null> = {
  all: null,
  visible: null,
};

/** Список для выбора: удалённые свои упражнения сюда не попадают. */
export function allExercises(s: State = state, withArchived = false): Exercise[] {
  const slot = withArchived ? "all" : "visible";
  const hit = exCache[slot];
  if (hit && hit.src === s.customEx) return hit.out;
  const custom = withArchived ? s.customEx : s.customEx.filter((e) => !e.archived);
  const out = [...EXERCISES, ...custom];
  exCache[slot] = { src: s.customEx, out };
  return out;
}

/** Поиск по id идёт и по удалённым: иначе в журнале вместо названия голый id. */
export function exById(id: string, s: State = state): Exercise | undefined {
  return allExercises(s, true).find((e) => e.id === id);
}

export function addCustomExercise(ex: Omit<Exercise, "id" | "custom">) {
  const id = "my-" + uid();
  update((s) => {
    s.customEx.push({ ...ex, id, custom: true });
  });
  return id;
}

export function removeCustomExercise(id: string) {
  update((s) => {
    // если упражнение уже попало в историю, физически не удаляем — иначе
    // в журнале вместо названия останется внутренний идентификатор
    const inHistory = s.sessions.some((ses) =>
      ses.entries.some((e) => e.exId === id),
    );
    if (inHistory) {
      const ex = s.customEx.find((e) => e.id === id);
      if (ex) ex.archived = true;
    } else {
      s.customEx = s.customEx.filter((e) => e.id !== id);
    }
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
    // берём первую свободную букву: после удаления среднего дня счёт по длине
    // списка давал второй «День C»
    const used = new Set(s.plan.map((d) => d.name));
    let letter = 0;
    while (letter < 26 && used.has(`День ${String.fromCharCode(65 + letter)}`)) {
      letter += 1;
    }
    s.plan.push({
      id: uid(),
      name: `День ${String.fromCharCode(65 + letter)}`,
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

/**
 * Начинает тренировку. Если предыдущая не завершена, вернёт false и ничего
 * не тронет — иначе незаписанные подходы пропали бы молча.
 */
export function startSession(dayId: string, force = false): boolean {
  const day = state.plan.find((d) => d.id === dayId);
  if (!day) return false;
  if (state.active && !force) return false;
  const entries: EntryLog[] = day.items.map((it) => {
    const prev = lastEntry(it.exId)?.entry;
    return {
      exId: it.exId,
      targetSets: it.sets,
      targetReps: it.reps,
      targetRest: it.rest,
      planNote: it.note ?? "",
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
  return true;
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

export function finishSession(): boolean {
  let saved = false;
  update((s) => {
    if (!s.active) return;
    const done = structuredClone(s.active);
    done.finishedAt = Date.now();
    // неотмеченные подходы в историю не тащим, но запись с заметкой сохраняем:
    // «болело плечо, вес не пошёл» — это тоже результат
    done.entries.forEach((e) => {
      e.sets = e.sets.filter((x) => x.done);
    });
    done.entries = done.entries.filter(
      (e) => e.sets.length > 0 || e.note.trim().length > 0,
    );
    if (done.entries.length) {
      s.sessions.push(done);
      saved = true;
    }
    s.active = null;
    s.cursor = 0;
    s.timer = { endsAt: null, total: 0, label: "" };
  });
  return saved;
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
    const parsed: unknown = JSON.parse(text);
    if (!isObj(parsed) || !Array.isArray(parsed.plan) || !Array.isArray(parsed.sessions)) {
      return "Файл не похож на выгрузку тренировок";
    }
    const next = normalize(parsed);
    // незавершённую тренировку из файла не поднимаем: доверия к ней нет
    next.active = null;
    next.cursor = 0;
    set(next);
    return null;
  } catch (e) {
    return "Не удалось прочитать JSON: " + (e as Error).message;
  }
}

export function wipeAll() {
  set(initial());
}

