/**
 * Каждое упражнение показывается как анимация между двумя позами.
 * Углы — абсолютные, в градусах, от направления «строго вниз»:
 * 0 — вниз, 90 — в сторону (вид спереди) или вперёд (вид сбоку), 180 — вверх.
 */
export type Pose = {
  /** Наклон корпуса от вертикали, + = вперёд. Вид спереди: корпус визуально укорачивается. */
  lean?: number;
  hip?: number;
  knee?: number;
  hipL?: number;
  kneeL?: number;
  arm: number;
  fore: number;
  armL?: number;
  foreL?: number;
  /** Подъём плеч (шраги). */
  lift?: number;
  x?: number;
  y?: number;
};

export type EnvKey =
  | "floor"
  | "seatFront"
  | "seatSide"
  | "benchFlat"
  | "benchIncline"
  | "benchLow"
  | "pullupBar"
  | "cableTop"
  | "cableBottom"
  | "cableSides"
  | "cableMid"
  | "dipBars"
  | "sled"
  | "hyperPad"
  | "machine";

export type Motion = {
  view: "front" | "side";
  env?: EnvKey[];
  equip?: "barbell" | "dumbbell" | "cable" | "band" | "bar" | "none";
  /** Точка блока, откуда идёт трос к правой/левой руке. */
  anchor?: { x: number; y: number };
  anchorL?: { x: number; y: number };
  origin?: { x: number; y: number };
  a: Pose;
  b: Pose;
  phases: [string, string];
  /** Секунд на полный цикл. */
  period?: number;
};

const P = (o: { x: number; y: number }) => o;

