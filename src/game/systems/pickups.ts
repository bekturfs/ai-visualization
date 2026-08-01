/**
 * Бонусы над дорогой: звёзды-искры (очки + немного нитро) и канистры нитро.
 *
 * Всё состояние берётся из `g.pickups` — пул фиксированного размера
 * `LIMITS.pickups`. Ничего своего про мир этот модуль не знает и не хранит:
 * спавн и подбор — дело `worldGen` и `engine`, здесь только отрисовка.
 *
 * ЗАЧЕМ ВСЁ ЭТО. Бонус, который не видно за 250 м, не бонус: на 250 км/ч
 * (69 м/с) от решения «еду за звездой» до перестроения через две полосы
 * проходит около двух секунд, то есть 140 м, и это уже без времени на то,
 * чтобы её заметить. Поэтому здесь всё подчинено одному: звезда обязана
 * читаться на горизонте.
 *
 * ПОЧЕМУ РАНЬШЕ НЕ ЧИТАЛАСЬ. Бонус висит на `PICKUPS.y` = 1.5 м, глаз водителя
 * на `CAM.height` = 1.16 м, то есть всего на 34 см выше линии взгляда: на любой
 * дистанции он садится ровно на горизонт, в самую светлую и шумную полосу кадра.
 * Дальше добивала минификация: ореол размером 1.8 м на 200 м — это 8 экранных
 * пикселей, а текстура ореола — 128². GPU берёт мип-уровень 4, где от блика
 * остаётся средняя альфа по всему квадрату, и вместо звезды в кадре ровный
 * тусклый прямоугольник (именно он и виден в q2-a.png). Лечится не яркостью, а
 * УГЛОВЫМ РАЗМЕРОМ: ореол и шахта растут с дистанцией как `d^p`, экранный
 * размер держится в районе 12…37 px, мип не уходит глубже второго, форма
 * блика выживает. Остаток переусреднения добирается множителем `MIP_BOOST`.
 *
 * ЗВЕЗДА ≠ КАНИСТРА. Их нельзя путать: одна стоит вылазки на встречку, вторая
 * нет. Различия сложены так, чтобы работать по отдельности на любой дистанции:
 *   - цвет: тёплое золото `COLORS.combo` против мятного `COLORS.nitro`;
 *   - ореол: жёсткий четырёхлучевой блик (тот самый из кадра f_001) против
 *     круглого свечения с кольцом;
 *   - тело: колючая шестилучевая искра против гладкой наклонённой капсулы.
 *
 * СЛОИ, все аддитивные (ночь, неон, bloom), ни одной аллокации в кадре:
 *   1. ТЕЛО — InstancedMesh искры и InstancedMesh капсулы, вершинный цвет
 *      вместо освещения.
 *   2. ОРЕОЛ — аддитивный квад за телом, свой на каждый вид бонуса.
 *   3. ШАХТА СВЕТА — тонкий вертикальный квад от полотна до бонуса и чуть выше.
 *      Ореол говорит «здесь бонус», шахта — «вот в этой полосе»: висящее у
 *      горизонта пятно само по себе не показывает, куда рулить.
 *
 * ВСПЫШКА ПРИ ПОДБОРЕ живёт в отдельном кольце `POPS` инстансов, а не в слоте
 * пула. Так и должно быть: `worldGen` освобождает слот собранного бонуса, как
 * только тот на 6 м позади камеры (на максималке это 0.13 с, вдвое меньше
 * `POP_TIME`), и слот тут же уходит под новый бонус. Вспышка, привязанная к
 * слоту, обрывалась бы на середине. Кольцо хранит снимок (вид, полоса, фаза) и
 * доигрывает свои 0.25 с само, придерживая картинку перед капотом.
 *
 * ЦЕНА. Инстансы упакованы подряд, `mesh.count` режет хвост: пустые слоты не
 * стоят ни вершины, ни байта загрузки, а в кадре обычно живых бонусов 3…6 из 24.
 * Время берётся из `g.t`, а не из часов кадра, поэтому пауза честно
 * останавливает и вращение, и вспышку.
 *
 * ПОСЛЕ УХОДА REACT. Ресурсы собираются один раз в теле фабрики (раньше это
 * делал ref-холдер, обходивший двойной монтаж StrictMode), кадр — это тело
 * `update`, а освобождение — `dispose`: без r3f никто больше не освобождает
 * геометрию и материалы за нас, поэтому каждый созданный ресурс перечислен
 * явно. Вся память про слоты (`seenId`, `done`), вспышки (`pops`) и игровое
 * время (`anim`) живёт в замыкании фабрики, а не в модуле: две системы, если их
 * когда-нибудь создадут, не будут стирать состояние друг другу. Модульными
 * остались только скретч-объекты матриц и цветов — в них ничего не переживает
 * один синхронный вызов `update`.
 */

