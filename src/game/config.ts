/**
 * Все настраиваемые числа игры и палитра. Единственный источник правды: если
 * значение нужно двум модулям — оно живёт здесь, а не дублируется.
 *
 * Единицы: метры, секунды, м/с. Скорость на экране — км/ч (× 3.6).
 */

import type { Quality } from "./types";

/* ---------- геометрия дороги ---------- */

export const ROAD = {
  /** Половина ширины полотна (без обочин), м. Всего 13.6 м на четыре полосы. */
  halfWidth: 6.8,
  /** Центры наших полос (правостороннее движение, +x — вправо). */
  laneCenters: [1.85, 5.15] as const,
  /** Обочина за полотном. */
  shoulder: 1.3,
  /** Отбойник: дальше не пускаем. */
  railX: 8.4,
  /** Ширина разметки. */
  markWidth: 0.17,
  /** Прерывистая разметка: длина штриха и разрыва. */
  dashLen: 4,
  dashGap: 7,
  /** Длина сегмента ленты полотна и их количество: 5 × 200 = 1000 м видимости. */
  segLen: 5,
  segCount: 200,
} as const;

/** Полная длина отрисовываемой дороги, м. */
export const ROAD_LEN = ROAD.segLen * ROAD.segCount;

/* ---------- камера и туман ---------- */

export const CAM = {
  /** Высота глаз водителя над полотном, м. */
  height: 1.16,
  fov: 74,
  /** Насколько FOV раскрывается на нитро. */
  fovNitro: 88,
  /** Доля курса дороги, которую отрабатывает камера (0 — жёстко вперёд). */
  headingFollow: 0.55,
  /** Крен от руления, рад на единицу руля. */
  rollPerSteer: 0.055,
  /** Амплитуда покачивания кабины, м. */
  bobAmp: 0.016,
  /** Частота покачивания, Гц на м/с. */
  bobRate: 0.09,
  /** Максимальный сдвиг камеры от тряски, м. */
  shakeAmp: 0.32,
} as const;

export const FOG = {
  near: 260,
  far: 940,
} as const;

/* ---------- физика ---------- */

export const PHYS = {
  /** Скорость на старте, м/с (~108 км/ч). */
  speedStart: 30,
  /** Потолок без нитро, м/с (~280 км/ч). */
  speedMax: 78,
  /** Дистанция, на которой потолок раскрывается полностью, м. */
  rampDistance: 4200,
  /** Прибавка потолка на нитро, м/с. */
  nitroBoost: 20,
  /** Разгон, м/с². */
  accel: 4.6,
  /** Дополнительный разгон на нитро. */
  accelNitro: 9,
  /** Замедление тормозом, м/с². */
  brakeDecel: 24,
  /** Пассивное сопротивление, м/с² на (м/с)². */
  drag: 0.0016,
  /** Боковое ускорение от полностью выкрученного руля на малой скорости, м/с². */
  steerAccel: 34,
  /** Насколько руль «тяжелеет» с ростом скорости, м/с² на (м/с). */
  steerHeavy: 0.14,
  /** Нижний предел бокового ускорения, чтобы на максималке ещё можно было ехать. */
  steerAccelMin: 15,
  /** Затухание боковой скорости, 1/с. */
  vxDamp: 5.2,
  /** Скорость сглаживания графики руля, 1/с. */
  steerSmooth: 9,
  /** Замедление на обочине, м/с². */
  offroadDrag: 14,
  /** Потеря скорости при задире об отбойник, доля. */
  scrapeLoss: 0.12,
  /** Потеря скорости при аварии, доля от текущей. */
  crashLoss: 0.62,
  /** Сколько длится состояние «crashed», с. */
  crashTime: 1.15,
  /** Неуязвимость после аварии, с. */
  invulnTime: 2.2,
} as const;

