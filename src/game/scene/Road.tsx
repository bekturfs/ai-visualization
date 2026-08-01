/**
 * Полотно дороги: обочины, мокрый асфальт, разметка и отбойники.
 *
 * Вся дорога — это несколько «лент». Лента строится один раз как BufferGeometry
 * (строки по дистанции × колонки по ширине), а каждый кадр в неё переписываются
 * позиции вершин: строка `i` берёт дистанцию `s = base + (i - 1) * step`, где
 * `base = floor(camS / step) * step`. Привязка базы к сетке сегментов — то, что
 * не даёт полотну «кипеть» на ходу: пока камера идёт внутри одной клетки сетки,
 * дистанции вершин не меняются вообще, а значит не меняются ни `roadX`, ни
 * `roadY` в них. Меняется только общий сдвиг по Z, и лента едет цельным куском.
 *
 * Длина отрисовки всегда `ROAD_LEN`, а качество меняет `step`: на слабом железе
 * сегменты просто длиннее. Так дорога не обрывается в воздухе на низком пресете.
 *
 * Слои (каждый — свой меш, но проход по строкам общий, считается один раз):
 * обочины, асфальт с мокрым отблеском, продольные аддитивные блики, двойная
 * осевая и краевые линии, прерывистая разметка между полосами, отбойники с
 * катафотами. Всё на MeshBasicMaterial: настоящего света в сцене нет, есть
 * свечение и bloom, поэтому яркой разметке выставлен `toneMapped: false`.
 *
 * Ни одной аллокации в кадре: скретч-массивы строк и матрицы подняты в модуль,
 * пулы штрихов и катафотов — InstancedMesh фиксированного размера, лишние слоты
 * прячутся нулевым масштабом.
 */

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { Game } from "../types";
import { COLORS, FOG, QUALITY, ROAD, ROAD_LEN } from "../config";
import { localX, localY, localZ, roadPitch } from "../road";
import { clamp, clamp01, smoothstep } from "../num";
import { hash1 } from "../rng";

/* ---------- константы раскладки ---------- */

/** Максимум строк ленты: по строке на стык сегментов, плюс одна «за спиной». */
const ROWS_MAX = ROAD.segCount + 2;

/**
 * Насколько разметка толстеет с дистанцией, 1/м, и предел утолщения. На
 * четырёхстах метрах настоящая линия шириной 17 см — это треть пикселя: без
 * утолщения она рассыпается в мерцающий пунктир. Утолщённая читается сплошной,
 * а вблизи прибавка незаметна.
 */
const WIDEN_RATE = 1 / 110;
const WIDEN_MAX = 5.5;

/** Где полотно начинает и заканчивает растворяться в ночи, м. Ночью асфальт
 *  видно ровно до конца света фар, дальше дорогу держат только огни. */
const FADE0 = FOG.near * 0.23;
const FADE1 = FOG.far * 0.66;

/** Цель растворения аддитивных слоёв. */
const BLACK = "#000000";

/** Полуширина штриха разметки. */
const MARK_H = ROAD.markWidth * 0.5;

/** Минимальный отступ первой строки ленты за камеру, м. */
const BEHIND = 2.5;

/** Куда прячутся незанятые слоты пулов: далеко и с нулевым масштабом. */
const HIDE_Y = -1e4;

/** Разделительная прерывистая — ровно между двумя нашими полосами. */
const DASH_X = (ROAD.laneCenters[0] + ROAD.laneCenters[1]) * 0.5;
const DASH_PERIOD = ROAD.dashLen + ROAD.dashGap;
/** Дальность штрихов по пресетам качества и размер пула под максимум. */
const DASH_RANGE: readonly [number, number, number] = [300, 400, 460];
const DASH_SLOTS = Math.ceil(DASH_RANGE[2] / DASH_PERIOD) + 2;

/** Катафоты на отбойнике. */
const STUD_PERIOD = 14;
const STUD_RANGE = 430;
const STUD_SLOTS = Math.ceil(STUD_RANGE / STUD_PERIOD) + 2;
const STUD_Y = 0.74;

