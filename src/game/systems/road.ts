/**
 * Полотно дороги: обочины, мокрый асфальт, разметка и отбойники.
 *
 * Вся дорога — это несколько «лент». Лента строится один раз как BufferGeometry
 * (строки по дистанции × колонки по ширине). Строка `i` берёт дистанцию
 * `s = base + (i - 1) * step`, где `base = floor(camS / step) * step`.
 *
 * Ключевая экономия: вершины ленты хранятся **относительно `base`**, а не
 * относительно камеры. Пока камера идёт внутри одной клетки сетки сегментов,
 * ни одна координата не меняется — меняется только общий сдвиг, и он ставится
 * одной строчкой в `position` группы лент. Позиции переписываются лишь при
 * смене клетки (раз в `step / speed` секунд — на максималке это каждый
 * четвёртый кадр), и вместе с ними уходит из кадра вся тригонометрия:
 * `roadX`/`roadY` по строкам, мокрые пятна и фазы бликов тоже привязаны к `s`,
 * то есть к дороге, а не к камере.
 *
 * Каждый кадр остаются только цвета: они зависят от дистанции до камеры
 * (туман, световое пятно фар, блеск), и это чистая арифметика без sin.
 *
 * Лента рисуется не до конца массива, а до первой строки, где туман уже
 * съел цвет полностью: дальше идут треугольники цвета фона. `ROAD_LEN` = 1000 м,
 * туман закрывается на ~620 м — примерно треть строк не рисуется вообще.
 * Разметка гаснет ещё раньше (`MARK_FADE`), у неё своя граница.
 *
 * Слои (каждый — свой меш, проход по строкам общий): обочины, тёмный асфальт,
 * продольные мокрые блики, двойная осевая и краевые линии, отбойники.
 * Всё на MeshBasicMaterial: настоящего света в сцене нет, есть свечение и bloom,
 * поэтому яркому выставлен `toneMapped: false`.
 *
 * Ни одной аллокации в кадре: матрицы и цвета-скретч подняты в модуль, строковые
 * массивы живут в мире системы, пулы штрихов и катафотов — InstancedMesh, у
 * которых в кадре меняется только `count` (живые слоты идут подряд, прятать
 * хвост не нужно).
 *
 * Размеры всех пулов берутся из пресета качества **на сборке**: число сегментов
 * ленты, длина строковых массивов и число слотов у штрихов. Смена качества —
 * это пересборка системы в `main.ts`, а не изменение размеров на ходу.
 */

import * as THREE from "three";

import type { RenderCtx, System } from "../ctx";
import type { Game, Quality } from "../types";
import { COLORS, FOG, QUALITY, ROAD, ROAD_LEN, TUNE } from "../config";
import { roadPitch, roadX, roadY } from "../road";
import { clamp, clamp01, smoothstep } from "../num";
import { hash1 } from "../rng";

/* ---------- константы раскладки ---------- */

/**
 * Насколько разметка толстеет с дистанцией, 1/м, и предел утолщения. На
 * четырёхстах метрах настоящая линия шириной 17 см — это треть пикселя: без
 * утолщения она рассыпается в мерцающий пунктир.
 *
 * Утолщение начинается не от бампера, а с `WIDEN_FROM`: вблизи оно всё равно
 * не нужно, зато так ширина ближних линий перестаёт зависеть от того, где
 * именно между узлами сетки стоит камера — иначе кэш позиций давал бы заметное
 * подрагивание толщины при каждой смене клетки.
 */
const WIDEN_RATE = 1 / 110;
const WIDEN_MAX = 5.5;
const WIDEN_FROM = 26;

/** Где полотно начинает и заканчивает растворяться в ночи, м. Ночью асфальт
 *  видно ровно до конца света фар, дальше дорогу держат только огни. */
const FADE0 = FOG.near * 0.23;
const FADE1 = FOG.far * 0.66;

/** Разметка гаснет раньше полотна: на пределе видимости линия тоньше пикселя. */
const MARK_FADE = 1.55;

/** Цель растворения аддитивных слоёв. */
const BLACK = "#000000";

/** Полуширина штриха разметки. */
const MARK_H = ROAD.markWidth * 0.5;

/** Минимальный отступ первой строки ленты за камеру, м. */
const BEHIND = 2.5;

/** Разделительная прерывистая — ровно между двумя нашими полосами. */
const DASH_X = (ROAD.laneCenters[0] + ROAD.laneCenters[1]) * 0.5;
const DASH_PERIOD = ROAD.dashLen + ROAD.dashGap;
/** Дальше `MARK_FADE` всё равно гасит штрих в ноль — дальность обрезана по ней. */
const DASH_RANGE: readonly [number, number, number] = [260, 320, 350];

/** Катафоты на отбойнике. */
const STUD_PERIOD = 13;
const STUD_RANGE = 340;
const STUD_SLOTS = Math.ceil(STUD_RANGE / STUD_PERIOD) + 2;
const STUD_Y = 0.72;

