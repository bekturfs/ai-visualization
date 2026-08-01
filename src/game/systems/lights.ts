/**
 * Фонари на обочине и огни далёкого городка — весь мелкий свет, который задаёт
 * ночи масштаб. В референсе это два разных слоя: цепочка холодных фонарей,
 * уходящая за поворот (кадр f_005), и россыпь тёплых и красных точек на склоне
 * за пару километров (кадр f_007).
 *
 * Слои:
 *   1. столбы — один InstancedMesh на слитой геометрии «мачта + вылет + голова»;
 *   2. ореол головы — аддитивные квады с мягким свечением;
 *   3. пятно света на асфальте — аддитивный эллипс, лежащий на полотне. Именно
 *      он делает дорогу освещённой, а не раскрашенной: без него фонарь висит
 *      сам по себе и читается как наклейка;
 *   4. городок — один слой THREE.Points с покадрово переписываемыми позициями.
 *
 * Зависимости инвертированы: генераторы `lamps` / `town` приходят в `LightsDeps`,
 * модуль не знает про `worldGen`.
 *
 * Ни одной аллокации в кадре: колбэки обходов созданы один раз в фабрике и
 * читают общий контекст `walk`, матрицы и цвета — модульный скретч, пулы
 * фиксированы под пресет качества. Лишние слоты не прячутся нулевым масштабом,
 * а просто не рисуются: `InstancedMesh.count` и `setDrawRange` обрезают хвост,
 * и GPU не прогоняет вершины вырожденных инстансов.
 *
 * Размер пулов берётся из пресета **на сборке** (`QUALITY[ctx.quality]`). Смена
 * качества — это пересборка системы в `main.ts`, а не изменение пулов на ходу.
 */

import * as THREE from "three";

import type { RenderCtx, System } from "../ctx";
import type { Game, Lamp, Quality, TownLight } from "../types";
import { COLORS, PHYS, QUALITY, ROAD, TUNE } from "../config";
import { localX, localY, localZ, roadDY } from "../road";
import { clamp01, damp, lerp, smoothstep } from "../num";
import { hash1 } from "../rng";

/* ---------- раскладка фонаря ---------- */

/**
 * Высота мачты, м. Намеренно выше средней кроны: `worldGen` ставит деревья
 * 4…17 м вплотную за отбойником, и на восьмиметровой мачте голова фонаря в
 * полусотне метров ещё видна, а весь ряд дальше — уже нет, он тонет в
 * лесополосе. В кадре важен не столб, а цепочка голов, уходящая за поворот.
 */
const LAMP_H = 11;
/** Длина вылета к дороге, м. */
const ARM_LEN = 2.9;
/** Высота головы над полотном, м. */
const HEAD_Y = LAMP_H - 0.4;
/** Мачта стоит между отбойником и лесополосой. */
const POST_X = ROAD.railX + 1.15;
/** Голова свешивается над обочиной. */
const HEAD_X = POST_X - ARM_LEN;
/** Центр светового пятна — над внешней полосой. */
const POOL_X = 5.2;
/** Пятно лежит чуть выше разметки: свет поверх краски, а не под ней. */
const POOL_Y = 0.05;
/**
 * Габарит квада пятна, м (видимая часть — около 60% от него). Полоса дороги
 * в кадре занимает считанные десятки пикселей по вертикали, поэтому пятно
 * читается шириной, а не длиной: узкий эллипс на таком угле просто исчезает.
 */
const POOL_W = 12;
const POOL_L = 18;
/** Дальше этого пятно не рисуется вовсе — квад стоил бы дороже, чем виден. */
const POOL_FAR = 460;

/**
 * Базовый размер квада ореола, м, и нижний предел его углового размера, рад.
 * Чистая перспектива уводит ореол на восьмистах метрах в пару пикселей, и ряд
 * фонарей за поворотом рассыпается в мерцающую пыль; предел держит дальние
 * головы примерно на 0.6° и оставляет цепочку читаемой до самого тумана.
 */
const GLOW_SIZE = 3.6;
const GLOW_MIN_ANG = 0.0112;
/** Сдвиг ореола к камере, м: иначе коробка головы выедает середину квада. */
const GLOW_Z_BIAS = 0.35;

/**
 * Яркости слоёв (уходят в instanceColor, поэтому могут быть больше единицы).
 * Срезаны примерно вдвое: с прежними значениями фонари и огни городка уходили
 * далеко за единицу, целиком попадали в bloom и давали россыпь пересвеченных
 * пятен вместо ночного города. Огни должны обозначать расстояние, а не спорить
 * с дорогой за внимание.
 */
