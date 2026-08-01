/**
 * Трафик: кузова, фары, стопы и — главное — световые полосы.
 *
 * В референсе (кадры f_001, f_007) встречная машина почти не машина: пара
 * жёстких белых точек и длинная неоново-синяя лента, которая тянется от
 * бампера до самой точки схода и занимает половину кадра. Именно лента держит
 * весь образ, поэтому она здесь не украшение, а основной слой; кузов нужен
 * только чтобы силуэт не пропадал вблизи.
 *
 * Слои (по одному InstancedMesh на роль, матрицы переписываются каждый кадр):
 *   1. кузова      — слитая геометрия «шасси + будка», почти чёрная, со слабым
 *                    синим кантом по крыше (отсвет неба), чтобы читался силуэт;
 *   2. стопы       — два маленьких аддитивных квада + широкий тусклый ореол;
 *   3. фары        — два жёстких квада с пересветом (их и подхватывает bloom)
 *                    + тёплый ореол, тем меньший, чем ближе машина;
 *   4. ленты       — по две на машину (по одной на фонарь), выгнутым сечением
 *                    на высоте фонарей.
 *
 * Про ленты — пять решений, которые стоит объяснить:
 *
 *   • лента разбита на сегменты ФИКСИРОВАННОЙ длины (`TRAIL_STEP`), а не на
 *     фиксированное их число. Один квад на две сотни метров был бы прямым, а
 *     дорога на этой длине уводит вбок до 25 м — след ушёл бы с полотна в
 *     воздух. Постоянный шаг важнее постоянного числа: и кривизна отрабатывается
 *     одинаково на любой длине, и короткому красному следу не нужно платить за
 *     сегменты длинного синего — он просто берёт их меньше.
 *
 *   • затухание и сужение — геометрические прогрессии ПО СЕГМЕНТУ, а не по всей
 *     ленте. Сегмент k получает q^k, а сам квад внутри себя гаснет ровно в q
 *     раз, так что стык непрерывен при любом числе сегментов.
 *
 *   • сечение — не плоский квад, а дуга шириной ~1.5 м и высотой ~0.45 м на
 *     высоте фонарей. Плоская лента на асфальте с глаз водителя (1.16 м) видна
 *     под скользящим углом и схлопывается в ниточку — ровно то, чем наш кадр
 *     проигрывал референсу. Дуге есть что показать в ближнем поле.
 *
 *   • лента начинается не у машины, а немного впереди неё (`TRAIL_LEAD`).
 *     Строго «за кормой» она правильна как выдержка, но уходит от камеры и
 *     схлопывается в точку схода: встречная в тридцати метрах давала полосу в
 *     полсотни пикселей — то, чем наш кадр и проигрывал референсу. Подробности
 *     у самой константы.
 *
 *   • яркость подобрана под ACES: сцена рисуется в HDR и тонмапится один раз в
 *     `OutputPass`, а ACES обесцвечивает всё ярче ~1.5. Поэтому широкая «юбка»
 *     ленты держится около 0.4–0.7 (там синий остаётся синим), и только узкое
 *     ядро уходит в пересвет и белеет — как в референсе, где у полосы белое
 *     сердце в насыщенном голубом ореоле.
 *
 * ## Почему ленты НЕ переехали на `meshline`
 *
 * Переезд был задан как часть порта, и он был проверен, а не отклонён с ходу:
 * прочитан шейдер `meshline@3.3.1`, посчитана его арифметика ширины и измерено
 * поведение `setPoints`. Три замера против, и все три — не вкусовые.
 *
 *   1. **`setPoints` нельзя звать в кадре.** «Переиспользует буфер, если длина
 *      не изменилась» верно только про объект `BufferAttribute`: сами данные
 *      пересобираются с нуля. Повторный вызов той же длины (11 точек) — семь
 *      новых типизированных массивов (1264 Б), восемь обычных массивов, набитых
 *      через `push`, плюс `computeBoundingSphere` и `computeBoundingBox`. На 24
 *      лентах при 60 кадрах это 10080 массивов и 1.7 МБ мусора в секунду —
 *      против правила «ноль аллокаций в `update`». Обойти можно, только вписывая
 *      `attributes.position/previous/next` мимо API, то есть взяв от meshline
 *      один вершинный шейдер.
 *
 *   2. **Цвет у `MeshLineMaterial` — юниформа, а не атрибут.** Ни вершинных
 *      цветов, ни инстансинга: цвет и яркость ленты живут в материале. А у нас
 *      они свои у каждой ленты (синий/красный × яркость от относительной
 *      скорости и дистанции). Значит — свой материал и свой вызов отрисовки на
 *      ленту: с одного до 56 в пределе, 14–24 в типичном кадре. Кадр и так
 *      признан тяжёлым (`PROGRESS.md`, пункт 1 недоделанного), и плотность
 *      трафика по ходу заезда только растёт.
 *
 *   3. **Ширина у meshline анизотропна по соотношению сторон.** В шейдере
 *      `finalPosition` домножен на `aspect` целиком, а делится на `resolution`
 *      покомпонентно, и горизонтальная линия выходит в `1/aspect` раз толще
 *      вертикальной. Замер при `lineWidth = 1`: портрет 390×844 — 0.815 px
 *      против 0.377 px (×2.16), десктоп 1920×1080 — 0.212 px против 0.377 px
 *      (×0.56). Наши полосы почти горизонтальны, то есть одна и та же константа
 *      дала бы в портрете полосы в 3.8 раза толще, чем на десктопе. Снаружи
 *      шейдера это не лечится.
 *
 * И четвёртое, уже про сам образ: постоянной экранной ширины у полос в рилe
 * нет. На f_005 и f_007 каждая полоса заметно сужается к точке схода — она
 * держит не толщину, а ЯРКОСТЬ, и держит её за счёт аддитивного ядра, которое
 * у нас уже есть. Плоская экранная лента вдобавок стоила бы дуги сечения и
 * профиля «узкое ядро — широкая юбка» (у meshline поперёк ленты цвет
 * постоянный), а дуга — это ровно та правка, которой ленты вообще стали видны
 * с высоты глаз водителя.
 *
 * Итог: инстансные квады остаются как были, до константы. Что честно теряется —
 * непрерывная полилиния вместо цепочки сегментов; но сегменты стыкуются без
 * ступеньки по построению (см. `buildTrailGeom`), так что шва там и нет.
 * Ширина не зависит от размера холста, поэтому `resize` системе не нужен.
 *
 * Модуль ничего не мутирует в `g` и не считает столкновения — это дело
 * `engine.ts`. Аллокаций в кадре нет: матрицы, векторы и цвета подняты в
 * модульный скретч, пулы фиксированы под пресет качества, а неиспользованные
 * слоты не прячутся нулевым масштабом, а просто отсекаются `mesh.count` —
 * их не касается ни вершинный шейдер, ни растеризатор.
 *
 * Размер пулов берётся из пресета **на сборке** (`QUALITY[ctx.quality]`). Смена
 * качества — это пересборка системы в `main.ts`, а не изменение пулов на ходу.
 */