/** Высоты слоёв. Разметка лежит выше асфальта, а сам асфальт отодвинут
 *  polygonOffset-ом — вместе это снимает любые z-конфликты на дистанции. */
const Y_SHOULDER = -0.02;
const Y_STREAK = 0.012;
const Y_DASH = 0.02;
const Y_MARK = 0.024;
const RAIL_Y0 = 0.42;
const RAIL_Y1 = 0.9;

/* ---------- скретч кадра ---------- */

const rowX = new Float64Array(ROWS_MAX);
const rowY = new Float64Array(ROWS_MAX);
const rowZ = new Float64Array(ROWS_MAX);
/** Насколько строка утонула в ночи, 0…1. */
const rowFog = new Float64Array(ROWS_MAX);
/** Блеск мокрого асфальта: пятна вдоль дороги + световое пятно фар. */
const rowLit = new Float64Array(ROWS_MAX);
/** Яркость продольных отражённых полос. */
const rowGlow = new Float64Array(ROWS_MAX);

const _m4 = new THREE.Matrix4();
const _sc = new THREE.Vector3();
const _col = new THREE.Color();
const _mk = new THREE.Color();
const _mk2 = new THREE.Color();

/* ---------- лента ---------- */

/**
 * Колонка ленты. По ширине точка стоит в `c + w * k`, где `k` — коэффициент
 * утолщения от дистанции: у разметки `w` — полуширина штриха, у остальных 0.
 * Цвет вершины — интерполяция базового в «подсвеченный» по яркости строки.
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
): Col {
  _mk.set(hex);
  _mk2.set(litHex);
  return {
    c,
    w,
    y,
    link,
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
  lit: Float64Array;
  geom: THREE.BufferGeometry;
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  pos: Float32Array;
  colr: Float32Array;
  mesh: THREE.Mesh;
}

/** Что нужно знать о ленте на сборке. */
interface RibbonSpec {
  cols: Col[];
  /** Через сколько строк общей сетки берётся своя строка. */
  rowStep: number;
  /** Предел утолщения разметки (0 — не толстеет). */
  widen?: number;
  /** Множитель к кривой растворения: >1 — гаснет раньше. */
  fade?: number;
  /** Цвет растворения: ночь у непрозрачных, чёрный у аддитивных. */
  fog: string;
  /** Откуда брать яркость подсветки строки. */
  lit: Float64Array;
  mat: THREE.Material;
  order: number;
}

function buildRibbon(spec: RibbonSpec): Ribbon {
  const cols = spec.cols;
  const rowStep = spec.rowStep;
  const widen = spec.widen ?? 0;
  const fade = spec.fade ?? 1;
  const lit = spec.lit;
  _mk.set(spec.fog);
  const fr = _mk.r;
  const fg = _mk.g;
  const fb = _mk.b;
  const nc = cols.length;
  const rows = Math.ceil((ROWS_MAX - 1) / rowStep) + 1;

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
  // Ручная сфера с запасом: вершины переписываются каждый кадр, считать её
  // заново нельзя, а отсечение по фрустуму дороге всё равно не нужно.
  geom.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, -ROAD_LEN * 0.5),
    ROAD_LEN,
  );

  const mesh = new THREE.Mesh(geom, spec.mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = spec.order;

  return {
    cols, rowStep, quads, widen, fade, fr, fg, fb,
    lit, geom, posAttr, colAttr, pos, colr, mesh,
  };
}