/** Высоты слоёв. Разметка лежит выше асфальта, а сам асфальт отодвинут
 *  polygonOffset-ом — вместе это снимает любые z-конфликты на дистанции. */
const Y_SHOULDER = -0.02;
const Y_STREAK = 0.012;
const Y_DASH = 0.02;
const Y_MARK = 0.024;
/** Отбойник: нижняя юбка, тело балки, светлая верхняя кромка. */
const RAIL_Y0 = 0.34;
const RAIL_Y1 = 0.8;
const RAIL_Y2 = 0.95;

/* ---------- мокрые блики ---------- */

/**
 * Сколько независимых фаз у продольных бликов. Референс — не ровная синяя
 * пелена по всему полотну, а несколько длинных отражений, которые загораются и
 * гаснут вразнобой; общая фаза на все полосы как раз и давала пелену.
 */
const BANDS = 3;
const BAND_PHASE: readonly number[] = [0, 2.4, 4.9];

/**
 * Раскладка бликов: центр, полуширина, пик яркости, цвет, фаза. Полосы стоят с
 * разрывами — между ними асфальт должен оставаться чёрным, иначе «мокро» не
 * читается. Синий — от встречных фар, красный — от стопов ведущих.
 */
interface StreakSpec {
  x: number;
  hw: number;
  peak: number;
  hex: string;
  band: number;
}
const STREAKS: readonly StreakSpec[] = [
  { x: -5.6, hw: 0.55, peak: 0.42, hex: COLORS.neonDeep, band: 0 },
  { x: -2.6, hw: 0.55, peak: 0.3, hex: COLORS.neon, band: 1 },
  { x: 1.6, hw: 0.42, peak: 0.24, hex: COLORS.tail, band: 2 },
  { x: 3.6, hw: 0.55, peak: 0.38, hex: COLORS.neonDeep, band: 0 },
  { x: 6.1, hw: 0.42, peak: 0.2, hex: COLORS.tail, band: 1 },
];

/* ---------- скретч кадра ---------- */

/** Значения подсветки текущей строки по индексу источника — чтобы в цикле по
 *  колонкам не разыменовывать массив массивов на каждую вершину. */
const litRow = new Float64Array(BANDS);

const _m4 = new THREE.Matrix4();
const _sc = new THREE.Vector3();
const _col = new THREE.Color();
const _mk = new THREE.Color();
const _mk2 = new THREE.Color();

/** Линейный RGB, посчитанный один раз на сборке. */
interface RGB {
  r: number;
  g: number;
  b: number;
}

function linear(hex: string): RGB {
  _mk.set(hex);
  return { r: _mk.r, g: _mk.g, b: _mk.b };
}

/**
 * Отметить, что в буфер записан только префикс `count` элементов. Диапазон —
 * заранее созданный объект: three сам чистит массив после заливки, а нам нельзя
 * аллоцировать в кадре, поэтому кладём туда каждый раз одну и ту же ссылку.
 */
function markRange(
  attr: THREE.BufferAttribute,
  range: { start: number; count: number },
  count: number,
) {
  range.count = count;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(range);
  attr.needsUpdate = true;
}

/* ---------- лента ---------- */

/**
 * Колонка ленты. По ширине точка стоит в `c + w * k`, где `k` — коэффициент
 * утолщения от дистанции: у разметки `w` — полуширина штриха, у остальных 0.
 * Цвет вершины — интерполяция базового в «подсвеченный» по яркости строки;
 * `li` выбирает, из какого источника подсветки эту яркость брать.
 */
interface Col {
  c: number;
  w: number;
  y: number;
  cr: number;
  cg: number;
  cb: number;
  sr: number;
  sg: number;
  sb: number;
  li: number;
  /** Тянуть квад к следующей колонке (false — разрыв в ленте). */
  link: boolean;
}

function col(
  c: number,
  w: number,
  y: number,
  hex: string,
  mul: number,
  litHex: string,
  litMul: number,
  link: boolean,
  li = 0,
): Col {
  _mk.set(hex);
  _mk2.set(litHex);
  return {
    c,
    w,
    y,
    link,
    li,
    cr: _mk.r * mul,
    cg: _mk.g * mul,
    cb: _mk.b * mul,
    sr: _mk2.r * litMul,
    sg: _mk2.g * litMul,
    sb: _mk2.b * litMul,
  };
}