import * as THREE from "three";

import type { RenderCtx, System } from "../ctx";
import type { Quality } from "../types";
import { BOX, COLORS, FOG, LIMITS, PHYS, QUALITY } from "../config";
import { roadHeading, roadPitch, roadX, roadY } from "../road";
import { clamp, clamp01, damp, smoothstep } from "../num";

/* ---------- габариты и раскладка ---------- */

/** Высота кузова по `CarKind`: седан, фургон, фура. */
const CAR_H: readonly number[] = [1.42, 2.5, 3.9];
/** Высота фонарей над полотном по `CarKind`. */
const LAMP_Y: readonly number[] = [0.58, 0.74, 1.04];
/** Разнос фонарей — доля полуширины кузова. */
const LAMP_X = 0.74;

/** Дальность отрисовки машин по пресетам качества, м. Не больше `FOG.far`. */
const CAR_FAR: readonly number[] = [420, 720, 940];
/** Сколько метров позади камеры машина ещё нужна (её лента уходит вперёд). */
const CAR_BEHIND = 70;
/** Дальше этого кузов — четыре пикселя почти чёрного: не считаем матрицу вовсе. */
const BODY_FAR = 175;
/** Позади этого кузов заведомо вне кадра. */
const BODY_BEHIND = 14;

/** Базовые размеры квадов света, м. */
const HEAD_CORE = 0.3;
const HEAD_HALO = 1.5;
const TAIL_CORE = 0.24;
const TAIL_HALO = 1.15;

/**
 * Яркости (уходят в instanceColor, поэтому свободно больше единицы). Ядро фары
 * специально уводится в пересвет: bloom режет по 0.24 линейной яркости, и
 * именно из клиппинга он делает луч.
 */
const HEAD_CORE_GAIN = 4.2;
const HEAD_HALO_GAIN = 1.2;
const TAIL_CORE_GAIN = 2.2;
const TAIL_HALO_GAIN = 0.8;