/** Переписать вершины ленты под текущий проход по строкам. */
function updateRibbon(rb: Ribbon, rows: number) {
  const cols = rb.cols;
  const nc = cols.length;
  const pos = rb.pos;
  const colr = rb.colr;
  const k = rb.rowStep;
  const last = rows - 1;
  const jMax = Math.ceil(last / k);
  let p = 0;

  for (let j = 0; j <= jMax; j++) {
    const jk = j * k;
    const i = jk < last ? jk : last;
    const x0 = rowX[i];
    const y0 = rowY[i];
    const z0 = rowZ[i];
    const d = -z0;
    const dw = d > 0 ? d * WIDEN_RATE : 0;
    const wide = 1 + (dw < rb.widen ? dw : rb.widen);
    // Непрозрачные ленты уходят в цвет ночи, аддитивные — в ноль: и те и другие
    // на пределе дальности сливаются с фоном, а не сыплются точками.
    const tf = rb.fade * rowFog[i];
    const t = tf < 1 ? tf : 1;
    const u = 1 - t;
    const fr = rb.fr * t;
    const fg = rb.fg * t;
    const fb = rb.fb * t;
    const lit = rb.lit[i];

    for (let n = 0; n < nc; n++) {
      const cc = cols[n];
      pos[p] = x0 + cc.c + cc.w * wide;
      pos[p + 1] = y0 + cc.y;
      pos[p + 2] = z0;
      colr[p] = (cc.cr + (cc.sr - cc.cr) * lit) * u + fr;
      colr[p + 1] = (cc.cg + (cc.sg - cc.cg) * lit) * u + fg;
      colr[p + 2] = (cc.cb + (cc.sb - cc.cb) * lit) * u + fb;
      p += 3;
    }
  }

  rb.geom.setDrawRange(0, jMax * rb.quads * 6);
  rb.posAttr.needsUpdate = true;
  rb.colAttr.needsUpdate = true;
}

/**
 * Спрятать слот пула. Нулевой масштаб схлопывает квад в точку, но в начале
 * координат эта точка лежит в плоскости камеры — вырожденный случай проекции.
 * Поэтому слот заодно уезжает далеко вниз, подальше от глаз и от near-плоскости.
 */
