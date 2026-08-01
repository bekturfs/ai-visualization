/**
 * Фонари на обочине и огни далёкого городка — весь мелкий свет, который задаёт
 * ночи масштаб. В референсе это два разных слоя: цепочка бирюзовых фонарей,
 * уходящая за поворот (кадр f_005), и россыпь тёплых и красных точек на склоне
 * за пару километров (кадр f_007).
 *
 * Слои:
 *   1. столбы — один InstancedMesh на слитой геометрии «мачта + вылет + голова»;
 *   2. свечение головы — аддитивные квады с мягким ореолом;
 *   3. пятно света на асфальте — аддитивный эллипс, лежащий на полотне. Именно
 *      он делает дорогу освещённой, а не раскрашенной: без него фонарь висит
 *      сам по себе и читается как наклейка;
 *   4. городок — один слой THREE.Points с покадрово переписываемыми позициями.
 *
 * Зависимости инвертированы: генераторы `forEachLamp` / `forEachTownLight`
 * приходят пропсами, модуль не знает про `worldGen` (см. `LightsProps`).
 *
 * Ни одной аллокации в кадре: колбэки обходов подняты в модуль и читают общий
 * контекст `walk`, матрицы и цвета — модульный скретч, пулы фиксированы под
 * пресет качества, лишние слоты прячутся нулевым масштабом.
 */

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { Game, Lamp, Quality, TownLight } from "../types";
import { COLORS, PHYS, QUALITY, ROAD } from "../config";
import { localX, localY, localZ, roadPitch } from "../road";
import { clamp01, damp, lerp, smoothstep } from "../num";
import { hash1 } from "../rng";

/* ---------- раскладка фонаря ---------- */

/** Высота мачты, м. */
const LAMP_H = 8.2;
/** Длина вылета к дороге, м. */
const ARM_LEN = 2.4;
/** Высота головы над полотном, м. */
const HEAD_Y = LAMP_H - 0.34;
/** Мачта стоит между отбойником и лесополосой. */
const POST_X = ROAD.railX + 1.15;
/** Голова свешивается над обочиной. */
const HEAD_X = POST_X - ARM_LEN;
/** Центр светового пятна — над внешней полосой. */
const POOL_X = 5.4;
/** Пятно лежит чуть выше разметки: свет поверх краски, а не под ней. */
const POOL_Y = 0.05;
/** Габарит квада пятна, м (видимая часть — около 60% от него). */
const POOL_W = 9.5;
const POOL_L = 13;

/** Базовый размер квада свечения, м, и предел его «раздувания» с дистанцией. */
const GLOW_SIZE = 2.5;
const GLOW_GROW = 210;
const GLOW_GROW_MAX = 3.6;

/** Яркости слоёв (уходят в instanceColor, поэтому могут быть больше единицы). */
const GLOW_GAIN = 1.55;
const POOL_GAIN = 0.9;
const TOWN_GAIN = 1.15;

/** Сколько метров позади камеры ещё имеет смысл держать фонарь. */
const LAMP_BEHIND = 10;
/** Дальность фонарей по пресетам качества, м. */
const LAMP_FAR: readonly number[] = [380, 620, 820];

/** Ближе этого огни городка уже уехали за край кадра. */
const TOWN_NEAR = 45;
/** Дальность огней городка по пресетам качества, м. */
const TOWN_FAR: readonly number[] = [620, 850, 1000];
/**
 * Грубый отсев за краем кадра: точка дальше `depth * TOWN_SPREAD` вбок или
 * вверх заведомо не в кадре. Нужен не ради заполнения GPU, а ради пула — иначе
 * невидимые огни у самой камеры съедают слоты, и до видимой грозди на горизонте
 * очередь не доходит.
 */
const TOWN_SPREAD = 1.25;
/** Базовый размер точки городка в пикселях и дистанция, на которой он верен. */
const TOWN_PX = 2.7;
const TOWN_REF = 320;

/** Куда прячутся незанятые слоты пулов. */
const HIDE_Y = -1e4;

/* ---------- скретч кадра ---------- */

const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** Единичный поворот: квады свечения смотрят в +Z. */
const _qi = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _col = new THREE.Color();
const _mk = new THREE.Color();

