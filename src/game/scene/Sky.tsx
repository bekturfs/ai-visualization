/**
 * Небо «Starry Ride» — всё, что выше горизонта.
 *
 * Шесть слоёв, живущих на общей сфере радиуса `SKY.radius` вокруг камеры:
 *
 *   1. купол-градиент (ShaderMaterial, BackSide) — ночь от зенита к горизонту;
 *   2. звёздное поле (Points, мерцание считает шейдер по одному uniform-времени);
 *   3. воронка звёздных треков (глава 2) — тангенциальные штрихи вокруг оси зенита;
 *   4. туманность (глава 1) — три аддитивные плоскости с процедурным вихрем;
 *   5. метеоры (глава 0) — пул инстансов, падают по общему наклону;
 *   6. звезда-блик (главы 0 и 3) — жёсткий четырёхлучевой крест плюс ореол.
 *
 * Главы перекрёстно затухают: цель прозрачности берётся из таблицы весов по
 * `g.chapter`, последние `SKY.fade` доли главы подмешивают следующую, а сама
 * прозрачность подтягивается через `damp` — тогда ни рестарт, ни смена главы
 * посреди кроссфейда не дают скачка.
 *
 * Все текстуры рисуются в canvas прямо здесь: ни одного файла, ни одной сетевой
 * загрузки. Всё созданное освобождается при размонтировании.
 */

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { COLORS, PHYS, QUALITY, SKY } from "../config";
import { clamp01, damp, lerp, smoothstep } from "../num";
import { hash2, range } from "../rng";
import type { Game, Quality } from "../types";

/* ---------- константы слоёв ---------- */

const TAU = Math.PI * 2;
const R = SKY.radius;

/** Радиусы слоёв: чуть внутри купола, чтобы гарантированно попадать в кадр. */
const R_STARS = R * 0.985;
const R_TRAIL = R * 0.94;
const R_METEOR = R * 0.9;
const R_NEBULA = R * 0.82;
const R_FLARE = R * 0.88;

/** Нижние ~12% сферы оставляем пустыми: там дорога и склоны, звёзды там мешают. */
const STAR_Y_MIN = 0.12;

/**
 * Ось воронки треков. Половина вертикального поля зрения — 37°, поэтому центр
 * воронки поднят примерно на 33°: он у верхней кромки кадра, как в f_005.
 */
const VORTEX_AXIS = new THREE.Vector3(0.25, 0.68, -1).normalize();
/** Угловой радиус воронки, рад. */
const VORTEX_SPREAD = 1.18;
/** Скорость вращения воронки, рад/с. */
const VORTEX_RATE = 0.032;

/** Направление на туманность: верх-лево, как в f_003 (краем уходит за кромку). */
const NEBULA_DIR = new THREE.Vector3(-0.42, 0.54, -1).normalize();
/** Направление на звезду-блик: верх-право, как в f_001; видна и в портрете. */
const FLARE_DIR = new THREE.Vector3(0.3, 0.6, -1).normalize();

/** Наклон, по которому падают все метеоры, рад (0 — строго вниз). */
const METEOR_SLANT = 0.3;
/** Длина пролёта метеора в единицах касательной плоскости. */
const METEOR_TRAVEL = 2.6;

/** Поворот неба за пройденный метр, рад. */
const SPIN_PER_M = 0.000028;
/** Доля курса, на которую небо отстаёт при рулении (параллакс, не качели). */
const YAW_PARALLAX = 0.05;

/**
 * Веса слоёв по главам. Длина таблиц должна совпадать с `SKY.chapters`; если
 * глав станет больше, номер главы возьмётся по модулю длины таблицы — небо не
 * сломается, просто цикл станет короче, чем в конфиге.
 *
 * Ненулевые «остатки» в чужих главах намеренны: небо не выключается щелчком.
 */
const W_STARS = [1, 0.9, 0.46, 1] as const;
const W_NEBULA = [0, 1, 0.14, 0.05] as const;
const W_TRAIL = [0, 0.04, 1, 0] as const;
const W_METEOR = [1, 0.14, 0, 0.08] as const;
const W_FLARE = [1, 0.3, 0.12, 1] as const;

/** Скорость подтягивания прозрачностей, 1/с. */
const FADE_RATE = 1.6;

/** Порядок отрисовки всех групп неба: раньше всего остального в сцене. */
const GROUP_ORDER = -1000;

/* ---------- рабочие объекты (ни одной аллокации в кадре) ---------- */

const ORIGIN = new THREE.Vector3(0, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);
const V0 = new THREE.Vector3();
const V1 = new THREE.Vector3();
const SCL = new THREE.Vector3();
const M0 = new THREE.Matrix4();

/**
 * Матрица для «билборда»: плоскость в точке `pos` смотрит в начало координат,
 * её локальная ось +Y направлена вдоль `up` (для метеора — вдоль полёта).
 */
function faceMatrix(pos: THREE.Vector3, up: THREE.Vector3, w: number, h: number): THREE.Matrix4 {
  M0.lookAt(pos, ORIGIN, up);
  SCL.set(w, h, 1);
  M0.scale(SCL);
  M0.setPosition(pos);
  return M0;
}

