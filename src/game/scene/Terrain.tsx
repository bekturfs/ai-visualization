/**
 * Рельеф вокруг дороги: силуэты хребтов, тёмная насыпь обочин и хвойный лес.
 *
 * Три слоя, все — от дистанции камеры, без единой аллокации в кадре:
 *
 *   1. ХРЕБТЫ. Две длинные ленты-силуэта (слева и справа) на удалении
 *      `RIDGE_LANE` метров. Каждая — полоса из трёх рядов: подножие, которое
 *      растворяется в ночи, плотная тёмная масса и гребень на высоте
 *      `ridge(s, side)`. Сверху по гребню идёт вторая, тонкая аддитивная лента
 *      `COLORS.mountainRim` — та самая холодная кромка из f_003 и f_007.
 *      Позиции переписываются каждый кадр, но дистанции вершин привязаны к
 *      сетке `RIDGE_STEP`: пока камера идёт внутри клетки, `ridge()` считается
 *      в тех же точках, и гребень не «кипит» на ходу.
 *
 *   2. НАСЫПЬ. Тёмный склон от кромки обочины (дорога заканчивается на
 *      `railX + 0.7`) и до 260 м в стороны. Без него под деревьями и у нижних
 *      углов кадра просвечивал бы купол неба. Заодно склон даёт лесу, на чём
 *      стоять: основание дерева садится на тот же профиль `slopeY`.
 *
 *   3. ЛЕС. Один InstancedMesh низкополигонального хвойника (ствол + три
 *      юбки одной геометрией, чтобы не платить вторым вызовом отрисовки).
 *      Пул рассчитан на самый жирный пресет, в кадре занимается столько слотов,
 *      сколько разрешает `QUALITY[g.quality].trees`; лишние схлопываются в ноль.
 *      Цвет слота — от `COLORS.foliage` к `COLORS.foliageLit` по близости к
 *      дороге, считается один раз на назначение слота, а не каждый кадр.
 *
 * Туман сцены ставит Rig. Насыпь и деревья честно им гасятся (`fog: true`) и
 * потому не заканчиваются резкой линией. Хребты стоят в 1–2 км, то есть далеко
 * за `FOG.far`, — линейный туман съел бы их целиком, поэтому у них `fog: false`
 * и собственное растворение по альфе в вершинах.
 */

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { Game, Tree } from "../types";
import { COLORS, FOG, QUALITY } from "../config";
import { localX, localY, localZ } from "../road";
import { clamp, lerp, smoothstep } from "../num";
import { noise1 } from "../rng";

/* ---------- общее ---------- */

const TAU = Math.PI * 2;

/** Куда уезжает незанятый слот пула: нулевой масштаб в кадре камеры даёт w = 0
 *  и мусор в перспективном делении, поэтому слот ещё и проваливается вниз. */
const HIDE_Y = -1e4;

/* ---------- хребты ---------- */

/** Боковое удаление гребня, м. Ближе — гора лезет в кадр стеной, дальше —
 *  теряется у точки схода. На 400 м силуэт входит в портретный кадр примерно
 *  с километра и красиво сходится к горизонту. */
const RIDGE_LANE = 400;
/** Насколько гребень гуляет вбок вдоль дороги, ±м: линии перестают быть
 *  параллельными коридору и читаются как отроги. */
const RIDGE_WANDER = 90;
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

/** Ряды тела: подножие (альфа 0), низ массы, гребень. */
const RIDGE_BOT_Y = -190;
const RIDGE_MID_Y = -30;

/** Толщина кромки в метрах: доля дистанции, чтобы на экране она всегда была
 *  в пару пикселей, а не исчезала вдали и не превращалась в вал вблизи. */
