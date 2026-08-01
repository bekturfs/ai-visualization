/**
 * Бонусы над дорогой: звёзды-искры (очки + немного нитро) и канистры нитро.
 *
 * Всё состояние берётся из `g.pickups` — пул фиксированного размера
 * `LIMITS.pickups`, слот инстанса жёстко соответствует индексу в пуле. Ничего
 * своего про мир этот модуль не знает и не хранит: спавн и подбор — дело
 * `worldGen` и `engine`, здесь только отрисовка.
 *
 * Пять слоёв, все аддитивные (ночь, неон, bloom), ни одной аллокации в кадре:
 *
 *   1. ЗВЕЗДА. InstancedMesh шестилучевой искры — три скрещенных «октаэдра»
 *      разной длины. Силуэт колючий с любого ракурса, вращение вокруг Y от
 *      `pickup.spin` держит её живой. Цвет `COLORS.combo`, `toneMapped: false`,
 *      так что bloom честно раздувает её в блик.
 *
 *   2. КАНИСТРА. InstancedMesh капсулы в `COLORS.nitro`. Форма нарочно
 *      противоположна звезде — гладкая наклонённая «пилюля» против колючки:
 *      на 250 км/ч игрок различает их по силуэту и цвету раньше, чем успевает
 *      прочитать детали.
 *
 *   3. ОРЕОЛ. Аддитивный квад за телом, по одному InstancedMesh на вид бонуса:
 *      у звезды в текстуру вписан жёсткий четырёхлучевой крест (тот самый блик
 *      из кадра f_001), у канистры — мягкое круглое свечение. Без ореола тело
 *      читается ярким пятном пластика, а не источником света.
 *
 *   4. ШАХТА СВЕТА. Тонкий вертикальный квад от полотна до бонуса, низкая
 *      прозрачность. Самый дешёвый способ увидеть звезду за 600 м: сама искра
 *      там меньше пикселя, а столбик света — нет.
 *
 * ВСПЫШКА ПРИ ПОДБОРЕ. `pickup.taken` не гасит слот мгновенно: прогресс
 * вспышки живёт в модульном `popT` (индекс = слот), тело раздувается и гаснет
 * за `POP_TIME`, после чего слот паркуется с нулевым масштабом. Слот
 * переиспользуется под новый бонус — это ловится по смене `pickup.id`, и
 * прогресс сбрасывается. Время вспышки берётся из `g.t`, а не из часов кадра,
 * поэтому пауза действительно останавливает её, как и вращение с покачиванием.
 */

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { Game } from "../types";
import { COLORS, LIMITS, PICKUPS, QUALITY } from "../config";
import { localX, localY, localZ } from "../road";
import { clamp01, lerp, smoothstep } from "../num";

/* ---------- размеры и темп ---------- */

const TAU = Math.PI * 2;

/** Слотов ровно столько, сколько в пуле игры: слот = индекс в `g.pickups`. */
const POOL = LIMITS.pickups;

/** Куда уезжает незанятый слот: нулевой масштаб плюс уход под мир. */
const HIDE_Y = -1e4;

/** Масштаб искры: короткий луч в метрах (длинный по Y — в полтора раза). */
const STAR_R = 0.46;
/** Постоянный завал искры, чтобы лучи не совпадали с осями кадра. */
const STAR_LEAN = 0.26;

/** Канистра: радиус и длина цилиндрической части, м. */
const CAN_R = 0.24;
const CAN_H = 0.66;
/** Наклон канистры: лежащая набок капсула читается объёмнее стоящей. */
const CAN_TILT = 0.44;

/** Вращение, рад/с. */
const SPIN_W = 2.1;
/** Покачивание: амплитуда в метрах и частота в рад/с. */
const BOB_AMP = 0.16;
const BOB_W = 1.9;

/** Вспышка подбора: длительность, с, и подъём тела за это время, м. */
const POP_TIME = 0.25;
const POP_RISE = 1.15;
/**
 * На какой дистанции догорает вспышка, м. Бонус подбирается в упор
 * (`PICKUPS.grabS` — 3.2 м) и мгновенно уезжает за камеру, так что вспышку
 * приходится придержать перед капотом — иначе её просто никто не увидит.
 */
