/**
 * Трафик: кузова, фары, стопы и — главное — световые полосы.
 *
 * В референсе (кадры f_001, f_007) встречная машина почти не машина: пара
 * жёстких белых точек и длинный неоново-синий след, уходящий к точке схода.
 * Именно след держит весь образ, поэтому он здесь не украшение, а основной
 * слой; кузов нужен только чтобы силуэт не пропадал вблизи.
 *
 * Слои (по одному InstancedMesh на роль, матрицы переписываются каждый кадр):
 *   1. кузова      — слитая геометрия «шасси + будка», очень тёмная, с синим
 *                    кантом по крыше (отсвет неба), чтобы читался силуэт;
 *   2. стопы       — два маленьких аддитивных квада + широкий тусклый ореол;
 *   3. фары        — два жёстких квада с пересветом (их и подхватывает bloom)
 *                    + большой тёплый ореол;
 *   4. полосы      — ленты по две на машину (по одной на фонарь), лежащие в
 *                    25 см над асфальтом.
 *
 * Про ленты — три решения, которые стоит объяснить:
 *
 *   • лента разбита на несколько инстансов вдоль своей длины. Один квад на
 *     сотню метров был бы прямым, а дорога на этой длине уводит вбок до 25 м и
 *     по высоте до 4 м — след ушёл бы с полотна в воздух. Геометрия при этом
 *     всё равно одна и строится один раз: каждый сегмент — тот же квад,
 *     растянутый матрицей инстанса между двумя точками дороги.
 *
 *   • затухание и сужение по длине — геометрические прогрессии. Сегмент k
 *     получает множитель q^k, а сам квад внутри себя гаснет ровно в q раз, так
 *     что стык сегментов непрерывен и полоса не полосатая.
 *
 *   • поперёк лента не плоская, а слегка выгнута (пять колонок вершин с
 *     профилем яркости): сверху это отражение на асфальте, сбоку — низкий
 *     валик света. Плоский квад с одной высоты водителя читался бы как линия,
 *     нарисованная на дороге.
 *
 * Модуль ничего не мутирует в `g` и не считает столкновения — это дело
 * `engine.ts`. Аллокаций в кадре нет: матрицы, векторы и цвета подняты в
 * модульный скретч, пулы фиксированы под пресет качества, лишние слоты
 * прячутся нулевым масштабом.
 */

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { Game, Quality } from "../types";
import { BOX, COLORS, LIMITS, PHYS, QUALITY } from "../config";
import { localX, localY, localZ, roadHeading, roadPitch } from "../road";
import { clamp, clamp01, damp, smoothstep } from "../num";

/* ---------- габариты и раскладка ---------- */

/** Высота кузова по `CarKind`: седан, фургон, фура. */
const CAR_H: readonly number[] = [1.42, 2.5, 3.9];
/** Высота фонарей над полотном по `CarKind`. */
const LAMP_Y: readonly number[] = [0.58, 0.74, 1.04];
/** Разнос фонарей — доля полуширины кузова. */
const LAMP_X = 0.74;

/** Дальность отрисовки машин по пресетам качества, м. */
const CAR_FAR: readonly number[] = [420, 720, 940];
/** Сколько метров позади камеры машина ещё нужна (её след уходит вперёд). */
const CAR_BEHIND = 70;
/** Дальше этого кузов уже не читается — остаются одни огни. */
const BODY_FAR = 240;
/** Позади этого кузов заведомо вне кадра. */
const BODY_BEHIND = 14;

/** Базовые размеры квадов света, м. */
const HEAD_CORE = 0.3;
const HEAD_HALO = 2.15;
const TAIL_CORE = 0.24;
const TAIL_HALO = 1.5;

/**
 * Яркости (уходят в instanceColor, поэтому свободно больше единицы). Ядро фары
 * специально уводится в пересвет: именно из клиппинга bloom делает лучи.
 */
const HEAD_CORE_GAIN = 3.4;
const HEAD_HALO_GAIN = 1.5;
const TAIL_CORE_GAIN = 2;
const TAIL_HALO_GAIN = 0.85;

/** Раздувание огня с дистанцией, чтобы дальний не проваливался в полпикселя. */
const LIGHT_GROW = 230;
const LIGHT_GROW_MAX = 3.4;

/** Амплитуда визуального покачивания машины поперёк полосы, м. */
const SWAY = 0.06;

/* ---------- ленты ---------- */