import * as THREE from "three";

import type { RenderCtx, System } from "../ctx";
import type { Game, Pickup } from "../types";
import { COLORS, LIMITS, PICKUPS, QUALITY } from "../config";
import { localX, localY, localZ } from "../road";
import { clamp01, lerp, smoothstep } from "../num";

/* ---------- пул ---------- */

const TAU = Math.PI * 2;

/** Слотов ровно столько, сколько в пуле игры. */
const POOL = LIMITS.pickups;

/** Сколько вспышек подбора может гореть одновременно. Больше не бывает: они
 *  живут по четверти секунды, а бонусы стоят в 22 м друг от друга. */
const POPS = 4;

/** Ёмкость инстансных буферов тел и ореолов. */
const CAP = POOL + POPS;

/* ---------- размеры и темп ---------- */

/** Искра: длина короткого луча, м (длинный по Y — в полтора раза). */
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
 * На каком расстоянии перед камерой доигрывает вспышка, м. Бонус подбирается в
 * упор (`PICKUPS.grabS` — 3.2 м) и мгновенно уезжает за камеру, так что её
 * приходится придержать перед капотом — иначе её просто никто не увидит.
 */
const POP_HOLD = 7;

/* ---------- дальность ---------- */

/** Дальность отрисовки по пресетам качества, м. */
const FAR: readonly number[] = [420, 700, 900];
/** Насколько метров позади камеры бонус ещё имеет смысл рисовать. */
const NEAR_CUT = -3;

/* ---------- угловая компенсация ---------- */

/**
 * Тело: с `BODY_D0` метров растёт как корень из дистанции. Ближе — честный
 * размер (именно он определяет вид бонуса, когда до него уже долетаешь),
 * дальше — искра не сваливается в мерцающий субпиксель.
 */
const BODY_D0 = 55;
const BODY_POW = 0.5;
const BODY_MAX = 4;

/** Ореол: базовый размер, м, и закон роста — почти постоянный угловой размер. */
const HALO_SIZE = 1.7;
const HALO_D0 = 26;
const HALO_POW = 0.72;
const HALO_MAX = 11;
/**
 * Ореол приподнят над телом на эту долю своего размера. Вблизи это 27 см и
 * незаметно, вдали — несколько метров, и блик выходит из полосы горизонта,
 * где его иначе съедает и туман, и фары встречных.
 */
const HALO_LIFT = 0.16;

/**
 * Шахта света: ширина у камеры, м, и её рост с дистанцией. Рост ограничен
 * жёстко: шахта обязана оставаться столбиком выше, чем шире, иначе на 300 м
 * она превращается в такое же пятно, как ореол, и перестаёт что-либо говорить
 * про полосу.
 */
const SHAFT_W = 0.42;
const SHAFT_D0 = 30;
const SHAFT_POW = 0.75;
const SHAFT_MAX = 3;
/** На сколько метров шахта поднимается выше бонуса. */
const SHAFT_UP = 1;
/** Полная высота шахты, м: от полотна и с запасом над бонусом. */
const SHAFT_H = PICKUPS.y + SHAFT_UP;
/** Доля высоты, на которой сидит бонус: там у текстуры пик яркости. */
const SHAFT_VP = PICKUPS.y / SHAFT_H;

/* ---------- яркости ---------- */

/** Уходят в instanceColor, поэтому спокойно бывают больше единицы. */
const STAR_GAIN = 1.5;
const CAN_GAIN = 1.35;
const HALO_GAIN = 0.85;
const SHAFT_GAIN = 0.55;
/**
 * Компенсация мип-усреднения: на дистанции квад читается уже не пиком
 * текстуры, а её средним по мипу, и это в разы темнее. Разгоняем яркость
 * ровно там, где начинается минификация, и не трогаем ближний план.
 */