interface Ribbon {
  cols: Col[];
  /** Через сколько строк общей сетки берётся своя строка. */
  rowStep: number;
  /** Квадов в строке (по числу связанных пар колонок). */
  quads: number;
  /** Предел утолщения разметки. */
  widen: number;
  /** Множитель к общей кривой растворения: >1 — гаснет раньше. */
  fade: number;
  /** Цвет, в который лента растворяется: ночь у непрозрачных, ноль у аддитивных. */
  fr: number;
  fg: number;
  fb: number;
  lits: Float64Array[];
  geom: THREE.BufferGeometry;
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  pos: Float32Array;
  colr: Float32Array;
  posRange: { start: number; count: number };
  colRange: { start: number; count: number };
  mesh: THREE.Mesh;
}

/** Что нужно знать о ленте на сборке. */
interface RibbonSpec {
  cols: Col[];
  /** Максимум строк общей сетки — из пресета качества. */
  rowsMax: number;
  /** Через сколько строк общей сетки берётся своя строка. */
  rowStep: number;
  /** Предел утолщения разметки (0 — не толстеет). */
  widen?: number;
  /** Множитель к кривой растворения: >1 — гаснет раньше. */
  fade?: number;
  /** Цвет растворения: ночь у непрозрачных, чёрный у аддитивных. */
  fog: string;
  /** Источники яркости подсветки; колонка выбирает свой по `Col.li`. */
  lits: Float64Array[];
  mat: THREE.Material;
  order: number;
}

function buildRibbon(spec: RibbonSpec): Ribbon {
  const cols = spec.cols;
  const rowStep = spec.rowStep;
  const widen = spec.widen ?? 0;
  const fade = spec.fade ?? 1;
  const fog = linear(spec.fog);
  const nc = cols.length;
  const rows = Math.ceil((spec.rowsMax - 1) / rowStep) + 1;

  const pos = new Float32Array(nc * rows * 3);
  const colr = new Float32Array(nc * rows * 3);
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const colAttr = new THREE.BufferAttribute(colr, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);

  let quads = 0;
  for (let j = 0; j < nc - 1; j++) if (cols[j].link) quads++;

  const index = new Uint32Array((rows - 1) * quads * 6);
  let p = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let j = 0; j < nc - 1; j++) {
      if (!cols[j].link) continue;
      const a = r * nc + j;
      index[p++] = a;
      index[p++] = a + 1;
      index[p++] = a + nc;
      index[p++] = a + 1;
      index[p++] = a + nc + 1;
      index[p++] = a + nc;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", posAttr);
  geom.setAttribute("color", colAttr);
  geom.setIndex(new THREE.BufferAttribute(index, 1));
  // Ручная сфера с запасом, поставленная один раз: вершины переписываются на
  // ходу, а `computeBoundingSphere` по сотням вершин в кадре — чистая трата.
  // Отсечение по фрустуму дороге всё равно не нужно.
  geom.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, -ROAD_LEN * 0.5),
    ROAD_LEN,
  );

  const mesh = new THREE.Mesh(geom, spec.mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = spec.order;

  return {
    cols, rowStep, quads, widen, fade,
    fr: fog.r, fg: fog.g, fb: fog.b,
    lits: spec.lits, geom, posAttr, colAttr, pos, colr, mesh,
    posRange: { start: 0, count: 0 },
    colRange: { start: 0, count: 0 },
  };
}

/**
 * Переписать позиции ленты. Вызывается только при смене клетки сетки —
 * внутри клетки вершины стоят на месте.
 */
function writePositions(w: RoadWorld, rb: Ribbon, rows: number) {
  const cols = rb.cols;
  const nc = cols.length;
  const pos = rb.pos;
  const k = rb.rowStep;
  const rowX = w.rowX;
  const rowY = w.rowY;
  const rowZ = w.rowZ;
  const rowWide = w.rowWide;
  const last = rows - 1;
  const jMax = Math.ceil(last / k);
  let p = 0;

  for (let j = 0; j <= jMax; j++) {
    const jk = j * k;
    const i = jk < last ? jk : last;
    const x0 = rowX[i];
    const y0 = rowY[i];
    const z0 = rowZ[i];
    const dw = rowWide[i];
    const wide = 1 + (dw < rb.widen ? dw : rb.widen);
    for (let n = 0; n < nc; n++) {
      const cc = cols[n];
      pos[p] = x0 + cc.c + cc.w * wide;
      pos[p + 1] = y0 + cc.y;
      pos[p + 2] = z0;
      p += 3;
    }
  }

  markRange(rb.posAttr, rb.posRange, p);
}

/**
 * Переписать цвета ленты и подрезать диапазон отрисовки. Как только строка
 * полностью ушла в туман, дальше рисовать нечего: следующие строки — сплошной
 * фон. Это и есть «лента заканчивается внутри тумана», а не у дальней плоскости.
 */
