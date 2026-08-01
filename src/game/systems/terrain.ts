/**
 * Рельеф вокруг дороги: силуэты хребтов, тёмная насыпь обочин и хвойный лес.
 *
 * Правило кадра из референса: ЦЕННОСТЬ ЕСТЬ ТОЛЬКО У ДОРОГИ, ОГНЕЙ И НЕБА.
 * Всё, что растёт и лежит по сторонам, — почти чёрное. Лес читается силуэтом с
 * холодной кромкой там, где его достают фары и небо; насыпь уходит в ноль;
 * хребет темнее неба и светлеет только от воздушной перспективы.
 *
 * Три слоя, все — от дистанции камеры, без единой аллокации в кадре:
 *
 *   1. ХРЕБТЫ. Две длинные ленты-силуэта (слева и справа) на удалении
 *      `RIDGE_LANE` метров. Каждая — полоса из трёх рядов: подножие, которое
 *      растворяется в ночи, плотная тёмная масса и гребень на высоте
 *      `ridge(s, side)`. Поверх гребня идёт вторая, тонкая аддитивная лента
 *      `COLORS.mountainRim` — холодная кромка из f_003 и f_007. Кромка лежит
 *      НА склоне (вниз от гребня), а не над ним, и включается только там, где
 *      под ней читается масса горы: иначе она отрывается и висит в небе
 *      отдельной синей загогулиной.
 *
 *   2. НАСЫПЬ. Тёмный склон от кромки обочины (дорога заканчивается на
 *      `railX + 0.7`) и до 260 м в стороны. Без него под деревьями и у нижних
 *      углов кадра просвечивал бы купол неба. Заодно склон даёт лесу, на чём
 *      стоять: основание дерева садится на тот же профиль `slopeY`.
 *
 *   3. ЛЕС. Один InstancedMesh низкополигонального хвойника. Пул считается один
 *      раз по `QUALITY[ctx.quality].trees` — качество меняется пересборкой
 *      систем, а не переразмером буферов на ходу; в кадре занимается столько
 *      слотов, сколько разрешает пресет, но не больше пула. Освещение запечено
 *      в цвет вершин: почти чёрное тело `COLORS.foliage` плюс узкий блик
 *      `COLORS.foliageLit` на грани, повёрнутой к дороге. Цвет инстанса —
 *      только затемнение, он никогда не выводит дерево ярче `foliage`.
 *
 * ЛЕНТЫ ЖЁСТКИЕ. Внутри клетки s-сетки полоса не меняет формы: и `localX`, и
 * `localY`, и `localZ` отличаются от «сеточных» координат ровно на общий сдвиг
 * (`roadX(base) − roadX(camS) − camX`, `roadY(base) − roadY(camS)`,
 * `camS − base`). Поэтому вершины пересчитываются только на переходе через
 * клетку, а в кадре двигается `mesh.position`. Всё, что зависит от дистанции
 * (альфа, дымка, толщина кромки, свет фар), меняется на масштабе сотен метров,
 * и ступенька в 24–32 м в этом не видна.
 *
 * Туман сцены ставит Rig. Насыпь и деревья честно им гасятся (`fog: true`) и
 * потому не заканчиваются резкой линией. Хребты стоят в 1–2 км, то есть далеко
 * за `FOG.far`, — линейный туман съел бы их целиком, поэтому у них `fog: false`
 * и собственное растворение по альфе в вершинах.
 *
 * Генераторы деревьев и высоты хребта приходят снаружи, в `TerrainDeps`. Это не
 * церемония: ровно она и не даёт этому модулю импортировать `worldGen`.
 */

import * as THREE from "three";

import type { RenderCtx, System } from "../ctx";
import type { Game, Tree } from "../types";
import { COLORS, FOG, QUALITY } from "../config";
import { localX, localY, localZ, roadX, roadY } from "../road";
import { clamp, lerp, smoothstep } from "../num";
import { noise1 } from "../rng";

/* ---------- общее ---------- */

const TAU = Math.PI * 2;

/* ---------- хребты ---------- */

/** Боковое удаление гребня, м. Ближе — гора лезет в кадр стеной у самых краёв,
 *  и её гребень уходит высоко в небо; дальше — силуэт ложится низкой полосой
 *  над точкой схода, как в f_007. Заодно огни городка (до 420 м) оказываются
 *  перед хребтом, а не за ним. */
const RIDGE_LANE = 560;
/** Насколько гребень гуляет вбок вдоль дороги, ±м: линии перестают быть
 *  параллельными коридору и читаются как отроги. */