/* ---------- процедурные текстуры ---------- */

const RGB_A = new Float64Array(3);
const RGB_B = new Float64Array(3);
const RGB_C = new Float64Array(3);

/** Разбор `#rrggbb` в компоненты 0…255 (sRGB, как их ждёт canvas). */
function hexRgb(hex: string, out: Float64Array): Float64Array {
  const n = parseInt(hex.slice(1), 16);
  out[0] = (n >> 16) & 255;
  out[1] = (n >> 8) & 255;
  out[2] = n & 255;
  return out;
}

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

function toTexture(ctx: CanvasRenderingContext2D, img: ImageData): THREE.CanvasTexture {
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(ctx.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Гладкий value-noise по решётке хешей из `rng`. */
function vnoise2(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

function fbm2(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise2(x * f + o * 13.7, y * f - o * 9.1) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return sum / norm;
}

/** Спрайт звезды: мягкий диск с еле заметным крестиком, чтобы крупные искрились. */
function makeStarTex(): THREE.CanvasTexture | null {
  const size = 64;
  const ctx = ctx2d(size);
  if (!ctx) return null;
  const w = ctx.canvas.width;
  const img = ctx.createImageData(w, w);
  const d = img.data;
  const c = (w - 1) / 2;
  for (let y = 0; y < w; y++) {
    const dy = (y - c) / c;
    for (let x = 0; x < w; x++) {
      const dx = (x - c) / c;
      const r2 = dx * dx + dy * dy;
      const r = Math.sqrt(r2);
      // Профиль намеренно широкий: точка размером 3 px берёт из текстуры всего
      // несколько текселей, и узкое ядро просто не попало бы ни в один из них.
      const disc = (Math.exp(-r2 * 6) + 0.35 * Math.exp(-r2 * 1.6)) * smoothstep(1.15, 0.3, r);
      const cross =
        Math.pow(Math.max(0, 1 - r), 3) *
        (Math.exp(-dy * dy * 300) + Math.exp(-dx * dx * 300)) *
        0.14;
      const a = clamp01(disc + cross);
      const i = (y * w + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = Math.round(a * 255);
    }
  }
  return toTexture(ctx, img);
}

/** Мягкий ореол — подложка под блик. */
function makeGlowTex(): THREE.CanvasTexture | null {
  const size = 128;
  const ctx = ctx2d(size);
  if (!ctx) return null;
  const w = ctx.canvas.width;
  const img = ctx.createImageData(w, w);
  const d = img.data;
  const c = (w - 1) / 2;
  const near = hexRgb(COLORS.star, RGB_A);
  const far = hexRgb(COLORS.neon, RGB_B);
  for (let y = 0; y < w; y++) {
    const dy = (y - c) / c;
    for (let x = 0; x < w; x++) {
      const dx = (x - c) / c;
      const r2 = dx * dx + dy * dy;
      const a = clamp01((Math.exp(-r2 * 9) * 0.85 + Math.exp(-r2 * 2.2) * 0.3) * (r2 < 1 ? 1 : 0));
      const t = clamp01(Math.sqrt(r2) * 1.4);
      const i = (y * w + x) * 4;
      d[i] = Math.round(lerp(near[0], far[0], t));
      d[i + 1] = Math.round(lerp(near[1], far[1], t));
      d[i + 2] = Math.round(lerp(near[2], far[2], t));
      d[i + 3] = Math.round(a * 255);
    }
  }
  return toTexture(ctx, img);
}

/**
 * Штрих: узкая полоса вдоль локальной оси +Y. `head` = 0 — симметричный след
 * (звёздные треки), `head` = 1 — комета с яркой головой у v = 1 (метеор).
 */
function makeStreakTex(head: number): THREE.CanvasTexture | null {
  const size = 64;
  const ctx = ctx2d(size);
  if (!ctx) return null;
  const w = ctx.canvas.width;
  const img = ctx.createImageData(w, w);
  const d = img.data;
  const warm = hexRgb(COLORS.head, RGB_A);
  const cool = hexRgb(COLORS.neon, RGB_B);
  for (let y = 0; y < w; y++) {
    // v = 0 у «хвоста», v = 1 у «головы» (текстура читается снизу вверх).
    const v = 1 - (y + 0.5) / w;
    const along = lerp(Math.pow(Math.sin(Math.PI * v), 1.15), Math.pow(v, 3.1), head);
    const headHot = head * Math.exp(-Math.pow(1 - v, 2) * 210);
    const thick = lerp(0.5 + 0.5 * Math.sin(Math.PI * v), 0.22 + 0.78 * v, head);
    for (let x = 0; x < w; x++) {
      const u = ((x + 0.5) / w - 0.5) * 2;
      const q = u / Math.max(0.04, thick * 0.85);
      // Узкое горячее ядро плюс мягкий ореол: после растяжения в 30 раз штрих
      // читается чёткой линией, а не пятном, и красиво отдаёт в bloom.
      const across = 0.55 * Math.exp(-q * q * 3.2) + 0.6 * Math.exp(-q * q * 14);
      const a = clamp01(along * across + headHot * Math.exp(-q * q * 1.6));
      const t = clamp01(1 - along * 1.3);
      const i = (y * w + x) * 4;
      d[i] = Math.round(lerp(warm[0], cool[0], t));
      d[i + 1] = Math.round(lerp(warm[1], cool[1], t));
      d[i + 2] = Math.round(lerp(warm[2], cool[2], t));
      d[i + 3] = Math.round(a * 255);
    }
  }
  return toTexture(ctx, img);
}

/**
 * Звезда-блик: раскалённое ядро, длинный горизонтальный и короткий вертикальный
 * лучи, слабые диагонали и ореол. Ровно тот крест, что в f_001 и f_007.
 */
function makeFlareTex(): THREE.CanvasTexture | null {
  const size = 256;
  const ctx = ctx2d(size);
  if (!ctx) return null;
  const w = ctx.canvas.width;
  const img = ctx.createImageData(w, w);
  const d = img.data;
  const c = (w - 1) / 2;
  const hot = hexRgb(COLORS.star, RGB_A);
  const cool = hexRgb(COLORS.neon, RGB_B);
  for (let y = 0; y < w; y++) {
    const ny = (y - c) / c;
    for (let x = 0; x < w; x++) {
      const nx = (x - c) / c;
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const r2 = nx * nx + ny * ny;

      const core = Math.exp(-r2 * 1500) + Math.exp(-r2 * 260) * 0.55 + Math.exp(-r2 * 60) * 0.22;
      const halo = Math.exp(-r2 * 16) * 0.16 + Math.exp(-r2 * 2.6) * 0.05;

      // Горизонтальный луч длиннее вертикального — так «читается» анаморфный блик.
      const wH = 0.008 + 0.036 * Math.exp(-ax * 8);
      const sH = Math.exp(-(ny * ny) / (wH * wH)) * Math.pow(Math.max(0, 1 - ax), 1.5);

      const wV = 0.007 + 0.028 * Math.exp(-ay * 10);
      const sV = Math.exp(-(nx * nx) / (wV * wV)) * Math.pow(Math.max(0, 1 - ay / 0.66), 2.2) * 0.8;

      const p = (nx + ny) * 0.7071;
      const q = (nx - ny) * 0.7071;
      const wD = 0.006 + 0.018 * Math.exp(-Math.abs(p) * 14);
      const wE = 0.006 + 0.018 * Math.exp(-Math.abs(q) * 14);
      const sD =
        Math.exp(-(q * q) / (wD * wD)) * Math.pow(Math.max(0, 1 - Math.abs(p) / 0.44), 2.6) * 0.3 +
        Math.exp(-(p * p) / (wE * wE)) * Math.pow(Math.max(0, 1 - Math.abs(q) / 0.44), 2.6) * 0.3;

      const a = clamp01(core + halo + sH + sV + sD);
      const t = clamp01(1 - (core + 0.55 * (sH + sV)) * 1.4);
      const i = (y * w + x) * 4;
      d[i] = Math.round(lerp(hot[0], cool[0], t));
      d[i + 1] = Math.round(lerp(hot[1], cool[1], t));
      d[i + 2] = Math.round(lerp(hot[2], cool[2], t));
      d[i + 3] = Math.round(a * 255);
    }
  }
  return toTexture(ctx, img);
}

/**
 * Туманность: полярная закрутка + ридж-фрактал = вихрь с нитями и рукавами.
 * Самый заметный элемент рила, поэтому считается попиксельно, а не градиентами.
 */
function makeNebulaTex(size: number): THREE.CanvasTexture | null {
  const ctx = ctx2d(size);
  if (!ctx) return null;
  const w = ctx.canvas.width;
  const img = ctx.createImageData(w, w);
  const d = img.data;
  const core = hexRgb(COLORS.nebulaCore, RGB_A);
  const mid = hexRgb(COLORS.nebulaMid, RGB_B);
  const edge = hexRgb(COLORS.nebulaEdge, RGB_C);
  const inv = 2 / w;
  for (let y = 0; y < w; y++) {
    const ny = (y + 0.5) * inv - 1;
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) * inv - 1;
      const i = (y * w + x) * 4;
      const r = Math.sqrt(nx * nx + ny * ny);
      if (r >= 1) {
        d[i + 3] = 0;
        continue;
      }
      // Чем ближе к центру, тем сильнее проворот — получается вихрь, а не пятно.
      const tw = Math.atan2(ny, nx) + 2.3 / (r + 0.32) + 1.2 * r;
      const wx = Math.cos(tw) * r;
      const wy = Math.sin(tw) * r;
      const f = fbm2(wx * 4.6 + 7.3, wy * 4.6 - 2.1, 5);
      // Ридж-фрактал в пятой степени даёт тонкие нити вместо ватного пятна.
      const ridge = 1 - Math.abs(f * 2 - 1);
      const rr = ridge * ridge;
      const fil = rr * rr * ridge;
      const arms = 0.5 + 0.5 * Math.sin(tw * 2 + r * 4.2);
      // Крупный шум прогрызает в туманности тёмные провалы — как в f_003.
      const voids = 0.3 + 0.7 * fbm2(wx * 1.5 - 3.1, wy * 1.5 + 5.7, 3);
      const halo = Math.exp(-r * r * 3.2);
      const rim = smoothstep(1, 0.4, r);
      const dens = rim * voids * (0.17 * halo + 0.1 * f + 1.5 * fil * (0.22 + 0.78 * arms));
      const I = clamp01(dens * 1.35);
      const t1 = smoothstep(0.02, 0.34, I);
      const t2 = smoothstep(0.42, 1, I);
      d[i] = Math.round(lerp(lerp(edge[0], mid[0], t1), core[0], t2));
      d[i + 1] = Math.round(lerp(lerp(edge[1], mid[1], t1), core[1], t2));
      d[i + 2] = Math.round(lerp(lerp(edge[2], mid[2], t1), core[2], t2));
      d[i + 3] = Math.round(clamp01(Math.pow(I, 1.15) * 1.25) * 255);
    }
  }
  return toTexture(ctx, img);
}

/* ---------- шейдеры ---------- */

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGlowColor;
uniform float uGlow;
uniform float uBand;
varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // Ночь темнее всего в зените и светлеет к горизонту — как в рефересах.
  // Светлая приземная полоса узкая — её почти целиком закрывают склоны.
  vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.16, h));
  col = mix(col, uZenith, smoothstep(0.16, 0.95, h));

  // Зарево над дорогой: сильнее прямо по курсу (−Z). Узкое: оно должно лежать
  // у самой кромки склонов, а не заливать полнеба.
  float fwd = max(-dir.z, 0.0);
  col += uGlowColor * (exp(-abs(h) * 15.0) * (0.10 + 0.90 * fwd * fwd) * uGlow);

  // Еле заметная широкая полоса «млечного пути» по наклонному большому кругу.
  float b = dot(dir, vec3(0.62, 0.40, 0.67));
  col += uHorizon * (exp(-b * b * 9.0) * uBand);

  // Ниже горизонта купол гаснет: там склоны и дорога, лишнее свечение мешает.
  col *= mix(0.22, 1.0, smoothstep(-0.22, 0.02, h));

  // Дизеринг убивает полосы на восьмибитном градиенте.
  float dith = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += dith * 0.004;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const STAR_VERT = /* glsl */ `
attribute vec3 aColor;
// x — размер в пикселях, y — фаза, z — частота, w — амплитуда мерцания
attribute vec4 aData;
uniform float uTime;
uniform float uDpr;
uniform float uTwinkle;
uniform float uOpacity;
varying vec3 vCol;
varying float vA;

void main() {
  float k = 1.0 + aData.w * uTwinkle * sin(uTime * aData.z + aData.y);
  vCol = aColor;
  vA = uOpacity * clamp(0.30 + 0.70 * k, 0.0, 1.8);
  // Не меньше 3 CSS-пикселей: иначе спрайт попадает мимо ярких текселей.
  gl_PointSize = uDpr * max(3.0, aData.x * (0.78 + 0.22 * k));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const STAR_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec3 vCol;
varying float vA;

void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol, a);
  #include <colorspace_fragment>
}
`;