const MIP_BOOST = 2.4;
const MIP_D0 = 70;
const MIP_D1 = 420;
/** Во сколько раз ореол ярче обычного в первый кадр вспышки. */
const POP_FLASH = 2.2;

/** Порядок отрисовки: поверх дороги (до 5) и фонарей (до 8). */
const ORDER_SHAFT = 9;
const ORDER_HALO = 10;
const ORDER_BODY = 11;

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

/**
 * Во сколько раз растянуть элемент на дистанции `d`, чтобы он не растаял.
 * До `d0` — единица: ближний план должен иметь честный размер.
 */
function angGain(d: number, d0: number, p: number, max: number): number {
  if (d <= d0) return 1;
  const k = Math.pow(d / d0, p);
  return k > max ? max : k;
}

/* ---------- текстуры ---------- */

/** Контекст canvas или `null`, если рисовать негде (SSR, нулевой размер). */
function ctx2d(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = Math.max(4, w | 0);
  cv.height = Math.max(4, h | 0);
  return cv.getContext("2d");
}

/** Полуширина луча блика в долях полукадра текстуры. */
const RAY_W = 0.055;

/**
 * Ореол. Всё пишется белым — цвет придёт инстансом.
 *
 * `cross` даёт звезде четырёхлучевой блик (горизонтальный луч длиннее — так он
 * выглядит в кадре f_001 референса), иначе рисуется круглое свечение с кольцом:
 * на дистанции «✳» и «○» не спутать, даже когда обе размером в десяток
 * пикселей и цвет уже сомнителен.
 *
 * Размер намеренно маленький: экранный размер ореола держится в пределах
 * 12…37 px, глубже второго мип-уровня GPU не заходит, и 64² хватает с запасом.
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
      // Срез у края квада: на аддитивном блендинге шов виден сразу.
      const cut = smoothstep(1, 0.42, Math.sqrt(r2));
      let a = (0.95 * Math.exp(-r2 * 30) + 0.42 * Math.exp(-r2 * 3.4)) * cut;
      if (cross) {
        // Знаменатели — квадраты длин лучей: горизонтальный достаёт почти до
        // края квада, вертикальный короче. Длинные лучи нужны не для красоты:
        // под минификацией первым исчезает то, что тоньше и короче.
        const rayH = Math.exp(-(dy * dy) / (RAY_W * RAY_W)) * Math.exp(-(dx * dx) / 0.608);
        const rayV = Math.exp(-(dx * dx) / (RAY_W * RAY_W)) * Math.exp(-(dy * dy) / 0.27);
        a += (0.95 * rayH + 0.68 * rayV) * cut;
      } else {
        // Кольцо: круглое пятно без него на дистанции неотличимо от чего угодно.
        const rd = (Math.sqrt(r2) - 0.52) / 0.1;
        a += 0.42 * Math.exp(-rd * rd) * cut;
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
 * Шахта света: по горизонтали мягкий колокол, по вертикали свеча — тускло у
 * асфальта, пик на высоте бонуса, сход в ноль над ним. Восемь текселей в
 * ширину: на экране шахта никогда не шире пары десятков пикселей, а градиент
 * от этого не страдает.
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
    // верхушка шахты, нижняя — контакт с асфальтом.
    const v = 1 - y / (ch - 1);
    const up =
      (0.3 + 0.7 * smoothstep(0, SHAFT_VP, v)) *
      (1 - smoothstep(SHAFT_VP, 1, v)) *
      smoothstep(0, 0.05, v);
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
 * силуэт остаётся гладким, но объём читается даже одним цветом. Сегментов
 * ровно столько, чтобы силуэт не гранился: на экране канистра почти никогда
 * не крупнее пары сантиметров.
 */