const RIM_K = 0.009;
const RIM_MIN = 4;
const RIM_MAX = 30;

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
/** Яркость ряда: чем выше по склону, тем чернее. */
const APRON_MUL: readonly number[] = [1.15, 0.95, 0.72, 0.5, 0.34];
/** Сколько света фар достаёт до ряда. */
const APRON_NEAR: readonly number[] = [1, 0.62, 0.22, 0, 0];
/** Амплитуда рельефа дальних рядов, м. Ближние ряды ровные — на них стоит лес. */
const APRON_BUMP: readonly number[] = [0, 0, 0, 5, 11];
const APRON_NOISE = 1 / 180;

/** Высота грунта на боковом удалении `a` (модуль lane), м. Двумя ступенями:
 *  пологая обочина у дороги и уходящий вверх лесистый склон. */
function slopeY(a: number): number {
  return -0.25 + 3.4 * smoothstep(9, 48, a) + 26 * smoothstep(44, 260, a);
}

/* ---------- лес ---------- */

/** Пул на самый жирный пресет: качество можно менять на лету, а пул — нет. */
const TREE_POOL = Math.max(QUALITY[0].trees, QUALITY[1].trees, QUALITY[2].trees);

/** Дальность леса по пресетам, м. Дальше пул всё равно кончится, а обрыв
 *  прячется туманом и усадкой у самого края. */
const TREE_RANGE: readonly number[] = [350, 620, 860];
/** Предел бокового удаления: на экономном режиме дальний ряд не рисуем вовсе,
 *  зато ближняя стена доживает до нормальной дистанции. */
const TREE_LANE_MAX: readonly number[] = [19, 40, 40];
/** Насколько закапываем основание, м: профиль насыпи между колонками ленты
 *  интерполируется линейно и на полметра расходится с `slopeY`. */
const TREE_SINK = -0.4;

/** Ярусы кроны в долях высоты. */
const TIERS: readonly { y0: number; y1: number; r: number }[] = [
  { y0: 0.08, y1: 0.5, r: 0.26 },
  { y0: 0.38, y1: 0.76, r: 0.195 },
  { y0: 0.66, y1: 1, r: 0.125 },
];
/** Рваный радиус по граням: силуэт перестаёт быть циркульным конусом. */
const RAG: readonly number[] = [1, 0.88, 0.97, 0.84, 1, 0.91];
const TREE_SEG = RAG.length;
const TRUNK_H = 0.22;
const TRUNK_R = 0.048;

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

function hideSlot(m: THREE.Matrix4) {
  m.makeScale(0, 0, 0);
  m.setPosition(0, HIDE_Y, 0);
}

/* ---------- лента ---------- */

/**
 * Полоса `cols × rows` вершин: колонки идут по дистанции, ряды — снизу вверх.
 * Цвет с альфой (itemSize 4): аддитивной кромке альфа задаёт яркость, телу
 * хребта — растворение подножия и дальнего края.
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
  // Сферу задаём руками: вершины переписываются каждый кадр, считать её заново
  // нельзя, а отсечение по фрустуму лентам всё равно выключено.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -radius * 0.5), radius);

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return { pos, col, posAttr, colAttr, geom, mesh };
}

/* ---------- геометрия хвойника ---------- */

/**
 * Ствол и три конические юбки одной геометрией высотой 1 и радиусом ~0.26.
 * Освещение запечено в цвет вершин: вертикальный градиент (низ темнее) плюс
 * разброс по граням, чтобы низкополигональный конус не читался плоским пятном.
 * Итоговый цвет — это произведение цвета вершины на цвет инстанса, поэтому
 * стволу достаётся не серый, а отношение `trunk / foliage`: у базового дерева
 * он выйдет ровно `COLORS.trunk`, у подсвеченного — его тёплым оттенком.
 */