const POP_HOLD = 7;

/* ---------- дальность и слои ---------- */

/** Дальность отрисовки по пресетам качества, м. */
const FAR: readonly number[] = [420, 700, 900];
/** Насколько метров позади камеры бонус ещё имеет смысл рисовать. */
const NEAR_CUT = -4;

/** Базовый размер ореола, м, и предел его «раздувания» с дистанцией. */
const HALO_SIZE = 1.8;
const HALO_GROW = 240;
const HALO_GROW_MAX = 3.4;

/** Шахта света: ширина у камеры, м, её рост с дистанцией и запас сверху. */
const SHAFT_W = 0.5;
const SHAFT_GROW = 300;
const SHAFT_GROW_MAX = 3;
const SHAFT_TOP = 0.22;

/** Яркости слоёв (уходят в instanceColor, поэтому могут быть больше единицы). */
const STAR_GAIN = 1.5;
const CAN_GAIN = 1.35;
const HALO_GAIN = 0.9;
const SHAFT_GAIN = 0.22;
/** Во сколько раз ореол ярче обычного в первый кадр вспышки. */
const POP_FLASH = 2.4;

/** Порядок отрисовки: поверх дороги (до 5) и фонарей (до 8). */
const ORDER_SHAFT = 9;
const ORDER_HALO = 10;
const ORDER_BODY = 11;

/* ---------- состояние слотов ---------- */

/** Прогресс вспышки 0…1 по слоту. Модульный, не React-состояние. */
const popT = new Float32Array(POOL);
/** Чей бонус лежал в слоте прошлый кадр: смена id — слот переиспользован. */
const popId = new Float64Array(POOL);
popId.fill(-1);

/* ---------- скретч кадра ---------- */

const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** Единичный поворот: квады смотрят в +Z, как и камера — в −Z. */
const _qi = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _col = new THREE.Color();
const _mk = new THREE.Color();

const _hide = new THREE.Matrix4();
_hide.makeScale(0, 0, 0);
_hide.setPosition(0, HIDE_Y, 0);

/* ---------- текстуры ---------- */

/** Контекст canvas или `null`, если рисовать негде (SSR, нулевой размер). */
function ctx2d(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = Math.max(4, w | 0);
  cv.height = Math.max(4, h | 0);
  if (cv.width < 1 || cv.height < 1) return null;
  return cv.getContext("2d");
}

/**
 * Ореол: узкое ядро плюс широкая юбка, всё в белом — цвет придёт инстансом.
 * `cross` добавляет четырёхлучевой блик, каким в референсе горит звезда над
 * дорогой; для канистры он лишний, ей достаётся чистое круглое свечение.
 */