function writeColors(w: RoadWorld, rb: Ribbon, rows: number) {
  const cols = rb.cols;
  const nc = cols.length;
  const colr = rb.colr;
  const k = rb.rowStep;
  const lits = rb.lits;
  const nl = lits.length;
  const rowFog = w.rowFog;
  const last = rows - 1;
  const jMax = Math.ceil(last / k);
  let p = 0;
  let written = 0;

  for (let j = 0; j <= jMax; j++) {
    const jk = j * k;
    const i = jk < last ? jk : last;
    // Непрозрачные ленты уходят в цвет ночи, аддитивные — в ноль: и те и другие
    // на пределе дальности сливаются с фоном, а не сыплются точками.
    const tf = rb.fade * rowFog[i];
    const t = tf < 1 ? tf : 1;
    const u = 1 - t;
    const fr = rb.fr * t;
    const fg = rb.fg * t;
    const fb = rb.fb * t;
    for (let b = 0; b < nl; b++) litRow[b] = lits[b][i];

    for (let n = 0; n < nc; n++) {
      const cc = cols[n];
      const lit = litRow[cc.li];
      colr[p] = (cc.cr + (cc.sr - cc.cr) * lit) * u + fr;
      colr[p + 1] = (cc.cg + (cc.sg - cc.cg) * lit) * u + fg;
      colr[p + 2] = (cc.cb + (cc.sb - cc.cb) * lit) * u + fb;
      p += 3;
    }

    written = j + 1;
    if (t >= 1) break;
  }

  markRange(rb.colAttr, rb.colRange, p);
  rb.geom.setDrawRange(0, (written > 1 ? written - 1 : 0) * rb.quads * 6);
}

/* ---------- плоский квад для инстансов ---------- */

/**
 * Единичный квад с белым цветовым атрибутом: без него `vertexColors` в
 * материале нечего умножать, а без `vertexColors` шейдер игнорирует
 * `instanceColor` — и погасить дальние штрихи было бы нечем.
 */
function unitQuad(): THREE.PlaneGeometry {
  const geom = new THREE.PlaneGeometry(1, 1);
  const white = new Float32Array(12);
  white.fill(1);
  geom.setAttribute("color", new THREE.BufferAttribute(white, 3));
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
  return geom;
}

/* ---------- сборка ---------- */