function buildConifer(tr: number, tg: number, tb: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];

  const shade = (y: number, a: number) =>
    (0.52 + 0.62 * y) * (0.86 + 0.26 * (0.5 + 0.5 * Math.cos(a - 0.7)));

  const put = (x: number, y: number, z: number, b: number, trunk: boolean) => {
    pos.push(x, y, z);
    if (trunk) col.push(tr * b, tg * b, tb * b);
    else col.push(b, b, b);
  };

  // Ствол: четырёхгранная призма, видна только между нижней юбкой и землёй.
  for (let j = 0; j < 4; j++) {
    const a0 = (j / 4) * TAU + 0.4;
    const a1 = ((j + 1) / 4) * TAU + 0.4;
    const x0 = Math.cos(a0) * TRUNK_R;
    const z0 = Math.sin(a0) * TRUNK_R;
    const x1 = Math.cos(a1) * TRUNK_R;
    const z1 = Math.sin(a1) * TRUNK_R;
    const b = 0.5 + 0.25 * (0.5 + 0.5 * Math.cos(a0 - 0.7));
    put(x1, 0, z1, b, true);
    put(x0, 0, z0, b, true);
    put(x0, TRUNK_H, z0, b, true);
    put(x1, 0, z1, b, true);
    put(x0, TRUNK_H, z0, b, true);
    put(x1, TRUNK_H, z1, b, true);
  }

  // Юбки: боковая поверхность конуса, донышко не нужно — камера всегда выше
  // основания дерева и внутрь конуса не заглядывает.
  for (let ti = 0; ti < TIERS.length; ti++) {
    const tier = TIERS[ti];
    for (let j = 0; j < TREE_SEG; j++) {
      const a0 = (j / TREE_SEG) * TAU;
      const a1 = ((j + 1) / TREE_SEG) * TAU;
      const r0 = tier.r * RAG[j];
      const r1 = tier.r * RAG[(j + 1) % TREE_SEG];
      put(Math.cos(a1) * r1, tier.y0, Math.sin(a1) * r1, shade(tier.y0, a1), false);
      put(Math.cos(a0) * r0, tier.y0, Math.sin(a0) * r0, shade(tier.y0, a0), false);
      put(0, tier.y1, 0, shade(tier.y1, (a0 + a1) * 0.5) * 1.06, false);
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
  /** Какое дерево лежит в слоте: пока то же — цвет не пересчитываем. */
  keys: Float64Array;

  /* палитра в линейном пространстве */
  foliage: Float64Array;
  foliageLit: Float64Array;
  mountLo: Float64Array;
  mountHi: Float64Array;
  rimRGB: Float64Array;
  apronRGB: Float64Array;
  apronLit: Float64Array;

  /* контекст кадра для колбэка деревьев */
  cb: (t: Tree) => void;
  slot: number;
  used: number;
  limit: number;
  range: number;
  laneMax: number;
  camS: number;
  camX: number;
  colDirty: boolean;

  dispose: () => void;
}

function buildWorld(): World {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const geoms: THREE.BufferGeometry[] = [];

  /* --- палитра --- */

  const foliage = new Float64Array(3);
  const foliageLit = new Float64Array(3);
  const mountLo = new Float64Array(3);
  const mountHi = new Float64Array(3);
  const rimRGB = new Float64Array(3);
  const apronRGB = new Float64Array(APRON_ROWS * 3);
  const apronLit = new Float64Array(APRON_ROWS * 3);

  hexInto(COLORS.foliage, 1, foliage, 0);
  hexInto(COLORS.foliageLit, 1, foliageLit, 0);
  hexInto(COLORS.mountain, 1, mountLo, 0);
  hexInto(COLORS.mountainRim, 1, mountHi, 0);
  hexInto(COLORS.mountainRim, 1, rimRGB, 0);
  for (let r = 0; r < APRON_ROWS; r++) {
    hexInto(COLORS.night0, APRON_MUL[r], apronRGB, r * 3);
    hexInto(COLORS.shoulder, 1.35 * APRON_MUL[r], apronLit, r * 3);
  }

  // Отношение «ствол / листва»: цвет вершины умножается на цвет инстанса.
  const trunk = new Float64Array(3);
  hexInto(COLORS.trunk, 1, trunk, 0);
  const tr = clamp(trunk[0] / Math.max(foliage[0], 1e-4), 0, 2);
  const tg = clamp(trunk[1] / Math.max(foliage[1], 1e-4), 0, 2);
  const tb = clamp(trunk[2] / Math.max(foliage[2], 1e-4), 0, 2);

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
    toneMapped: false,
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

  const treeGeom = buildConifer(tr, tg, tb);
  geoms.push(treeGeom);
  const trees = new THREE.InstancedMesh(treeGeom, matTree, TREE_POOL);
  trees.frustumCulled = false;
  trees.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hideSlot(_m4);
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < TREE_POOL; i++) {
    trees.setMatrixAt(i, _m4);
    // Цвет инстанса создаём заранее: в кадре останется только пометить грязным.
    trees.setColorAt(i, _col);
  }
  trees.count = 0;
  group.add(trees);

  const keys = new Float64Array(TREE_POOL);
  keys.fill(Number.NaN);

  const w: World = {
    group,
    mats,
    geoms,
    body,
    rim,
    apron,
    trees,
    keys,
    foliage,
    foliageLit,
    mountLo,
    mountHi,
    rimRGB,
    apronRGB,
    apronLit,
    cb: noTree,
    slot: 0,
    used: 0,
    limit: 0,
    range: FOG.far,
    laneMax: 40,
    camS: 0,
    camX: 0,
    colDirty: false,
    dispose: () => {
      for (const m of mats) m.dispose();
      for (const geom of geoms) geom.dispose();
      trees.dispose();
    },
  };
  w.cb = (t: Tree) => placeTree(w, t);
  return w;
}