const RIDGE_WANDER = 120;
const RIDGE_NOISE = 1 / 780;

/** Шаг сетки вершин, м. Вершины у `ridgeHeight` живут на масштабе ~145 м,
 *  так что 32 м — это ещё 4–5 отсчётов на пик, а не гребёнка. */
const RIDGE_STEP = 32;
/** Насколько лента начинается позади камеры, м. */
const RIDGE_BACK = 64;
/** Дальний край и начало растворения, м. Край — заведомо внутри купола неба
 *  (`SKY.radius` 2600), иначе гора уехала бы за дальнюю плоскость. */
const RIDGE_FAR = 2200;
const RIDGE_FADE = 1500;
const RIDGE_COLS = Math.ceil((RIDGE_FAR + RIDGE_BACK) / RIDGE_STEP) + 1;

/** Ряды тела: подножие (альфа 0), низ массы, гребень. Ниже −24 м массу всё
 *  равно закрывает непрозрачная насыпь, поэтому подножие не тянем в бездну —
 *  это чистый оверфилл на всю ширину кадра. */
const RIDGE_BOT_Y = -110;
const RIDGE_MID_Y = -24;

/** Воздушная перспектива: дальний хребет светлеет и синеет, ближний остаётся
 *  почти чёрным силуэтом. Подмес идёт во ВСЕ ряды сразу — гора должна быть
 *  плоским силуэтом, а не подсвеченным по гребню валиком. */
const RIDGE_HAZE_LO = 0.07;
const RIDGE_HAZE_HI = 0.24;
const RIDGE_HAZE_D0 = 700;

/** Толщина кромки в метрах: доля дистанции, чтобы на экране она всегда была
 *  в пару пикселей, а не исчезала вдали и не превращалась в вал вблизи. */
const RIM_K = 0.01;
const RIM_MIN = 5;
const RIM_MAX = 34;
/** Полоса кромки: почти ничего вверх от гребня и длинный хвост вниз по склону.
 *  Симметричная полоса читалась бы линией, висящей в небе, — ровно тот дефект,
 *  который видно в верхних углах старого кадра. */
const RIM_UP = 0.25;
const RIM_DOWN = 2;
/** Кромка появляется только там, где под ней есть читаемая масса горы. Ближе
 *  `RIM_D0` лента идёт почти ребром к камере, уходит за край кадра, и линия
 *  отрывается от силуэта. */
const RIM_D0 = 520;
const RIM_D1 = 900;
const RIM_LO = 0.24;
const RIM_HI = 0.45;

/** Порядок отрисовки: после неба (у него −1000…−860), но до всего дорожного. */
const ORDER_RIDGE = -820;
const ORDER_RIM = -815;

/* ---------- насыпь ---------- */

const APRON_STEP = 24;
const APRON_BACK = 24;
/** Насыпь тянется заметно дальше тумана: её край должен утонуть в нём целиком,
 *  а не оборваться там, где ещё виден грунт. */
const APRON_FAR = 1500;
const APRON_COLS = Math.ceil((APRON_FAR + APRON_BACK) / APRON_STEP) + 1;

/** Где насыпь смыкается под дорогой: лента полотна кончается на `ROAD_LEN`
 *  (1000 м), и дальше между левой и правой обочиной осталась бы щель в небо. */
const APRON_SEAL0 = 940;
const APRON_SEAL1 = 1080;

/** Колонки склона по боковому удалению, м. Первая садится на внешнюю кромку
 *  обочины (`ROAD.railX + 0.7` = 9.1 м), последняя уходит за огни городка. */
const APRON_X: readonly number[] = [9, 20, 46, 110, 260];
const APRON_ROWS = APRON_X.length;
/** Яркость ряда: чем выше по склону, тем чернее. Все множители сильно меньше
 *  единицы — обочина в референсе не «серо-синее поле», а темнота, на фоне
 *  которой асфальт остаётся самым светлым на земле. */
const APRON_MUL: readonly number[] = [1, 0.66, 0.38, 0.19, 0.09];
/** Сколько света фар достаёт до ряда. */
const APRON_NEAR: readonly number[] = [0.55, 0.22, 0.06, 0, 0];
/** Подмес `COLORS.shoulder` в освещённый ряд. Меньше единицы: даже под фарами
 *  обочина обязана остаться темнее асфальта. */
const APRON_LIT_MUL = 0.75;
/** Спад света фар, м. Длинный намеренно: короткий спад пришлось бы считать
 *  каждый кадр, а так его хватает пересчитывать на переходе через клетку. */