function hideSlot(m: THREE.Matrix4) {
  m.makeScale(0, 0, 0);
  m.setPosition(0, HIDE_Y, 0);
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

function buildWorld() {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const geoms: THREE.BufferGeometry[] = [];

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
  const matStreak = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const matMark = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const matRail = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const matDash = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const matStud = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  mats.push(matShoulder, matPave, matStreak, matMark, matRail, matDash, matStud);

  /* --- обочины: две ленты по краям, под полотном нет ни одной вершины --- */

  const outer = ROAD.railX + 0.7;
  const edge = ROAD.halfWidth + ROAD.shoulder;
  const shoulder = buildRibbon({
    cols: [
      col(-outer, 0, Y_SHOULDER, COLORS.shoulder, 0.35, COLORS.shoulder, 0.35, true),
      col(-edge, 0, Y_SHOULDER, COLORS.shoulder, 0.8, COLORS.shoulder, 1, true),
      col(-ROAD.halfWidth, 0, Y_SHOULDER, COLORS.shoulder, 1.2, COLORS.asphaltSheen, 0.8, false),
      col(ROAD.halfWidth, 0, Y_SHOULDER, COLORS.shoulder, 1.2, COLORS.asphaltSheen, 0.8, true),
      col(edge, 0, Y_SHOULDER, COLORS.shoulder, 0.8, COLORS.shoulder, 1, true),
      col(outer, 0, Y_SHOULDER, COLORS.shoulder, 0.35, COLORS.shoulder, 0.35, false),
    ],
    rowStep: 2,
    fog: COLORS.night0,
    lit: rowLit,
    mat: matShoulder,
    order: 0,
  });

  /* --- полотно: пять колонок, чтобы блеск шёл не только вдоль, но и поперёк --- */

  const hw = ROAD.halfWidth;
  const pavement = buildRibbon({
    cols: [
      col(-hw, 0, 0, COLORS.asphalt, 1, COLORS.asphaltSheen, 0.7, true),
      col(-hw * 0.5, 0, 0, COLORS.asphalt, 1.1, COLORS.asphaltSheen, 1.1, true),
      col(0, 0, 0, COLORS.asphalt, 1.15, COLORS.asphaltSheen, 0.9, true),
      col(hw * 0.5, 0, 0, COLORS.asphalt, 1.1, COLORS.asphaltSheen, 1.1, true),
      col(hw, 0, 0, COLORS.asphalt, 1, COLORS.asphaltSheen, 0.7, false),
    ],
    rowStep: 1,
    fog: COLORS.night0,
    lit: rowLit,
    mat: matPave,
    order: 0,
  });

  /* --- мокрые продольные блики: аддитивные полосы вдоль движения --- */

  const streakAt: readonly number[] = [-6.2, -5.0, -3.5, -1.85, 1.85, 3.5, 5.0, 6.2];
  const streakK: readonly number[] = [1, 0.8, 0.55, 0.7, 0.7, 0.55, 0.8, 1];
  const streakCols: Col[] = [];
  for (let i = 0; i < streakAt.length; i++) {
    const x = streakAt[i];
    const k = streakK[i];
    streakCols.push(col(x - 0.45, 0, Y_STREAK, COLORS.neonDeep, 0, COLORS.neonDeep, 0, true));
    streakCols.push(col(x, 0, Y_STREAK, COLORS.neonDeep, 0, COLORS.neonDeep, 0.19 * k, true));
    streakCols.push(
      col(x + 0.45, 0, Y_STREAK, COLORS.neonDeep, 0, COLORS.neonDeep, 0, i < streakAt.length - 1),
    );
  }
  const streaks = buildRibbon({
    cols: streakCols,
    rowStep: 3,
    fog: BLACK,
    lit: rowGlow,
    mat: matStreak,
    order: 2,
  });

  /* --- разметка: двойная осевая и краевые линии одной геометрией --- */

  const eg = ROAD.halfWidth - 0.14;
  const marks = buildRibbon({
    cols: [
      col(-eg, -MARK_H, Y_MARK, COLORS.markSide, 0.8, COLORS.markSide, 1.2, true),
      col(-eg, MARK_H, Y_MARK, COLORS.markSide, 0.8, COLORS.markSide, 1.2, false),
      col(-0.3, -MARK_H, Y_MARK, COLORS.markCenter, 1, COLORS.markCenter, 1.35, true),
      col(-0.3, MARK_H, Y_MARK, COLORS.markCenter, 1, COLORS.markCenter, 1.35, false),
      col(0.3, -MARK_H, Y_MARK, COLORS.markCenter, 1, COLORS.markCenter, 1.35, true),
      col(0.3, MARK_H, Y_MARK, COLORS.markCenter, 1, COLORS.markCenter, 1.35, false),
      col(eg, -MARK_H, Y_MARK, COLORS.markSide, 0.8, COLORS.markSide, 1.2, true),
      col(eg, MARK_H, Y_MARK, COLORS.markSide, 0.8, COLORS.markSide, 1.2, false),
    ],
    rowStep: 1,
    widen: WIDEN_MAX,
    // Разметка гаснет раньше полотна: на пределе видимости линия тоньше пикселя
    // и без этого сыплется в мерцающий пунктир.
    fade: 1.5,
    fog: BLACK,
    lit: rowLit,
    mat: matMark,
    order: 4,
  });

  /* --- отбойники: вертикальные ленты, верхняя кромка ловит свет фар --- */

  const rails = buildRibbon({
    cols: [
      col(-ROAD.railX, 0, RAIL_Y0, COLORS.rail, 0.12, COLORS.rail, 0.45, true),
      col(-ROAD.railX, 0, RAIL_Y1, COLORS.rail, 0.4, COLORS.markSide, 0.14, false),
      col(ROAD.railX, 0, RAIL_Y0, COLORS.rail, 0.12, COLORS.rail, 0.45, true),
      col(ROAD.railX, 0, RAIL_Y1, COLORS.rail, 0.4, COLORS.markSide, 0.14, false),
    ],
    rowStep: 2,
    fog: COLORS.night0,
    lit: rowLit,
    mat: matRail,
    order: 0,
  });

  const ribbons: Ribbon[] = [shoulder, pavement, streaks, marks, rails];
  for (const rb of ribbons) {
    geoms.push(rb.geom);
    group.add(rb.mesh);
  }

  /* --- прерывистая разметка: пул плоских квадов --- */

  const dashGeom = unitQuad();
  const dashes = new THREE.InstancedMesh(dashGeom, matDash, DASH_SLOTS * 2);
  dashes.frustumCulled = false;
  dashes.renderOrder = 3;
  dashes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  /* --- катафоты отбойника --- */

  const studGeom = unitQuad();
  const studs = new THREE.InstancedMesh(studGeom, matStud, STUD_SLOTS * 2);
  studs.frustumCulled = false;
  studs.renderOrder = 5;
  studs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Первичная инициализация: слоты спрятаны, instanceColor создан заранее,
  // чтобы в кадре его оставалось только пометить грязным.
  hideSlot(_m4);
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < dashes.count; i++) {
    dashes.setMatrixAt(i, _m4);
    dashes.setColorAt(i, _col);
  }
  for (let i = 0; i < studs.count; i++) {
    studs.setMatrixAt(i, _m4);
    studs.setColorAt(i, _col);
  }

  geoms.push(dashGeom, studGeom);
  group.add(dashes, studs);

  /* --- базовые цвета инстансов (уже в линейном пространстве) --- */

  _mk.set(COLORS.markSide);
  const dashRGB = { r: _mk.r, g: _mk.g, b: _mk.b };
  _mk.set(COLORS.railStud);
  const studRGB = { r: _mk.r, g: _mk.g, b: _mk.b };

  return {
    group,
    mats,
    geoms,
    shoulder,
    pavement,
    streaks,
    marks,
    rails,
    dashes,
    studs,
    dashRGB,
    studRGB,
  };
}