function noTree(_t: Tree) {}

/* ---------- хребты ---------- */

function drawRidge(w: World, g: Game, ridge: (s: number, side: -1 | 1) => number) {
  const camS = g.s;
  const camX = g.x;
  // База на сетке: пока камера внутри клетки, `ridge()` спрашивают в тех же
  // точках, и гребень стоит на месте вместо того, чтобы переливаться.
  const base = Math.floor(camS / RIDGE_STEP) * RIDGE_STEP - RIDGE_BACK;

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
      const d = s - camS;
      const off = RIDGE_LANE + RIDGE_WANDER * (noise1(s * RIDGE_NOISE + seed) * 2 - 1);
      const x = localX(s, side * off, camS, camX);
      const z = localZ(s, camS);
      const crest = localY(s, ridge(s, side), camS);
      const mid = localY(s, RIDGE_MID_Y, camS);
      const bot = localY(s, RIDGE_BOT_Y, camS);
      // Дальний край не обрывается, а уходит в дымку — иначе у точки схода
      // висела бы вертикальная кромка ленты.
      const a = smoothstep(RIDGE_FAR, RIDGE_FADE, d);
      const haze = smoothstep(700, RIDGE_FAR, d);
      const hz = 0.16 + 0.34 * haze;

      /* тело: подножие (прозрачное) → масса → гребень */
      bp[pi] = x;
      bp[pi + 1] = bot;
      bp[pi + 2] = z;
      bc[ci] = w.mountLo[0];
      bc[ci + 1] = w.mountLo[1];
      bc[ci + 2] = w.mountLo[2];
      bc[ci + 3] = 0;

      bp[pi + 3] = x;
      bp[pi + 4] = mid;
      bp[pi + 5] = z;
      bc[ci + 4] = w.mountLo[0];
      bc[ci + 5] = w.mountLo[1];
      bc[ci + 6] = w.mountLo[2];
      bc[ci + 7] = a;

      bp[pi + 6] = x;
      bp[pi + 7] = crest;
      bp[pi + 8] = z;
      bc[ci + 8] = lerp(w.mountLo[0], w.mountHi[0], hz);
      bc[ci + 9] = lerp(w.mountLo[1], w.mountHi[1], hz);
      bc[ci + 10] = lerp(w.mountLo[2], w.mountHi[2], hz);
      bc[ci + 11] = a;

      /* кромка: тонкая аддитивная линия, гаснущая в обе стороны от гребня */
      const th = clamp(d * RIM_K, RIM_MIN, RIM_MAX);
      const glow = a * (0.55 + 0.45 * haze);
      rp[pi] = x;
      rp[pi + 1] = crest - th * 0.6;
      rp[pi + 2] = z;
      rc[ci] = w.rimRGB[0];
      rc[ci + 1] = w.rimRGB[1];
      rc[ci + 2] = w.rimRGB[2];
      rc[ci + 3] = 0;

      rp[pi + 3] = x;
      rp[pi + 4] = crest;
      rp[pi + 5] = z;
      rc[ci + 4] = w.rimRGB[0];
      rc[ci + 5] = w.rimRGB[1];
      rc[ci + 6] = w.rimRGB[2];
      rc[ci + 7] = glow;

      rp[pi + 6] = x;
      rp[pi + 7] = crest + th * 1.4;
      rp[pi + 8] = z;
      rc[ci + 8] = w.rimRGB[0];
      rc[ci + 9] = w.rimRGB[1];
      rc[ci + 10] = w.rimRGB[2];
      rc[ci + 11] = 0;

      pi += 9;
      ci += 12;
    }

    w.body[k].posAttr.needsUpdate = true;
    w.body[k].colAttr.needsUpdate = true;
    w.rim[k].posAttr.needsUpdate = true;
    w.rim[k].colAttr.needsUpdate = true;
  }
}