export const MOTIONS: Record<string, Motion> = {
  pressStand: {
    view: "front",
    env: ["floor"],
    equip: "barbell",
    a: { arm: 35, fore: 186 },
    b: { arm: 168, fore: 178 },
    phases: ["гриф на груди", "выжал над головой"],
  },
  pressSeated: {
    view: "front",
    env: ["seatFront"],
    equip: "dumbbell",
    a: { arm: 70, fore: 175 },
    b: { arm: 165, fore: 172 },
    phases: ["гантели у ушей", "руки вверх"],
  },
  machinePress: {
    view: "front",
    env: ["seatFront", "machine"],
    equip: "none",
    a: { arm: 72, fore: 172 },
    b: { arm: 160, fore: 170 },
    phases: ["ручки у плеч", "выжал"],
  },
  arnold: {
    view: "front",
    env: ["seatFront"],
    equip: "dumbbell",
    a: { arm: 22, fore: 202 },
    b: { arm: 165, fore: 172 },
    phases: ["ладони к себе", "разворот и жим"],
  },
  lateralRaise: {
    view: "front",
    env: ["floor"],
    equip: "dumbbell",
    a: { arm: 8, fore: 12 },
    b: { arm: 88, fore: 78 },
    phases: ["руки вдоль тела", "до линии плеч"],
  },
  lateralRaiseSeated: {
    view: "front",
    env: ["seatSide"],
    equip: "dumbbell",
    a: { arm: 10, fore: 14 },
    b: { arm: 88, fore: 78 },
    phases: ["внизу", "до линии плеч"],
  },
  cableLateral: {
    view: "front",
    env: ["floor", "cableBottom"],
    equip: "cable",
    anchor: P({ x: 26, y: 190 }),
    a: { arm: -28, fore: -24, armL: 8, foreL: 10 },
    b: { arm: 85, fore: 75, armL: 8, foreL: 10 },
    phases: ["рука перед корпусом", "мах в сторону"],
  },
  uprightRow: {
    view: "front",
    env: ["floor"],
    equip: "barbell",
    a: { arm: 8, fore: 6 },
    b: { arm: 100, fore: 245 },
    phases: ["гриф у бёдер", "локти в стороны, к груди"],
  },
  shrug: {
    view: "front",
    env: ["floor"],
    equip: "dumbbell",
    a: { arm: 6, fore: 6, lift: 0 },
    b: { arm: 6, fore: 6, lift: 12 },
    phases: ["плечи опущены", "плечи к ушам"],
  },
  frontRaise: {
    view: "side",
    env: ["floor"],
    equip: "dumbbell",
    a: { arm: 5, fore: 5 },
    b: { arm: 85, fore: 82 },
    phases: ["внизу", "до уровня глаз"],
  },
  scaption: {
    view: "front",
    env: ["floor"],
    equip: "dumbbell",
    a: { arm: 8, fore: 10 },
    b: { arm: 68, fore: 60 },
    phases: ["внизу", "по диагонали 45°"],
  },
  bentRearFly: {
    view: "front",
    env: ["floor"],
    equip: "dumbbell",
    a: { lean: 70, arm: 10, fore: 14 },
    b: { lean: 70, arm: 95, fore: 85 },
    phases: ["наклон, руки внизу", "развёл в стороны"],
  },
  seatedRearFly: {
    view: "front",
    env: ["seatSide"],
    equip: "dumbbell",
    a: { lean: 74, arm: 10, fore: 14 },
    b: { lean: 74, arm: 95, fore: 85 },
    phases: ["лёг грудью на бёдра", "развёл"],
  },
  cableRearFly: {
    view: "front",
    env: ["floor", "cableSides"],
    equip: "cable",
    anchor: P({ x: 12, y: 78 }),
    anchorL: P({ x: 188, y: 78 }),
    a: { arm: -30, fore: -34, armL: -30, foreL: -34 },
    b: { arm: 95, fore: 88, armL: 95, foreL: 88 },
    phases: ["руки скрещены", "развёл назад"],
  },
  facePull: {
    view: "side",
    env: ["floor", "cableTop"],
    equip: "cable",
    anchor: P({ x: 186, y: 34 }),
    a: { arm: 120, fore: 118 },
    b: { arm: 95, fore: 200 },
    phases: ["руки вытянуты", "канат к лицу, локти выше кистей"],
  },
  bandApart: {
    view: "front",
    env: ["floor"],
    equip: "band",
    a: { arm: 38, fore: 34 },
    b: { arm: 88, fore: 84 },
    phases: ["руки перед собой", "растянул ленту"],
  },
  extRot: {
    view: "front",
    env: ["floor", "cableMid"],
    equip: "cable",
    anchor: P({ x: 18, y: 120 }),
    a: { arm: 5, fore: 250, armL: 6, foreL: 8 },
    b: { arm: 5, fore: 95, armL: 6, foreL: 8 },
    phases: ["предплечье у живота", "разворот наружу"],
  },
  cuban: {
    view: "front",
    env: ["floor"],
    equip: "dumbbell",
    a: { arm: 8, fore: 6 },
    b: { arm: 95, fore: 185 },
    phases: ["внизу", "локти вверх, предплечья вверх"],
  },
  rearRow: {
    view: "front",
    env: ["floor"],
    equip: "barbell",
    a: { lean: 62, arm: 12, fore: 10 },
    b: { lean: 62, arm: 85, fore: 230 },
    phases: ["гриф внизу", "локти в стороны, к груди"],
  },
  bentRow: {
    view: "side",
    env: ["floor"],
    equip: "barbell",
    a: { lean: 58, hip: -6, knee: 10, arm: 0, fore: 0 },
    b: { lean: 58, hip: -6, knee: 10, arm: -42, fore: 184 },
    phases: ["гриф у голеней", "тяга к животу"],
  },
  dbRow: {
    view: "side",
    env: ["floor", "benchLow"],
    equip: "dumbbell",
    a: { lean: 66, hip: -6, knee: 10, arm: 0, fore: 0 },
    b: { lean: 66, hip: -6, knee: 10, arm: -44, fore: 186 },
    phases: ["рука вытянута", "локоть вдоль тела назад"],
  },
  pulldown: {
    view: "side",
    env: ["seatSide", "cableTop"],
    equip: "cable",
    anchor: P({ x: 118, y: 20 }),
    a: { arm: 168, fore: 176 },
    b: { arm: 15, fore: 160 },
    phases: ["руки вверху", "локти вниз, к груди"],
  },
  pullup: {
    view: "side",
    env: ["pullupBar"],
    equip: "bar",
    a: { arm: 176, fore: 178, hip: -8, knee: 16, y: 16 },
    b: { arm: 150, fore: 214, hip: -8, knee: 16, y: -14 },
    phases: ["вис на прямых руках", "подбородок выше перекладины"],
  },
  hyper: {
    view: "side",
    env: ["hyperPad"],
    equip: "none",
    origin: P({ x: 118, y: 108 }),
    a: { lean: 118, hip: -104, knee: -94, arm: 150, fore: 232 },
    b: { lean: 86, hip: -104, knee: -94, arm: 150, fore: 232 },
    phases: ["корпус вниз", "до прямой линии"],
  },
  benchPress: {
    view: "side",
    env: ["floor", "benchFlat"],
    equip: "barbell",
    origin: P({ x: 92, y: 112 }),
    a: { lean: 90, hip: -42, knee: -4, arm: 232, fore: 136 },
    b: { lean: 90, hip: -42, knee: -4, arm: 186, fore: 178 },
    phases: ["гриф у груди", "выжал"],
  },
  inclinePress: {
    view: "side",
    env: ["floor", "benchIncline"],
    equip: "dumbbell",
    origin: P({ x: 88, y: 126 }),
    a: { lean: 58, hip: -34, knee: 4, arm: 224, fore: 144 },
    b: { lean: 58, hip: -34, knee: 4, arm: 182, fore: 176 },
    phases: ["гантели у груди", "выжал"],
  },
  pushup: {
    view: "side",
    env: ["floor"],
    equip: "none",
    origin: P({ x: 88, y: 140 }),
    a: { lean: 92, hip: -86, knee: -90, arm: 0, fore: 2 },
    b: { lean: 92, hip: -86, knee: -90, arm: -34, fore: 36, y: 14 },
    phases: ["упор лёжа", "грудь к полу"],
  },
  dips: {
    view: "side",
    env: ["dipBars"],
    equip: "none",
    a: { arm: -8, fore: -4, hip: -14, knee: 26 },
    b: { arm: -46, fore: 22, hip: -14, knee: 26, y: 24 },
    phases: ["вверху", "локти ~90°"],
  },
  squat: {
    view: "side",
    env: ["floor"],
    equip: "barbell",
    a: { lean: 8, hip: 4, knee: -4, arm: 150, fore: 194 },
    b: { lean: 34, hip: 54, knee: -30, arm: 150, fore: 194, y: 23 },
    phases: ["стоя", "бедро параллельно полу"],
  },
  legPress: {
    view: "side",
    env: ["sled"],
    equip: "none",
    origin: P({ x: 74, y: 132 }),
    a: { lean: -42, hip: 96, knee: -28, arm: 62, fore: 96 },
    b: { lean: -42, hip: 62, knee: 58, arm: 62, fore: 96 },
    phases: ["колени согнуты", "выпрямил ноги"],
  },
  rdl: {
    view: "side",
    env: ["floor"],
    equip: "barbell",
    a: { lean: 6, hip: 0, knee: -4, arm: 0, fore: 0 },
    b: { lean: 74, hip: -8, knee: 12, arm: 0, fore: 0 },
    phases: ["стоя", "таз назад, гриф по бедру"],
  },
  curl: {
    view: "front",
    env: ["floor"],
    equip: "dumbbell",
    a: { arm: 6, fore: 6 },
    b: { arm: 8, fore: 150 },
    phases: ["руки прямые", "согнул до плеч"],
  },
  pushdown: {
    view: "side",
    env: ["floor", "cableTop"],
    equip: "cable",
    anchor: P({ x: 160, y: 26 }),
    a: { arm: 0, fore: 138 },
    b: { arm: 0, fore: 6 },
    phases: ["предплечья у груди", "разогнул вниз"],
  },
  plank: {
    view: "side",
    env: ["floor"],
    equip: "none",
    origin: P({ x: 92, y: 146 }),
    a: { lean: 92, hip: -86, knee: -90, arm: -10, fore: 88 },
    b: { lean: 90, hip: -87, knee: -90, arm: -10, fore: 88 },
    phases: ["держим", "тело — одна линия"],
    period: 3.6,
  },
  farmer: {
    view: "side",
    env: ["floor"],
    equip: "dumbbell",
    a: { arm: 3, fore: 3, hip: 14, knee: -12, hipL: -12, kneeL: 14 },
    b: { arm: 3, fore: 3, hip: -12, knee: 14, hipL: 14, kneeL: -12 },
    phases: ["шаг", "шаг"],
    period: 1.6,
  },
};

export const DEFAULT_MOTION: Motion = MOTIONS.lateralRaise;