/** Габариты для столкновений: половина ширины и половина длины, м. */
export const BOX = {
  player: { hw: 0.94, hl: 2.3 },
  /** По `CarKind`: седан, фургон, фура. */
  cars: [
    { hw: 0.95, hl: 2.35 },
    { hw: 1.08, hl: 2.95 },
    { hw: 1.32, hl: 5.1 },
  ] as const,
} as const;

/* ---------- трафик и бонусы ---------- */

export const TRAFFIC = {
  /** Насколько далеко вперёд заселяем мир, м. */
  spawnAhead: 950,
  /** На сколько метров позади машину пора убирать. */
  despawnBehind: 90,
  /** Интервал между появлениями на старте и в пределе, м. */
  gapStart: 130,
  gapMin: 52,
  /** Дистанция, на которой интервал доходит до минимума, м. */
  gapRamp: 5000,
  /** Доля встречных среди появляющихся. */
  oncomingShare: 0.46,
  /** Скорость ведущих машин как доля от текущего потолка игрока. */
  leadSpeedFrac: [0.38, 0.66] as const,
  /** Скорость встречных, м/с (по модулю). */
  oncomingSpeed: [26, 40] as const,
  /** Шанс, что появится сразу пара машин рядом (сложнее обгонять). */
  pairChance: 0.22,
  /** Боковой зазор, при котором проезд считается near-miss, м. */
  nearMissGap: 2.15,
} as const;

export const PICKUPS = {
  /** Интервал между бонусами, м. */
  gap: [150, 300] as const,
  /** Доля нитро-канистр среди бонусов (остальное — звёзды). */
  nitroShare: 0.3,
  /**
   * Высота над полотном, м. Глаза водителя на 1.16 м, поэтому на 1.5 м бонус
   * висел ровно на линии горизонта и на любой дистанции сливался с ней. 2.6 м
   * поднимает его над прицелом и вынимает из полосы тумана, но оставляет под
   * крышей фуры.
   */
  y: 2.6,
  /** Радиус подбора: боковой и по дистанции, м. */
  grabLane: 1.5,
  grabS: 3.2,
  /** Сколько метров позади держать подобранный бонус, чтобы доиграла анимация. */
  keepBehind: 20,
  /** Звёзды часто идут дорожкой — сколько подряд. */
  chain: [1, 4] as const,
  chainStep: 22,
} as const;

/* ---------- очки и нитро ---------- */

export const SCORE = {
  /** Очков за метр. */
  perMeter: 1,
  star: 250,
  /** База за near-miss, умножается на длину комбо. */
  nearMiss: 120,
  /** Комбо выше этого не растит множитель. */
  comboCap: 12,
  /** Сколько живёт комбо без подтверждения, с. */
  comboWindow: 4.5,
  /** Вклад комбо в множитель. */
  comboMul: 0.14,
  /** Вклад скорости в множитель (на доле от потолка). */
  speedMul: 0.6,
} as const;

export const NITRO = {
  /** Расход при активном нитро, 1/с. */
  drain: 0.3,
  /** Пассивная подзарядка, 1/с. */
  regen: 0.014,
  fromStar: 0.2,
  fromCan: 0.55,
  fromNearMiss: 0.06,
  /** Ниже этого запаса нитро не включается. */
  minToFire: 0.08,
} as const;

/* ---------- небо ---------- */

export const SKY = {
  /** Длины глав в метрах; дальше цикл. */
  chapters: [1200, 1400, 1600, 1800] as const,
  /** Доля главы, уходящая на кроссфейд в следующую. */
  fade: 0.16,
  /** Радиус купола, м. */
  radius: 2600,
} as const;

/* ---------- пулы и лимиты ---------- */

export const LIMITS = {
  cars: 28,
  pickups: 24,
} as const;

/* ---------- пресеты качества ---------- */