function buildWorld(quality: Quality) {
  // Сегменты ленты — из пресета качества, один раз. Отсюда же длина строковых
  // массивов и дальность штрихов: пресет меняется пересборкой системы.
  const segs = clamp(Math.round(QUALITY[quality].roadSegments), 16, ROAD.segCount);
  /** Максимум строк ленты: по строке на стык сегментов, плюс одна «за спиной». */
  const rowsMax = segs + 2;
  const gridStep = ROAD_LEN / segs;
  const dashRange = DASH_RANGE[quality];
  const dashSlots = Math.ceil(dashRange / DASH_PERIOD) + 2;

  const group = new THREE.Group();
  // Ленты живут в своей группе: раз в клетку сетки в них переписываются
  // вершины, а каждый кадр двигается только вот эта одна матрица.
  const ribbons = new THREE.Group();
  group.add(ribbons);

  const mats: THREE.Material[] = [];
  const geoms: THREE.BufferGeometry[] = [];

  /* --- строковый скретч: всё, что считается по дистанции, а не по вершинам --- */

  /** Координаты строк **относительно `base`**, пересчитываются при смене клетки. */
  const rowX = new Float64Array(rowsMax);
  const rowY = new Float64Array(rowsMax);
  const rowZ = new Float64Array(rowsMax);
  /** Прибавка к толщине разметки, тоже привязана к сетке. */
  const rowWide = new Float64Array(rowsMax);
  /** Мокрые пятна вдоль трассы — функция от `s`, живёт вместе с дорогой. */
  const rowWet = new Float64Array(rowsMax);
  /** Продольная волна бликов по фазам. */
  const rowBand: Float64Array[] = [];
  for (let b = 0; b < BANDS; b++) rowBand.push(new Float64Array(rowsMax));

  /** Насколько строка утонула в ночи, 0…1. */
  const rowFog = new Float64Array(rowsMax);
  /** Блеск асфальта: пятна вдоль дороги + световое пятно фар. */
  const rowLit = new Float64Array(rowsMax);
  /** Отдельная кривая для отбойника: он ловит фары дальше, чем полотно. */
  const rowRail = new Float64Array(rowsMax);
  /** Яркость продольных бликов по фазам. */
  const rowGlow: Float64Array[] = [];
  for (let b = 0; b < BANDS; b++) rowGlow.push(new Float64Array(rowsMax));

  /* --- материалы --- */

  const matShoulder = new THREE.MeshBasicMaterial({ vertexColors: true });
  const matPave = new THREE.MeshBasicMaterial({
    vertexColors: true,
    // Асфальт отодвинут в глубину — разметка над ним не проигрывает depth-тест
    // даже там, где точности буфера уже не хватает на 2 сантиметра.
    polygonOffset: true,
    polygonOffsetFactor: 3,
    polygonOffsetUnits: 6,
  });
  // Один аддитивный материал на блики, разметку, штрихи и катафоты: настройки у
  // них были одинаковые, а четыре копии — это четыре шейдерные программы.
  const matGlow = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  // Отбойник — непрозрачный объект, а не свечение: тональная компрессия у него
  // та же, что у полотна и склона, иначе на пределе тумана он не сходится с
  // фоном, а остаётся висеть бледной ниткой.
  const matRail = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  mats.push(matShoulder, matPave, matGlow, matRail);

  /* --- обочины: две ленты по краям, под полотном нет ни одной вершины --- */

  const outer = ROAD.railX + 0.7;
  const edge = ROAD.halfWidth + ROAD.shoulder;
  const shoulder = buildRibbon({
    cols: [
      col(-outer, 0, Y_SHOULDER, COLORS.shoulder, 0.26, COLORS.shoulder, 0.26, true),
      col(-edge, 0, Y_SHOULDER, COLORS.shoulder, 0.55, COLORS.shoulder, 0.7, true),
      col(-ROAD.halfWidth, 0, Y_SHOULDER, COLORS.shoulder, 0.85, COLORS.asphaltSheen, 0.5, false),
      col(ROAD.halfWidth, 0, Y_SHOULDER, COLORS.shoulder, 0.85, COLORS.asphaltSheen, 0.5, true),
      col(edge, 0, Y_SHOULDER, COLORS.shoulder, 0.55, COLORS.shoulder, 0.7, true),
      col(outer, 0, Y_SHOULDER, COLORS.shoulder, 0.26, COLORS.shoulder, 0.26, false),
    ],
    rowsMax,
    rowStep: 2,
    fog: COLORS.night0,
    lits: [rowLit],
    mat: matShoulder,
    order: 0,
  });

  /* --- полотно: почти чёрное. Всё «мокро» живёт в аддитивных бликах поверх,
         иначе подсветка по всей ширине превращает асфальт в серую пыль. --- */

  const hw = ROAD.halfWidth;
  const pavement = buildRibbon({
    cols: [
      col(-hw, 0, 0, COLORS.asphalt, 0.55, COLORS.asphaltSheen, 0.3, true),
      col(-hw * 0.5, 0, 0, COLORS.asphalt, 0.7, COLORS.asphaltSheen, 0.62, true),
      col(0, 0, 0, COLORS.asphalt, 0.75, COLORS.asphaltSheen, 0.48, true),
      col(hw * 0.5, 0, 0, COLORS.asphalt, 0.7, COLORS.asphaltSheen, 0.62, true),
      col(hw, 0, 0, COLORS.asphalt, 0.55, COLORS.asphaltSheen, 0.3, false),
    ],
    rowsMax,
    rowStep: 1,
    fog: COLORS.night0,
    lits: [rowLit],
    mat: matPave,
    order: 0,
  });

  /* --- мокрые продольные блики: несколько узких длинных отражений с
         разрывами между ними, каждое на своей фазе --- */

  const streakCols: Col[] = [];
  for (const st of STREAKS) {
    streakCols.push(col(st.x - st.hw, 0, Y_STREAK, st.hex, 0, st.hex, 0, true, st.band));
    streakCols.push(col(st.x, 0, Y_STREAK, st.hex, 0, st.hex, st.peak, true, st.band));
    // Разрыв до следующего блика: квад между ними был бы чёрным и стоил бы
    // лишнего аддитивного перекрытия по всей длине дороги.
    streakCols.push(col(st.x + st.hw, 0, Y_STREAK, st.hex, 0, st.hex, 0, false, st.band));
  }
  const streaks = buildRibbon({
    cols: streakCols,
    rowsMax,
    // Шаг мельче, чем у обочины: продольная волна блика должна тянуться
    // градиентом, а не ступеньками — это самый заметный слой в ближней зоне.
    rowStep: 2,
    fog: BLACK,
    lits: rowGlow,
    mat: matGlow,
    order: 2,
  });

  /* --- разметка: двойная осевая и краевые линии одной геометрией --- */

  const eg = ROAD.halfWidth - 0.14;
  const marks = buildRibbon({
    cols: [
      // Дальний конец был ярче ближнего (1.35 против 1 у осевой) — то есть чем
      // мельче становилась линия, тем сильнее она светила. На настоящем экране
      // это и давало пересвеченные полосы и кашу у горизонта: тонкая линия
      // меньше пикселя, а яркость максимальная. Теперь наоборот — дальний конец
      // приглушён, и разметка спокойно уходит в ночь.
      col(-eg, -MARK_H, Y_MARK, COLORS.markSide, TUNE.road.sideNear, COLORS.markSide, TUNE.road.sideFar, true),
      col(-eg, MARK_H, Y_MARK, COLORS.markSide, TUNE.road.sideNear, COLORS.markSide, TUNE.road.sideFar, false),
      col(-0.3, -MARK_H, Y_MARK, COLORS.markCenter, TUNE.road.centerNear, COLORS.markCenter, TUNE.road.centerFar, true),
      col(-0.3, MARK_H, Y_MARK, COLORS.markCenter, TUNE.road.centerNear, COLORS.markCenter, TUNE.road.centerFar, false),
      col(0.3, -MARK_H, Y_MARK, COLORS.markCenter, TUNE.road.centerNear, COLORS.markCenter, TUNE.road.centerFar, true),
      col(0.3, MARK_H, Y_MARK, COLORS.markCenter, TUNE.road.centerNear, COLORS.markCenter, TUNE.road.centerFar, false),
      col(eg, -MARK_H, Y_MARK, COLORS.markSide, TUNE.road.sideNear, COLORS.markSide, TUNE.road.sideFar, true),
      col(eg, MARK_H, Y_MARK, COLORS.markSide, TUNE.road.sideNear, COLORS.markSide, TUNE.road.sideFar, false),
    ],
    rowsMax,
    rowStep: 1,
    widen: WIDEN_MAX,
    fade: MARK_FADE,
    fog: BLACK,
    lits: [rowLit],
    mat: matGlow,
    order: 4,
  });

  /* --- отбойники: юбка, тело балки и светлая кромка. Кромка — непрерывная
         бледная лента, по которой в референсе и читается вся композиция. --- */

  const railCols: Col[] = [];
  for (const sx of [-ROAD.railX, ROAD.railX]) {
    // Дальний конец гасим, а не разгоняем. С непрозрачностью 0.6…0.85 и почти
    // белым `markSide` отбойник у горизонта сливался в сплошную светлую стену
    // поперёк кадра — она читалась как туман и съедала всю глубину. Ярким он
    // остаётся вблизи, где и должен: там он и виден, и продаёт скорость.
    railCols.push(col(sx, 0, RAIL_Y0, COLORS.rail, 0.12, COLORS.rail, 0.2, true));
    railCols.push(col(sx, 0, RAIL_Y1, COLORS.rail, 0.5, COLORS.rail, 0.24, true));
    railCols.push(col(sx, 0, RAIL_Y2, COLORS.markSide, 0.3, COLORS.rail, 0.16, false));
  }
  const rails = buildRibbon({
    cols: railCols,
    rowsMax,
    rowStep: 2,
    fog: COLORS.night0,
    lits: [rowRail],
    mat: matRail,
    order: 0,
  });

  const list: Ribbon[] = [shoulder, pavement, streaks, marks, rails];
  for (const rb of list) {
    geoms.push(rb.geom);
    ribbons.add(rb.mesh);
  }

  /* --- пулы инстансов: одна геометрия и один материал на оба --- */

  const quad = unitQuad();
  geoms.push(quad);

  const dashes = new THREE.InstancedMesh(quad, matGlow, dashSlots * 2);
  dashes.frustumCulled = false;
  dashes.renderOrder = 3;
  dashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const studs = new THREE.InstancedMesh(quad, matGlow, STUD_SLOTS * 2);
  studs.frustumCulled = false;
  studs.renderOrder = 5;
  studs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Слоты живых инстансов идут подряд (слот = номер × 2 + сторона), поэтому в
  // кадре достаточно подвинуть `count` — прятать хвост нулевым масштабом не
  // нужно. Здесь только создаём `instanceColor`, чтобы он был готов заранее.
  _m4.identity();
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < dashes.count; i++) {
    dashes.setMatrixAt(i, _m4);
    dashes.setColorAt(i, _col);
  }
  for (let i = 0; i < studs.count; i++) {
    studs.setMatrixAt(i, _m4);
    studs.setColorAt(i, _col);
  }
  dashes.count = 0;
  studs.count = 0;

  group.add(dashes, studs);

  return {
    group,
    ribbons,
    mats,
    geoms,
    list,
    streaks,
    dashes,
    studs,
    /* Размеры и дальности, снятые с пресета качества на сборке. */
    segs,
    gridStep,
    dashRange,
    dashSlots,
    /* Строковый скретч. */
    rowX,
    rowY,
    rowZ,
    rowWide,
    rowWet,
    rowBand,
    rowFog,
    rowLit,
    rowRail,
    rowGlow,
    dashRGB: linear(COLORS.markSide),
    // Красный слева — так стоят катафоты на встречной кромке, и так же они
    // выглядят в референсе; справа — цвет из палитры.
    studLeft: linear(COLORS.tail),
    studRight: linear(COLORS.railStud),
    dashMR: { start: 0, count: 0 },
    dashCR: { start: 0, count: 0 },
    studMR: { start: 0, count: 0 },
    studCR: { start: 0, count: 0 },
    /* Кэш сетки: пока `base` и `step` те же, позиции вершин не трогаем. */
    base: Number.NaN,
    step: 0,
    rows: 0,
    baseX: 0,
    baseY: 0,
  };
}