/* ---------- насыпь ---------- */

function drawApron(w: World, g: Game) {
  const camS = g.s;
  const camX = g.x;
  const base = Math.floor(camS / APRON_STEP) * APRON_STEP - APRON_BACK;

  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? -1 : 1;
    const pos = w.apron[k].pos;
    const col = w.apron[k].col;
    const seed = k === 0 ? 0 : 41.9;
    let pi = 0;
    let ci = 0;

    for (let i = 0; i < APRON_COLS; i++) {
      const s = base + i * APRON_STEP;
      const d = s - camS;
      // Свет фар выхватывает ближнюю обочину, дальше склон уходит в чёрное.
      const near = smoothstep(150, 8, d);
      // За концом дорожной ленты внутренний край съезжает к осевой: обе
      // насыпи встречаются на x = 0 и закрывают щель у точки схода.
      const seal = 1 - smoothstep(APRON_SEAL0, APRON_SEAL1, d);
      for (let r = 0; r < APRON_ROWS; r++) {
        const ax = r === 0 ? APRON_X[0] * seal : APRON_X[r];
        const amp = APRON_BUMP[r];
        const bump =
          amp > 0 ? amp * (noise1(s * APRON_NOISE + r * 3.7 + seed) * 2 - 1) : 0;
        pos[pi] = localX(s, side * ax, camS, camX);
        pos[pi + 1] = localY(s, slopeY(ax) + bump, camS);
        pos[pi + 2] = localZ(s, camS);

        const j = r * 3;
        const lit = near * APRON_NEAR[r];
        col[ci] = lerp(w.apronRGB[j], w.apronLit[j], lit);
        col[ci + 1] = lerp(w.apronRGB[j + 1], w.apronLit[j + 1], lit);
        col[ci + 2] = lerp(w.apronRGB[j + 2], w.apronLit[j + 2], lit);
        col[ci + 3] = 1;

        pi += 3;
        ci += 4;
      }
    }

    w.apron[k].posAttr.needsUpdate = true;
    w.apron[k].colAttr.needsUpdate = true;
  }
}

/* ---------- лес ---------- */

/**
 * Колбэк итератора деревьев. `t` — переиспользуемый объект генератора: поля
 * читаются здесь же и никуда не сохраняются.
 */