type RoadWorld = ReturnType<typeof buildWorld>;

/* ---------- компонент ---------- */

export function Road({ g }: { g: Game }) {
  const w = useMemo(buildWorld, []);

  // Всё, что попало на GPU, освобождается на размонтировании. Детей группы при
  // этом не трогаем: в StrictMode React монтирует компонент дважды, и пустая
  // группа после «первого» размонтирования оставила бы сцену без дороги.
  useEffect(
    () => () => {
      for (const m of w.mats) m.dispose();
      for (const geom of w.geoms) geom.dispose();
    },
    [w],
  );

  useFrame(() => {
    const preset = QUALITY[g.quality];
    const segs = clamp(Math.round(preset.roadSegments), 16, ROAD.segCount);
    const step = ROAD_LEN / segs;
    const camS = g.s;
    const camX = g.x;
    // База привязана к сетке сегментов — вершины стоят на месте, пока камера
    // идёт внутри клетки. Первая строка уходит за камеру, и не ближе BEHIND
    // метров к ней: вершина в самой плоскости камеры — вырожденный случай
    // перспективного деления, и связываться с ним незачем.
    let base = Math.floor(camS / step) * step;
    if (camS - base < BEHIND) base -= step;
    const rows = segs + 2;

    for (let i = 0; i < rows; i++) {
      const s = base + (i - 1) * step;
      const d = s - camS;
      rowX[i] = localX(s, 0, camS, camX);
      rowY[i] = localY(s, 0, camS);
      rowZ[i] = localZ(s, camS);
      rowFog[i] = smoothstep(FADE0, FADE1, d);

      // Мокрые пятна вдоль трассы плюс световое пятно собственных фар.
      const wet = 0.5 + 0.3 * Math.sin(s * 0.021) + 0.2 * Math.sin(s * 0.0067 + 1.3);
      rowLit[i] = clamp01(wet * 0.4 + smoothstep(95, 4, d) * 0.62);

      // Длинные отражённые полосы: медленная волна по дистанции, ярче вблизи.
      const band = 0.5 + 0.5 * Math.sin(s * 0.043 + Math.sin(s * 0.0105) * 2.2);
      rowGlow[i] = clamp01((0.28 + 0.72 * band) * (0.3 + 0.7 * smoothstep(430, 18, d)));
    }

    updateRibbon(w.shoulder, rows);
    updateRibbon(w.pavement, rows);
    updateRibbon(w.marks, rows);
    updateRibbon(w.rails, rows);

    // На экономном пресете мокрых бликов нет: они чистая декорация.
    const wetOn = g.quality > 0;
    w.streaks.mesh.visible = wetOn;
    if (wetOn) updateRibbon(w.streaks, rows);

    drawDashes(w, g, camS, camX);
    drawStuds(w, g, camS, camX);
  });

  return <primitive object={w.group} />;
}