/* ---------- сборка сцены неба ---------- */

interface SkyRes {
  root: THREE.Group;
  domeMat: THREE.ShaderMaterial;
  stars: THREE.Points | null;
  starMat: THREE.ShaderMaterial | null;
  nebula: THREE.Group;
  nebulaMats: THREE.MeshBasicMaterial[];
  nebulaMeshes: THREE.Mesh[];
  nebulaBase: Float32Array;
  nebulaSpin: Float32Array;
  nebulaSize: Float32Array;
  trailSpin: THREE.Group;
  trails: THREE.InstancedMesh | null;
  trailMat: THREE.MeshBasicMaterial | null;
  meteors: THREE.InstancedMesh | null;
  meteorMat: THREE.MeshBasicMaterial | null;
  meteorPhase: Float32Array;
  meteorCycle: Int32Array;
  /** Линейные rgb двух оттенков метеора: тёплый и неоновый. */
  meteorTint: Float32Array;
  flare: THREE.Group;
  flareMat: THREE.SpriteMaterial | null;
  haloMat: THREE.SpriteMaterial | null;
  flareSprite: THREE.Sprite | null;
  haloSprite: THREE.Sprite | null;
  dispose: () => void;
}

function buildSky(q: Quality): SkyRes {
  const preset = QUALITY[q];
  const textures: THREE.Texture[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const root = new THREE.Group();
  root.name = "sky";
  root.frustumCulled = false;
  // renderOrder на Group задаёт groupOrder всем потомкам: небо уходит в самое
  // начало обеих очередей отрисовки, и любая геометрия сцены ложится поверх.
  // Поэтому его обязаны нести все группы неба, иначе вложенная сбросит порядок.
  root.renderOrder = GROUP_ORDER;

  /* --- 1. купол --- */

  const domeGeo = new THREE.SphereGeometry(R, 36, 22);
  geometries.push(domeGeo);
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(COLORS.night0) },
      uMid: { value: new THREE.Color(COLORS.night1) },
      uHorizon: { value: new THREE.Color(COLORS.night2) },
      uGlowColor: { value: new THREE.Color(COLORS.neonDeep) },
      uGlow: { value: 0.5 },
      uBand: { value: 0.09 },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  materials.push(domeMat);
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = GROUP_ORDER;
  root.add(dome);

  /* --- 2. звёздное поле --- */

  const starTex = makeStarTex();
  if (starTex) textures.push(starTex);
  let stars: THREE.Points | null = null;
  let starMat: THREE.ShaderMaterial | null = null;
  if (starTex) {
    const n = Math.max(1, preset.stars);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const data = new Float32Array(n * 4);
    const cStar = new THREE.Color(COLORS.star);
    const cWarm = new THREE.Color(COLORS.starWarm);
    const cCold = new THREE.Color(COLORS.neon);
    const tmp = new THREE.Color();
    for (let i = 0; i < n; i++) {
      // Равномерно по высоте = равномерно по площади сферы.
      const y = lerp(STAR_Y_MIN, 1, hash2(i, 0));
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const a = hash2(i, 1) * TAU;
      pos[i * 3] = Math.cos(a) * rr * R_STARS;
      pos[i * 3 + 1] = y * R_STARS;
      pos[i * 3 + 2] = Math.sin(a) * rr * R_STARS;

      const m = hash2(i, 2);
      const big = m > 0.987 ? 4 : 0;
      data[i * 4] = 1.8 + 3.2 * m * m * m + big;
      data[i * 4 + 1] = hash2(i, 3) * TAU;
      data[i * 4 + 2] = range(hash2(i, 4), 0.5, 2.4);
      data[i * 4 + 3] = range(hash2(i, 5), 0.12, 0.42);

      const tint = hash2(i, 6);
      tmp.copy(cStar);
      if (tint > 0.74) tmp.lerp(cWarm, (tint - 0.74) / 0.26);
      else if (tint < 0.13) tmp.lerp(cCold, 0.45);
      // Низкие звёзды приглушены — так небо не «сыпется» на склоны.
      const dim = lerp(0.42, 1, smoothstep(STAR_Y_MIN, 0.5, y)) * (0.4 + 0.6 * m);
      col[i * 3] = tmp.r * dim;
      col[i * 3 + 1] = tmp.g * dim;
      col[i * 3 + 2] = tmp.b * dim;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aData", new THREE.BufferAttribute(data, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R_STARS * 1.02);
    geometries.push(geo);

    starMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: starTex },
        uTime: { value: 0 },
        uDpr: { value: 1 },
        uTwinkle: { value: 1 },
        uOpacity: { value: 1 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    materials.push(starMat);
    stars = new THREE.Points(geo, starMat);
    stars.frustumCulled = false;
    stars.renderOrder = -900;
    root.add(stars);
  }

  /* --- 3. воронка звёздных треков --- */

  const trailTex = makeStreakTex(0);
  if (trailTex) textures.push(trailTex);
  const trailTilt = new THREE.Group();
  trailTilt.quaternion.setFromUnitVectors(UP, VORTEX_AXIS);
  trailTilt.renderOrder = GROUP_ORDER;
  const trailSpin = new THREE.Group();
  trailSpin.renderOrder = GROUP_ORDER;
  trailTilt.add(trailSpin);
  root.add(trailTilt);

  let trails: THREE.InstancedMesh | null = null;
  let trailMat: THREE.MeshBasicMaterial | null = null;
  if (trailTex) {
    const n = Math.max(24, Math.round(preset.stars * 0.15));
    const geo = new THREE.PlaneGeometry(1, 1);
    geometries.push(geo);
    trailMat = new THREE.MeshBasicMaterial({
      map: trailTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    materials.push(trailMat);
    trails = new THREE.InstancedMesh(geo, trailMat, n);
    trails.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    trails.frustumCulled = false;
    trails.renderOrder = -880;
    trails.visible = false;
    const cA = new THREE.Color(COLORS.star);
    const cB = new THREE.Color(COLORS.neon);
    const tmp = new THREE.Color();
    for (let i = 0; i < n; i++) {
      // Ближе к оси треки короче — ровно как на длинной выдержке.
      const rho = 0.02 + Math.pow(hash2(i, 1), 0.62) * VORTEX_SPREAD;
      const phi = hash2(i, 2) * TAU;
      const sr = Math.sin(rho);
      V0.set(sr * Math.cos(phi), Math.cos(rho), sr * Math.sin(phi)).multiplyScalar(R_TRAIL);
      // Касательная к параллели: ось(+Y) × p.
      V1.set(-V0.z, 0, V0.x).normalize();
      const len = R_TRAIL * (0.03 + 0.19 * sr) * range(hash2(i, 3), 0.6, 1.45);
      const wid = R_TRAIL * 0.0042 * range(hash2(i, 4), 0.7, 1.7);
      trails.setMatrixAt(i, faceMatrix(V0, V1, wid, len));
      const b =
        Math.pow(range(hash2(i, 5), 0.22, 1), 1.5) *
        smoothstep(VORTEX_SPREAD * 1.05, VORTEX_SPREAD * 0.6, rho);
      tmp.copy(cA).lerp(cB, hash2(i, 6) * 0.8);
      tmp.multiplyScalar(b);
      trails.setColorAt(i, tmp);
    }
    trails.instanceMatrix.needsUpdate = true;
    if (trails.instanceColor) trails.instanceColor.needsUpdate = true;
    trailSpin.add(trails);
  }

  /* --- 4. туманность --- */

  const nebTex = makeNebulaTex(q === 2 ? 384 : q === 1 ? 320 : 256);
  if (nebTex) textures.push(nebTex);
  const nebula = new THREE.Group();
  nebula.position.copy(NEBULA_DIR).multiplyScalar(R_NEBULA);
  M0.lookAt(nebula.position, ORIGIN, UP);
  nebula.quaternion.setFromRotationMatrix(M0);
  nebula.renderOrder = GROUP_ORDER;
  nebula.visible = false;
  root.add(nebula);

  const nebulaMats: THREE.MeshBasicMaterial[] = [];
  const nebulaMeshes: THREE.Mesh[] = [];
  const nebulaBase = new Float32Array(3);
  const nebulaSpin = new Float32Array(3);
  const nebulaSize = new Float32Array(3);
  if (nebTex) {
    const base = R_NEBULA * 0.62;
    // подложка, основное тело, яркое ядро
    const size = [base * 1.62, base, base * 0.6];
    const opa = [0.34, 1, 0.6];
    const spin = [0.009, -0.015, 0.024];
    const tint = [COLORS.nebulaMid, 0xffffff, COLORS.nebulaCore] as const;
    const offs = [
      [0, 0, -R_NEBULA * 0.05],
      [0, 0, 0],
      [base * 0.12, base * 0.08, R_NEBULA * 0.04],
    ] as const;
    const geo = new THREE.PlaneGeometry(1, 1);
    geometries.push(geo);
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: nebTex,
        color: tint[i],
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        fog: false,
        side: THREE.DoubleSide,
      });
      materials.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(offs[i][0], offs[i][1], offs[i][2]);
      mesh.rotation.z = i * 1.7;
      mesh.scale.set(size[i], size[i], 1);
      mesh.frustumCulled = false;
      mesh.renderOrder = -890 + i;
      nebula.add(mesh);
      nebulaMats.push(mat);
      nebulaMeshes.push(mesh);
      nebulaBase[i] = opa[i];
      nebulaSpin[i] = spin[i];
      nebulaSize[i] = size[i];
    }
  }

  /* --- 5. метеоры --- */

  const meteorTex = makeStreakTex(1);
  if (meteorTex) textures.push(meteorTex);
  let meteors: THREE.InstancedMesh | null = null;
  let meteorMat: THREE.MeshBasicMaterial | null = null;
  const nMet = Math.max(1, preset.meteors);
  const meteorPhase = new Float32Array(nMet);
  const meteorCycle = new Int32Array(nMet);
  const meteorTint = new Float32Array(6);
  if (meteorTex) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geometries.push(geo);
    meteorMat = new THREE.MeshBasicMaterial({
      map: meteorTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    materials.push(meteorMat);
    meteors = new THREE.InstancedMesh(geo, meteorMat, nMet);
    meteors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    meteors.frustumCulled = false;
    meteors.renderOrder = -870;
    meteors.visible = false;
    const white = new THREE.Color(0, 0, 0);
    for (let i = 0; i < nMet; i++) {
      meteorPhase[i] = hash2(i, 11);
      meteors.setColorAt(i, white);
    }
    const cWarm = new THREE.Color(COLORS.head);
    const cCold = new THREE.Color(COLORS.neon);
    meteorTint[0] = cWarm.r;
    meteorTint[1] = cWarm.g;
    meteorTint[2] = cWarm.b;
    meteorTint[3] = cCold.r;
    meteorTint[4] = cCold.g;
    meteorTint[5] = cCold.b;
    root.add(meteors);
  }

  /* --- 6. звезда-блик --- */

  const flareTex = makeFlareTex();
  if (flareTex) textures.push(flareTex);
  const glowTex = makeGlowTex();
  if (glowTex) textures.push(glowTex);
  const flare = new THREE.Group();
  flare.position.copy(FLARE_DIR).multiplyScalar(R_FLARE);
  flare.renderOrder = GROUP_ORDER;
  flare.visible = false;
  root.add(flare);

  let flareMat: THREE.SpriteMaterial | null = null;
  let haloMat: THREE.SpriteMaterial | null = null;
  let flareSprite: THREE.Sprite | null = null;
  let haloSprite: THREE.Sprite | null = null;
  if (glowTex) {
    haloMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: new THREE.Color(COLORS.neon),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    materials.push(haloMat);
    haloSprite = new THREE.Sprite(haloMat);
    haloSprite.scale.set(R * 0.2, R * 0.2, 1);
    haloSprite.frustumCulled = false;
    haloSprite.renderOrder = -862;
    flare.add(haloSprite);
  }
  if (flareTex) {
    flareMat = new THREE.SpriteMaterial({
      map: flareTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
      rotation: 0.1,
    });
    materials.push(flareMat);
    flareSprite = new THREE.Sprite(flareMat);
    flareSprite.scale.set(R * 0.34, R * 0.34, 1);
    flareSprite.frustumCulled = false;
    flareSprite.renderOrder = -860;
    flare.add(flareSprite);
  }

  const dispose = () => {
    for (let i = 0; i < textures.length; i++) textures[i].dispose();
    for (let i = 0; i < geometries.length; i++) geometries[i].dispose();
    for (let i = 0; i < materials.length; i++) materials[i].dispose();
    trails?.dispose();
    meteors?.dispose();
    textures.length = 0;
    geometries.length = 0;
    materials.length = 0;
    root.clear();
  };

  return {
    root,
    domeMat,
    stars,
    starMat,
    nebula,
    nebulaMats,
    nebulaMeshes,
    nebulaBase,
    nebulaSpin,
    nebulaSize,
    trailSpin,
    trails,
    trailMat,
    meteors,
    meteorMat,
    meteorPhase,
    meteorCycle,
    meteorTint,
    flare,
    flareMat,
    haloMat,
    flareSprite,
    haloSprite,
    dispose,
  };
}

/* ---------- состояние анимации ---------- */

interface SkyAnim {
  t: number;
  wStars: number;
  wNebula: number;
  wTrail: number;
  wMeteor: number;
  wFlare: number;
  spin: number;
  glow: number;
}

/* ---------- компонент ---------- */

export function Sky({ g }: { g: Game }) {
  const quality = g.quality;

  // Ресурсы живут в ref, а не в useMemo: StrictMode дважды вызывает рендер, и
  // фабрика useMemo успела бы построить две туманности, из которых одна утекла бы.
  const holder = useRef<{ q: Quality; res: SkyRes } | null>(null);
  if (holder.current === null) {
    holder.current = { q: quality, res: buildSky(quality) };
  } else if (holder.current.q !== quality) {
    holder.current.res.dispose();
    holder.current = { q: quality, res: buildSky(quality) };
  }
  const res = holder.current.res;

  const animRef = useRef<SkyAnim | null>(null);
  if (animRef.current === null) {
    animRef.current = {
      t: 0,
      wStars: 1,
      wNebula: 0,
      wTrail: 0,
      wMeteor: 1,
      wFlare: 1,
      spin: 0,
      glow: 0.5,
    };
  }

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
    const t = anim.t;
    const calm = g.reducedMotion;

    /* --- веса слоёв по главе --- */
    const n = W_STARS.length;
    const ch = ((g.chapter % n) + n) % n;
    const nx = (ch + 1) % n;
    const f = SKY.fade > 0 ? smoothstep(1 - SKY.fade, 1, clamp01(g.chapterT)) : 0;

    anim.wStars = damp(anim.wStars, lerp(W_STARS[ch], W_STARS[nx], f), FADE_RATE, dt);
    anim.wNebula = damp(anim.wNebula, lerp(W_NEBULA[ch], W_NEBULA[nx], f), FADE_RATE, dt);
    anim.wTrail = damp(anim.wTrail, lerp(W_TRAIL[ch], W_TRAIL[nx], f), FADE_RATE, dt);
    anim.wMeteor = damp(anim.wMeteor, lerp(W_METEOR[ch], W_METEOR[nx], f), FADE_RATE, dt);
    anim.wFlare = damp(anim.wFlare, lerp(W_FLARE[ch], W_FLARE[nx], f), FADE_RATE, dt);

    /* --- общий дрейф неба --- */
    const spinTo = -g.s * SPIN_PER_M - g.yaw * YAW_PARALLAX;
    anim.spin = damp(anim.spin, spinTo, 5, dt);
    res.root.rotation.y = anim.spin;

    /* --- 1. купол --- */
    const speedFrac = clamp01(g.speed / PHYS.speedMax);
    anim.glow = damp(anim.glow, 0.05 + 0.06 * speedFrac + 0.03 * anim.wNebula, 1.4, dt);
    res.domeMat.uniforms.uGlow.value = anim.glow;
    res.domeMat.uniforms.uBand.value = 0.05 + 0.07 * anim.wStars;

    /* --- 2. звёзды --- */
    if (res.stars && res.starMat) {
      const on = anim.wStars > 0.008;
      res.stars.visible = on;
      if (on) {
        const u = res.starMat.uniforms;
        // Время в шейдер уходит по кругу: float32 на многочасовом заезде уже не
        // держит долю секунды, и мерцание начало бы дрожать ступеньками.
        u.uTime.value = t % 1000;
        u.uOpacity.value = anim.wStars;
        u.uDpr.value = state.gl.getPixelRatio();
        u.uTwinkle.value = calm ? 0.28 : 1;
      }
    }

    /* --- 3. воронка треков --- */
    if (res.trails && res.trailMat) {
      const on = anim.wTrail > 0.008;
      res.trails.visible = on;
      if (on) {
        res.trailMat.opacity = anim.wTrail;
        res.trailSpin.rotation.y += VORTEX_RATE * (calm ? 0.45 : 1) * dt;
      }
    }

    /* --- 4. туманность --- */
    if (res.nebulaMats.length) {
      const on = anim.wNebula > 0.006;
      res.nebula.visible = on;
      if (on) {
        const breathe = calm ? 1 : 1 + 0.022 * Math.sin(t * 0.13);
        for (let i = 0; i < res.nebulaMats.length; i++) {
          res.nebulaMats[i].opacity = anim.wNebula * res.nebulaBase[i];
          const mesh = res.nebulaMeshes[i];
          mesh.rotation.z += res.nebulaSpin[i] * (calm ? 0.4 : 1) * dt;
          const s = res.nebulaSize[i] * breathe;
          mesh.scale.set(s, s, 1);
        }
      }
    }

    /* --- 5. метеоры --- */
    if (res.meteors && res.meteorMat) {
      const on = anim.wMeteor > 0.01;
      res.meteors.visible = on;
      if (on) {
        res.meteorMat.opacity = anim.wMeteor;
        const su = Math.sin(METEOR_SLANT) * METEOR_TRAVEL;
        const sv = -Math.cos(METEOR_SLANT) * METEOR_TRAVEL;
        const phase = res.meteorPhase;
        const cycle = res.meteorCycle;
        const tint = res.meteorTint;
        const colors = res.meteors.instanceColor;
        for (let i = 0; i < phase.length; i++) {
          let p = phase[i] + range(hash2(i * 131 + cycle[i] * 7919, 7), 0.3, 0.62) * (calm ? 0.55 : 1) * dt;
          if (p >= 1) {
            p -= 1;
            cycle[i] = cycle[i] + 1;
          }
          phase[i] = p;

          const k = i * 131 + cycle[i] * 7919;
          const u0 = range(hash2(k, 2), -1.9, 1.9);
          const v0 = range(hash2(k, 3), 0.5, 2.8);
          const bright = range(hash2(k, 4), 0.35, 1);
          const len = R_METEOR * range(hash2(k, 5), 0.12, 0.38) * (0.6 + 0.4 * bright);

          const u = u0 + su * p;
          const v = v0 + sv * p;
          V0.set(u, v, -1).normalize().multiplyScalar(R_METEOR);
          V1.set(u + su * 0.02, v + sv * 0.02, -1)
            .normalize()
            .multiplyScalar(R_METEOR)
            .sub(V0)
            .normalize();
          // Голова должна лететь впереди, поэтому центр сдвинут назад на пол-длины.
          V0.addScaledVector(V1, -len * 0.5);
          res.meteors.setMatrixAt(i, faceMatrix(V0, V1, R_METEOR * 0.006, len));

          if (colors) {
            const a =
              bright *
              smoothstep(0, 0.1, p) *
              smoothstep(1, 0.76, p) *
              (calm ? 0.7 : 1);
            const mix = hash2(k, 6);
            colors.array[i * 3] = lerp(tint[0], tint[3], mix) * a;
            colors.array[i * 3 + 1] = lerp(tint[1], tint[4], mix) * a;
            colors.array[i * 3 + 2] = lerp(tint[2], tint[5], mix) * a;
          }
        }
        res.meteors.instanceMatrix.needsUpdate = true;
        if (colors) colors.needsUpdate = true;
      }
    }

    /* --- 6. блик --- */
    const flareOn = anim.wFlare > 0.008;
    res.flare.visible = flareOn;
    if (flareOn) {
      const pulse = calm ? 1 : 1 + 0.055 * Math.sin(t * 0.85) + 0.03 * Math.sin(t * 1.97 + 1.1);
      if (res.flareMat && res.flareSprite) {
        res.flareMat.opacity = anim.wFlare * (calm ? 0.9 : 0.82 + 0.18 * pulse);
        res.flareMat.rotation = 0.1 + (calm ? 0 : 0.03 * Math.sin(t * 0.21));
        const s = R * 0.34 * pulse;
        res.flareSprite.scale.set(s, s, 1);
      }
      if (res.haloMat && res.haloSprite) {
        res.haloMat.opacity = anim.wFlare * 0.5 * (calm ? 1 : 0.85 + 0.15 * pulse);
        const s = R * 0.2 * (calm ? 1 : 2 - pulse);
        res.haloSprite.scale.set(s, s, 1);
      }
    }
  });

  return <primitive object={res.root} dispose={null} />;
}