const APRON_LIT_D = 430;
/** Затухание в чёрное по дистанции: дальний грунт гаснет раньше тумана. */
const APRON_DARK_D0 = 40;
const APRON_DARK_D1 = 700;
const APRON_DARK_MIN = 0.05;
/** Амплитуда рельефа дальних рядов, м. Ближние ряды ровные — на них стоит лес. */
const APRON_BUMP: readonly number[] = [0, 0, 0, 5, 11];
const APRON_NOISE = 1 / 180;

/** Высота грунта на боковом удалении `a` (модуль lane), м. Двумя ступенями:
 *  пологая обочина у дороги и уходящий вверх лесистый склон. */
function slopeY(a: number): number {
  return -0.25 + 3.4 * smoothstep(9, 48, a) + 26 * smoothstep(44, 260, a);
}

/* ---------- лес ---------- */

/** Дальность леса по пресетам, доля от `FOG.far`. Дальше туман съедает дерево
 *  на две трети и больше — платить за него нечем. Плюс пул перестаёт кончаться
 *  раньше дальней кромки, и усадка `grow` наконец работает как задумана. */
const TREE_RANGE: readonly number[] = [0.34 * FOG.far, 0.6 * FOG.far, 0.77 * FOG.far];
/** Предел бокового удаления: на экономном режиме дальний ряд не рисуем вовсе,
 *  зато ближняя стена доживает до нормальной дистанции. */
const TREE_LANE_MAX: readonly number[] = [19, 40, 40];
/** Насколько закапываем основание, м: профиль насыпи между колонками ленты
 *  интерполируется линейно и на полметра расходится с `slopeY`. */
const TREE_SINK = -0.4;
/** Ближний ряд генератора стоит в 9.9 м от осевой и семнадцатиметровой ёлкой
 *  закрывает полкадра. Отодвигаем его от полотна и подрезаем по высоте, чтобы
 *  крона обрамляла дорогу, а не заполняла небо. */
const TREE_PUSH = 3.1;
const TREE_PUSH_FAR = 21;
const TREE_PUSH_NEAR = 9;
const TREE_H_MAX = 13.5;
/** Ближние деревья ниже дальних: дальний ряд строит силуэт стены. */
const TREE_H_LO = 0.72;
const TREE_H_D0 = 12;
const TREE_H_D1 = 27;

/** Ярусы кроны в долях высоты. Нижний садится прямо на землю: ствол ночью
 *  всё равно чёрный, а это была треть треугольников дерева. */
const TIERS: readonly { y0: number; y1: number; r: number }[] = [
  { y0: 0, y1: 0.46, r: 0.23 },
  { y0: 0.34, y1: 0.74, r: 0.17 },
  { y0: 0.62, y1: 1, r: 0.11 },
];
/** Рваный радиус по граням: силуэт перестаёт быть циркульным конусом. */
const RAG: readonly number[] = [1, 0.88, 0.97, 0.84, 1, 0.91];
const TREE_SEG = RAG.length;

/** Тело кроны в долях `COLORS.foliage`: снизу почти чёрное, к макушке доходит
 *  до самого цвета палитры (её достаёт небо). Ярче палитры — никогда. */
const BODY_LO = 0.56;
const BODY_HI = 0.4;
/** Куда смотрит подсвеченная грань в локальных осях дерева; инстанс
 *  доворачивает её в сторону дороги. */
const LIT_DIR = 0;
/** Ширина блика: чем больше степень, тем уже кромка. */
const LIT_TIGHT = 5;
const LIT_GAIN = 0.7;

/* ---------- скретч кадра ---------- */

const _m4 = new THREE.Matrix4();
const _sc = new THREE.Vector3();
const _col = new THREE.Color();

/** Разложить цвет палитры в тройку линейных компонент. */
function hexInto(hex: string, mul: number, out: Float64Array, at: number) {
  _col.set(hex);
  out[at] = _col.r * mul;
  out[at + 1] = _col.g * mul;
  out[at + 2] = _col.b * mul;
}

/* ---------- лента ---------- */

/**
 * Полоса `cols × rows` вершин: колонки идут по дистанции, ряды — снизу вверх.
 * Цвет с альфой (itemSize 4): аддитивной кромке альфа задаёт яркость, телу
 * хребта — растворение подножия и дальнего края.
 *
 * Вершины лежат в системе координат клетки сетки (`base`), в кадр лента
 * попадает сдвигом `mesh.position`.
 */
interface Strip {
  pos: Float32Array;
  col: Float32Array;
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  geom: THREE.BufferGeometry;
  mesh: THREE.Mesh;
}