// Значения живут в TUNE: их подбирают глазами, и панель в dev крутит именно их.
const GLOW_GAIN = TUNE.lights.glow;
const POOL_GAIN = TUNE.lights.pool;
const TOWN_GAIN = TUNE.lights.town;

/** Сколько метров позади камеры ещё имеет смысл держать фонарь. */
const LAMP_BEHIND = 10;
/** Дальность фонарей по пресетам качества, м. */
const LAMP_FAR: readonly number[] = [380, 620, 820];

/** Ближе этого огни городка уже уехали за край кадра. */
const TOWN_NEAR = 45;
/** Дальность огней городка по пресетам качества, м. */
const TOWN_FAR: readonly number[] = [620, 850, 1000];
/**
 * Запас к границам пирамиды видимости при отсеве огней городка. Отсев нужен не
 * ради заполнения GPU, а ради пула: огни сидят в 120…420 м вбок, и на близких
 * дистанциях они гарантированно за краем кадра — но обход отдаёт их первыми и
 * они съедают слоты, до которых видимой грозди на горизонте уже не хватает.
 * По горизонтали запас больше: камера доворачивает по курсу дороги до ~9°.
 */
const TOWN_MARGIN_X = 1.5;
const TOWN_MARGIN_Y = 1.3;
/** Тангенс половины вертикального угла на случай, если у камеры мусорный FOV. */
const TOWN_TAN_FALLBACK = 0.75;
/** Аспект на случай нулевого канваса в первом кадре. */
const TOWN_ASPECT_FALLBACK = 1.6;
/** Базовый размер точки городка в пикселях и дистанция, на которой он верен. */
const TOWN_PX = 3.4;
const TOWN_REF = 340;
/** Пределы хода перспективы для точки: ниже — огонёк схлопывается в ничто. */
const TOWN_MIN = 1;
const TOWN_MAX = 2.3;

/** Верхняя граница шага анимации, с: за вкладкой в фоне кадр может быть любым. */
const DT_MAX = 0.05;

/* ---------- скретч кадра ---------- */

const _m4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** Единичный поворот: квады ореола смотрят в +Z, правые мачты не повёрнуты. */
const _qi = new THREE.Quaternion();
/**
 * Разворот на 180° вокруг Y — левая обочина. Раньше сторона задавалась
 * отрицательным масштабом по X, а он выворачивает обход треугольников и
 * требует DoubleSide; поворот даёт то же зеркало (геометрия симметрична по Z)
 * и позволяет рисовать мачты одной стороной.
 */
const _qFlip = new THREE.Quaternion(0, 1, 0, 0);
const _col = new THREE.Color();
const _mk = new THREE.Color();

/** cos(π/4) = sin(π/4) — половинный угол поворота «положить квад на дорогу». */
const Q_HALF = Math.SQRT1_2;

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
 *
 * 64 пикселя хватает с запасом: это размытое пятно, а не спрайт с деталью.
 */
function radialTex(
  size: number,
  core: string,
  edge: string,
  tight: number,
  wide: number,
  wideK: number,
): THREE.CanvasTexture | null {
  const c2d = ctx2d(size);
  if (!c2d) return null;
  const w = c2d.canvas.width;
  const img = c2d.createImageData(w, w);
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
  c2d.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c2d.canvas);
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
 * Мачта + вылет + голова, основанием в нуле, вылет уходит в −X. Левая обочина
 * получает разворот на 180° вокруг Y — коробки симметричны по Z, так что это
 * ровно то же зеркало, но без выворота нормалей.
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
uniform float uMin;
uniform float uMax;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(1.0, -mv.z);
  gl_PointSize = uSize * uDpr * clamp(uRef / d, uMin, uMax);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Профиль огонька считается на лету, а не берётся из текстуры. Текстура тут
 * ровно та же по форме, но спрайт в 2…3 пикселя уходит на дальний мип, где от
 * ядра остаётся средняя альфа по всему квадрату — примерно 0.17, то есть
 * далёкий городок гаснет ровно там, где он и должен читаться. Заодно это
 * минус одна текстура и минус выборка на фрагмент.
 */