/** Раздувание огня с дистанцией, чтобы дальний не проваливался в полпикселя. */
const LIGHT_GROW = 230;
const LIGHT_GROW_MAX = 3.4;

/** Амплитуда визуального покачивания машины поперёк полосы, м. */
const SWAY = 0.06;

/* ---------- ленты ---------- */

/** Длина одного сегмента ленты, м. Компромисс: кривизна дороги на 20 м даёт
 *  стрелку прогиба меньше метра, а сегментов на длинный след нужно ещё немного. */
const TRAIL_STEP = 20;
/** Потолок сегментов на ленту по пресетам качества (нулевой не используется). */
const TRAIL_SEGS_MAX: readonly number[] = [0, 7, 10];
/** Пол — иначе медленная ведущая машина осталась бы без следа. */
const TRAIL_SEGS_MIN = 3;
/** Во сколько раз лента гаснет и сужается ЗА ОДИН СЕГМЕНТ. */
const TRAIL_FADE_STEP = 0.845;
const TRAIL_TIP_STEP = 0.945;
/** Высота «валика» сечения, м, и куда его посадить относительно фонарей. */
const TRAIL_ARCH = 0.46;
const TRAIL_ARCH_DROP = 0.52;
/** Ширина ленты у машины, м. */
const TRAIL_W = 1.55;
const TRAIL_W_RED = 1.25;
/** Длина следа = относительная скорость × это время, с. */
const TRAIL_TIME = 1.9;
const TRAIL_TIME_RED = 2.6;
/** Яркости лент (см. комментарий про ACES в шапке). */
const TRAIL_GAIN = 1.95;
const TRAIL_GAIN_RED = 1.45;
/** Относительная скорость, на которой лента набирает полную яркость, м/с. */
const TRAIL_REF = 105;
/**
 * Насколько лента забегает ВПЕРЁД машины, доля своей длины.
 *
 * Строго «за кормой» лента правильна как выдержка, но на экране почти не видна:
 * она уходит от камеры и схлопывается в точку схода — машина в тридцати метрах
 * давала полосу в полсотни пикселей. В референсе (f_007) полосы наоборот идут от
 * горизонта к самым краям кадра, и головы у них нет: ни у одной нет фар на
 * ближнем конце. Значит, полоса там — не строгий след, а размазанный свет, и
 * забег вперёд её честно воспроизводит: у встречной он выносит яркое начало
 * ленты в ближнее поле, где лента широкая, и полоса пересекает кадр.
 * У ведущей забег почти нулевой: её след обязан оставаться позади неё, иначе
 * красное поехало бы нам навстречу.
 */
const TRAIL_LEAD = 0.3;
const TRAIL_LEAD_RED = 0.08;
/**
 * Потолок забега, м. Без него на максималке доля от двухсотметровой ленты
 * выносила бы её начало на шестьдесят метров за спину: самые яркие сегменты
 * уходили бы в клип, и встречная в сорока метрах светила бы половиной силы.
 */
const TRAIL_LEAD_MAX = 38;
/**
 * Ленты живут только в ближней половине видимости: у машины на 400 м лента
 * занимает десяток пикселей у точки схода, но стоит столько же аддитивных
 * квадов, сколько у машины в двадцати метрах. Доли от `CAR_FAR`.
 */
const TRAIL_FAR = 0.38;
const TRAIL_FULL = 0.26;

/**
 * Профиль сечения ленты: семь колонок по дуге. `W` — яркость (узкое ядро,
 * широкая насыщенная юбка), `Y` — высота над базой в долях `TRAIL_ARCH`.
 */
const PROF_X: readonly number[] = [-0.5, -0.33, -0.15, 0, 0.15, 0.33, 0.5];
const PROF_Y: readonly number[] = [0.06, 0.44, 0.85, 1, 0.85, 0.44, 0.06];
const PROF_W: readonly number[] = [0, 0.26, 0.64, 1, 0.64, 0.26, 0];

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

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _norm = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Линейные цвета лент, посчитанные один раз. Синий — почти чистый `neonDeep`:
 * после ACES он единственный из палитры остаётся синим на той яркости, где
 * `neon` уже уходит в белёсый.
 */