function buildStrip(
  cols: number,
  rows: number,
  mat: THREE.Material,
  order: number,
  radius: number,
): Strip {
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 4);
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const colAttr = new THREE.BufferAttribute(col, 4);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);

  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let p = 0;
  for (let i = 0; i < cols - 1; i++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r;
      index[p++] = a;
      index[p++] = a + 1;
      index[p++] = a + rows;
      index[p++] = a + 1;
      index[p++] = a + rows + 1;
      index[p++] = a + rows;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", posAttr);
  geom.setAttribute("color", colAttr);
  geom.setIndex(new THREE.BufferAttribute(index, 1));
  // Сферу задаём руками: вершины переписываются на переходе через клетку,
  // считать её заново нельзя, а отсечение по фрустуму лентам всё равно выключено.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -radius * 0.5), radius);

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return { pos, col, posAttr, colAttr, geom, mesh };
}

function stripDirty(s: Strip) {
  s.posAttr.needsUpdate = true;
  s.colAttr.needsUpdate = true;
}

/* ---------- геометрия хвойника ---------- */

/**
 * Три конические юбки одной геометрией высотой 1 и радиусом ~0.23.
 *
 * Освещение запечено в цвет вершины и состоит из двух слагаемых:
 *
 *   тело  — `BODY_LO … BODY_LO + BODY_HI` от цвета инстанса: у земли остаётся
 *           чуть больше половины, у макушки — почти всё. Даже «почти всё» —
 *           это `COLORS.foliage`, то есть на экране near-black;
 *   блик  — узкая кромка на грани, смотрящей в сторону `LIT_DIR`, заданная не
 *           яркостью, а ОТНОШЕНИЕМ `foliageLit / foliage`. Цвет вершины
 *           умножается на цвет инстанса (`foliage × k`), поэтому в кадре
 *           кромка выходит ровно `COLORS.foliageLit × k` — палитра остаётся
 *           единственным источником правды, никаких своих оттенков.
 */
function buildConifer(lr: number, lg: number, lb: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];

  const body = (y: number, a: number) =>
    (BODY_LO + BODY_HI * y) * (0.9 + 0.1 * Math.cos(a * 2 + 1.3));

  const rim = (y: number, a: number) => {
    const c = Math.cos(a - LIT_DIR);
    if (c <= 0) return 0;
    return Math.pow(c, LIT_TIGHT) * (0.28 + 0.72 * y) * LIT_GAIN;
  };

  const put = (x: number, y: number, z: number, a: number) => {
    const b = body(y, a);
    const r = rim(y, a);
    pos.push(x, y, z);
    col.push(b + r * lr, b + r * lg, b + r * lb);
  };

  // Боковая поверхность конусов, донышко не нужно — камера всегда выше
  // основания дерева и внутрь конуса не заглядывает.
  for (let ti = 0; ti < TIERS.length; ti++) {
    const tier = TIERS[ti];
    for (let j = 0; j < TREE_SEG; j++) {
      const a0 = (j / TREE_SEG) * TAU;
      const a1 = ((j + 1) / TREE_SEG) * TAU;
      const r0 = tier.r * RAG[j];
      const r1 = tier.r * RAG[(j + 1) % TREE_SEG];
      put(Math.cos(a1) * r1, tier.y0, Math.sin(a1) * r1, a1);
      put(Math.cos(a0) * r0, tier.y0, Math.sin(a0) * r0, a0);
      put(0, tier.y1, 0, (a0 + a1) * 0.5);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 0.9);
  return geom;
}

/* ---------- мир ---------- */

interface World {
  group: THREE.Group;
  mats: THREE.Material[];
  geoms: THREE.BufferGeometry[];
  /** [левый, правый]. */
  body: Strip[];
  rim: Strip[];
  apron: Strip[];
  trees: THREE.InstancedMesh;
  /** Размер пула инстансов: считается один раз, на лету не меняется. */
  pool: number;
  /** Какое дерево лежит в слоте: пока то же — цвет не пересчитываем. */
  keys: Float64Array;
  /** Диапазон загрузки матриц. Один объект на всю жизнь: `addUpdateRange`
   *  аллоцировал бы новый каждый кадр, а три чистит массив после загрузки. */
  matRange: { start: number; count: number };

  /* палитра в линейном пространстве */
  foliage: Float64Array;
  mountLo: Float64Array;
  /** Дальний край воздушной перспективы и он же цвет кромки — `mountainRim`. */
  mountHi: Float64Array;
  apronRGB: Float64Array;
  apronLit: Float64Array;