type RoadWorld = ReturnType<typeof buildWorld>;

/* ---------- пересчёт сетки ---------- */

/**
 * Всё, что зависит только от дистанции по дороге, а не от камеры: координаты
 * строк относительно `base`, толщина разметки, мокрые пятна и фазы бликов.
 * Отсюда же берётся, сколько строк вообще имеет смысл держать: за `FADE1`
 * туман съедает цвет полностью.
 */
function rebuildGrid(w: RoadWorld, base: number, step: number, rows: number) {
  const rowsUsed = Math.min(rows, Math.ceil((FADE1 + BEHIND) / step) + 6);
  const bx = roadX(base);
  const by = roadY(base);
  // Камера стоит где-то между узлами; берём середину, чтобы ошибка в толщине
  // разметки была симметричной и не превышала половины шага.
  const lag = BEHIND + step * 0.5;

  for (let i = 0; i < rowsUsed; i++) {
    const s = base + (i - 1) * step;
    w.rowX[i] = roadX(s) - bx;
    w.rowY[i] = roadY(s) - by;
    w.rowZ[i] = base - s;

    const dw = (i - 1) * step - lag - WIDEN_FROM;
    w.rowWide[i] = dw > 0 ? dw * WIDEN_RATE : 0;

    w.rowWet[i] = 0.5 + 0.3 * Math.sin(s * 0.021) + 0.2 * Math.sin(s * 0.0067 + 1.3);

    for (let b = 0; b < BANDS; b++) {
      const ph = BAND_PHASE[b];
      const raw =
        0.5 + 0.5 * Math.sin(s * 0.03 + ph + Math.sin(s * 0.0088 + ph * 0.7) * 2.1);
      // Куб: середины гаснут, остаются редкие длинные вспышки — то самое
      // «несколько отражений, а между ними чёрный асфальт».
      w.rowBand[b][i] = raw * raw * raw;
    }
  }

  w.base = base;
  w.step = step;
  w.rows = rowsUsed;
  w.baseX = bx;
  w.baseY = by;
  for (const rb of w.list) writePositions(w, rb, rowsUsed);
}

