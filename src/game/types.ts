/**
 * Контракт игры. Все модули `src/game/**` импортируют типы отсюда и никогда
 * друг из друга — это то, что позволяет писать их независимо.
 */

export type Phase = "menu" | "playing" | "paused" | "crashed" | "over";

/** 0 — слабое железо/мобильный, 1 — обычное, 2 — «покажи всё». */
export type Quality = 0 | 1 | 2;

export interface InputState {
  /** Намерение по рулю, −1 (влево) … +1 (вправо). */
  steer: number;
  /** Газ 0…1. По умолчанию игра сама держит 1 — газ нужен только чтобы «доддать». */
  throttle: number;
  brake: number;
  nitro: boolean;
}

/** 0 — седан, 1 — фургон, 2 — фура. Задаёт габарит и раскладку огней. */
export type CarKind = 0 | 1 | 2;

export interface Car {
  id: number;
  /** Слот пула занят. Неактивные машины не рисуются и не участвуют в столкновениях. */
  active: boolean;
  /** Дистанция по дороге, м. */
  s: number;
  /** Боковое смещение от осевой, м. */
  lane: number;
  /** Скорость вдоль +s, м/с. У встречных отрицательная. */
  speed: number;
  oncoming: boolean;
  kind: CarKind;
  /** Фаза лёгкого покачивания, чтобы машины не выглядели приклеенными. */
  wobble: number;
  /** Обгон/near-miss по этой машине уже засчитан. */
  scored: boolean;
}

export type PickupKind = "star" | "nitro";

export interface Pickup {
  id: number;
  active: boolean;
  taken: boolean;
  s: number;
  lane: number;
  kind: PickupKind;
  /** Фаза вращения. */
  spin: number;
}

export type GameEventType =
  | "start"
  | "nearmiss"
  | "pickup-star"
  | "pickup-nitro"
  | "scrape"
  | "crash"
  | "nitro-on"
  | "nitro-off"
  | "chapter"
  | "over";

/** Разовое событие кадра. Копится в `game.events`, вычерпывается звуком и HUD. */
export interface GameEvent {
  type: GameEventType;
  /** Смысл зависит от типа: сила удара, номер главы, размер бонуса. */
  value?: number;
}

/** Дерево у дороги — детерминированно выводится из индекса ячейки, не хранится. */
export interface Tree {
  s: number;
  lane: number;
  /** Высота, м. */
  h: number;
  /** Разброс формы 0…1. */
  v: number;
}

/** Фонарь на обочине. */
export interface Lamp {
  s: number;
  /** −1 — левая обочина, +1 — правая. */
  side: -1 | 1;
}

/** Огонёк далёкого городка на склоне. */
export interface TownLight {
  s: number;
  lane: number;
  y: number;
  /** Индекс цвета в `COLORS.town`. */
  tint: number;
}

/**
 * Всё живое состояние заезда в одном мутируемом объекте. Живёт в ref, не в
 * React-состоянии: цикл кадра не должен вызывать перерисовку React.
 */
export interface Game {
  /* --- режим --- */
  phase: Phase;
  /** Секунды с начала заезда. */
  t: number;
  /** Сколько заездов сыграно в этой сессии (для разнообразия сидов). */
  runs: number;

  /* --- движение --- */
  /** Дистанция по дороге, м. */
  s: number;
  /** Скорость, м/с. */
  speed: number;
  /** Боковое положение относительно осевой, м. */
  x: number;
  /** Боковая скорость, м/с. */
  vx: number;
  /** Сглаженное положение руля −1…1 (для графики, не для физики). */
  steer: number;
  /** Курс камеры, рад. */
  yaw: number;
  /** Крен камеры, рад. */
  roll: number;
  /** Фаза покачивания кабины. */
  bob: number;

  /* --- ресурсы и счёт --- */
  /** Запас нитро 0…1. */
  nitro: number;
  nitroActive: boolean;
  lives: number;
  score: number;
  best: number;
  /** Длина текущей цепочки near-miss. */
  combo: number;
  /** Сколько секунд комбо ещё живо. */
  comboTimer: number;
  /** Итоговый множитель очков. */
  multiplier: number;
  /** Собрано звёзд за заезд. */
  stars: number;

  /* --- обратная связь --- */
  /** Сила тряски 0…1, затухает. */
  shake: number;
  /** Сила вспышки 0…1, затухает. */
  flash: number;
  /** Сколько секунд длится состояние `crashed`. */
  crashTimer: number;
  /** Неуязвимость после удара, с. */
  invuln: number;

  /* --- небо --- */
  /** Индекс главы неба (растёт бесконечно, цвет берётся по модулю). */
  chapter: number;
  /** Прогресс внутри главы 0…1. */
  chapterT: number;

  /* --- ввод и мир --- */
  input: InputState;
  /** Пул машин фиксированного размера, см. `LIMITS.cars`. */
  cars: Car[];
  /** Пул бонусов, см. `LIMITS.pickups`. */
  pickups: Pickup[];
  /** Очередь событий кадра. Потребители обязаны её опустошать. */
  events: GameEvent[];

  /* --- служебное --- */
  seed: number;
  quality: Quality;
  reducedMotion: boolean;
  muted: boolean;
  /** До какой дистанции мир уже заселён машинами. */
  spawnCursor: number;
  /** До какой дистанции расставлены бонусы. */
  pickupCursor: number;
  nextId: number;
}

/** Снимок для HUD: React читает его ~12 раз в секунду, а не каждый кадр. */
export interface HudSnapshot {
  phase: Phase;
  speedKmh: number;
  score: number;
  best: number;
  lives: number;
  nitro: number;
  combo: number;
  multiplier: number;
  distance: number;
  stars: number;
  chapter: number;
  muted: boolean;
}