const TOWN_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 pc = gl_PointCoord - 0.5;
  float r2 = dot(pc, pc) * 4.0;
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 5.5) + 0.38 * exp(-r2 * 1.6);
  a = min(a, 1.0) * (1.0 - r2 * r2);
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`;

/* ---------- ресурсы ---------- */

interface TownRes {
  geo: THREE.BufferGeometry;
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

/** Разбудить instanceColor до первого кадра и пометить буферы как «часто меняются». */
function primeInstance(mesh: THREE.InstancedMesh): void {
  _col.setRGB(1, 1, 1);
  mesh.setColorAt(0, _col);
  if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // До первого обхода рисовать нечего: счётчик поднимет `update`.
  mesh.count = 0;
  mesh.frustumCulled = false;
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
    fog: true,
  });
  mats.push(postMat);
  const posts = new THREE.InstancedMesh(postGeom, postMat, lampCap);
  primeInstance(posts);
  group.add(posts);

  /* --- 2. ореол головы --- */

  const glowTex = radialTex(64, COLORS.star, COLORS.neon, 15, 2.1, 0.6);
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
    primeInstance(glow);
    glow.renderOrder = 8;
    group.add(glow);
  }

  /* --- 3. пятно света на асфальте --- */

  const poolTex = radialTex(64, COLORS.lampGlow, COLORS.neonDeep, 3.2, 0.9, 0.5);
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
    primeInstance(pool);
    pool.renderOrder = 6;
    group.add(pool);
  }

  /* --- 4. огни городка --- */

  const pos = new Float32Array(townCap * 3);
  const col = new Float32Array(townCap * 3);
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  const townGeo = new THREE.BufferGeometry();
  townGeo.setAttribute("position", posAttr);
  townGeo.setAttribute("aColor", colAttr);
  // Хвост пула не рисуется вовсе, поэтому и гасить его не нужно.
  townGeo.setDrawRange(0, 0);
  geoms.push(townGeo);

  const townMat = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: TOWN_PX },
      uRef: { value: TOWN_REF },
      uDpr: { value: 1 },
      uMin: { value: TOWN_MIN },
      uMax: { value: TOWN_MAX },
    },
    vertexShader: TOWN_VERT,
    fragmentShader: TOWN_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  mats.push(townMat);

  const tints = COLORS.town.length;
  const rgb = new Float32Array(tints * 3);
  for (let i = 0; i < tints; i++) {
    _mk.set(COLORS.town[i]);
    rgb[i * 3] = _mk.r;
    rgb[i * 3 + 1] = _mk.g;
    rgb[i * 3 + 2] = _mk.b;
  }

  const pts = new THREE.Points(townGeo, townMat);
  pts.frustumCulled = false;
  pts.renderOrder = 7;
  group.add(pts);

  const townRes: TownRes = {
    geo: townGeo,
    pos,
    col,
    posAttr,
    colAttr,
    mat: townMat,
    rgb,
    tints,
    cap: townCap,
  };

  const dispose = () => {
    // InstancedMesh.dispose освобождает буферы инстансов; геометрия и материал
    // общие и снимаются отдельно. Авто-освобождения при размонтировании больше
    // нет ни у кого — всё вручную.
    posts.dispose();
    if (glow) glow.dispose();
    if (pool) pool.dispose();
    for (const m of mats) m.dispose();
    for (const geo of geoms) geo.dispose();
    for (const t of texs) t.dispose();
  };

  return { group, posts, glow, pool, townRes, lampCap, dispose };
}

/* ---------- контекст обходов ---------- */

/**
 * Колбэки итераторов создаются один раз в фабрике и читают отсюда: замыкание,
 * созданное в кадре, — это аллокация в кадре. Поля заполняются в начале
 * `update`, живут ровно один синхронный обход.
 */
interface WalkCtx {
  camS: number;
  camX: number;
  t: number;
  calm: boolean;
  dim: number;
  stretch: number;
  lampFar: number;
  townFar: number;
  /** Тангенсы половин углов пирамиды видимости с запасом. */
  spreadX: number;
  spreadY: number;
  nLamp: number;
  /** Сколько фонарей попало в радиус светового пятна (всегда префикс `nLamp`). */
  nPool: number;
  nTown: number;
}

/** Покадровая анимация слоя: своя, не из `Game`. */
interface Anim {
  t: number;
  /** Общая приглушённость: на скорости свет смазывается. */
  dim: number;
  /** Растяжение светового пятна вдоль дороги на скорости. */
  stretch: number;
}

/* ---------- система ---------- */

export interface LightsDeps {
  /** Обход фонарей в [s0, s1]; `cb` получает один переиспользуемый объект. */
  lamps: (s0: number, s1: number, cb: (l: Lamp) => void) => void;
  /** Обход огней городка в [s0, s1]; `cb` получает один переиспользуемый объект. */
  town: (s0: number, s1: number, cb: (t: TownLight) => void) => void;
}

export function createLights(ctx: RenderCtx, deps: LightsDeps): System {
  const res = buildLights(ctx.quality);

  const anim: Anim = { t: 0, dim: 1, stretch: 1 };

  const walk: WalkCtx = {
    camS: 0,
    camX: 0,
    t: 0,
    calm: false,
    dim: 1,
    stretch: 1,
    lampFar: 620,
    townFar: 850,
    spreadX: 1.2,
    spreadY: 0.98,
    nLamp: 0,
    nPool: 0,
    nTown: 0,
  };

  function onLamp(l: Lamp): void {
    if (walk.nLamp >= res.lampCap) return;
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
    // Спад отодвинут почти к границе дальности: цепочка должна доживать до тумана.
    let bri = smoothstep(walk.lampFar, walk.lampFar * 0.72, d) * smoothstep(-2, 26, d);
    if (!walk.calm && hash1(key + 7) > 0.86) {
      // Каждый седьмой фонарь на издыхании: натриевая лампа мигает.
      bri *= 0.78 + 0.22 * Math.sin(walk.t * 19 + h * 40);
    }
    bri *= walk.dim;

    const z = localZ(s, camS);

    /* мачта */
    _pos.set(localX(s, side * POST_X, camS, camX), localY(s, 0, camS), z);
    _scl.set(1, sc, 1);
    _m4.compose(_pos, side > 0 ? _qi : _qFlip, _scl);
    res.posts.setMatrixAt(i, _m4);
    const fade = lerp(0.2, 1, smoothstep(walk.lampFar * 0.9, 45, d));
    _col.setRGB(fade, fade, fade);
    res.posts.setColorAt(i, _col);

    /* ореол головы: плоскость смотрит в +Z. Камера стоит в начале координат и
       смотрит в −Z, отклоняясь на единицы градусов, — настоящий билборд на
       инстанс тут не окупается, разница меньше пикселя. */
    if (res.glow) {
      const size = d * GLOW_MIN_ANG > GLOW_SIZE ? d * GLOW_MIN_ANG : GLOW_SIZE;
      _pos.set(
        localX(s, side * HEAD_X, camS, camX),
        localY(s, HEAD_Y * sc, camS),
        z + GLOW_Z_BIAS,
      );
      _scl.set(size, size, 1);
      _m4.compose(_pos, _qi, _scl);
      res.glow.setMatrixAt(i, _m4);
      const gb = bri * GLOW_GAIN;
      _col.setRGB(gb, gb, gb);
      res.glow.setColorAt(i, _col);
    }

    /* пятно на асфальте: квад кладётся на полотно и доворачивается на уклон
       дороги — без этого дальний край восемнадцатиметрового эллипса уходит под
       асфальт на подъёме и обрезается тестом глубины. Курс не отрабатываем:
       размытое пятно повёрнутым не читается.

       Обход идёт по возрастанию дистанции, поэтому «ближе POOL_FAR» — всегда
       префикс списка фонарей: достаточно счётчика, отдельный слот не нужен. */
    if (res.pool && d < POOL_FAR) {
      walk.nPool = i + 1;
      // Уклон дороги не превышает 0.038 рад, поэтому кватернион поворота вокруг X
      // на (−π/2 + p) собирается из малых углов напрямую: sin(p/2) ≈ p/2,
      // cos(p/2) ≈ 1. Ошибка нормы ~2e-4 — для размытого пятна ничто, зато это
      // шесть тригонометрических вызовов на фонарь, которых больше нет.
      const hp = roadDY(s) * 0.5;
      _q.set(Q_HALF * (hp - 1), 0, 0, Q_HALF * (hp + 1));
      _pos.set(localX(s, side * POOL_X, camS, camX), localY(s, POOL_Y, camS), z);
      _scl.set(POOL_W, POOL_L * walk.stretch, 1);
      _m4.compose(_pos, _q, _scl);
      res.pool.setMatrixAt(i, _m4);
      const pb = bri * POOL_GAIN * smoothstep(POOL_FAR, POOL_FAR * 0.28, d);
      _col.setRGB(pb, pb, pb);
      res.pool.setColorAt(i, _col);
    }
  }

  function onTown(t: TownLight): void {
    const tr = res.townRes;
    if (!tr || walk.nTown >= tr.cap) return;

    const camS = walk.camS;
    const depth = t.s - camS;
    if (depth < TOWN_NEAR || depth > walk.townFar) return;
    const lx = localX(t.s, t.lane, camS, walk.camX);
    const ly = localY(t.s, t.y, camS);
    const limX = depth * walk.spreadX;
    const limY = depth * walk.spreadY;
    if (lx > limX || lx < -limX || ly > limY || ly < -limY) return;

    const dist = Math.sqrt(lx * lx + ly * ly + depth * depth);
    // Спад к границе дальности короткий (последние ~14%): гроздь на горизонте —
    // это и есть кадр f_007, гасить её на половине дистанции нечем оправдать.
    let b =
      smoothstep(walk.townFar, walk.townFar * 0.86, depth) *
      smoothstep(TOWN_NEAR, TOWN_NEAR * 2.2, depth) *
      lerp(1, 0.72, smoothstep(300, 1000, dist));
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

  return {
    object: res.group,

    update(g: Game, rawDt: number, rc: RenderCtx) {
      const dt = rawDt > DT_MAX ? DT_MAX : rawDt;
      anim.t += dt;

      const speedFrac = clamp01(g.speed / PHYS.speedMax);
      anim.dim = damp(anim.dim, 1 - 0.14 * speedFrac, 2.2, dt);
      anim.stretch = damp(anim.stretch, 1 + 0.35 * speedFrac, 2.6, dt);

      // Границы кадра берутся у самой камеры: FOV гуляет на нитро, аспект — на
      // повороте телефона, а на первом кадре канвас может быть ещё 0×0 и отдать
      // нулевой или нечисловой аспект. Отсев по фиксированной константе на
      // портретном экране выбрасывал видимые огни и пропускал невидимые.
      const cam = rc.camera;
      let tanY = TOWN_TAN_FALLBACK;
      let asp = TOWN_ASPECT_FALLBACK;
      if (cam.fov > 0 && cam.fov < 180) tanY = Math.tan((cam.fov * Math.PI) / 360);
      if (cam.aspect > 0 && cam.aspect < 100) asp = cam.aspect;

      walk.camS = g.s;
      walk.camX = g.x;
      walk.t = anim.t;
      walk.calm = g.reducedMotion;
      walk.dim = anim.dim;
      walk.stretch = g.reducedMotion ? 1 : anim.stretch;
      walk.lampFar = LAMP_FAR[g.quality];
      walk.townFar = TOWN_FAR[g.quality];
      walk.spreadX = tanY * asp * TOWN_MARGIN_X;
      walk.spreadY = tanY * TOWN_MARGIN_Y;
      walk.nLamp = 0;
      walk.nPool = 0;
      walk.nTown = 0;

      /* --- фонари: обход идёт от камеры вперёд, поэтому пул сначала забирают
             ближние; когда слоты кончились, дальние просто не рисуются --- */
      deps.lamps(g.s - LAMP_BEHIND, g.s + walk.lampFar, onLamp);
      const nLamp = walk.nLamp;
      res.posts.count = nLamp;
      if (nLamp > 0) {
        res.posts.instanceMatrix.needsUpdate = true;
        if (res.posts.instanceColor) res.posts.instanceColor.needsUpdate = true;
      }
      if (res.glow) {
        res.glow.count = nLamp;
        if (nLamp > 0) {
          res.glow.instanceMatrix.needsUpdate = true;
          if (res.glow.instanceColor) res.glow.instanceColor.needsUpdate = true;
        }
      }
      if (res.pool) {
        res.pool.count = walk.nPool;
        if (walk.nPool > 0) {
          res.pool.instanceMatrix.needsUpdate = true;
          if (res.pool.instanceColor) res.pool.instanceColor.needsUpdate = true;
        }
      }

      /* --- городок --- */
      const tr = res.townRes;
      if (tr) {
        deps.town(g.s, g.s + walk.townFar, onTown);
        const used = walk.nTown;
        tr.geo.setDrawRange(0, used);
        if (used > 0) {
          tr.posAttr.needsUpdate = true;
          tr.colAttr.needsUpdate = true;
        }
        tr.mat.uniforms.uDpr.value = rc.renderer.getPixelRatio();
      }
    },

    dispose() {
      res.dispose();
    },
  };
}