/* ---------- система ---------- */

export function createRoad(ctx: RenderCtx): System {
  const w = buildWorld(ctx.quality);

  return {
    object: w.group,

    update(g: Game) {
      const step = w.gridStep;
      const camS = g.s;
      const camX = g.x;
      // База привязана к сетке сегментов — вершины стоят на месте, пока камера
      // идёт внутри клетки. Первая строка уходит за камеру, и не ближе BEHIND
      // метров к ней: вершина в самой плоскости камеры — вырожденный случай
      // перспективного деления, и связываться с ним незачем.
      let base = Math.floor(camS / step) * step;
      if (camS - base < BEHIND) base -= step;

      if (base !== w.base || step !== w.step) rebuildGrid(w, base, step, w.segs + 2);

      const rows = w.rows;
      const camRX = roadX(camS);
      const camRY = roadY(camS);
      // Весь сдвиг мира за кадр — одна матрица группы, а не переписанные вершины.
      w.ribbons.position.set(w.baseX - camRX - camX, w.baseY - camRY, camS - base);

      // Дистанция строки до камеры: `s = base + (i - 1) * step`, без тригонометрии.
      let d = base - step - camS;
      for (let i = 0; i < rows; i++, d += step) {
        w.rowFog[i] = smoothstep(FADE0, FADE1, d);
        // Пятно собственных фар держим коротким: длинное поднимало весь асфальт
        // до серого, а мокрая дорога должна быть чёрной между бликами.
        w.rowLit[i] = clamp01(w.rowWet[i] * 0.3 + smoothstep(78, 3, d) * 0.55);
        w.rowRail[i] = 0.16 + 0.84 * smoothstep(320, 42, d);
        const env = 0.1 + 0.9 * smoothstep(330, 15, d);
        for (let b = 0; b < BANDS; b++) w.rowGlow[b][i] = w.rowBand[b][i] * env;
      }

      // На экономном пресете мокрых бликов нет: они чистая декорация.
      const wetOn = g.quality > 0;
      w.streaks.mesh.visible = wetOn;
      for (const rb of w.list) {
        if (rb === w.streaks && !wetOn) continue;
        writeColors(w, rb, rows);
      }

      drawDashes(w, camS, camX, camRX, camRY);
      drawStuds(w, g, camS, camX, camRX, camRY);
    },

    dispose() {
      // Всё, что попало на GPU, освобождается вручную: авто-освобождения при
      // размонтировании больше нет ни у кого.
      for (const m of w.mats) m.dispose();
      for (const geom of w.geoms) geom.dispose();
      // У InstancedMesh свои буферы матриц и цветов — геометрия их не освобождает.
      w.dashes.dispose();
      w.studs.dispose();
    },
  };
}