  /* на какой клетке сетки собраны ленты (NaN — ещё ни разу) */
  ridgeBase: number;
  apronBase: number;

  /* контекст кадра для колбэка деревьев */
  cb: (t: Tree) => void;
  slot: number;
  limit: number;
  range: number;
  laneMax: number;
  camS: number;
  camX: number;
  colDirty: boolean;
}

function buildWorld(pool: number): World {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const geoms: THREE.BufferGeometry[] = [];

  /* --- палитра --- */

  const foliage = new Float64Array(3);
  const foliageLit = new Float64Array(3);
  const mountLo = new Float64Array(3);
  const mountHi = new Float64Array(3);
  const apronRGB = new Float64Array(APRON_ROWS * 3);
  const apronLit = new Float64Array(APRON_ROWS * 3);

  hexInto(COLORS.foliage, 1, foliage, 0);
  hexInto(COLORS.foliageLit, 1, foliageLit, 0);
  hexInto(COLORS.mountain, 1, mountLo, 0);
  hexInto(COLORS.mountainRim, 1, mountHi, 0);
  for (let r = 0; r < APRON_ROWS; r++) {
    hexInto(COLORS.night0, APRON_MUL[r], apronRGB, r * 3);
    hexInto(COLORS.shoulder, APRON_LIT_MUL * APRON_MUL[r], apronLit, r * 3);
  }

  // Отношение «подсвеченная хвоя / хвоя»: цвет вершины умножается на цвет
  // инстанса, поэтому кромке достаётся не своя яркость, а именно это число.
  // Зажим — страховка на случай, если в палитре `foliage` уйдёт в ноль.
  const lr = clamp(foliageLit[0] / Math.max(foliage[0], 1e-4), 0, 8);
  const lg = clamp(foliageLit[1] / Math.max(foliage[1], 1e-4), 0, 8);
  const lb = clamp(foliageLit[2] / Math.max(foliage[2], 1e-4), 0, 8);

  /* --- материалы --- */

  const matBody = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // Глубину не пишем, но тестируем: лес и дорога, нарисованные раньше,
    // обязаны закрывать гору, а сама она красится поверх неба.
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  const matRim = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    // Тонмаппинг НЕ отключаем: кромка — атмосферное явление, а не источник
    // света. С `toneMapped: false` она вела бы себя по-разному на пресетах
    // с bloom (композер, тонмаппинг в OutputPass) и без него (прямо в холст).
    fog: false,
    side: THREE.DoubleSide,
  });
  const matApron = new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: true,
    side: THREE.DoubleSide,
  });
  const matTree = new THREE.MeshBasicMaterial({
    vertexColors: true,
    fog: true,
  });
  mats.push(matBody, matRim, matApron, matTree);

  /* --- ленты --- */

  const body: Strip[] = [];
  const rim: Strip[] = [];
  const apron: Strip[] = [];
  for (let k = 0; k < 2; k++) {
    const b = buildStrip(RIDGE_COLS, 3, matBody, ORDER_RIDGE, RIDGE_FAR);
    const r = buildStrip(RIDGE_COLS, 3, matRim, ORDER_RIM, RIDGE_FAR);
    const a = buildStrip(APRON_COLS, APRON_ROWS, matApron, 0, APRON_FAR);
    body.push(b);
    rim.push(r);
    apron.push(a);
    geoms.push(b.geom, r.geom, a.geom);
    group.add(b.mesh, r.mesh, a.mesh);
  }

  /* --- лес --- */

  const treeGeom = buildConifer(lr, lg, lb);
  geoms.push(treeGeom);
  const trees = new THREE.InstancedMesh(treeGeom, matTree, pool);
  trees.frustumCulled = false;
  trees.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Цвета инстансов заводим заранее: в кадре останется только переписать те,
  // в чьих слотах сменилось дерево. Матрицы не трогаем — `trees.count` не
  // пускает в отрисовку ни один слот, который не был заполнен в этом кадре.
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < pool; i++) trees.setColorAt(i, _col);
  trees.count = 0;
  group.add(trees);

  const keys = new Float64Array(pool);
  keys.fill(Number.NaN);

  const w: World = {
    group,
    mats,
    geoms,
    body,
    rim,
    apron,
    trees,
    pool,
    keys,
    matRange: { start: 0, count: 0 },
    foliage,
    mountLo,
    mountHi,
    apronRGB,
    apronLit,
    ridgeBase: Number.NaN,
    apronBase: Number.NaN,
    cb: noTree,
    slot: 0,
    limit: 0,
    range: TREE_RANGE[1],
    laneMax: 40,
    camS: 0,
    camX: 0,
    colDirty: false,
  };
  w.cb = (t: Tree) => placeTree(w, t);
  return w;
}