const _blue = new THREE.Color(COLORS.neonDeep).lerp(new THREE.Color(COLORS.neon), 0.18);
const _red = new THREE.Color(COLORS.tail);

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
  const c2d = ctx2d(size);
  if (!c2d) return null;
  const w = c2d.canvas.width;
  const img = c2d.createImageData(w, w);
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
 * вдвое длиннее седана и втрое выше — разница видна с одного взгляда.
 *
 * Вершинный цвет — почти чёрная ночь внизу и слабый синий кант по крыше: ночью
 * машину выдаёт не краска, а то, чем небо подсвечивает горизонтальные грани.
 * Подмес намеренно скупой (0.22): в референсе кузова нет вовсе, есть силуэт.
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
    _mk.copy(dark).multiplyScalar(0.8).lerp(rim, t * 0.22);
    cols[i * 3] = _mk.r;
    cols[i * 3 + 1] = _mk.g;
    cols[i * 3 + 2] = _mk.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return geo;
}

/**
 * Сегмент ленты: семь колонок вершин от z = 0 (у машины) до z = −1 (вдаль).
 * Дальний ряд заранее сужен в `TRAIL_TIP_STEP` раз и притушен в
 * `TRAIL_FADE_STEP` — ровно на столько же, во сколько инстансный множитель
 * падает от сегмента к сегменту, поэтому соседние сегменты стыкуются без
 * ступеньки при любом их числе.
 */
function buildTrailGeom(): THREE.BufferGeometry {
  const tp = TRAIL_TIP_STEP;
  const fd = TRAIL_FADE_STEP;
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
  /** Потолок сегментов на одну ленту. */
  segMax: number;
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
  const meshes: THREE.InstancedMesh[] = [];

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
  bodies.renderOrder = 2;
  group.add(bodies);
  meshes.push(bodies);

  /* --- 2. огни --- */

  // 64² хватает обеим ролям: это гладкое пятно, а не текстура с деталью.
  // Ореол раньше был 128² — вчетверо больше выборок мимо кеша ради того же вида.
  const coreTex = radialTex(64, 24, 4.2, 0.26);
  const haloTex = radialTex(64, 6, 1.35, 0.9);
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
    group.add(m);
    meshes.push(m);
  }

  /* --- 3. ленты --- */

  const segMax = preset.trails ? Math.max(2, Math.round(TRAIL_SEGS_MAX[q])) : 0;
  const trailCap = segMax > 0 ? cap * 2 * segMax : 0;
  let trails: THREE.InstancedMesh | null = null;
  if (trailCap > 0) {
    const geo = buildTrailGeom();
    geoms.push(geo);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      // Сечение — дуга: с переломов рельефа её видно и «изнутри».
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    mats.push(mat);
    trails = new THREE.InstancedMesh(geo, mat, trailCap);
    trails.renderOrder = 4;
    group.add(trails);
    meshes.push(trails);
  }

  // Общее для всех пулов: инстансы двигаются каждый кадр, кадрирование делаем
  // сами (машина позади камеры выброшена по `s`, а не по bounding sphere), и
  // ни один слот не рисуется, пока кадр его не заполнил — `count = 0`.
  _col.setRGB(1, 1, 1);
  for (const m of meshes) {
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Один проход, чтобы instanceColor вообще появился: дальше в кадре
    // останется только переписать занятые слоты и пометить буфер грязным.
    for (let i = 0; i < m.count; i++) m.setColorAt(i, _col);
    m.count = 0;
  }

  // Прогрессии сужения и затухания вдоль ленты — считаем один раз, чтобы в
  // кадре не звать Math.pow на каждый сегмент.
  const taper = new Float32Array(Math.max(1, segMax));
  const fade = new Float32Array(Math.max(1, segMax));
  let tAcc = 1;
  let fAcc = 1;
  for (let k = 0; k < taper.length; k++) {
    taper[k] = tAcc;
    fade[k] = fAcc;
    tAcc *= TRAIL_TIP_STEP;
    fAcc *= TRAIL_FADE_STEP;
  }

  const dispose = () => {
    // InstancedMesh держит собственные буферы матриц и цветов — без его
    // `dispose()` они остаются на GPU после смены пресета качества.
    for (const m of meshes) m.dispose();
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
    segMax,
    taper,
    fade,
    cap,
    lampCap,
    trailCap,
    carFar: Math.min(CAR_FAR[q], FOG.far),
    dispose,
  };
}

/* ---------- система ---------- */

/**
 * Кузова, огни и световые ленты трафика. Читает `g.cars` и больше ничего:
 * ни зависимостей от других систем, ни мутаций состояния.
 */