/** Высота ленты над полотном, м. */
const TRAIL_Y = 0.25;
/** Высота «валика» в середине сечения ленты, м. */
const TRAIL_ARCH = 0.19;
/** Сегментов на ленту по пресетам качества (нулевой не используется). */
const TRAIL_SEGS: readonly number[] = [4, 4, 6];
/** Ширина ленты у машины, м. */
const TRAIL_W = 0.62;
const TRAIL_W_RED = 0.5;
/** Длина следа = относительная скорость × это время, с. */
const TRAIL_TIME = 1.15;
const TRAIL_TIME_RED = 0.95;
/** Зажимы длины, м. */
const TRAIL_MIN = 26;
const TRAIL_MAX = 210;
const TRAIL_MIN_RED = 10;
const TRAIL_MAX_RED = 95;
/** Во сколько раз лента гаснет и сужается на всей своей длине. */
const TRAIL_END = 0.035;
const TRAIL_TIP = 0.34;
/** Яркости лент. */
const TRAIL_GAIN = 2.1;
const TRAIL_GAIN_RED = 1.25;
/** Относительная скорость, на которой лента набирает полную яркость, м/с. */
const TRAIL_REF = 110;

/** Профиль сечения ленты: положения колонок, яркость и высота валика. */
const PROF_X: readonly number[] = [-0.5, -0.25, 0, 0.25, 0.5];
const PROF_W: readonly number[] = [0, 0.42, 1, 0.42, 0];
const PROF_Y: readonly number[] = [0, 0.55, 1, 0.55, 0];

/** Куда прячутся незанятые слоты пулов. */
const HIDE_Y = -1e4;

/* ---------- скретч кадра ---------- */

const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** Единичный поворот: квады света смотрят в +Z. */
const _qi = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _col = new THREE.Color();
const _mk = new THREE.Color();

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _norm = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Линейные цвета лент, посчитанные один раз. */
const _neon = new THREE.Color(COLORS.neon);
const _red = new THREE.Color(COLORS.tail);

const _hide = new THREE.Matrix4();
_hide.makeScale(0, 0, 0);
_hide.setPosition(0, HIDE_Y, 0);

/* ---------- текстуры огней ---------- */

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

/**
 * Белый радиальный профиль в альфе: узкое ядро плюс широкая юбка. Цвет даёт
 * материал и instanceColor, поэтому одна и та же текстура работает и на стопах,
 * и на фарах. Срез у края квада обязателен — на аддитивном блендинге шов виден.
 */