const _hide = new THREE.Matrix4();
_hide.makeScale(0, 0, 0);
_hide.setPosition(0, HIDE_Y, 0);

/* ---------- текстуры ---------- */

/** Контекст квадратного canvas. `null`, если рисовать негде (SSR, нулевой размер). */
function ctx2d(size: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const s = Math.max(8, Math.round(size));
  const cv = document.createElement("canvas");
  cv.width = s;
  cv.height = s;
  if (cv.width < 1 || cv.height < 1) return null;
  return cv.getContext("2d");
}

/** Байты из `#rrggbb` — в canvas мы пишем именно sRGB, без конверсий. */
function hexRgb(hex: string, out: Uint8Array): Uint8Array {
  const n = parseInt(hex.slice(1), 16) | 0;
  out[0] = (n >> 16) & 255;
  out[1] = (n >> 8) & 255;
  out[2] = n & 255;
  return out;
}

const RGB_A = new Uint8Array(3);
const RGB_B = new Uint8Array(3);

/**
 * Мягкий радиальный ореол: узкое ядро плюс широкая юбка. Два лепестка вместо
 * одного гаусса — иначе либо ядро тонет, либо юбка обрубается краем квада.
 * Цвет идёт от `core` в центре к `edge` по краю.
 */
function radialTex(
  size: number,
  core: string,
  edge: string,
  tight: number,
  wide: number,
  wideK: number,
): THREE.CanvasTexture | null {
  const ctx = ctx2d(size);
  if (!ctx) return null;
  const w = ctx.canvas.width;
  const img = ctx.createImageData(w, w);
  const d = img.data;
  const c = (w - 1) / 2;
  const near = hexRgb(core, RGB_A);
  const far = hexRgb(edge, RGB_B);
  for (let y = 0; y < w; y++) {
    const dy = (y - c) / c;
    for (let x = 0; x < w; x++) {
      const dx = (x - c) / c;
      const r2 = dx * dx + dy * dy;
      const r = Math.sqrt(r2);
      // Обрезка у края квада: иначе на аддитивном блендинге видно шов.
      const a = clamp01(
        (Math.exp(-r2 * tight) + wideK * Math.exp(-r2 * wide)) * smoothstep(1, 0.45, r),
      );
      const t = clamp01(r * 1.35);
      const i = (y * w + x) * 4;
      d[i] = Math.round(lerp(near[0], far[0], t));
      d[i + 1] = Math.round(lerp(near[1], far[1], t));
      d[i + 2] = Math.round(lerp(near[2], far[2], t));
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(ctx.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ---------- геометрия мачты ---------- */

/**
 * Слить несколько коробок в одну BufferGeometry вручную: позиции подряд,
 * индексы со сдвигом. Нормали и UV не нужны — материал basic, свет в сцене
 * поддельный.
 */
function mergeParts(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const p of parts) {
    const a = p.getAttribute("position") as THREE.BufferAttribute;
    const idx = p.getIndex();
    vCount += a.count;
    iCount += idx ? idx.count : a.count;
  }
  const pos = new Float32Array(vCount * 3);
  const index = new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const a = p.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < a.count; i++) {
      pos[(vo + i) * 3] = a.getX(i);
      pos[(vo + i) * 3 + 1] = a.getY(i);
      pos[(vo + i) * 3 + 2] = a.getZ(i);
    }
    const idx = p.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) index[io + i] = vo + idx.getX(i);
      io += idx.count;
    } else {
      for (let i = 0; i < a.count; i++) index[io + i] = vo + i;
      io += a.count;
    }
    vo += a.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Мачта + вылет + голова, основанием в нуле, вылет уходит в −X. Правая и левая
 * обочины различаются зеркалом по X через масштаб инстанса.
 *
 * Вершинный цвет — вертикальный градиент: низ почти растворён в ночи, верх
 * ловит свет собственной лампы. Инстансный цвет поверх него гасит дальние
 * мачты целиком.
 */
function buildPostGeom(): THREE.BufferGeometry {
  const post = new THREE.BoxGeometry(0.17, LAMP_H, 0.17);
  post.translate(0, LAMP_H * 0.5, 0);
  const arm = new THREE.BoxGeometry(ARM_LEN, 0.13, 0.13);
  arm.translate(-ARM_LEN * 0.5, LAMP_H - 0.22, 0);
  const head = new THREE.BoxGeometry(0.62, 0.17, 0.3);
  head.translate(-ARM_LEN, HEAD_Y, 0);

  const geo = mergeParts([post, arm, head]);
  post.dispose();
  arm.dispose();
  head.dispose();

  const a = geo.getAttribute("position") as THREE.BufferAttribute;
  const cols = new Float32Array(a.count * 3);
  const rail = new THREE.Color(COLORS.rail);
  const lit = new THREE.Color(COLORS.lampGlow);
  for (let i = 0; i < a.count; i++) {
    const t = clamp01(a.getY(i) / LAMP_H);
    _mk.copy(rail).multiplyScalar(lerp(0.3, 0.72, t)).lerp(lit, t * t * 0.4);
    cols[i * 3] = _mk.r;
    cols[i * 3 + 1] = _mk.g;
    cols[i * 3 + 2] = _mk.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return geo;
}

/* ---------- шейдер огней городка ---------- */

/**
 * Размер точки почти постоянен на экране: чистое `sizeAttenuation` уводит огонь
 * на километре в четверть пикселя, и гроздь начинает мерцать при каждом
 * подрагивании камеры. Зажим оставляет перспективе только часть хода.
 */
const TOWN_VERT = /* glsl */ `
attribute vec3 aColor;
uniform float uSize;
uniform float uRef;
uniform float uDpr;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(1.0, -mv.z);
  gl_PointSize = uSize * uDpr * clamp(uRef / d, 0.55, 2.4);
  gl_Position = projectionMatrix * mv;
}
`;

const TOWN_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`;

/* ---------- ресурсы ---------- */

interface TownRes {
  pts: THREE.Points;
  pos: Float32Array;
  col: Float32Array;
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  mat: THREE.ShaderMaterial;
  /** Линейные RGB палитры `COLORS.town`, по три числа на оттенок. */
  rgb: Float32Array;
  tints: number;
  cap: number;
}

interface LightsWorld {
  group: THREE.Group;
  posts: THREE.InstancedMesh;
  glow: THREE.InstancedMesh | null;
  pool: THREE.InstancedMesh | null;
  townRes: TownRes | null;
  lampCap: number;
  dispose: () => void;
}

function buildLights(q: Quality): LightsWorld {
  const preset = QUALITY[q];
  const group = new THREE.Group();
  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];

  const lampCap = Math.max(4, Math.round(preset.lamps));
  const townCap = Math.max(8, Math.round(preset.townLights));

  /* --- 1. мачты --- */

  const postGeom = buildPostGeom();
  geoms.push(postGeom);
  const postMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    // Зеркало по X переворачивает обход треугольников, поэтому обе стороны.
    side: THREE.DoubleSide,
    fog: true,
  });
  mats.push(postMat);
  const posts = new THREE.InstancedMesh(postGeom, postMat, lampCap);
  posts.frustumCulled = false;
  posts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(posts);

  /* --- 2. свечение головы --- */

  const glowTex = radialTex(128, COLORS.star, COLORS.lampGlow, 15, 2.1, 0.6);
  let glow: THREE.InstancedMesh | null = null;
  if (glowTex) {
    texs.push(glowTex);
    const geo = new THREE.PlaneGeometry(1, 1);
    geoms.push(geo);
    const mat = new THREE.MeshBasicMaterial({
      map: glowTex,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    mats.push(mat);
    glow = new THREE.InstancedMesh(geo, mat, lampCap);
    glow.frustumCulled = false;
    glow.renderOrder = 8;
    glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(glow);
  }

  /* --- 3. пятно света на асфальте --- */

  const poolTex = radialTex(128, COLORS.lampGlow, COLORS.neonDeep, 3.2, 0.9, 0.5);
  let pool: THREE.InstancedMesh | null = null;
  if (poolTex) {
    texs.push(poolTex);
    const geo = new THREE.PlaneGeometry(1, 1);
    geoms.push(geo);
    const mat = new THREE.MeshBasicMaterial({
      map: poolTex,
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    mats.push(mat);
    pool = new THREE.InstancedMesh(geo, mat, lampCap);
    pool.frustumCulled = false;
    pool.renderOrder = 6;
    pool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(pool);
  }

  // Стартовое состояние пулов: слоты спрятаны, instanceColor уже существует —
  // в кадре останется только пометить его грязным.
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < lampCap; i++) {
    posts.setMatrixAt(i, _hide);
    posts.setColorAt(i, _col);
    if (glow) {
      glow.setMatrixAt(i, _hide);
      glow.setColorAt(i, _col);
    }
    if (pool) {
      pool.setMatrixAt(i, _hide);
      pool.setColorAt(i, _col);
    }
  }

  /* --- 4. огни городка --- */

  const dotTex = radialTex(32, "#ffffff", "#ffffff", 6, 1.7, 0.35);
  let townRes: TownRes | null = null;
  if (dotTex) {
    texs.push(dotTex);
    const pos = new Float32Array(townCap * 3);
    const col = new Float32Array(townCap * 3);
    for (let i = 0; i < townCap; i++) pos[i * 3 + 1] = HIDE_Y;

    const posAttr = new THREE.BufferAttribute(pos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(col, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", posAttr);
    geo.setAttribute("aColor", colAttr);
    geo.setDrawRange(0, 0);
    geoms.push(geo);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: dotTex },
        uSize: { value: TOWN_PX },
        uRef: { value: TOWN_REF },
        uDpr: { value: 1 },
      },
      vertexShader: TOWN_VERT,
      fragmentShader: TOWN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    mats.push(mat);

    const tints = COLORS.town.length;
    const rgb = new Float32Array(tints * 3);
    for (let i = 0; i < tints; i++) {
      _mk.set(COLORS.town[i]);
      rgb[i * 3] = _mk.r;
      rgb[i * 3 + 1] = _mk.g;
      rgb[i * 3 + 2] = _mk.b;
    }

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    group.add(pts);

    townRes = { pts, pos, col, posAttr, colAttr, mat, rgb, tints, cap: townCap };
  }

  const dispose = () => {
    for (const m of mats) m.dispose();
    for (const geo of geoms) geo.dispose();
    for (const t of texs) t.dispose();
  };

  return { group, posts, glow, pool, townRes, lampCap, dispose };
}

/* ---------- контекст обходов ---------- */

/**
 * Колбэки итераторов подняты в модуль и читают отсюда: замыкание, созданное в
 * кадре, — это аллокация в кадре. Поля заполняются в начале `useFrame`, живут
 * ровно один синхронный обход.
 */
interface WalkCtx {
  w: LightsWorld | null;
  camS: number;
  camX: number;
  t: number;
  calm: boolean;
  dim: number;
  stretch: number;
  lampFar: number;
  townFar: number;
  nLamp: number;
  nTown: number;
}

const walk: WalkCtx = {
  w: null,
  camS: 0,
  camX: 0,
  t: 0,
  calm: false,
  dim: 1,
  stretch: 1,
  lampFar: 620,
  townFar: 850,
  nLamp: 0,
  nTown: 0,
};

function onLamp(l: Lamp): void {
  const w = walk.w;
  if (!w || walk.nLamp >= w.lampCap) return;
  const camS = walk.camS;
  const camX = walk.camX;
  const s = l.s;
  const d = s - camS;
  if (d < -LAMP_BEHIND || d > walk.lampFar) return;

  const side = l.side;
  const i = walk.nLamp++;
  // Ключ по дистанции, а не по слоту: слоты каждый кадр перераспределяются, и
  // разброс, привязанный к слоту, скакал бы с фонаря на фонарь.
  const key = Math.round(s * 4);
  const h = hash1(key);
  const sc = 0.9 + h * 0.22;

  // Дальние тонут в ночи, ближние не должны слепить, пролетая мимо камеры.
  let bri = smoothstep(walk.lampFar, walk.lampFar * 0.55, d) * smoothstep(-2, 26, d);
  if (!walk.calm && hash1(key + 7) > 0.86) {
    // Каждый седьмой фонарь на издыхании: натриевая лампа мигает.
    bri *= 0.78 + 0.22 * Math.sin(walk.t * 19 + h * 40);
  }
  bri *= walk.dim;

  const z = localZ(s, camS);

  /* мачта */
  _pos.set(localX(s, side * POST_X, camS, camX), localY(s, 0, camS), z);
  _scl.set(side, sc, 1);
  _m4.compose(_pos, _qi, _scl);
  w.posts.setMatrixAt(i, _m4);
  const fade = lerp(0.2, 1, smoothstep(walk.lampFar * 0.85, 45, d));
  _col.setRGB(fade, fade, fade);
  w.posts.setColorAt(i, _col);

  /* свечение головы: плоскость смотрит в +Z. Камера стоит в начале координат и
     смотрит в −Z, отклоняясь на единицы градусов, — настоящий билборд на
     инстанс тут не окупается, разница меньше пикселя. */
  if (w.glow) {
    const size =
      GLOW_SIZE * (d > 0 ? Math.min(1 + d / GLOW_GROW, GLOW_GROW_MAX) : 1);
    _pos.set(localX(s, side * HEAD_X, camS, camX), localY(s, HEAD_Y * sc, camS), z);
    _scl.set(size, size, 1);
    _m4.compose(_pos, _qi, _scl);
    w.glow.setMatrixAt(i, _m4);
    const gb = bri * GLOW_GAIN;
    _col.setRGB(gb, gb, gb);
    w.glow.setColorAt(i, _col);
  }

  /* пятно на асфальте: квад кладётся на полотно и доворачивается на уклон
     дороги — без этого дальний край тринадцатиметрового эллипса уходит под
     асфальт на подъёме и обрезается тестом глубины. Курс не отрабатываем:
     размытое пятно повёрнутым не читается. */
  if (w.pool) {
    _eu.set(-Math.PI * 0.5 + roadPitch(s), 0, 0, "XYZ");
    _q.setFromEuler(_eu);
    _pos.set(localX(s, side * POOL_X, camS, camX), localY(s, POOL_Y, camS), z);
    _scl.set(POOL_W, POOL_L * walk.stretch, 1);
    _m4.compose(_pos, _q, _scl);
    w.pool.setMatrixAt(i, _m4);
    const pb = bri * POOL_GAIN * smoothstep(340, 40, d);
    _col.setRGB(pb, pb, pb);
    w.pool.setColorAt(i, _col);
  }
}

function onTown(t: TownLight): void {
  const w = walk.w;
  if (!w) return;
  const tr = w.townRes;
  if (!tr || walk.nTown >= tr.cap) return;

  const camS = walk.camS;
  const depth = t.s - camS;
  if (depth < TOWN_NEAR || depth > walk.townFar) return;
  const lx = localX(t.s, t.lane, camS, walk.camX);
  const ly = localY(t.s, t.y, camS);
  const lim = depth * TOWN_SPREAD;
  if (lx > lim || lx < -lim || ly > lim) return;

  const dist = Math.sqrt(lx * lx + ly * ly + depth * depth);
  let b =
    smoothstep(walk.townFar, walk.townFar * 0.72, depth) *
    smoothstep(TOWN_NEAR, TOWN_NEAR * 2.2, depth) *
    lerp(1, 0.45, smoothstep(240, 950, dist));
  if (!walk.calm) {
    // Сцинтилляция: далёкий огонь дрожит сам по себе, фаза привязана к дистанции.
    const ph = hash1(Math.round(t.s * 2) * 7 + t.tint);
    b *= 0.82 + 0.18 * Math.sin(walk.t * (1.6 + ph * 3.2) + ph * 31);
  }
  b *= walk.dim * TOWN_GAIN;

  const i = walk.nTown++;
  tr.pos[i * 3] = lx;
  tr.pos[i * 3 + 1] = ly;
  tr.pos[i * 3 + 2] = localZ(t.s, camS);
  const ti = (t.tint | 0) % tr.tints;
  const c = (ti < 0 ? ti + tr.tints : ti) * 3;
  tr.col[i * 3] = tr.rgb[c] * b;
  tr.col[i * 3 + 1] = tr.rgb[c + 1] * b;
  tr.col[i * 3 + 2] = tr.rgb[c + 2] * b;
}

/* ---------- компонент ---------- */

interface Anim {
  t: number;
  /** Общая приглушённость: на скорости свет смазывается. */
  dim: number;
  /** Растяжение светового пятна вдоль дороги на скорости. */
  stretch: number;
  /** Сколько слотов городка было занято в прошлом кадре. */
  prevTown: number;
}

export interface LightsProps {
  g: Game;
  /** Обход фонарей в [s0, s1]; `cb` получает один переиспользуемый объект. */
  lamps: (s0: number, s1: number, cb: (l: Lamp) => void) => void;
  /** Обход огней городка в [s0, s1]; `cb` получает один переиспользуемый объект. */
  town: (s0: number, s1: number, cb: (t: TownLight) => void) => void;
}

export function Lights({ g, lamps, town }: LightsProps) {
  const quality = g.quality;

  // Ресурсы живут в ref, а не в useMemo: в StrictMode фабрика useMemo успела бы
  // построить два комплекта, из которых один утёк бы мимо cleanup.
  const holder = useRef<{ q: Quality; res: LightsWorld } | null>(null);
  if (holder.current === null) {
    holder.current = { q: quality, res: buildLights(quality) };
  } else if (holder.current.q !== quality) {
    holder.current.res.dispose();
    holder.current = { q: quality, res: buildLights(quality) };
  }
  const res = holder.current.res;

  const animRef = useRef<Anim | null>(null);
  if (animRef.current === null) {
    animRef.current = { t: 0, dim: 1, stretch: 1, prevTown: 0 };
  }

  // Освобождение отложено на тик: StrictMode размонтирует компонент и тут же
  // монтирует обратно, и настоящий unmount от этой репетиции надо отличать.
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
          h.res.dispose();
          holder.current = null;
        }
      }, 0);
    };
  }, []);

  useFrame((state, rawDt) => {
    const dt = rawDt > 0.05 ? 0.05 : rawDt;
    const anim = animRef.current;
    if (!anim) return;
    anim.t += dt;

    const speedFrac = clamp01(g.speed / PHYS.speedMax);
    anim.dim = damp(anim.dim, 1 - 0.22 * speedFrac, 2.2, dt);
    anim.stretch = damp(anim.stretch, 1 + 0.5 * speedFrac, 2.6, dt);

    walk.w = res;
    walk.camS = g.s;
    walk.camX = g.x;
    walk.t = anim.t;
    walk.calm = g.reducedMotion;
    walk.dim = anim.dim;
    walk.stretch = g.reducedMotion ? 1 : anim.stretch;
    walk.lampFar = LAMP_FAR[g.quality];
    walk.townFar = TOWN_FAR[g.quality];
    walk.nLamp = 0;
    walk.nTown = 0;

    /* --- фонари: обход идёт от камеры вперёд, поэтому пул сначала забирают
           ближние; когда слоты кончились, дальние просто не рисуются --- */
    lamps(g.s - LAMP_BEHIND, g.s + walk.lampFar, onLamp);
    for (let i = walk.nLamp; i < res.lampCap; i++) {
      res.posts.setMatrixAt(i, _hide);
      if (res.glow) res.glow.setMatrixAt(i, _hide);
      if (res.pool) res.pool.setMatrixAt(i, _hide);
    }
    res.posts.instanceMatrix.needsUpdate = true;
    if (res.posts.instanceColor) res.posts.instanceColor.needsUpdate = true;
    if (res.glow) {
      res.glow.instanceMatrix.needsUpdate = true;
      if (res.glow.instanceColor) res.glow.instanceColor.needsUpdate = true;
    }
    if (res.pool) {
      res.pool.instanceMatrix.needsUpdate = true;
      if (res.pool.instanceColor) res.pool.instanceColor.needsUpdate = true;
    }

    /* --- городок --- */
    const tr = res.townRes;
    if (tr) {
      town(g.s, g.s + walk.townFar, onTown);
      const used = walk.nTown;
      // Гасим только то, что занимал прошлый кадр: полный проход по пулу здесь
      // ни к чему, drawRange и так обрезает хвост.
      for (let i = used; i < anim.prevTown; i++) {
        tr.pos[i * 3 + 1] = HIDE_Y;
        tr.col[i * 3] = 0;
        tr.col[i * 3 + 1] = 0;
        tr.col[i * 3 + 2] = 0;
      }
      anim.prevTown = used;
      tr.pts.geometry.setDrawRange(0, used);
      tr.posAttr.needsUpdate = true;
      tr.colAttr.needsUpdate = true;
      tr.mat.uniforms.uDpr.value = state.gl.getPixelRatio();
    }

    walk.w = null;
  });

  return <primitive object={res.group} />;
}