export interface QualityPreset {
  label: string;
  stars: number;
  trees: number;
  townLights: number;
  lamps: number;
  /** Bloom включён. */
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  /** Верхняя граница devicePixelRatio. */
  dprMax: number;
  /** Рисовать световые полосы за встречными. */
  trails: boolean;
  /** Сегментов у ленты дороги (меньше — грубее дальний план). */
  roadSegments: number;
  meteors: number;
}

export const QUALITY: Record<Quality, QualityPreset> = {
  0: {
    label: "экономно",
    stars: 900,
    trees: 90,
    townLights: 70,
    lamps: 10,
    bloom: false,
    bloomStrength: 0,
    bloomRadius: 0,
    bloomThreshold: 1,
    dprMax: 1,
    trails: false,
    roadSegments: 110,
    meteors: 6,
  },
  1: {
    label: "обычно",
    stars: 2000,
    trees: 190,
    // worldGen может выдать до ~210 огней в пределах видимости — с меньшим пулом
    // дальний край городка просто обрубается.
    townLights: 210,
    // Фонари стоят не чаще чем раз в 70 м, дальше 900 м не видно: больше 12 в
    // кадре не бывает физически.
    lamps: 12,
    bloom: true,
    // Сравнение одного и того же кадра с bloom и без него показало: свечение
    // должно доставаться только по-настоящему ярким вещам — звезде, фарам,
    // головам фонарей, приборке. Стоило порогу опуститься, и в свечение уходила
    // разметка и блики на асфальте, а кадр затягивало молочной пеленой; тёплый
    // оттенок ей давала жёлтая осевая, размазанная по всему небу.
    bloomStrength: 0.5,
    bloomRadius: 0.28,
    bloomThreshold: 0.8,
    dprMax: 1.5,
    trails: true,
    roadSegments: 170,
    meteors: 14,
  },
  2: {
    label: "красиво",
    stars: 3400,
    trees: 280,
    townLights: 260,
    lamps: 14,
    bloom: true,
    bloomStrength: 0.6,
    bloomRadius: 0.3,
    bloomThreshold: 0.8,
    dprMax: 1.9,
    trails: true,
    roadSegments: 200,
    meteors: 22,
  },
};

/* ---------- палитра ---------- */

export const COLORS = {
  night0: "#04081a",
  night1: "#0a1a3a",
  night2: "#123061",

  asphalt: "#0a1120",
  asphaltSheen: "#14264a",
  shoulder: "#0d1526",

  markCenter: "#ffd15c",
  markSide: "#cfe6ff",

  neon: "#5ecbff",
  neonDeep: "#2b8cff",

  tail: "#ff2a1a",
  tailDim: "#8c1108",
  head: "#dbeaff",
  headWarm: "#fff0d0",

  foliage: "#0e3a2f",
  foliageLit: "#1f7a5a",

  rail: "#37455c",
  // Янтарь, а не мята: раньше катафоты отбойника были байт в байт цвета нитро,
  // и на скорости отблеск на ограждении читался как бонус.
  railStud: "#ffb46a",
  lampGlow: "#9fd8ff",

  town: ["#ffcf8a", "#ff7a5a", "#7affc8", "#9fd0ff"] as const,

  star: "#eaf4ff",
  starWarm: "#ffe6b0",
  nebulaCore: "#48e0ff",
  nebulaMid: "#1b4fd6",
  nebulaEdge: "#08133c",

  mountain: "#050d22",
  mountainRim: "#123a6b",

  gauge: "#ff2a1a",
  gaugeGlow: "#ff6a4a",
  gaugeDim: "#5c1008",
  cabin: "#05070d",
  cabinEdge: "#151f31",

  nitro: "#7affc8",
  combo: "#ffd15c",
  danger: "#ff4a3a",
} as const;

/* ---------- ключи в localStorage ---------- */

export const STORE = {
  best: "starry-ride:best",
  muted: "starry-ride:muted",
  quality: "starry-ride:quality",
  seen: "starry-ride:seen-help",
} as const;