function buildCanGeom(): THREE.BufferGeometry {
  const geo = new THREE.CapsuleGeometry(CAN_R, CAN_H, 3, 8);
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

/* ---------- слой инстансов ---------- */

/**
 * Один InstancedMesh плюс всё, что нужно, чтобы писать в него подряд.
 * Инстансы упаковываются с нуля, `count` режет хвост — незанятые слоты не
 * попадают ни в отрисовку, ни в загрузку буфера.
 */
interface Layer {
  mesh: THREE.InstancedMesh;
  /** Сколько инстансов записано в этом кадре. */
  n: number;
  /** Диапазоны загрузки. По одному объекту на всю жизнь слоя: `addUpdateRange`
   *  аллоцировал бы новый каждый кадр, а three чистит массив после загрузки. */
  mRange: { start: number; count: number };
  cRange: { start: number; count: number };
}

function makeLayer(mesh: THREE.InstancedMesh): Layer {
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Один вызов заводит буфер цветов целиком; нули безобидны — за `count`
  // инстансы всё равно не рисуются, а рисуемым цвет пишется каждый кадр.
  _col.setRGB(1, 1, 1);
  mesh.setColorAt(0, _col);
  mesh.count = 0;
  mesh.visible = false;
  return { mesh, n: 0, mRange: { start: 0, count: 0 }, cRange: { start: 0, count: 0 } };
}

function put(l: Layer, m: THREE.Matrix4, c: THREE.Color): void {
  const i = l.n;
  if (i >= l.mesh.instanceMatrix.count) return;
  l.n = i + 1;
  l.mesh.setMatrixAt(i, m);
  l.mesh.setColorAt(i, c);
}

/** Закрыть слой: выставить `count` и загрузить ровно занятую часть буферов. */
function seal(l: Layer): void {
  const mesh = l.mesh;
  const n = l.n;
  mesh.count = n;
  // Пустой слой прячем целиком: так он не попадает даже в список отрисовки,
  // а это единственное, что у пустого InstancedMesh ещё стоит процессорного
  // времени. Ни байта на GPU при этом тоже не уходит.
  mesh.visible = n > 0;
  if (n === 0) return;
  const im = mesh.instanceMatrix;
  // Диапазон нулевой длины в WebGL2 означает «до конца массива», поэтому
  // границы выставляются только когда есть что грузить.
  if (im.updateRanges.length === 0) im.updateRanges.push(l.mRange);
  l.mRange.start = 0;
  l.mRange.count = n * 16;
  im.needsUpdate = true;
  const ic = mesh.instanceColor;
  if (ic) {
    if (ic.updateRanges.length === 0) ic.updateRanges.push(l.cRange);
    l.cRange.start = 0;
    l.cRange.count = n * 3;
    ic.needsUpdate = true;
  }
}

/* ---------- вспышка подбора ---------- */

/** Снимок собранного бонуса: живёт сам по себе, слот пула ему больше не нужен. */
interface Pop {
  live: boolean;
  star: boolean;
  s: number;
  lane: number;
  spin: number;
  /** Прогресс 0…1. */
  q: number;
}

/* ---------- ресурсы ---------- */

interface World {
  group: THREE.Group;
  starBody: Layer;
  canBody: Layer;
  starHalo: Layer | null;
  canHalo: Layer | null;
  shaft: Layer | null;
  /** Линейные RGB палитры: звезда и канистра. */
  starRGB: Float64Array;
  nitroRGB: Float64Array;
  /** Чей бонус лежал в слоте: смена id — слот переиспользован. */
  seenId: Float64Array;
  /** Вспышка по этому бонусу уже запущена. */
  done: Uint8Array;
  pops: Pop[];
  dispose: () => void;
}

function hexInto(hex: string, out: Float64Array) {
  _mk.set(hex);
  out[0] = _mk.r;
  out[1] = _mk.g;
  out[2] = _mk.b;
}

/** Аддитивный квад с текстурой: ореолы и шахта отличаются только картой. */
function quadLayer(
  tex: THREE.Texture,
  geo: THREE.BufferGeometry,
  order: number,
  cap: number,
  mats: THREE.Material[],
): Layer {
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
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.renderOrder = order;
  return makeLayer(mesh);
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

  const starsMesh = new THREE.InstancedMesh(starGeom, bodyMat, CAP);
  starsMesh.renderOrder = ORDER_BODY;
  const cansMesh = new THREE.InstancedMesh(canGeom, bodyMat, CAP);
  cansMesh.renderOrder = ORDER_BODY;

  const starBody = makeLayer(starsMesh);
  const canBody = makeLayer(cansMesh);

  /* --- квады: ореолы и шахта --- */

  const quadGeom = new THREE.PlaneGeometry(1, 1);
  geoms.push(quadGeom);

  const starTex = haloTex(64, true);
  const canTex = haloTex(64, false);
  const shaftTexture = shaftTex(8, 32);

  let starHalo: Layer | null = null;
  let canHalo: Layer | null = null;
  let shaft: Layer | null = null;

  if (starTex) {
    texs.push(starTex);
    starHalo = quadLayer(starTex, quadGeom, ORDER_HALO, CAP, mats);
  }
  if (canTex) {
    texs.push(canTex);
    canHalo = quadLayer(canTex, quadGeom, ORDER_HALO, CAP, mats);
  }
  if (shaftTexture) {
    texs.push(shaftTexture);
    // Шахта есть только у живых бонусов — вспышке она не нужна.
    shaft = quadLayer(shaftTexture, quadGeom, ORDER_SHAFT, POOL, mats);
  }

  // Шахта уходит под ореолы и тела, порядок в группе повторяет renderOrder.
  if (shaft) group.add(shaft.mesh);
  if (starHalo) group.add(starHalo.mesh);
  if (canHalo) group.add(canHalo.mesh);
  group.add(starBody.mesh, canBody.mesh);

  const starRGB = new Float64Array(3);
  const nitroRGB = new Float64Array(3);
  hexInto(COLORS.combo, starRGB);
  hexInto(COLORS.nitro, nitroRGB);

  const seenId = new Float64Array(POOL);
  seenId.fill(-1);
  const done = new Uint8Array(POOL);
  const pops: Pop[] = [];
  for (let i = 0; i < POPS; i++) {
    pops.push({ live: false, star: true, s: 0, lane: 0, spin: 0, q: 0 });
  }

  const dispose = () => {
    // Без r3f никто не освобождает ресурсы за нас: считаем поимённо.
    // 3 геометрии (искра, капсула, квад), до 4 материалов (тело + три квада),
    // до 3 текстур (два ореола, шахта), 5 InstancedMesh.
    for (const m of mats) m.dispose();
    for (const geo of geoms) geo.dispose();
    for (const t of texs) t.dispose();
    starBody.mesh.dispose();
    canBody.mesh.dispose();
    starHalo?.mesh.dispose();
    canHalo?.mesh.dispose();
    shaft?.mesh.dispose();
    group.clear();
  };

  return {
    group,
    starBody,
    canBody,
    starHalo,
    canHalo,
    shaft,
    starRGB,
    nitroRGB,
    seenId,
    done,
    pops,
    dispose,
  };
}

/* ---------- покадровая раскладка ---------- */

/** Погасить все вспышки. */
function killPops(w: World): void {
  for (let i = 0; i < w.pops.length; i++) w.pops[i].live = false;
}

/** Забыть всё, что помнилось про слоты и вспышки: новый заезд. */
function resetSlots(w: World): void {
  w.seenId.fill(-1);
  w.done.fill(0);
  killPops(w);
}

/** Занять кольцо под новую вспышку. Кольцо полное — гасим самую старую. */
function startPop(w: World, p: Pickup): void {
  const pops = w.pops;
  let slot = -1;
  let oldest = -1;
  for (let i = 0; i < pops.length; i++) {
    if (!pops[i].live) {
      slot = i;
      break;
    }
    if (pops[i].q > oldest) {
      oldest = pops[i].q;
      slot = i;
    }
  }
  const pop = pops[slot];
  pop.live = true;
  pop.star = p.kind === "star";
  pop.s = p.s;
  pop.lane = p.lane;
  pop.spin = p.spin;
  pop.q = 0;
}

/**
 * Тело и ореол в свои слои. Шахта рисуется отдельно: она бывает только у
 * живых бонусов и требует другой позы.
 */
function emit(
  w: World,
  star: boolean,
  px: number,
  py: number,
  pz: number,
  ang: number,
  bodyScale: number,
  bodyB: number,
  haloS: number,
  haloB: number,
): void {
  const rgb = star ? w.starRGB : w.nitroRGB;

  if (star) {
    _eu.set(STAR_LEAN, ang, STAR_LEAN * 0.6, "XYZ");
    const sc = STAR_R * bodyScale;
    _scl.set(sc, sc, sc);
  } else {
    // Лёгкое кувыркание вокруг наклона: капсула перестаёт быть поплавком.
    _eu.set(CAN_TILT * 0.4 * Math.sin(ang * 0.5), ang, CAN_TILT, "XYZ");
    _scl.set(bodyScale, bodyScale, bodyScale);
  }
  _q.setFromEuler(_eu);
  _pos.set(px, py, pz);
  _m4.compose(_pos, _q, _scl);
  _col.setRGB(rgb[0] * bodyB, rgb[1] * bodyB, rgb[2] * bodyB);
  put(star ? w.starBody : w.canBody, _m4, _col);

  /* Ореол: квад смотрит в +Z, камера отклоняется от оси на единицы градусов,
     и честный билборд тут не окупается. */
  const halo = star ? w.starHalo : w.canHalo;
  if (halo && haloB > 0.002) {
    _pos.set(px, py + haloS * HALO_LIFT, pz);
    _scl.set(haloS, haloS, 1);
    _m4.compose(_pos, _qi, _scl);
    // Ядро ореола подбелено: чистый оттенок в центре выглядит краской, а не
    // светом. Подмес маленький — цвет остаётся главным различием видов.
    _col.setRGB(
      lerp(rgb[0], 1, 0.2) * haloB,
      lerp(rgb[1], 1, 0.2) * haloB,
      lerp(rgb[2], 1, 0.2) * haloB,
    );
    put(halo, _m4, _col);
  }
}

interface Anim {
  /** `g.t` прошлого кадра: вспышка живёт по игровому времени, не по кадрам. */
  lastT: number;
  /** Номер заезда прошлого кадра: сменился — всё забыть. */
  runs: number;
}

/* ---------- система ---------- */

/**
 * `ctx` фабрике не нужен: качество и дальность читаются из `g` каждый кадр
 * (`g.quality` меняется на лету, пересборки системы для этого не требуется),
 * а размер холста на бонусы не влияет — поэтому и `resize` здесь нет.
 */
export function createPickups(_ctx: RenderCtx): System {
  const w = buildWorld();
  const anim: Anim = { lastT: 0, runs: -1 };

  return {
    object: w.group,

    update(g: Game): void {
      const preset = QUALITY[g.quality];
      const far = FAR[g.quality];
      // Без bloom бонусы теряют половину читаемости — добираем яркостью.
      const gain = preset.bloom ? 1 : 1.3;
      const calm = g.reducedMotion;
      const camS = g.s;
      const camX = g.x;
      const t = g.t;

      // Новый заезд: `startRun` поднимает `g.runs` и обнуляет `g.t`, а id бонусов
      // начинают считаться заново — то есть старые id могут совпасть с новыми.
      // Поэтому память о слотах и недогоревшие вспышки сбрасываются целиком.
      if (anim.runs !== g.runs || t < anim.lastT) {
        anim.runs = g.runs;
        resetSlots(w);
      }
      // В меню и на экране конца `g.t` стоит: вспышка, начатая последним кадром
      // заезда, иначе зависла бы перед капотом до самого рестарта.
      if (g.phase === "over" || g.phase === "menu") killPops(w);

      // Шаг игрового времени: на паузе он ноль — вспышка честно замирает.
      let dtG = t - anim.lastT;
      if (!(dtG > 0)) dtG = 0;
      else if (dtG > 0.2) dtG = 0.2;
      anim.lastT = t;

      w.starBody.n = 0;
      w.canBody.n = 0;
      if (w.starHalo) w.starHalo.n = 0;
      if (w.canHalo) w.canHalo.n = 0;
      if (w.shaft) w.shaft.n = 0;

      const list = g.pickups;
      const n = list.length < POOL ? list.length : POOL;

      for (let i = 0; i < n; i++) {
        const p = list[i];

        // Слот переиспользован под новый бонус — память о нём обнуляется.
        if (w.seenId[i] !== p.id) {
          w.seenId[i] = p.id;
          w.done[i] = 0;
        }

        if (p.taken) {
          // Ровно один раз на бонус: дальше вспышка живёт в кольце, а слот
          // свободен и может хоть в этом же кадре уйти под следующий бонус.
          if (!w.done[i]) {
            w.done[i] = 1;
            startPop(w, p);
          }
          continue;
        }
        if (!p.active) continue;

        const d = p.s - camS;
        if (d <= NEAR_CUT || d >= far) continue;

        const star = p.kind === "star";
        const fade = smoothstep(far, far * 0.72, d) * smoothstep(NEAR_CUT, 2, d);
        // Пульсация — это строб, в спокойном режиме её нет.
        const puls = calm ? 1 : 1 + 0.16 * Math.sin(t * 3.4 + p.spin * 2.1);
        const mip = 1 + (MIP_BOOST - 1) * smoothstep(MIP_D0, MIP_D1, d);

        const y = PICKUPS.y + (calm ? 0.05 : BOB_AMP) * Math.sin(t * BOB_W + p.spin);
        const px = localX(p.s, p.lane, camS, camX);
        const pz = localZ(p.s, camS);

        emit(
          w,
          star,
          px,
          localY(p.s, y, camS),
          pz,
          p.spin + t * SPIN_W * (star ? 1 : 0.72) * (calm ? 0.5 : 1),
          angGain(d, BODY_D0, BODY_POW, BODY_MAX),
          fade * puls * (star ? STAR_GAIN : CAN_GAIN) * gain,
          (star ? HALO_SIZE : HALO_SIZE * 0.86) * angGain(d, HALO_D0, HALO_POW, HALO_MAX),
          fade * puls * HALO_GAIN * gain * mip,
        );

        /* --- шахта света: показывает полосу, в которой висит бонус --- */
        if (w.shaft) {
          // Окно, в котором она нужна: дальше 320 м игрок читает только ореол и
          // решает «ехать или нет», ближе 26 м бонус и так занимает пол-экрана.
          // Между ними идёт перестроение — вот там и надо показать полосу.
          const b = SHAFT_GAIN * gain * smoothstep(26, 55, d) * smoothstep(320, 200, d);
          if (b > 0.002) {
            const wide = SHAFT_W * angGain(d, SHAFT_D0, SHAFT_POW, SHAFT_MAX);
            _pos.set(px, localY(p.s, SHAFT_H * 0.5, camS), pz);
            _scl.set(wide, SHAFT_H, 1);
            _m4.compose(_pos, _qi, _scl);
            const rgb = star ? w.starRGB : w.nitroRGB;
            _col.setRGB(rgb[0] * b, rgb[1] * b, rgb[2] * b);
            put(w.shaft, _m4, _col);
          }
        }
      }

      /* --- вспышки подбора --- */
      for (let i = 0; i < w.pops.length; i++) {
        const pop = w.pops[i];
        if (!pop.live) continue;
        const q = pop.q + dtG / POP_TIME;
        if (q >= 1) {
          pop.live = false;
          continue;
        }
        pop.q = q;

        const k = 1 - q;
        const k2 = k * k;
        // Бонус уже за камерой: придерживаем вспышку перед капотом.
        const sPos = pop.s < camS + POP_HOLD ? camS + POP_HOLD : pop.s;
        // Дорожка звёзд идёт с шагом 22 м — на максималке это вспышка каждые
        // 0.3 с. В спокойном режиме такая очередь читается как строб, поэтому
        // там она тише и почти не раздувается.
        emit(
          w,
          pop.star,
          localX(sPos, pop.lane, camS, camX),
          localY(sPos, PICKUPS.y + POP_RISE * q, camS),
          localZ(sPos, camS),
          pop.spin + t * SPIN_W + q * 5.5,
          1 + (calm ? 0.7 : 1.7) * q,
          k2 * 1.7 * (pop.star ? STAR_GAIN : CAN_GAIN) * gain,
          HALO_SIZE * (1 + (calm ? 0.9 : 2.2) * q),
          k2 * POP_FLASH * gain * (calm ? 0.45 : 1),
        );
      }

      seal(w.starBody);
      seal(w.canBody);
      if (w.starHalo) seal(w.starHalo);
      if (w.canHalo) seal(w.canHalo);
      if (w.shaft) seal(w.shaft);
    },

    dispose() {
      w.dispose();
    },
  };
}