/* ---------- инстансы ---------- */

function drawDashes(w: RoadWorld, g: Game, camS: number, camX: number) {
  const range = DASH_RANGE[g.quality];
  const base = Math.floor(camS / DASH_PERIOD) * DASH_PERIOD;
  const half = ROAD.dashLen * 0.5;
  const rgb = w.dashRGB;
  const mesh = w.dashes;

  let slot = 0;
  for (let side = 0; side < 2; side++) {
    const lane = side === 0 ? -DASH_X : DASH_X;
    for (let k = 0; k < DASH_SLOTS; k++, slot++) {
      const s = base + k * DASH_PERIOD + half;
      const d = s - camS;
      if (d > range) {
        hideSlot(_m4);
        mesh.setMatrixAt(slot, _m4);
        continue;
      }
      const dw = d > 0 ? d * WIDEN_RATE : 0;
      const wide = ROAD.markWidth * (1 + (dw < WIDEN_MAX ? dw : WIDEN_MAX));
      // Штрих кладётся плашмя и доворачивается на уклон, иначе на переломе
      // рельефа его концы уходят под асфальт.
      _m4.makeRotationX(-Math.PI * 0.5 + roadPitch(s));
      _sc.set(wide, ROAD.dashLen, 1);
      _m4.scale(_sc);
      _m4.setPosition(
        localX(s, lane, camS, camX),
        localY(s, Y_DASH, camS),
        localZ(s, camS),
      );
      mesh.setMatrixAt(slot, _m4);

      const ft = 1.5 * smoothstep(FADE0, FADE1, d);
      const f = ft < 1 ? 1 - ft : 0;
      _col.setRGB(rgb.r * f, rgb.g * f, rgb.b * f);
      mesh.setColorAt(slot, _col);
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function drawStuds(w: RoadWorld, g: Game, camS: number, camX: number) {
  const base = Math.floor(camS / STUD_PERIOD) * STUD_PERIOD;
  const rgb = w.studRGB;
  const mesh = w.studs;
  const twinkle = g.reducedMotion ? 0 : 1;

  let slot = 0;
  for (let side = 0; side < 2; side++) {
    const lane = side === 0 ? -(ROAD.railX - 0.05) : ROAD.railX - 0.05;
    for (let k = 0; k < STUD_SLOTS; k++, slot++) {
      const s = base + k * STUD_PERIOD;
      const d = s - camS;
      if (d > STUD_RANGE || d < -10) {
        hideSlot(_m4);
        mesh.setMatrixAt(slot, _m4);
        continue;
      }
      const dw = d > 0 ? d / 150 : 0;
      const grow = 1 + (dw < 2.5 ? dw : 2.5);
      _m4.makeScale(0.2 * grow, 0.12 * grow, 1);
      _m4.setPosition(
        localX(s, lane, camS, camX),
        localY(s, STUD_Y, camS),
        localZ(s, camS),
      );
      mesh.setMatrixAt(slot, _m4);

      // Катафот — отражатель: горит от наших фар и гаснет с дистанцией.
      const cell = Math.round(s / STUD_PERIOD);
      const v = 0.45 + 0.55 * hash1(cell);
      const near = 0.05 + 0.95 * smoothstep(STUD_RANGE, 30, d);
      const blink = 1 - twinkle * 0.25 * (0.5 + 0.5 * Math.sin(g.t * 2.6 + cell));
      const f = v * near * blink;
      _col.setRGB(rgb.r * f, rgb.g * f, rgb.b * f);
      mesh.setColorAt(slot, _col);
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