function haloTex(size: number, cross: boolean): THREE.CanvasTexture | null {
  const ctx = ctx2d(size, size);
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
      // Срез у края квада: на аддитивном блендинге шов виден сразу.
      const cut = smoothstep(1, 0.44, r);
      let a = (Math.exp(-r2 * 17) + 0.5 * Math.exp(-r2 * 2.7)) * cut;
      if (cross) {
        // Горизонтальный луч длиннее вертикального — так блик выглядит в рил.
        const rays = Math.exp(-dy * dy * 620) + 0.7 * Math.exp(-dx * dx * 620);
        a += rays * 0.55 * smoothstep(1, 0.12, r);
      }
      const i = (y * w + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTex(ctx.canvas);
}

/**
 * Шахта света: по горизонтали мягкий колокол, по вертикали яркость растёт
 * снизу вверх — свет как будто стекает с бонуса на полотно. Верхний край не
 * гасим: там его закрывает ореол.
 */
function shaftTex(w: number, h: number): THREE.CanvasTexture | null {
  const ctx = ctx2d(w, h);
  if (!ctx) return null;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const img = ctx.createImageData(cw, ch);
  const d = img.data;
  const c = (cw - 1) / 2;
  for (let y = 0; y < ch; y++) {
    // Текстура попадает на квад с flipY: верхняя строка — это v = 1, то есть
    // верх шахты у самого бонуса, нижняя — контакт с асфальтом.
    const v = 1 - y / (ch - 1);
    const up = (0.16 + 0.84 * v * v) * smoothstep(0, 0.07, v);
    for (let x = 0; x < cw; x++) {
      const dx = (x - c) / c;
      const a = up * Math.exp(-dx * dx * 6.5) * smoothstep(1, 0.62, Math.abs(dx));
      const i = (y * cw + x) * 4;
      d[i] = 255;
      d[i + 1] = 255;
      d[i + 2] = 255;
      d[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTex(ctx.canvas);
}

function finishTex(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ---------- геометрия тел ---------- */

/** Длины лучей искры по осям X, Y, Z и радиус их «талии». */
const SPIKE_LEN: readonly number[] = [1, 1.5, 1];
const SPIKE_R: readonly number[] = [0.2, 0.25, 0.2];

/**
 * Шестилучевая искра: три скрещенных двойных пирамиды. Освещение запечено в
 * цвет вершин — кончик горячее талии, грани чуть разной яркости, иначе на
 * аддитивном блендинге искра сливается в ровное пятно.
 */
function buildStarGeom(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const tipP = [0, 0, 0];
  const tipN = [0, 0, 0];
  const ring = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  const put = (v: readonly number[], b: number) => {
    pos.push(v[0], v[1], v[2]);
    col.push(b, b, b);
  };

  for (let a = 0; a < 3; a++) {
    const b1 = (a + 1) % 3;
    const c1 = (a + 2) % 3;
    const len = SPIKE_LEN[a];
    const rad = SPIKE_R[a];

    tipP[0] = 0;
    tipP[1] = 0;
    tipP[2] = 0;
    tipP[a] = len;
    tipN[0] = 0;
    tipN[1] = 0;
    tipN[2] = 0;
    tipN[a] = -len;

    for (let k = 0; k < 4; k++) {
      const th = (k / 4) * TAU + Math.PI * 0.25;
      const v = ring[k];
      v[0] = 0;
      v[1] = 0;
      v[2] = 0;
      v[b1] = Math.cos(th) * rad;
      v[c1] = Math.sin(th) * rad;
    }

    for (let k = 0; k < 4; k++) {
      const v0 = ring[k];
      const v1 = ring[(k + 1) % 4];
      const face = 0.8 + 0.32 * (0.5 + 0.5 * Math.cos(k * 1.57 - 0.8 + a));
      put(tipP, 1.5 * face);
      put(v0, 0.5 * face);
      put(v1, 0.5 * face);
      put(tipN, 1.18 * face);
      put(v1, 0.42 * face);
      put(v0, 0.42 * face);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1.6);
  return geo;
}

/**
 * Канистра: капсула с запечённым в вершины поясом и подсветкой торцов —
 * силуэт остаётся гладким, но объём читается даже одним цветом.
 */
function buildCanGeom(): THREE.BufferGeometry {
  const geo = new THREE.CapsuleGeometry(CAN_R, CAN_H, 4, 10);
  const attr = geo.getAttribute("position") as THREE.BufferAttribute;
  const cols = new Float32Array(attr.count * 3);
  const half = CAN_H * 0.5 + CAN_R;
  for (let i = 0; i < attr.count; i++) {
    const x = attr.getX(i);
    const y = attr.getY(i);
    const z = attr.getZ(i);
    const v = y / half;
    const bd = (v - 0.04) * 5.5;
    const ed = (Math.abs(v) - 0.88) * 7;
    const belt = Math.exp(-bd * bd);
    const ends = Math.exp(-ed * ed);
    const face = 0.78 + 0.34 * (0.5 + 0.5 * Math.cos(Math.atan2(z, x) - 0.7));
    const b = (0.34 + 0.52 * belt + 0.38 * ends) * face;
    cols[i * 3] = b;
    cols[i * 3 + 1] = b;
    cols[i * 3 + 2] = b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), half * 1.15);
  return geo;
}

/* ---------- ресурсы ---------- */

interface World {
  group: THREE.Group;
  stars: THREE.InstancedMesh;
  cans: THREE.InstancedMesh;
  haloStar: THREE.InstancedMesh | null;
  haloCan: THREE.InstancedMesh | null;
  shaft: THREE.InstancedMesh | null;
  /** Линейные RGB палитры: звезда и канистра. */
  starRGB: Float64Array;
  nitroRGB: Float64Array;
  dispose: () => void;
}

function hexInto(hex: string, out: Float64Array) {
  _mk.set(hex);
  out[0] = _mk.r;
  out[1] = _mk.g;
  out[2] = _mk.b;
}

/** Аддитивный квад с текстурой: ореолы и шахта отличаются только картой. */
function quadMesh(
  tex: THREE.Texture,
  geo: THREE.BufferGeometry,
  order: number,
  mats: THREE.Material[],
): THREE.InstancedMesh {
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  mats.push(mat);
  const mesh = new THREE.InstancedMesh(geo, mat, POOL);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

function buildWorld(): World {
  const group = new THREE.Group();
  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];

  /* --- тела --- */

  const bodyMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    // Глубину не пишем: бонус — свет, он не должен вырезать дыру в дороге и
    // машинах, но тест глубины оставлен, чтобы фура его честно закрывала.
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
    // Аддитивно сложенные передняя и задняя грань дают объёмное свечение
    // вместо плоской наклейки.
    side: THREE.DoubleSide,
  });
  mats.push(bodyMat);

  const starGeom = buildStarGeom();
  const canGeom = buildCanGeom();
  geoms.push(starGeom, canGeom);

  const stars = new THREE.InstancedMesh(starGeom, bodyMat, POOL);
  stars.frustumCulled = false;
  stars.renderOrder = ORDER_BODY;
  stars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const cans = new THREE.InstancedMesh(canGeom, bodyMat, POOL);
  cans.frustumCulled = false;
  cans.renderOrder = ORDER_BODY;
  cans.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  /* --- квады: ореолы и шахта --- */

  const quadGeom = new THREE.PlaneGeometry(1, 1);
  geoms.push(quadGeom);

  const starTex = haloTex(128, true);
  const canTex = haloTex(128, false);
  const shaftTexture = shaftTex(32, 128);

  let haloStar: THREE.InstancedMesh | null = null;
  let haloCan: THREE.InstancedMesh | null = null;
  let shaft: THREE.InstancedMesh | null = null;

  if (starTex) {
    texs.push(starTex);
    haloStar = quadMesh(starTex, quadGeom, ORDER_HALO, mats);
  }
  if (canTex) {
    texs.push(canTex);
    haloCan = quadMesh(canTex, quadGeom, ORDER_HALO, mats);
  }
  if (shaftTexture) {
    texs.push(shaftTexture);
    shaft = quadMesh(shaftTexture, quadGeom, ORDER_SHAFT, mats);
  }

  // Шахта уходит под ореолы и тела, порядок в группе повторяет renderOrder.
  if (shaft) group.add(shaft);
  if (haloStar) group.add(haloStar);
  if (haloCan) group.add(haloCan);
  group.add(stars, cans);

  // Стартовое состояние: все слоты спрятаны, instanceColor уже существует —
  // в кадре останется только переписать его и пометить грязным.
  _col.setRGB(1, 1, 1);
  for (let i = 0; i < POOL; i++) {
    stars.setMatrixAt(i, _hide);
    stars.setColorAt(i, _col);
    cans.setMatrixAt(i, _hide);
    cans.setColorAt(i, _col);
    if (haloStar) {
      haloStar.setMatrixAt(i, _hide);
      haloStar.setColorAt(i, _col);
    }
    if (haloCan) {
      haloCan.setMatrixAt(i, _hide);
      haloCan.setColorAt(i, _col);
    }
    if (shaft) {
      shaft.setMatrixAt(i, _hide);
      shaft.setColorAt(i, _col);
    }
  }

  const starRGB = new Float64Array(3);
  const nitroRGB = new Float64Array(3);
  hexInto(COLORS.combo, starRGB);
  hexInto(COLORS.nitro, nitroRGB);

  const dispose = () => {
    for (const m of mats) m.dispose();
    for (const geo of geoms) geo.dispose();
    for (const t of texs) t.dispose();
    stars.dispose();
    cans.dispose();
    haloStar?.dispose();
    haloCan?.dispose();
    shaft?.dispose();
  };

  return { group, stars, cans, haloStar, haloCan, shaft, starRGB, nitroRGB, dispose };
}

/* ---------- покадровая раскладка ---------- */

function hideSlot(w: World, i: number) {
  w.stars.setMatrixAt(i, _hide);
  w.cans.setMatrixAt(i, _hide);
  if (w.haloStar) w.haloStar.setMatrixAt(i, _hide);
  if (w.haloCan) w.haloCan.setMatrixAt(i, _hide);
  if (w.shaft) w.shaft.setMatrixAt(i, _hide);
}

function flush(m: THREE.InstancedMesh | null) {
  if (!m) return;
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
}

interface Anim {
  /** `g.t` прошлого кадра: вспышка живёт по игровому времени, не по кадрам. */
  lastT: number;
}

/* ---------- компонент ---------- */

export function Pickups({ g }: { g: Game }) {
  // Ресурсы в ref, а не в useMemo: в StrictMode фабрика useMemo успела бы
  // собрать два комплекта, из которых один утёк бы мимо cleanup.
  const holder = useRef<World | null>(null);
  if (holder.current === null) holder.current = buildWorld();
  const w = holder.current;

  const animRef = useRef<Anim | null>(null);
  if (animRef.current === null) animRef.current = { lastT: 0 };

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
          h.dispose();
          holder.current = null;
        }
      }, 0);
    };
  }, []);

  useFrame(() => {
    const anim = animRef.current;
    if (!anim) return;

    const preset = QUALITY[g.quality];
    const far = FAR[g.quality];
    // Без bloom бонусы теряют половину читаемости — добираем яркостью.
    const gain = preset.bloom ? 1 : 1.3;
    const calm = g.reducedMotion;
    const camS = g.s;
    const camX = g.x;
    const t = g.t;

    // Шаг игрового времени: на паузе он ноль, на рестарте `g.t` падает в ноль
    // и разность уходит в минус — оба случая просто замораживают вспышку.
    let dtG = t - anim.lastT;
    if (!(dtG > 0)) dtG = 0;
    else if (dtG > 0.2) dtG = 0.2;
    anim.lastT = t;

    const list = g.pickups;
    const n = list.length < POOL ? list.length : POOL;

    for (let i = 0; i < POOL; i++) {
      if (i >= n) {
        hideSlot(w, i);
        continue;
      }
      const p = list[i];

      // Слот переиспользован под новый бонус — старая вспышка отменяется.
      if (popId[i] !== p.id) {
        popId[i] = p.id;
        popT[i] = 0;
      }

      const star = p.kind === "star";
      const d = p.s - camS;
      let sPos = p.s;
      let y = PICKUPS.y;
      let scale = 1;
      let bodyB = 0;
      let haloB = 0;
      let haloS = HALO_SIZE;
      let shaftB = 0;
      let ang = p.spin + t * SPIN_W * (star ? 1 : 0.72) * (calm ? 0.5 : 1);

      if (p.active && !p.taken) {
        /* --- живой бонус --- */
        popT[i] = 0;
        if (d <= NEAR_CUT || d >= far) {
          hideSlot(w, i);
          continue;
        }
        const fade = smoothstep(far, far * 0.72, d) * smoothstep(NEAR_CUT, 4, d);
        // Пульсация — это строб, в спокойном режиме её нет.
        const puls = calm ? 1 : 1 + 0.16 * Math.sin(t * 3.4 + p.spin * 2.1);
        y = PICKUPS.y + (calm ? 0.05 : BOB_AMP) * Math.sin(t * BOB_W + p.spin);
        bodyB = fade * puls * (star ? STAR_GAIN : CAN_GAIN) * gain;
        haloB = fade * puls * HALO_GAIN * gain;
        haloS =
          (star ? HALO_SIZE : HALO_SIZE * 0.82) *
          (d > 0 ? Math.min(1 + d / HALO_GROW, HALO_GROW_MAX) : 1);
        // Шахта — подсказка для дальнего плана: вблизи она только мешает.
        shaftB = fade * SHAFT_GAIN * gain * smoothstep(far * 0.9, 26, d);
      } else if (p.taken && popT[i] < 1) {
        /* --- вспышка подбора --- */
        let q = popT[i] + dtG / POP_TIME;
        if (q > 1) q = 1;
        popT[i] = q;
        if (q >= 1) {
          hideSlot(w, i);
          continue;
        }
        const k = 1 - q;
        const k2 = k * k;
        // Бонус уже за камерой: придерживаем вспышку перед капотом.
        sPos = p.s < camS + POP_HOLD ? camS + POP_HOLD : p.s;
        y = PICKUPS.y + POP_RISE * q;
        scale = 1 + 2.1 * q;
        ang += q * 5.5;
        bodyB = k2 * 1.7 * (star ? STAR_GAIN : CAN_GAIN) * gain;
        haloB = k2 * POP_FLASH * gain;
        haloS = HALO_SIZE * (1 + 2.4 * q);
      } else {
        hideSlot(w, i);
        continue;
      }

      const lane = p.lane;
      const px = localX(sPos, lane, camS, camX);
      const py = localY(sPos, y, camS);
      const pz = localZ(sPos, camS);
      const rgb = star ? w.starRGB : w.nitroRGB;

      /* --- тело --- */
      if (star) {
        _eu.set(STAR_LEAN, ang, STAR_LEAN * 0.6, "XYZ");
        const sc = STAR_R * scale;
        _scl.set(sc, sc, sc);
      } else {
        // Лёгкое кувыркание вокруг наклона: капсула перестаёт быть поплавком.
        _eu.set(CAN_TILT * 0.4 * Math.sin(ang * 0.5), ang, CAN_TILT, "XYZ");
        _scl.set(scale, scale, scale);
      }
      _q.setFromEuler(_eu);
      _pos.set(px, py, pz);
      _m4.compose(_pos, _q, _scl);
      _col.setRGB(rgb[0] * bodyB, rgb[1] * bodyB, rgb[2] * bodyB);
      if (star) {
        w.stars.setMatrixAt(i, _m4);
        w.stars.setColorAt(i, _col);
        w.cans.setMatrixAt(i, _hide);
      } else {
        w.cans.setMatrixAt(i, _m4);
        w.cans.setColorAt(i, _col);
        w.stars.setMatrixAt(i, _hide);
      }

      /* --- ореол: квад смотрит в +Z, камера отклоняется от оси на единицы
             градусов, и честный билборд тут не окупается --- */
      const halo = star ? w.haloStar : w.haloCan;
      const idle = star ? w.haloCan : w.haloStar;
      if (idle) idle.setMatrixAt(i, _hide);
      if (halo) {
        _scl.set(haloS, haloS, 1);
        _m4.compose(_pos, _qi, _scl);
        halo.setMatrixAt(i, _m4);
        // Ядро ореола подбелено: чистый оттенок в центре выглядит краской, а
        // не светом.
        _col.setRGB(
          lerp(rgb[0], 1, 0.22) * haloB,
          lerp(rgb[1], 1, 0.22) * haloB,
          lerp(rgb[2], 1, 0.22) * haloB,
        );
        halo.setColorAt(i, _col);
      }

      /* --- шахта света --- */
      if (w.shaft) {
        if (shaftB <= 0.001) {
          w.shaft.setMatrixAt(i, _hide);
        } else {
          const wide = SHAFT_W * (d > 0 ? Math.min(1 + d / SHAFT_GROW, SHAFT_GROW_MAX) : 1);
          const tall = y + SHAFT_TOP;
          _pos.set(px, localY(sPos, tall * 0.5, camS), pz);
          _scl.set(wide, tall, 1);
          _m4.compose(_pos, _qi, _scl);
          w.shaft.setMatrixAt(i, _m4);
          _col.setRGB(rgb[0] * shaftB, rgb[1] * shaftB, rgb[2] * shaftB);
          w.shaft.setColorAt(i, _col);
        }
      }
    }

    flush(w.stars);
    flush(w.cans);
    flush(w.haloStar);
    flush(w.haloCan);
    flush(w.shaft);
  });

  return <primitive object={w.group} dispose={null} />;
}
