// Типы данных фитнес-трекера. Всё хранится локально в браузере (localStorage).

export type MuscleGroup =
  | "shoulders"
  | "back"
  | "chest"
  | "legs"
  | "arms"
  | "core";

/** Пучок дельтовидной — нужен, чтобы считать баланс нагрузки на плечи. */
export type DeltHead = "front" | "side" | "rear";

export type Equipment =
  | "barbell"
  | "dumbbell"
  | "cable"
  | "band"
  | "machine"
  | "body"
  | "bars";

/** Ключ анимации из art/motions.ts. */
export type MotionKey = string;

export type Exercise = {
  id: string;
  name: string;
  en: string;
  group: MuscleGroup;
  /** Только для плеч: какие пучки грузим. */
  heads?: DeltHead[];
  equipment: Equipment;
  motion: MotionKey;
  /** Папка в free-exercise-db → две фотографии: начало и конец движения. */
  photo?: string;
  cues: string[];
  mistakes?: string[];
  def: { sets: number; reps: string; rest: number };
  /** true у упражнений, добавленных руками. */
  custom?: boolean;
  /** Своё упражнение удалили, но оно есть в истории — прячем, но имя храним. */
  archived?: boolean;
};

export type PlanItem = {
  exId: string;
  sets: number;
  reps: string;
  rest: number;
  note?: string;
};

export type PlanDay = {
  id: string;
  name: string;
  subtitle: string;
  items: PlanItem[];
};

export type SetLog = {
  id: string;
  weight: number;
  reps: number;
  rpe: number | null;
  done: boolean;
  at: number | null;
};

export type EntryLog = {
  exId: string;
  /** Копия цели на момент старта — план потом можно менять, история не поедет. */
  targetSets: number;
  targetReps: string;
  targetRest: number;
  /** Заметка из плана, скопированная на старте тренировки. */
  planNote: string;
  sets: SetLog[];
  note: string;
  done: boolean;
};

export type Session = {
  id: string;
  dayId: string;
  dayName: string;
  startedAt: number;
  finishedAt: number | null;
  entries: EntryLog[];
  note: string;
  /** Самочувствие 1–5. */
  feel: number | null;
};

export type Settings = {
  sound: boolean;
  vibrate: boolean;
  /** Подтягивать фотографии из интернета (нужен онлайн). */
  photos: boolean;
  /** Автостарт таймера отдыха после отметки подхода. */
  autoRest: boolean;
};

export type Timer = {
  /** Метка времени окончания отдыха; null — таймер выключен. */
  endsAt: number | null;
  total: number;
  label: string;
};

export type State = {
  v: number;
  plan: PlanDay[];
  customEx: Exercise[];
  /** id упражнения → ссылка на видео, которую сохранил пользователь. */
  videos: Record<string, string>;
  sessions: Session[];
  active: Session | null;
  /** Индекс упражнения, открытого в активной тренировке. */
  cursor: number;
  timer: Timer;
  settings: Settings;
};