function noTree(_t: Tree) {}

/* ---------- хребты ---------- */

/**
 * Пересобрать обе ленты хребта в системе координат клетки `base`.
 *
 * Дистанция до камеры известна с точностью до клетки: камера гуляет внутри
 * [base + RIDGE_BACK, base + RIDGE_BACK + RIDGE_STEP), берём середину.
 */
function buildRidgeStrips(
  w: World,
  base: number,
  ridge: (s: number, side: -1 | 1) => number,
) {
  const bx = roadX(base);
  const by = roadY(base);

  for (let k = 0; k < 2; k++) {
    const side: -1 | 1 = k === 0 ? -1 : 1;
    const bp = w.body[k].pos;
    const bc = w.body[k].col;
    const rp = w.rim[k].pos;
    const rc = w.rim[k].col;
    const seed = k === 0 ? 0 : 53.7;
    let pi = 0;
    let ci = 0;

    for (let i = 0; i < RIDGE_COLS; i++) {
      const s = base + i * RIDGE_STEP;
      const d = i * RIDGE_STEP - RIDGE_BACK - RIDGE_STEP * 0.5;
      const off = RIDGE_LANE + RIDGE_WANDER * (noise1(s * RIDGE_NOISE + seed) * 2 - 1);
      const dy = roadY(s) - by;
      const x = roadX(s) - bx + side * off;
      const z = base - s;
      const crest = dy + ridge(s, side);
      const mid = dy + RIDGE_MID_Y;
      const bot = dy + RIDGE_BOT_Y;
      // Дальний край не обрывается, а уходит в дымку — иначе у точки схода
      // висела бы вертикальная кромка ленты.
      const a = smoothstep(RIDGE_FAR, RIDGE_FADE, d);
      const haze = smoothstep(RIDGE_HAZE_D0, RIDGE_FAR, d);
      const hz = lerp(RIDGE_HAZE_LO, RIDGE_HAZE_HI, haze);
      // Один цвет на всю колонку: гора — плоский силуэт, светлеет только от
      // дистанции. Подсветка одного гребня делала из неё валик, а не массу.
      const mr = lerp(w.mountLo[0], w.mountHi[0], hz);
      const mg = lerp(w.mountLo[1], w.mountHi[1], hz);
      const mb = lerp(w.mountLo[2], w.mountHi[2], hz);

      /* тело: подножие (прозрачное) → масса → гребень */
      bp[pi] = x;
      bp[pi + 1] = bot;
      bp[pi + 2] = z;
      bc[ci] = mr;
      bc[ci + 1] = mg;
      bc[ci + 2] = mb;
      bc[ci + 3] = 0;

      bp[pi + 3] = x;
      bp[pi + 4] = mid;
      bp[pi + 5] = z;
      bc[ci + 4] = mr;
      bc[ci + 5] = mg;
      bc[ci + 6] = mb;
      bc[ci + 7] = a;

      bp[pi + 6] = x;
      bp[pi + 7] = crest;
      bp[pi + 8] = z;
      bc[ci + 8] = mr;
      bc[ci + 9] = mg;
      bc[ci + 10] = mb;
      bc[ci + 11] = a;

      /* кромка: свет лежит на склоне под гребнем и почти не выходит выше него */
      const th = clamp(d * RIM_K, RIM_MIN, RIM_MAX);
      const glow = a * smoothstep(RIM_D0, RIM_D1, d) * lerp(RIM_LO, RIM_HI, haze);
      rp[pi] = x;
      rp[pi + 1] = crest - th * RIM_DOWN;
      rp[pi + 2] = z;
      rc[ci] = w.mountHi[0];
      rc[ci + 1] = w.mountHi[1];
      rc[ci + 2] = w.mountHi[2];
      rc[ci + 3] = 0;

      rp[pi + 3] = x;
      rp[pi + 4] = crest;
      rp[pi + 5] = z;
      rc[ci + 4] = w.mountHi[0];
      rc[ci + 5] = w.mountHi[1];
      rc[ci + 6] = w.mountHi[2];
      rc[ci + 7] = glow;

      rp[pi + 6] = x;
      rp[pi + 7] = crest + th * RIM_UP;
      rp[pi + 8] = z;
      rc[ci + 8] = w.mountHi[0];
      rc[ci + 9] = w.mountHi[1];
      rc[ci + 10] = w.mountHi[2];
      rc[ci + 11] = 0;

      pi += 9;
      ci += 12;
    }

    stripDirty(w.body[k]);
    stripDirty(w.rim[k]);
  }
}