/* ---------- инстансы ---------- */

/** Сколько слотов пула укладывается в дальность. Живые идут подряд с нуля. */
function liveCount(d0: number, period: number, range: number, slots: number): number {
  const n = Math.floor((range - d0) / period) + 1;
  return n < 0 ? 0 : n > slots ? slots : n;
}

function drawDashes(
  w: RoadWorld,
  camS: number,
  camX: number,
  camRX: number,
  camRY: number,
) {
  const half = ROAD.dashLen * 0.5;
  const base = Math.floor(camS / DASH_PERIOD) * DASH_PERIOD;
  const live = liveCount(base + half - camS, DASH_PERIOD, w.dashRange, w.dashSlots);
  const rgb = w.dashRGB;
  const mesh = w.dashes;

  for (let k = 0; k < live; k++) {
    const s = base + k * DASH_PERIOD + half;
    const d = s - camS;
    const dw = d > WIDEN_FROM ? (d - WIDEN_FROM) * WIDEN_RATE : 0;
    const wide = ROAD.markWidth * (1 + (dw < WIDEN_MAX ? dw : WIDEN_MAX));
    const ft = MARK_FADE * smoothstep(FADE0, FADE1, d);
    const f = ft < 1 ? 1 - ft : 0;
    _col.setRGB(rgb.r * f, rgb.g * f, rgb.b * f);

    // roadX/roadY камеры вынесены из цикла — иначе на каждый штрих уходило бы
    // по пять синусов только на то, чтобы вычесть одну и ту же константу.
    const x = roadX(s) - camRX - camX;
    const y = roadY(s) - camRY + Y_DASH;
    const z = camS - s;
    // Штрих кладётся плашмя и доворачивается на уклон, иначе на переломе
    // рельефа его концы уходят под асфальт.
    const rot = -Math.PI * 0.5 + roadPitch(s);

    for (let side = 0; side < 2; side++) {
      _m4.makeRotationX(rot);
      _sc.set(wide, ROAD.dashLen, 1);
      _m4.scale(_sc);
      _m4.setPosition(x + (side === 0 ? -DASH_X : DASH_X), y, z);
      const slot = k * 2 + side;
      mesh.setMatrixAt(slot, _m4);
      mesh.setColorAt(slot, _col);
    }
  }

  mesh.count = live * 2;
  markRange(mesh.instanceMatrix, w.dashMR, live * 2 * 16);
  if (mesh.instanceColor) markRange(mesh.instanceColor, w.dashCR, live * 2 * 3);
}

function drawStuds(
  w: RoadWorld,
  g: Game,
  camS: number,
  camX: number,
  camRX: number,
  camRY: number,
) {
  const base = Math.floor(camS / STUD_PERIOD) * STUD_PERIOD;
  const live = liveCount(base - camS, STUD_PERIOD, STUD_RANGE, STUD_SLOTS);
  const mesh = w.studs;
  const lane = ROAD.railX - 0.05;
  const twinkle = g.reducedMotion ? 0 : 1;
  const t = g.t;

  for (let k = 0; k < live; k++) {
    const s = base + k * STUD_PERIOD;
    const d = s - camS;
    const cell = Math.round(s / STUD_PERIOD);

    // Катафот — отражатель, а не лампа: он вспыхивает, когда наши фары бьют в
    // него под нужным углом, и гаснет, едва мы с ним поравнялись. Это и есть
    // самый честный указатель скорости в кадре.
    const v = 0.5 + 0.5 * hash1(cell);
    const app = smoothstep(STUD_RANGE, 110, d);
    const pass = smoothstep(115, 32, d) * smoothstep(1.5, 12, d);
    const shim = 1 - twinkle * 0.18 * (0.5 + 0.5 * Math.sin(t * 3.1 + cell * 1.7));
    const f = clamp01(v * (0.24 * app + 1.1 * pass) * shim);

    const dw = d > 0 ? d / 140 : 0;
    const grow = 1 + (dw < 2.4 ? dw : 2.4);
    const x = roadX(s) - camRX - camX;
    const y = roadY(s) - camRY + STUD_Y;
    const z = camS - s;

    for (let side = 0; side < 2; side++) {
      _m4.makeScale(0.3 * grow, 0.16 * grow, 1);
      _m4.setPosition(x + (side === 0 ? -lane : lane), y, z);
      const slot = k * 2 + side;
      mesh.setMatrixAt(slot, _m4);
      const rgb = side === 0 ? w.studLeft : w.studRight;
      _col.setRGB(rgb.r * f, rgb.g * f, rgb.b * f);
      mesh.setColorAt(slot, _col);
    }
  }

  mesh.count = live * 2;
  markRange(mesh.instanceMatrix, w.studMR, live * 2 * 16);
  if (mesh.instanceColor) markRange(mesh.instanceColor, w.studCR, live * 2 * 3);
}