function radialTex(
  size: number,
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
  for (let y = 0; y < w; y++) {
    const dy = (y - c) / c;
    for (let x = 0; x < w; x++) {
      const dx = (x - c) / c;
      const r2 = dx * dx + dy * dy;
      const a = clamp01(
        (Math.exp(-r2 * tight) + wideK * Math.exp(-r2 * wide)) *
          smoothstep(1, 0.45, Math.sqrt(r2)),
      );
      const i = (y * w + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
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

/* ---------- геометрия ---------- */

/**
 * Слить несколько коробок в одну BufferGeometry: позиции подряд, индексы со
 * сдвигом. Нормали и UV не нужны — материал basic, света в сцене нет.
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
 * Кузов в единичном габарите: x и z в [−0.5, 0.5], y в [0, 1], основание на
 * полотне. Масштаб инстанса берётся из `BOX.cars[kind]`, поэтому фура и правда
 * вдесятеро длиннее, чем высока.
 *
 * Вершинный цвет — почти чёрная ночь внизу и слабый синий кант по крыше: ночью
 * машину выдаёт не краска, а то, чем небо подсвечивает горизонтальные грани.
 */
function buildBodyGeom(): THREE.BufferGeometry {
  const low = new THREE.BoxGeometry(1, 0.54, 1);
  low.translate(0, 0.27, 0);
  const top = new THREE.BoxGeometry(0.86, 0.52, 0.66);
  top.translate(0, 0.74, 0.02);

  const geo = mergeParts([low, top]);
  low.dispose();
  top.dispose();

  const a = geo.getAttribute("position") as THREE.BufferAttribute;
  const cols = new Float32Array(a.count * 3);
  const dark = new THREE.Color(COLORS.night0);
  const rim = new THREE.Color(COLORS.neonDeep);
  for (let i = 0; i < a.count; i++) {
    const t = smoothstep(0.45, 1, a.getY(i));
    _mk.copy(dark).multiplyScalar(0.8).lerp(rim, t * 0.34);
    cols[i * 3] = _mk.r;
    cols[i * 3 + 1] = _mk.g;
    cols[i * 3 + 2] = _mk.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return geo;
}

/**
 * Сегмент ленты: пять колонок вершин от z = 0 (у машины) до z = −1 (вдаль).
 * Дальний ряд заранее сужен в `tp` раз и притушен в `fd` раз — ровно на столько
 * же, во сколько инстансный множитель падает от сегмента к сегменту, поэтому
 * соседние сегменты стыкуются без ступеньки.
 */
function buildTrailGeom(segs: number): THREE.BufferGeometry {
  const tp = Math.pow(TRAIL_TIP, 1 / segs);
  const fd = Math.pow(TRAIL_END, 1 / segs);
  const cols = PROF_X.length;
  const pos = new Float32Array(cols * 2 * 3);
  const col = new Float32Array(cols * 2 * 3);
  for (let i = 0; i < cols; i++) {
    pos[i * 3] = PROF_X[i];
    pos[i * 3 + 1] = PROF_Y[i] * TRAIL_ARCH;
    pos[i * 3 + 2] = 0;
    col[i * 3] = PROF_W[i];
    col[i * 3 + 1] = PROF_W[i];
    col[i * 3 + 2] = PROF_W[i];

    const j = cols + i;
    pos[j * 3] = PROF_X[i] * tp;
    pos[j * 3 + 1] = PROF_Y[i] * TRAIL_ARCH * tp;
    pos[j * 3 + 2] = -1;
    col[j * 3] = PROF_W[i] * fd;
    col[j * 3 + 1] = PROF_W[i] * fd;
    col[j * 3 + 2] = PROF_W[i] * fd;
  }

  const index = new Uint16Array((cols - 1) * 6);
  for (let i = 0; i < cols - 1; i++) {
    const a = i;
    const b = i + 1;
    const c = cols + i + 1;
    const d = cols + i;
    index[i * 6] = a;
    index[i * 6 + 1] = c;
    index[i * 6 + 2] = b;
    index[i * 6 + 3] = a;
    index[i * 6 + 4] = d;
    index[i * 6 + 5] = c;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  return geo;
}

/* ---------- ресурсы ---------- */

interface TrafficWorld {
  group: THREE.Group;
  bodies: THREE.InstancedMesh;
  tailCore: THREE.InstancedMesh;
  tailHalo: THREE.InstancedMesh;
  headCore: THREE.InstancedMesh;
  headHalo: THREE.InstancedMesh;
  trails: THREE.InstancedMesh | null;
  /** Сегментов на одну ленту. */
  segs: number;
  /** Множитель ширины сегмента k. */
  taper: Float32Array;
  /** Множитель яркости сегмента k. */
  fade: Float32Array;
  cap: number;
  lampCap: number;
  trailCap: number;
  carFar: number;
  dispose: () => void;
}

/** Аддитивный квад света: одна геометрия на все четыре роли, цвет — в материале. */
function lightMat(map: THREE.Texture | null, color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map,
    color: new THREE.Color(color),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
}

function buildTraffic(q: Quality): TrafficWorld {
  const preset = QUALITY[q];
  const group = new THREE.Group();
  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];

  const cap = LIMITS.cars;
  const lampCap = cap * 2;

  /* --- 1. кузова --- */

  const bodyGeom = buildBodyGeom();
  geoms.push(bodyGeom);
  const bodyMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    fog: true,
  });
  mats.push(bodyMat);
  const bodies = new THREE.InstancedMesh(bodyGeom, bodyMat, cap);
  bodies.frustumCulled = false;
  bodies.renderOrder = 2;
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(bodies);

  /* --- 2. огни --- */

  const coreTex = radialTex(64, 24, 4.2, 0.26);
  const haloTex = radialTex(128, 6, 1.35, 0.9);
  if (coreTex) texs.push(coreTex);
  if (haloTex) texs.push(haloTex);

  const quad = new THREE.PlaneGeometry(1, 1);
  geoms.push(quad);

  const tailCoreMat = lightMat(coreTex, COLORS.tail);
  const tailHaloMat = lightMat(haloTex, COLORS.tailDim);
  const headCoreMat = lightMat(coreTex, COLORS.head);
  const headHaloMat = lightMat(haloTex, COLORS.headWarm);
  mats.push(tailCoreMat, tailHaloMat, headCoreMat, headHaloMat);

  const tailHalo = new THREE.InstancedMesh(quad, tailHaloMat, cap);
  const headHalo = new THREE.InstancedMesh(quad, headHaloMat, cap);
  const tailCore = new THREE.InstancedMesh(quad, tailCoreMat, lampCap);
  const headCore = new THREE.InstancedMesh(quad, headCoreMat, lampCap);
  tailHalo.renderOrder = 6;
  headHalo.renderOrder = 6;
  tailCore.renderOrder = 11;
  headCore.renderOrder = 11;
  for (const m of [tailHalo, headHalo, tailCore, headCore]) {
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }

  /* --- 3. ленты --- */

  const segs = Math.max(2, Math.round(TRAIL_SEGS[q]));
  const trailCap = preset.trails ? cap * 2 * segs : 0;
  let trails: THREE.InstancedMesh | null = null;
  if (trailCap > 0) {
    const geo = buildTrailGeom(segs);
    geoms.push(geo);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // Лента лежит почти в плоскости дороги: обе стороны, чтобы на переломах
      // рельефа она не пропадала.
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    mats.push(mat);
    trails = new THREE.InstancedMesh(geo, mat, trailCap);
    trails.frustumCulled = false;
    trails.renderOrder = 4;
    trails.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(trails);
  }

  // Стартовое состояние: слоты спрятаны, instanceColor уже существует — в кадре
  // останется только пометить буфер грязным.
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < cap; i++) {
    bodies.setMatrixAt(i, _hide);
    bodies.setColorAt(i, _col);
    tailHalo.setMatrixAt(i, _hide);
    tailHalo.setColorAt(i, _col);
    headHalo.setMatrixAt(i, _hide);
    headHalo.setColorAt(i, _col);
  }
  for (let i = 0; i < lampCap; i++) {
    tailCore.setMatrixAt(i, _hide);
    tailCore.setColorAt(i, _col);
    headCore.setMatrixAt(i, _hide);
    headCore.setColorAt(i, _col);
  }
  for (let i = 0; i < trailCap; i++) {
    trails?.setMatrixAt(i, _hide);
    trails?.setColorAt(i, _col);
  }

  // Прогрессии сужения и затухания вдоль ленты — считаем один раз, чтобы в
  // кадре не звать Math.pow на каждый сегмент.
  const taper = new Float32Array(segs);
  const fade = new Float32Array(segs);
  const tp = Math.pow(TRAIL_TIP, 1 / segs);
  const fd = Math.pow(TRAIL_END, 1 / segs);
  let tAcc = 1;
  let fAcc = 1;
  for (let k = 0; k < segs; k++) {
    taper[k] = tAcc;
    fade[k] = fAcc;
    tAcc *= tp;
    fAcc *= fd;
  }

  const dispose = () => {
    for (const m of mats) m.dispose();
    for (const geo of geoms) geo.dispose();
    for (const t of texs) t.dispose();
  };

  return {
    group,
    bodies,
    tailCore,
    tailHalo,
    headCore,
    headHalo,
    trails,
    segs,
    taper,
    fade,
    cap,
    lampCap,
    trailCap,
    carFar: CAR_FAR[q],
    dispose,
  };
}

/* ---------- компонент ---------- */

interface Anim {
  /** Сглаженная скорость игрока: длина лент не должна дёргаться на ударах. */
  speed: number;
}

export function Traffic({ g }: { g: Game }) {
  const quality = g.quality;

  // Ресурсы живут в ref, а не в useMemo: в StrictMode фабрика useMemo успела бы
  // построить два комплекта, из которых один утёк бы мимо cleanup.
  const holder = useRef<{ q: Quality; res: TrafficWorld } | null>(null);
  if (holder.current === null) {
    holder.current = { q: quality, res: buildTraffic(quality) };
  } else if (holder.current.q !== quality) {
    holder.current.res.dispose();
    holder.current = { q: quality, res: buildTraffic(quality) };
  }
  const res = holder.current.res;

  const animRef = useRef<Anim | null>(null);
  if (animRef.current === null) animRef.current = { speed: PHYS.speedStart };

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

  useFrame((_state, rawDt) => {
    const dt = rawDt > 0.05 ? 0.05 : rawDt;
    const anim = animRef.current;
    if (!anim) return;
    anim.speed = damp(anim.speed, g.speed, 5, dt);

    const camS = g.s;
    const camX = g.x;
    const calm = g.reducedMotion;
    const far = res.carFar;
    const spd = anim.speed;
    const cars = g.cars;
    const segs = res.segs;
    const trails = res.trails;

    let nBody = 0;
    let nTailCore = 0;
    let nTailHalo = 0;
    let nHeadCore = 0;
    let nHeadHalo = 0;
    let nTrail = 0;

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active) continue;
      const d = c.s - camS;
      if (d > far || d < -CAR_BEHIND) continue;

      const box = BOX.cars[c.kind];
      const hw = box.hw;
      const hl = box.hl;
      const lane = c.lane + (calm ? 0 : Math.sin(c.wobble) * SWAY);
      const onc = c.oncoming || c.speed < 0;

      /* --- кузов --- */
      if (d < BODY_FAR && d > -BODY_BEHIND && nBody < res.cap) {
        _eu.set(roadPitch(c.s), -roadHeading(c.s), 0, "YXZ");
        _q.setFromEuler(_eu);
        _pos.set(localX(c.s, lane, camS, camX), localY(c.s, 0, camS), localZ(c.s, camS));
        _scl.set(hw * 2, CAR_H[c.kind], hl * 2);
        _m4.compose(_pos, _q, _scl);
        res.bodies.setMatrixAt(nBody, _m4);
        // Нижний порог, а не ноль: дальний кузов должен сохранить синий кант,
        // иначе на подъезде к границе он схлопывается в чёрное пятно.
        const bf = 0.18 + 0.82 * smoothstep(BODY_FAR, BODY_FAR * 0.3, d);
        _col.setRGB(bf, bf, bf);
        res.bodies.setColorAt(nBody, _col);
        nBody++;
      }

      /* --- огни ---
         И стопы ведущей, и фары встречной сидят на той стороне кузова, что
         обращена к игроку, то есть на меньшем `s`: встречная едет к нам носом,
         ведущая — от нас кормой. */
      const lampS = c.s - hl;
      const lampY = LAMP_Y[c.kind];
      const lx = hw * LAMP_X;
      const ly = localY(lampS, lampY, camS);
      const lz = localZ(lampS, camS);
      const grow = d > 0 ? Math.min(1 + d / LIGHT_GROW, LIGHT_GROW_MAX) : 1;
      const lit = smoothstep(far, far * 0.5, d) * smoothstep(-12, 2, d);

      if (lit > 0.002) {
        // Сигнала торможения в контракте нет, поэтому стопы просто дышат по
        // фазе покачивания — этого хватает, чтобы они не выглядели наклейками.
        const shimmer = calm ? 1 : 0.84 + 0.16 * Math.sin(c.wobble * 1.7 + c.id * 0.7);
        const flick = calm ? 1 : 0.95 + 0.05 * Math.sin(c.wobble * 1.1 + c.id);

        const coreSize = (onc ? HEAD_CORE : TAIL_CORE) * grow;
        const coreGain =
          (onc ? HEAD_CORE_GAIN * flick : TAIL_CORE_GAIN * shimmer) * lit;
        const coreMesh = onc ? res.headCore : res.tailCore;
        let coreN = onc ? nHeadCore : nTailCore;
        _col.setRGB(coreGain, coreGain, coreGain);
        for (let side = -1; side <= 1; side += 2) {
          if (coreN >= res.lampCap) break;
          _pos.set(localX(lampS, lane + side * lx, camS, camX), ly, lz);
          _scl.set(coreSize, coreSize, 1);
          _m4.compose(_pos, _qi, _scl);
          coreMesh.setMatrixAt(coreN, _m4);
          coreMesh.setColorAt(coreN, _col);
          coreN++;
        }
        if (onc) nHeadCore = coreN;
        else nTailCore = coreN;

        const haloSize = (onc ? HEAD_HALO : TAIL_HALO) * grow * (0.7 + hw * 0.35);
        const haloGain =
          (onc ? HEAD_HALO_GAIN * flick : TAIL_HALO_GAIN * shimmer) * lit;
        const haloMesh = onc ? res.headHalo : res.tailHalo;
        const haloN = onc ? nHeadHalo : nTailHalo;
        if (haloN < res.cap) {
          _pos.set(localX(lampS, lane, camS, camX), ly, lz);
          _scl.set(haloSize * 1.4, haloSize, 1);
          _m4.compose(_pos, _qi, _scl);
          haloMesh.setMatrixAt(haloN, _m4);
          _col.setRGB(haloGain, haloGain, haloGain);
          haloMesh.setColorAt(haloN, _col);
          if (onc) nHeadHalo = haloN + 1;
          else nTailHalo = haloN + 1;
        }
      }

      /* --- световая полоса ---
         Тянется от машины в сторону БОЛЬШЕГО `s` — туда, откуда встречная
         приехала, то есть к точке схода. Длина — от скорости сближения:
         у встречной она складывается с нашей, у ведущей это разница, поэтому
         красный след сам собой выходит коротким. */
      if (trails) {
        const rel = onc ? spd + Math.abs(c.speed) : Math.abs(spd - c.speed);
        const len = onc
          ? clamp(rel * TRAIL_TIME, TRAIL_MIN, TRAIL_MAX)
          : clamp(rel * TRAIL_TIME_RED, TRAIL_MIN_RED, TRAIL_MAX_RED);
        const bri =
          (onc ? TRAIL_GAIN : TRAIL_GAIN_RED) *
          smoothstep(far, far * 0.62, d) *
          (0.35 + 0.65 * clamp01(rel / TRAIL_REF));
        if (bri > 0.004) {
          const step = len / segs;
          const w0 = onc ? TRAIL_W : TRAIL_W_RED;
          const offX = lx * 0.92;
          for (let side = -1; side <= 1; side += 2) {
            const off = lane + side * offX;
            for (let k = 0; k < segs; k++) {
              if (nTrail >= res.trailCap) break;
              const sa = lampS + step * k;
              const sb = sa + step;
              _p0.set(
                localX(sa, off, camS, camX),
                localY(sa, TRAIL_Y, camS),
                localZ(sa, camS),
              );
              _p1.set(
                localX(sb, off, camS, camX),
                localY(sb, TRAIL_Y, camS),
                localZ(sb, camS),
              );
              _dir.copy(_p1).sub(_p0);
              const segLen = _dir.length();
              if (segLen < 1e-3) continue;
              _dir.multiplyScalar(1 / segLen);
              // Базис ленты: X — поперёк, Y — нормаль (валик), Z — против хода,
              // потому что геометрия уходит в локальный −Z.
              _right.copy(_dir).cross(_up).normalize();
              _norm.copy(_right).cross(_dir);
              const tp = res.taper[k];
              _ax.copy(_right).multiplyScalar(w0 * tp);
              _ay.copy(_norm).multiplyScalar(tp);
              _az.copy(_dir).multiplyScalar(-segLen);
              _m4.makeBasis(_ax, _ay, _az);
              _m4.setPosition(_p0);
              trails.setMatrixAt(nTrail, _m4);
              _col.copy(onc ? _neon : _red).multiplyScalar(bri * res.fade[k]);
              trails.setColorAt(nTrail, _col);
              nTrail++;
            }
          }
        }
      }
    }

    /* --- гасим хвосты пулов --- */
    for (let i = nBody; i < res.cap; i++) res.bodies.setMatrixAt(i, _hide);
    for (let i = nTailHalo; i < res.cap; i++) res.tailHalo.setMatrixAt(i, _hide);
    for (let i = nHeadHalo; i < res.cap; i++) res.headHalo.setMatrixAt(i, _hide);
    for (let i = nTailCore; i < res.lampCap; i++) res.tailCore.setMatrixAt(i, _hide);
    for (let i = nHeadCore; i < res.lampCap; i++) res.headCore.setMatrixAt(i, _hide);
    if (trails) for (let i = nTrail; i < res.trailCap; i++) trails.setMatrixAt(i, _hide);

    res.bodies.instanceMatrix.needsUpdate = true;
    if (res.bodies.instanceColor) res.bodies.instanceColor.needsUpdate = true;
    res.tailHalo.instanceMatrix.needsUpdate = true;
    if (res.tailHalo.instanceColor) res.tailHalo.instanceColor.needsUpdate = true;
    res.headHalo.instanceMatrix.needsUpdate = true;
    if (res.headHalo.instanceColor) res.headHalo.instanceColor.needsUpdate = true;
    res.tailCore.instanceMatrix.needsUpdate = true;
    if (res.tailCore.instanceColor) res.tailCore.instanceColor.needsUpdate = true;
    res.headCore.instanceMatrix.needsUpdate = true;
    if (res.headCore.instanceColor) res.headCore.instanceColor.needsUpdate = true;
    if (trails) {
      trails.instanceMatrix.needsUpdate = true;
      if (trails.instanceColor) trails.instanceColor.needsUpdate = true;
    }
  });

  return <primitive object={res.group} />;
}