function drawRidge(w: World, g: Game, ridge: (s: number, side: -1 | 1) => number) {
  const base = Math.floor(g.s / RIDGE_STEP) * RIDGE_STEP - RIDGE_BACK;
  if (base !== w.ridgeBase) {
    w.ridgeBase = base;
    buildRidgeStrips(w, base, ridge);
  }
  // Сдвиг из системы клетки в кадр камеры — ровно то же, что делают
  // localX/localY/localZ, но один раз на ленту, а не на каждую вершину.
  const dx = roadX(base) - roadX(g.s) - g.x;
  const dy = roadY(base) - roadY(g.s);
  const dz = g.s - base;
  for (let k = 0; k < 2; k++) {
    w.body[k].mesh.position.set(dx, dy, dz);
    w.rim[k].mesh.position.set(dx, dy, dz);
  }
}

/* ---------- насыпь ---------- */

function buildApronStrips(w: World, base: number) {
  const bx = roadX(base);
  const by = roadY(base);

  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? -1 : 1;
    const pos = w.apron[k].pos;
    const col = w.apron[k].col;
    const seed = k === 0 ? 0 : 41.9;
    let pi = 0;
    let ci = 0;

    for (let i = 0; i < APRON_COLS; i++) {
      const s = base + i * APRON_STEP;
      const d = i * APRON_STEP - APRON_BACK - APRON_STEP * 0.5;
      const rx = roadX(s) - bx;
      const ry = roadY(s) - by;
      const z = base - s;
      // Свет фар выхватывает ближнюю обочину, дальше склон уходит в чёрное.
      const near = smoothstep(APRON_LIT_D, 25, d);
      const dark = lerp(
        APRON_DARK_MIN,
        1,
        smoothstep(APRON_DARK_D1, APRON_DARK_D0, d),
      );
      // За концом дорожной ленты внутренний край съезжает к осевой: обе
      // насыпи встречаются на x = 0 и закрывают щель у точки схода.
      const seal = 1 - smoothstep(APRON_SEAL0, APRON_SEAL1, d);
      for (let r = 0; r < APRON_ROWS; r++) {
        const ax = r === 0 ? APRON_X[0] * seal : APRON_X[r];
        const amp = APRON_BUMP[r];
        const bump =
          amp > 0 ? amp * (noise1(s * APRON_NOISE + r * 3.7 + seed) * 2 - 1) : 0;
        pos[pi] = rx + side * ax;
        pos[pi + 1] = ry + slopeY(ax) + bump;
        pos[pi + 2] = z;

        const j = r * 3;
        const lit = near * APRON_NEAR[r];
        col[ci] = lerp(w.apronRGB[j], w.apronLit[j], lit) * dark;
        col[ci + 1] = lerp(w.apronRGB[j + 1], w.apronLit[j + 1], lit) * dark;
        col[ci + 2] = lerp(w.apronRGB[j + 2], w.apronLit[j + 2], lit) * dark;
        col[ci + 3] = 1;

        pi += 3;
        ci += 4;
      }
    }

    stripDirty(w.apron[k]);
  }
}

function drawApron(w: World, g: Game) {
  const base = Math.floor(g.s / APRON_STEP) * APRON_STEP - APRON_BACK;
  if (base !== w.apronBase) {
    w.apronBase = base;
    buildApronStrips(w, base);
  }
  const dx = roadX(base) - roadX(g.s) - g.x;
  const dy = roadY(base) - roadY(g.s);
  const dz = g.s - base;
  for (let k = 0; k < 2; k++) w.apron[k].mesh.position.set(dx, dy, dz);
}

/* ---------- лес ---------- */

/**
 * Колбэк итератора деревьев. `t` — переиспользуемый объект генератора: поля
 * читаются здесь же и никуда не сохраняются.
 */