export function createTraffic(ctx: RenderCtx): System {
  const res = buildTraffic(ctx.quality);

  /** Сглаженная скорость игрока: длина лент не должна дёргаться на ударах. */
  let animSpeed: number = PHYS.speedStart;
  /** Номер заезда, на котором сглаживание в последний раз сбрасывали. */
  let animRuns = -1;

  return {
    object: res.group,

    update(g, rawDt) {
      const dt = rawDt > 0.05 ? 0.05 : rawDt;

      // Рестарт обнуляет скорость мгновенно, а сглаживание тянулось бы с прошлого
      // заезда — первые доли секунды нового старта шли бы с чужими длинами лент.
      if (animRuns !== g.runs) {
        animRuns = g.runs;
        animSpeed = g.speed;
      } else {
        animSpeed = damp(animSpeed, g.speed, 5, dt);
      }

      const camS = g.s;
      const camX = g.x;
      // Форма дороги под камерой — общий вычет всех проекций (`localX`/`localY`
      // из road.ts считают её заново на каждый вызов, а вызовов тут сотни).
      const camRX = roadX(camS);
      const camRY = roadY(camS);
      const calm = g.reducedMotion;
      const far = res.carFar;
      const spd = animSpeed;
      const cars = g.cars;
      const segMax = res.segMax;
      const trails = res.trails;
      const trailFar = far * TRAIL_FAR;
      const trailFull = far * TRAIL_FULL;

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
          _pos.set(roadX(c.s) - camRX + lane - camX, roadY(c.s) - camRY, camS - c.s);
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
        const lampRX = roadX(lampS) - camRX - camX;
        const lampY = LAMP_Y[c.kind];
        const lx = hw * LAMP_X;
        const ly = roadY(lampS) - camRY + lampY;
        const lz = camS - lampS;
        const grow = d > 0 ? Math.min(1 + d / LIGHT_GROW, LIGHT_GROW_MAX) : 1;
        // Спад начинается поздно (0.72 от дальности): скопление огней у точки
        // схода — половина образа референса, гасить его рано нельзя.
        const lit = smoothstep(far, far * 0.72, d) * smoothstep(-12, 2, d);

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
            _pos.set(lampRX + lane + side * lx, ly, lz);
            _scl.set(coreSize, coreSize, 1);
            _m4.compose(_pos, _qi, _scl);
            coreMesh.setMatrixAt(coreN, _m4);
            coreMesh.setColorAt(coreN, _col);
            coreN++;
          }
          if (onc) nHeadCore = coreN;
          else nTailCore = coreN;

          // Вблизи ореол сжимается: его работа — сделать читаемым ДАЛЬНИЙ огонь,
          // а в двух десятках метров всё держат ядра, и полноразмерный ореол там
          // только заливает половину полосы диском и жжёт филрейт.
          const haloSize =
            (onc ? HEAD_HALO : TAIL_HALO) *
            grow *
            (0.62 + hw * 0.42) *
            (0.45 + 0.55 * smoothstep(6, 45, d));
          const haloGain =
            (onc ? HEAD_HALO_GAIN * flick : TAIL_HALO_GAIN * shimmer) * lit;
          const haloMesh = onc ? res.headHalo : res.tailHalo;
          const haloN = onc ? nHeadHalo : nTailHalo;
          if (haloN < res.cap) {
            _pos.set(lampRX + lane, ly, lz);
            _scl.set(haloSize * 1.2, haloSize, 1);
            _m4.compose(_pos, _qi, _scl);
            haloMesh.setMatrixAt(haloN, _m4);
            _col.setRGB(haloGain, haloGain, haloGain);
            haloMesh.setColorAt(haloN, _col);
            if (onc) nHeadHalo = haloN + 1;
            else nTailHalo = haloN + 1;
          }
        }

        /* --- световая лента ---
           Тянется в сторону БОЛЬШЕГО `s` — туда, где фонарь был секунду назад,
           то есть к точке схода, и начинается чуть впереди машины (см.
           `TRAIL_LEAD`). Отсчёт от кормы, а не от фонаря: иначе самый яркий,
           нулевой сегмент прятался бы внутри собственного кузова, который
           перекрывает его по глубине. */
        if (trails && d < trailFar) {
          const rel = onc ? spd + Math.abs(c.speed) : Math.abs(spd - c.speed);
          const nseg = clamp(
            Math.round((rel * (onc ? TRAIL_TIME : TRAIL_TIME_RED)) / TRAIL_STEP),
            TRAIL_SEGS_MIN,
            segMax,
          );
          const bri =
            (onc ? TRAIL_GAIN : TRAIL_GAIN_RED) *
            smoothstep(trailFar, trailFull, d) *
            (0.5 + 0.5 * clamp01(rel / TRAIL_REF));
          if (bri > 0.004) {
            const w0 = onc ? TRAIL_W : TRAIL_W_RED;
            const offX = lx * 0.92;
            const ty = lampY - TRAIL_ARCH * TRAIL_ARCH_DROP;
            const s0 =
              c.s +
              hl -
              Math.min(
                nseg * TRAIL_STEP * (onc ? TRAIL_LEAD : TRAIL_LEAD_RED),
                TRAIL_LEAD_MAX,
              );
            // Обе ленты машины идут по одной кривой с точностью до постоянного
            // бокового сдвига: разность узлов, а значит и базис сегмента, у них
            // общая. Считаем узел и базис один раз на сегмент, а не по разу на
            // ленту, и катим предыдущий узел вперёд вместо повторной проекции.
            let ax0 = roadX(s0) - camRX - camX;
            let ay0 = roadY(s0) - camRY + ty;
            let az0 = camS - s0;
            for (let k = 0; k < nseg; k++) {
              if (nTrail + 2 > res.trailCap) break;
              // За туманом ленты не видно — дальше матриц не считаем вовсе.
              if (-az0 > FOG.far) break;
              const sb = s0 + TRAIL_STEP * (k + 1);
              const ax1 = roadX(sb) - camRX - camX;
              const ay1 = roadY(sb) - camRY + ty;
              const az1 = camS - sb;

              // Сегмент целиком за спиной (обе точки в +Z) — у только что
              // разъехавшейся машины таких два-три, и все они ушли бы в клип.
              // Проверка до базиса: иначе мы платили бы за них матрицей.
              if (az0 <= 0 || az1 <= 0) {
                _dir.set(ax1 - ax0, ay1 - ay0, az1 - az0);
                const segLen = _dir.length();
                if (segLen < 1e-3) break;
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

                _col.copy(onc ? _blue : _red).multiplyScalar(bri * res.fade[k]);
                for (let side = -1; side <= 1; side += 2) {
                  _m4.setPosition(ax0 + lane + side * offX, ay0, az0);
                  trails.setMatrixAt(nTrail, _m4);
                  trails.setColorAt(nTrail, _col);
                  nTrail++;
                }
              }

              ax0 = ax1;
              ay0 = ay1;
              az0 = az1;
            }
          }
        }
      }

      /* --- сколько слотов реально занято ---
         Незанятые не прячем нулевым масштабом: `count` отсекает их до вершинного
         шейдера, и вырожденные квады не проходят через растеризатор вовсе. */
      res.bodies.count = nBody;
      res.tailHalo.count = nTailHalo;
      res.headHalo.count = nHeadHalo;
      res.tailCore.count = nTailCore;
      res.headCore.count = nHeadCore;
      if (trails) trails.count = nTrail;

      if (nBody > 0) {
        res.bodies.instanceMatrix.needsUpdate = true;
        if (res.bodies.instanceColor) res.bodies.instanceColor.needsUpdate = true;
      }
      if (nTailHalo > 0) {
        res.tailHalo.instanceMatrix.needsUpdate = true;
        if (res.tailHalo.instanceColor) res.tailHalo.instanceColor.needsUpdate = true;
      }
      if (nHeadHalo > 0) {
        res.headHalo.instanceMatrix.needsUpdate = true;
        if (res.headHalo.instanceColor) res.headHalo.instanceColor.needsUpdate = true;
      }
      if (nTailCore > 0) {
        res.tailCore.instanceMatrix.needsUpdate = true;
        if (res.tailCore.instanceColor) res.tailCore.instanceColor.needsUpdate = true;
      }
      if (nHeadCore > 0) {
        res.headCore.instanceMatrix.needsUpdate = true;
        if (res.headCore.instanceColor) res.headCore.instanceColor.needsUpdate = true;
      }
      if (trails && nTrail > 0) {
        trails.instanceMatrix.needsUpdate = true;
        if (trails.instanceColor) trails.instanceColor.needsUpdate = true;
      }
    },

    dispose() {
      // Родителя снимает `main.ts`; наше дело — GPU-ресурсы. Их тут ровно
      // столько, сколько создал `buildTraffic`: пять-шесть InstancedMesh,
      // шесть материалов, три-четыре геометрии и две текстуры.
      res.group.clear();
      res.dispose();
    },
  };
}