function placeTree(w: World, t: Tree) {
  if (w.slot >= w.limit) return;
  const lane = t.lane;
  const al = lane < 0 ? -lane : lane;
  if (al > w.laneMax) return;

  // У дальней кромки дерево не выскакивает, а вырастает: пул конечен, и обрыв
  // ряда иначе читался бы как мигание на ходу.
  const grow = smoothstep(w.range, w.range * 0.78, t.s - w.camS);
  if (grow <= 0.002) return;

  const i = w.slot++;
  const h = t.h * grow;
  const wide = h * (0.78 + 0.44 * t.v);
  _m4.makeRotationY(t.v * TAU * 5.7);
  _sc.set(wide, h, wide);
  _m4.scale(_sc);
  _m4.setPosition(
    localX(t.s, lane, w.camS, w.camX),
    localY(t.s, slopeY(al) + TREE_SINK, w.camS),
    localZ(t.s, w.camS),
  );
  w.trees.setMatrixAt(i, _m4);

  // Цвет зависит только от самого дерева, поэтому пересчитывается лишь тогда,
  // когда в слоте оказалось другое дерево.
  const key = t.s * 1024 + lane;
  if (w.keys[i] !== key) {
    w.keys[i] = key;
    const lit = smoothstep(31, 10.5, al) * (0.42 + 0.58 * t.v);
    const bright = 0.86 + 0.46 * lit + 0.14 * t.v;
    _col.setRGB(
      lerp(w.foliage[0], w.foliageLit[0], lit) * bright,
      lerp(w.foliage[1], w.foliageLit[1], lit) * bright,
      lerp(w.foliage[2], w.foliageLit[2], lit) * bright,
    );
    w.trees.setColorAt(i, _col);
    w.colDirty = true;
  }
}

function finishTrees(w: World) {
  for (let i = w.slot; i < w.used; i++) {
    hideSlot(_m4);
    w.trees.setMatrixAt(i, _m4);
  }
  w.used = w.slot;
  w.trees.count = w.slot;
  w.trees.instanceMatrix.needsUpdate = true;
  if (w.colDirty && w.trees.instanceColor) w.trees.instanceColor.needsUpdate = true;
}

/* ---------- компонент ---------- */

export interface TerrainProps {
  g: Game;
  /**
   * Итератор деревьев в диапазоне дистанций (обычно `worldGen.forEachTree`).
   * ВНИМАНИЕ: колбэк получает один и тот же объект — ссылку не сохраняем.
   */
  trees: (s0: number, s1: number, cb: (t: Tree) => void) => void;
  /** Высота силуэта хребта на дистанции `s`, м (обычно `worldGen.ridgeHeight`). */
  ridge: (s: number, side: -1 | 1) => number;
}

export function Terrain({ g, trees, ridge }: TerrainProps) {
  // Ресурсы в ref, а не в useMemo: StrictMode дважды прогоняет рендер, и
  // фабрика useMemo успела бы собрать два леса, из которых один утёк бы.
  const holder = useRef<World | null>(null);
  if (holder.current === null) holder.current = buildWorld();
  const w = holder.current;

  // Освобождение отложено на тик: StrictMode размонтирует и тут же монтирует
  // компонент обратно, и настоящий unmount от этой репетиции надо отличать.
  const killRef = useRef(0);
  useEffect(() => {
    if (killRef.current) {
      clearTimeout(killRef.current);
      killRef.current = 0;
    }
    return () => {
      const h = holder.current;
      if (!h) return;
      killRef.current = window.setTimeout(() => {
        killRef.current = 0;
        if (holder.current === h) {
          h.dispose();
          holder.current = null;
        }
      }, 0);
    };
  }, []);

  useFrame(() => {
    const preset = QUALITY[g.quality];
    w.camS = g.s;
    w.camX = g.x;
    w.limit = preset.trees < TREE_POOL ? preset.trees : TREE_POOL;
    w.range = TREE_RANGE[g.quality];
    w.laneMax = TREE_LANE_MAX[g.quality];
    w.slot = 0;
    w.colDirty = false;

    trees(g.s - 20, g.s + w.range, w.cb);
    finishTrees(w);
    drawApron(w, g);
    drawRidge(w, g, ridge);
  });

  return <primitive object={w.group} dispose={null} />;
}