function placeTree(w: World, t: Tree) {
  if (w.slot >= w.limit) return;
  const lane = t.lane;
  const left = lane < 0;
  const raw = left ? -lane : lane;
  // Ближний ряд отодвигаем от полотна: генератор ставит его в 9.9 м, и в кадре
  // он вырастает стеной от земли до неба.
  const al = raw + TREE_PUSH * smoothstep(TREE_PUSH_FAR, TREE_PUSH_NEAR, raw);
  if (al > w.laneMax) return;

  // У дальней кромки дерево не выскакивает, а вырастает: пул конечен, и обрыв
  // ряда иначе читался бы как мигание на ходу.
  const grow = smoothstep(w.range, w.range * 0.78, t.s - w.camS);
  if (grow <= 0.002) return;

  const i = w.slot++;
  const tall = t.h < TREE_H_MAX ? t.h : TREE_H_MAX;
  const h = tall * lerp(TREE_H_LO, 1, smoothstep(TREE_H_D0, TREE_H_D1, al)) * grow;
  const wide = h * (0.66 + 0.34 * t.v);
  // Разворот: подсвеченная грань смотрит в сторону дороги (для левой обочины
  // это +x, для правой −x), плюс небольшой разброс ради силуэта.
  _m4.makeRotationY((left ? 0 : Math.PI) + (t.v - 0.5) * 0.9);
  _sc.set(wide, h, wide);
  _m4.scale(_sc);
  _m4.setPosition(
    localX(t.s, left ? -al : al, w.camS, w.camX),
    localY(t.s, slopeY(al) + TREE_SINK, w.camS),
    localZ(t.s, w.camS),
  );
  w.trees.setMatrixAt(i, _m4);

  // Цвет зависит только от самого дерева, поэтому пересчитывается лишь тогда,
  // когда в слоте оказалось другое дерево.
  const key = t.s * 1024 + lane;
  if (w.keys[i] !== key) {
    w.keys[i] = key;
    // Только затемнение: ярче `COLORS.foliage` дерево не станет никогда,
    // холодную кромку даёт запечённый в вершины блик, а не этот множитель.
    const lit = smoothstep(28, 11, al);
    const k = 0.8 + 0.12 * lit + 0.08 * t.v;
    _col.setRGB(w.foliage[0] * k, w.foliage[1] * k, w.foliage[2] * k);
    w.trees.setColorAt(i, _col);
    w.colDirty = true;
  }
}

function finishTrees(w: World) {
  // Хвосты пула прятать незачем: `count` не пускает их в отрисовку.
  w.trees.count = w.slot;
  if (w.slot > 0) {
    // Грузим на GPU только занятую часть буфера матриц, а не весь пул: на
    // экономном пресете это 90 инстансов из 280. Диапазон нулевой длины в
    // WebGL2 означает «до конца массива», поэтому пустой кадр просто
    // пропускаем — грузить всё равно нечего.
    const im = w.trees.instanceMatrix;
    const ranges = im.updateRanges;
    if (ranges.length === 0) ranges.push(w.matRange);
    w.matRange.start = 0;
    w.matRange.count = w.slot * 16;
    im.needsUpdate = true;
  }
  if (w.colDirty && w.trees.instanceColor) w.trees.instanceColor.needsUpdate = true;
}

/* ---------- система ---------- */

export interface TerrainDeps {
  /**
   * Итератор деревьев в диапазоне дистанций (обычно `worldGen.forEachTree`).
   * ВНИМАНИЕ: колбэк получает один и тот же объект — ссылку не сохраняем.
   */
  trees: (s0: number, s1: number, cb: (t: Tree) => void) => void;
  /** Высота силуэта хребта на дистанции `s`, м (обычно `worldGen.ridgeHeight`). */
  ridge: (s: number, side: -1 | 1) => number;
}

export function createTerrain(ctx: RenderCtx, deps: TerrainDeps): System {
  // Пул инстансов — по пресету, с которым система создана. Смена качества на
  // лету пересобирает системы целиком, поэтому переразмер здесь не нужен.
  const w = buildWorld(QUALITY[ctx.quality].trees);
  const { trees, ridge } = deps;

  return {
    object: w.group,

    update(g: Game) {
      const preset = QUALITY[g.quality];
      w.camS = g.s;
      w.camX = g.x;
      // Зажим по пулу оставлен намеренно: если качество успело уехать выше
      // того, с которым система построена, лес просто не досчитается деревьев
      // вместо выхода за буфер матриц.
      w.limit = preset.trees < w.pool ? preset.trees : w.pool;
      w.range = TREE_RANGE[g.quality];
      w.laneMax = TREE_LANE_MAX[g.quality];
      w.slot = 0;
      w.colDirty = false;

      trees(g.s - 20, g.s + w.range, w.cb);
      finishTrees(w);
      drawApron(w, g);
      drawRidge(w, g, ridge);
    },

    dispose() {
      // Авто-освобождения при размонтировании больше нет: всё, что уехало на
      // GPU, освобождается здесь руками.
      for (const m of w.mats) m.dispose();
      for (const geom of w.geoms) geom.dispose();
      // У InstancedMesh свои буферы матриц и цветов — геометрия их не трогает.
      w.trees.dispose();
    },
  };
}
