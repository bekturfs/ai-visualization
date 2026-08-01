/**
 * Кабина — SVG-оверлей поверх canvas: рама лобового стекла, приборка в красном
 * свечении, зеркало, консоль, руль с трёхлучевой звездой и руки на ободе.
 *
 * Главное правило файла не изменилось с уходом React: разметка строится ОДИН
 * раз, строкой, и больше не пересобирается никогда. Всё живое — стрелки, руль,
 * цифры, подсветка нитро — двигается императивно в `frame`, который читает
 * мутируемый `Game` и пишет атрибуты по заранее найденным ссылкам. Раньше этот
 * цикл был собственным requestAnimationFrame внутри `useEffect`; теперь его
 * крутит `main.ts`, а `sync` по снимку приборке не нужен вовсе.
 *
 * Геометрия задана в координатах viewBox 1000×460. Оверлей прижат к низу и
 * масштабируется «на покрытие» (`slice`), поэтому на широких экранах верх
 * кадра обрезается, а на узких — бока. Всё существенное (приборка, руль)
 * живёт в прямоугольнике x ∈ [200, 800], y ∈ [200, 460], который виден при
 * любом разумном соотношении сторон.
 */

import type { Overlay } from "../ctx";
import type { Game } from "../types";
import { COLORS, PHYS, QUALITY } from "../config";
import { clamp01, damp, inv } from "../num";
import { hash1 } from "../rng";

/* ---------- шкалы ---------- */

/** Угол развёртки шкалы, градусов. */
const SWEEP = 240;
/** Угол стрелки на нуле, отсчёт от «вверх», по часовой. */
const START = -120;
/** Верх шкалы спидометра, км/ч. */
const SPEED_TOP = 300;
/** Верх шкалы тахометра, об/мин. */
const RPM_TOP = 7000;
/** Холостые обороты. */
const RPM_IDLE = 800;
/** Красная зона начинается здесь (доля шкалы). */
const REDLINE = 0.85;
/** Число передач — та же шестиступенчатая идея, что и в звуке. */
const GEARS = 6;

/* ---------- геометрия приборки ---------- */

const DIAL_R = 82;
const DIAL_CY = 296;
const TACH_CX = 300;
const SPEED_CX = 700;

/** Руль: центр ступицы, радиус в «круглом» пространстве и сплющивание. */
const WHEEL_CX = 500;
const WHEEL_CY = 448;
const WHEEL_R = 250;
/** Обод — эллипс: круг, сжатый по вертикали (перспектива взгляда водителя). */
const WHEEL_SQUASH = 0.62;
/** Обратный коэффициент — им распрямляем руки внутри сплющенной группы. */
const WHEEL_UNSQUASH = 1 / WHEEL_SQUASH;
/** Максимальный поворот обода, градусов на единицу руля. */
const WHEEL_STEER = 26;

const RAD = Math.PI / 180;

/** X точки на радиусе `r` под углом `a` (0° — вверх, по часовой). */
function ax(r: number, a: number): number {
  return r * Math.sin(a * RAD);
}

/** Y той же точки. */
function ay(r: number, a: number): number {
  return -r * Math.cos(a * RAD);
}

/** Дуга по часовой от `a0` до `a1` на радиусе `r`, в локальных координатах циферблата. */
function arcPath(r: number, a0: number, a1: number): string {
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${ax(r, a0).toFixed(2)} ${ay(r, a0).toFixed(2)} A ${r} ${r} 0 ${large} 1 ${ax(
    r,
    a1,
  ).toFixed(2)} ${ay(r, a1).toFixed(2)}`;
}

interface Tick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  major: boolean;
}

/** Риски шкалы: `steps` интервалов, каждый `majorEvery`-й — длинный. */
function buildTicks(steps: number, majorEvery: number): Tick[] {
  const out: Tick[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = START + (i / steps) * SWEEP;
    const major = i % majorEvery === 0;
    const r0 = DIAL_R - 3;
    const r1 = DIAL_R - (major ? 17 : 9);
    out.push({
      x1: ax(r0, a),
      y1: ay(r0, a),
      x2: ax(r1, a),
      y2: ay(r1, a),
      major,
    });
  }
  return out;
}

interface Numeral {
  x: number;
  y: number;
  label: string;
}

/** Цифры шкалы на радиусе `r`. */
function buildNums(vals: readonly number[], top: number, r: number): Numeral[] {
  return vals.map((v) => {
    const a = START + (v / top) * SWEEP;
    return { x: ax(r, a), y: ay(r, a), label: String(v) };
  });
}

/**
 * Те же риски, но разложенные на короткие и длинные. Длинные светятся, и
 * светятся они ОДНОЙ группой на один SVG-фильтр вместо пятнадцати отдельных:
 * риски не перекрываются, результат тот же, а поверхностей под размытие в
 * восемь раз меньше.
 */
function splitTicks(steps: number, majorEvery: number): [Tick[], Tick[]] {
  const all = buildTicks(steps, majorEvery);
  return [all.filter((t) => !t.major), all.filter((t) => t.major)];
}

const [SPEED_MINOR, SPEED_MAJOR] = splitTicks(30, 5);
const [TACH_MINOR, TACH_MAJOR] = splitTicks(14, 2);
const SPEED_NUMS = buildNums([0, 50, 100, 150, 200, 250, 300], SPEED_TOP, 56);
const TACH_NUMS = buildNums([0, 1, 2, 3, 4, 5, 6, 7], 7, 56);
const REDLINE_ARC = arcPath(DIAL_R - 6, START + REDLINE * SWEEP, START + SWEEP);
const SCALE_ARC = arcPath(DIAL_R - 6, START, START + SWEEP);

/* ---------- силуэт кабины ---------- */

/** Проём лобового стекла: низ — кромка панели, бока — стойки, верх — линия крыши. */
const APERTURE_D =
  "M 96 152 C 300 208 700 208 904 152 L 818 44 C 760 22 640 14 500 14 " +
  "C 360 14 240 22 182 44 Z";

/** Тот же проём, вырезанный из прямоугольника с запасом: всё вне проёма — салон. */
const CABIN_D = `M -80 -60 H 1080 V 540 H -80 Z ${APERTURE_D}`;

/** Полоса блика на верхней кромке панели — свет с лобового стекла. */
const DASH_SHEEN_D =
  "M -80 176 L 96 152 C 300 208 700 208 904 152 L 1080 176 L 1080 240 " +
  "L 904 216 C 700 274 300 274 96 216 L -80 240 Z";

/** Всё, что ниже кромки панели: маска для свечения приборки. */
const DASH_CLIP_D =
  "M -80 176 L 96 152 C 300 208 700 208 904 152 L 1080 176 L 1080 540 L -80 540 Z";

/* ---------- центральная консоль ---------- */

interface Seg {
  x: number;
  y: number;
  w: number;
  o: number;
}

/** Ряды безымянных красных сегментов — тот самый анонимный подсвет консоли. */
function buildSegs(): Seg[] {
  const out: Seg[] = [];
  let k = 0;
  for (let row = 0; row < 3; row++) {
    const y = 350 + row * 22;
    let x = 754;
    while (x < 940) {
      const w = 8 + Math.floor(hash1(k * 7 + 3) * 26);
      out.push({ x, y, w, o: 0.3 + hash1(k * 13 + 5) * 0.62 });
      x += w + 7;
      k++;
    }
  }
  return out;
}

const CONSOLE_SEGS = buildSegs();

/* ---------- руки ---------- */

/**
 * Рука на ободе. Локальные координаты: +x — наружу от ступицы, +y — вниз.
 *
 * В референсе руки почти не читаются: тёмный силуэт, вцепившийся в обод,
 * холодная кромка сверху от лобового стекла и слабый тёплый отсвет приборки
 * снизу. Поэтому здесь одна тёмная масса-хват, а пальцы обозначены не
 * светлыми формами, а тёмными бороздами между ними — светлая кисть с
 * прорисованными пальцами на этом масштабе читается как варежка.
 */
const GRIP_D =
  "M 46 -18 C 40 -29 14 -33 -8 -29 C -28 -26 -43 -20 -43 -9 " +
  "C -43 6 -32 21 -14 25 C 6 30 34 30 47 21 C 55 15 53 -9 46 -18 Z";
/** Верхняя кромка хвата — по ней идёт синий контровой свет с лобового. */
const GRIP_RIM_D = "M 45 -19 C 39 -30 14 -34 -8 -30 C -24 -27 -37 -22 -42 -13";
/** Нижняя кромка — слабый тёплый отсвет от красной приборки. */
const GRIP_BOUNCE_D = "M -13 24 C 6 29 33 29 46 20";
/** Большой палец, зацепленный за верх обода: выступает над костяшками. */
const THUMB_D = "M 18 -24 C 2 -34 -16 -34 -25 -27";
/** Борозды между пальцами: идут вдоль пальцев, к ступице. */
const FINGERS = [-16, -4, 8] as const;
/** Начало и конец борозды по x — целиком внутри силуэта хвата. */
const GROOVE_X0 = 2;
const GROOVE_X1 = -36;
/** Предплечье. */
const ARM_D = "M 36 4 L 96 118 L 46 142 L -10 34 Z";
/** Ремешок часов поперёк предплечья. */
const WATCH_D = "M 61 50 L 11 76 L 22 96 L 71 70 Z";
/** Где кисти сидят на ободе, градусов от «вверх». */
const HAND_ANGLE = 68;
/** Радиус осевой линии обода. */
const RIM_MID = 238;
/** Разворот кисти: пальцы должны смотреть на ступицу, а не строго вбок. */
const HAND_TILT = -22;
const HAND_SCALE = 0.86;

/* ---------- стили ---------- */

/**
 * Нижняя граница здесь не вкусовая. `slice` масштабирует SVG по ширине, так
 * что видно ровно нижние `высота_контейнера / (ширина_экрана / 1000)` единиц
 * viewBox; циферблаты начинаются на y ≈ 186, и всё, что ниже ~42vh на 16:9,
 * срезает им верх вместе со строкой DIST. 46vh при этом съедало почти всё
 * место под горизонтом — дороги оставалось тридцать пикселей.
 */
const WRAP_CSS =
  "position:absolute;left:0;right:0;bottom:0;height:min(42vh, 62vw);pointer-events:none";

const SVG_CSS = "width:100%;height:100%;display:block";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Отражённые полосы в зеркале плывут сами по себе — чистый CSS, не кадр. */
const STREAK_CSS = `
@keyframes srd-drift {
  0%   { transform: translateX(-60px); opacity: 0 }
  15%  { opacity: .55 }
  85%  { opacity: .55 }
  100% { transform: translateX(230px); opacity: 0 }
}
.srd-streak { animation: srd-drift 5.2s linear infinite }
.srd-streak-b { animation-duration: 7.4s; animation-delay: -2.6s }
.srd-streak-c { animation-duration: 9.1s; animation-delay: -5.1s }
`;

/** Пишем текст только если он поменялся — лишний layout никому не нужен. */
function setText(node: SVGTextElement, v: string): void {
  if (node.textContent !== v) node.textContent = v;
}

/**
 * «Погашенные сегменты» настоящего LED-индикатора. Подложка обязана быть РОВНО
 * той же длины, что и значение, иначе лишние восьмёрки слева читаются как часть
 * числа («888811» вместо «11»). Оба слоя — один моноширинный шрифт, один
 * кегль, один `text-anchor="end"`, поэтому каждая живая цифра садится точно на
 * свою восьмёрку. Строки заготовлены, чтобы не звать `repeat` в цикле.
 */
const GHOSTS = ["", "8", "88", "888", "8888", "88888", "888888", "8888888", "88888888"];

function ghostFor(v: string): string {
  return GHOSTS[v.length] ?? "8".repeat(v.length);
}

/** Шаг квантования угла: 1/20 градуса. */
const DEG_Q = 20;
/** Шаг квантования прозрачности: 1/1000. */
const OP_Q = 1000;

/* ---------- сборка разметки ---------- */

/** Стрелка прибора: узкий клин от ступицы почти до края шкалы. */
const NEEDLE_D = `M -3.6 14 L -1.6 ${-DIAL_R + 18} L 0 ${-DIAL_R + 12} L 1.6 ${
  -DIAL_R + 18
} L 3.6 14 Z`;

function tickLines(ticks: readonly Tick[]): string {
  return ticks
    .map((t) => `<line x1="${t.x1}" y1="${t.y1}" x2="${t.x2}" y2="${t.y2}"/>`)
    .join("");
}

function numTexts(nums: readonly Numeral[], size: number): string {
  return nums
    .map(
      (n) =>
        `<text x="${n.x}" y="${n.y}" fill="${COLORS.gaugeDim}" font-family="${MONO}" ` +
        `font-size="${size}" text-anchor="middle" dominant-baseline="central">${n.label}</text>`,
    )
    .join("");
}

/** Решётка дефлектора: четыре щели от `x`. */
function slats(x: number): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out +=
      `<rect x="${x}" y="${230 + i * 16}" width="126" height="5" rx="2.5" fill="#0a1020" ` +
      `stroke="${COLORS.cabinEdge}" stroke-width="0.6"/>`;
  }
  return out;
}

/** Одна рука на ободе: `side` = +1 правая, −1 левая (зеркалится масштабом). */
function hand(side: 1 | -1): string {
  const tx = (side * ax(RIM_MID, HAND_ANGLE)).toFixed(1);
  const ty = ay(RIM_MID, HAND_ANGLE).toFixed(1);
  const sy = (WHEEL_UNSQUASH * HAND_SCALE).toFixed(3);
  const grooves = FINGERS.map(
    (fy) =>
      `<line x1="${GROOVE_X0}" y1="${fy}" x2="${GROOVE_X1}" y2="${fy + 2}" ` +
      `stroke="#03060c" stroke-width="2.4" stroke-linecap="round" opacity="0.75"/>`,
  ).join("");
  return (
    `<g transform="translate(${tx} ${ty}) scale(${side * HAND_SCALE} ${sy}) rotate(${HAND_TILT})">` +
    `<path d="${ARM_D}" fill="url(#srd-sleeve)"/>` +
    `<path d="${WATCH_D}" fill="#080d15"/>` +
    `<circle cx="64" cy="61" r="6" fill="#101823"/>` +
    `<circle cx="64" cy="61" r="2.4" fill="${COLORS.neon}" opacity="0.5"/>` +
    // Большой палец уходит под хват — виден только его верх.
    `<path d="${THUMB_D}" fill="none" stroke="#18212c" stroke-width="13" stroke-linecap="round"/>` +
    `<path d="${GRIP_D}" fill="url(#srd-skin)"/>` +
    // Пальцы — не формы, а борозды между ними.
    grooves +
    // Холодная кромка сверху — свет с лобового стекла.
    `<path d="${GRIP_RIM_D}" fill="none" stroke="${COLORS.neon}" stroke-width="2" ` +
    `stroke-linecap="round" opacity="0.5"/>` +
    // Тёплый отсвет снизу — красная приборка.
    `<path d="${GRIP_BOUNCE_D}" fill="none" stroke="${COLORS.gauge}" stroke-width="2" ` +
    `stroke-linecap="round" opacity="0.28"/>` +
    `</g>`
  );
}

/** Спица руля под углом `a`. */
function spoke(a: number): string {
  return (
    `<g transform="rotate(${a})">` +
    `<path d="M -27 -44 L -20 ${-WHEEL_R + 26} Q 0 ${-WHEEL_R + 16} 20 ${-WHEEL_R + 26} ` +
    `L 27 -44 Q 0 -32 -27 -44 Z" fill="url(#srd-spoke)" stroke="#01030a" stroke-width="1.5"/>` +
    `<path d="M -19 -48 L -13 ${-WHEEL_R + 30}" fill="none" stroke="${COLORS.neon}" ` +
    `stroke-width="1.4" opacity="0.16"/>` +
    `</g>`
  );
}

/** Луч трёхлучевой звезды на ступице. */
function starRay(a: number): string {
  return (
    `<line x1="0" y1="0" x2="${ax(38, a)}" y2="${ay(38, a)}" stroke="#b9c8d8" ` +
    `stroke-width="6.5" stroke-linecap="round" opacity="0.85"/>`
  );
}

/** Кнопка консоли с красным глазком. */
function consoleButton(i: number): string {
  const cx = 772 + i * 48;
  return (
    `<circle cx="${cx}" cy="428" r="16" fill="#070a12" stroke="${COLORS.cabinEdge}" stroke-width="1.2"/>` +
    `<circle cx="${cx}" cy="428" r="3.2" fill="${COLORS.gauge}" ` +
    `opacity="${0.55 + hash1(i * 31 + 9) * 0.4}" data-g="1"/>`
  );
}

/**
 * Вся разметка кабины одной строкой.
 *
 * `data-n` помечает узлы, которые двигаются в кадре (их находим один раз после
 * разбора), `data-g` — узлы, которым положен SVG-ореол: он есть только при
 * включённом bloom, и вешается атрибутом уже после разбора, потому что пресет
 * качества известен только из `Game`.
 */
const MARKUP =
  `<svg viewBox="0 0 1000 460" preserveAspectRatio="xMidYMax slice" style="${SVG_CSS}">` +
  `<defs>` +
  `<filter id="srd-glow" x="-70%" y="-70%" width="240%" height="240%" color-interpolation-filters="sRGB">` +
  `<feGaussianBlur stdDeviation="2.4" result="b"/>` +
  `<feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>` +
  `</filter>` +
  /* Тот же ореол для крупных групп: рамка фильтра задаётся в долях bbox, и для
     циферблата 160×160 хватает 12% (≈19 единиц при stdDeviation 2.4).
     Поверхность вчетверо меньше, чем у −70%/240%. */
  `<filter id="srd-glow-w" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">` +
  `<feGaussianBlur stdDeviation="2.4" result="b"/>` +
  `<feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>` +
  `</filter>` +
  /* Ореол вокруг приборов — градиентом, а не фильтром: он меняет прозрачность
     каждый кадр, фильтр тут был бы дорог. */
  `<radialGradient id="srd-halo">` +
  `<stop offset="0" stop-color="${COLORS.gaugeGlow}" stop-opacity="0.5"/>` +
  `<stop offset="0.45" stop-color="${COLORS.gauge}" stop-opacity="0.18"/>` +
  `<stop offset="1" stop-color="${COLORS.gauge}" stop-opacity="0"/>` +
  `</radialGradient>` +
  /* Циферблат: подсвеченная красным глубина. */
  `<radialGradient id="srd-face" cx="50%" cy="38%" r="72%">` +
  `<stop offset="0" stop-color="#280804"/>` +
  `<stop offset="0.68" stop-color="#0c0206"/>` +
  `<stop offset="1" stop-color="#01030a"/>` +
  `</radialGradient>` +
  `<linearGradient id="srd-dash" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="${COLORS.neon}" stop-opacity="0.24"/>` +
  `<stop offset="1" stop-color="${COLORS.neon}" stop-opacity="0"/>` +
  `</linearGradient>` +
  /* Обод руля: сверху ловит свет лобового, снизу глухая тень. */
  `<linearGradient id="srd-rim" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="#26303f"/>` +
  `<stop offset="0.32" stop-color="#111823"/>` +
  `<stop offset="1" stop-color="#04060b"/>` +
  `</linearGradient>` +
  `<linearGradient id="srd-spoke" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="#1b2432"/>` +
  `<stop offset="1" stop-color="#070a11"/>` +
  `</linearGradient>` +
  /* Кисть: почти силуэт. Сверху холодный отблеск лобового, к низу уходит в
     чёрное с еле заметным тёплым подмесом от приборки. Ничего «телесного» —
     в кадре рука не должна спорить с дорогой. */
  `<linearGradient id="srd-skin" x1="0" y1="0" x2="0.18" y2="1">` +
  `<stop offset="0" stop-color="#2b3947"/>` +
  `<stop offset="0.38" stop-color="#151d27"/>` +
  `<stop offset="0.78" stop-color="#0a0d14"/>` +
  `<stop offset="1" stop-color="#150c0e"/>` +
  `</linearGradient>` +
  /* Рукав: ещё темнее кисти, он дальше от стекла. */
  `<linearGradient id="srd-sleeve" x1="0" y1="0" x2="0.3" y2="1">` +
  `<stop offset="0" stop-color="#141c26"/>` +
  `<stop offset="1" stop-color="#04060c"/>` +
  `</linearGradient>` +
  `<linearGradient id="srd-mirror" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="#071228"/>` +
  `<stop offset="1" stop-color="#030711"/>` +
  `</linearGradient>` +
  `<clipPath id="srd-mirror-clip"><rect x="566" y="16" width="190" height="52" rx="10"/></clipPath>` +
  /* Всё, что светится на панели, обрезаем кромкой панели: выше неё стекло,
     и красный ореол не должен ложиться на дорогу. */
  `<clipPath id="srd-dash-clip"><path d="${DASH_CLIP_D}"/></clipPath>` +
  `</defs>` +
  /* ---------- 1. силуэт кабины ---------- */
  `<path d="${CABIN_D}" fill-rule="evenodd" fill="${COLORS.cabin}"/>` +
  `<path d="${APERTURE_D}" fill="none" stroke="${COLORS.cabinEdge}" stroke-width="1.5"/>` +
  `<path d="${DASH_SHEEN_D}" fill="url(#srd-dash)"/>` +
  `<path d="M 96 152 C 300 208 700 208 904 152" fill="none" stroke="${COLORS.neon}" ` +
  `stroke-width="1.2" opacity="0.22"/>` +
  /* ---------- 2. зеркало заднего вида ---------- */
  `<g>` +
  `<rect x="648" y="2" width="16" height="16" fill="#080c14"/>` +
  `<rect x="556" y="8" width="210" height="68" rx="16" fill="#05080f" ` +
  `stroke="${COLORS.cabinEdge}" stroke-width="1.5"/>` +
  `<rect x="566" y="16" width="190" height="52" rx="10" fill="url(#srd-mirror)"/>` +
  `<g clip-path="url(#srd-mirror-clip)" opacity="0.9">` +
  `<rect class="srd-streak" data-n="streak" data-still="0.35" x="566" y="26" width="54" ` +
  `height="5" rx="2.5" fill="${COLORS.neon}" opacity="0"/>` +
  `<rect class="srd-streak srd-streak-b" data-n="streak" data-still="0.3" x="566" y="40" ` +
  `width="78" height="4" rx="2" fill="${COLORS.neonDeep}" opacity="0"/>` +
  `<rect class="srd-streak srd-streak-c" data-n="streak" data-still="0.22" x="566" y="53" ` +
  `width="40" height="3" rx="1.5" fill="${COLORS.head}" opacity="0"/>` +
  `</g>` +
  `<rect x="566" y="16" width="190" height="52" rx="10" fill="none" ` +
  `stroke="${COLORS.cabinEdge}" stroke-width="1" opacity="0.7"/>` +
  `</g>` +
  /* ---------- 3. приборка ---------- */
  `<g clip-path="url(#srd-dash-clip)">` +
  /* козырёк приборки */
  `<rect x="206" y="200" width="588" height="226" rx="44" fill="#02040c" ` +
  `stroke="${COLORS.cabinEdge}" stroke-width="1.5"/>` +
  `<path d="M 250 202 C 360 194 640 194 750 202" fill="none" stroke="${COLORS.neon}" ` +
  `stroke-width="1.2" opacity="0.18"/>` +
  /* мягкий ореол — им же играем на нитро */
  `<g data-n="cluster" opacity="0.4">` +
  `<circle cx="${TACH_CX}" cy="${DIAL_CY}" r="132" fill="url(#srd-halo)"/>` +
  `<circle cx="${SPEED_CX}" cy="${DIAL_CY}" r="132" fill="url(#srd-halo)"/>` +
  `<circle cx="500" cy="248" r="104" fill="url(#srd-halo)"/>` +
  `</g>` +
  /* --- тахометр --- */
  `<g transform="translate(${TACH_CX} ${DIAL_CY})">` +
  `<circle r="${DIAL_R + 7}" fill="#01030a" stroke="${COLORS.cabinEdge}" stroke-width="2"/>` +
  `<circle r="${DIAL_R}" fill="url(#srd-face)"/>` +
  /* Короткие риски не светятся — фильтр им не нужен. */
  `<g stroke="${COLORS.gaugeDim}" stroke-width="1.4">${tickLines(TACH_MINOR)}</g>` +
  /* Шкала и длинные риски — один фильтр на всю статику циферблата. */
  `<g data-g="w">` +
  `<path d="${SCALE_ARC}" fill="none" stroke="${COLORS.gauge}" stroke-width="2" opacity="0.45"/>` +
  `<g stroke="${COLORS.gauge}" stroke-width="2.6" opacity="0.8">${tickLines(TACH_MAJOR)}</g>` +
  `</g>` +
  `<g data-n="redline" opacity="0.3">` +
  `<path d="${REDLINE_ARC}" fill="none" stroke="${COLORS.gauge}" stroke-width="5" ` +
  `stroke-linecap="round" data-g="w"/>` +
  `</g>` +
  numTexts(TACH_NUMS, 13) +
  `<text x="0" y="38" fill="${COLORS.gaugeDim}" font-family="${MONO}" font-size="9" ` +
  `letter-spacing="1.6" text-anchor="middle">x1000</text>` +
  /* индикатор передачи */
  `<text data-n="gear" x="0" y="-32" fill="${COLORS.gauge}" font-family="${MONO}" ` +
  `font-size="23" font-weight="700" text-anchor="middle" data-g="1">N</text>` +
  `<text x="0" y="-16" fill="${COLORS.gaugeDim}" font-family="${MONO}" font-size="8" ` +
  `letter-spacing="2" text-anchor="middle">GEAR</text>` +
  `<g data-n="tach" transform="rotate(${START})">` +
  `<path d="${NEEDLE_D}" fill="${COLORS.gauge}" data-g="1"/>` +
  `</g>` +
  `<circle r="8" fill="#180402" stroke="${COLORS.gauge}" stroke-width="1.6"/>` +
  `</g>` +
  /* --- спидометр --- */
  `<g transform="translate(${SPEED_CX} ${DIAL_CY})">` +
  `<circle r="${DIAL_R + 7}" fill="#01030a" stroke="${COLORS.cabinEdge}" stroke-width="2"/>` +
  `<circle r="${DIAL_R}" fill="url(#srd-face)"/>` +
  `<g stroke="${COLORS.gaugeDim}" stroke-width="1.4">${tickLines(SPEED_MINOR)}</g>` +
  `<g data-g="w">` +
  `<path d="${SCALE_ARC}" fill="none" stroke="${COLORS.gauge}" stroke-width="2" opacity="0.45"/>` +
  `<g stroke="${COLORS.gauge}" stroke-width="2.6" opacity="0.8">${tickLines(SPEED_MAJOR)}</g>` +
  `</g>` +
  numTexts(SPEED_NUMS, 12) +
  `<text x="0" y="44" fill="${COLORS.gaugeDim}" font-family="${MONO}" font-size="9.5" ` +
  `letter-spacing="2" text-anchor="middle">km/h</text>` +
  `<text data-n="kmh" x="0" y="-28" fill="${COLORS.gauge}" font-family="${MONO}" ` +
  `font-size="24" font-weight="700" text-anchor="middle" data-g="1">0</text>` +
  `<g data-n="speed" transform="rotate(${START})">` +
  `<path d="${NEEDLE_D}" fill="${COLORS.gauge}" data-g="1"/>` +
  `</g>` +
  `<circle r="8" fill="#180402" stroke="${COLORS.gauge}" stroke-width="1.6"/>` +
  `</g>` +
  /* --- центральный сегментный блок --- */
  `<g>` +
  `<rect x="396" y="204" width="208" height="86" rx="10" fill="#01030a" ` +
  `stroke="${COLORS.gaugeDim}" stroke-width="1.2"/>` +
  /* DIST */
  `<text x="406" y="232" fill="${COLORS.gaugeDim}" font-family="${MONO}" font-size="9.5" ` +
  `letter-spacing="1.5">DIST</text>` +
  `<text data-n="distGhost" x="594" y="234" fill="${COLORS.gaugeDim}" font-family="${MONO}" ` +
  `font-size="23" font-weight="700" text-anchor="end" opacity="0.15">8</text>` +
  `<text data-n="dist" x="594" y="234" fill="${COLORS.gauge}" font-family="${MONO}" ` +
  `font-size="23" font-weight="700" text-anchor="end" data-g="1">0</text>` +
  /* SCORE */
  `<text x="406" y="261" fill="${COLORS.gaugeDim}" font-family="${MONO}" font-size="9.5" ` +
  `letter-spacing="1.5">SCORE</text>` +
  `<text data-n="scoreGhost" x="594" y="262" fill="${COLORS.gaugeDim}" font-family="${MONO}" ` +
  `font-size="19" font-weight="700" text-anchor="end" opacity="0.15">8</text>` +
  `<text data-n="score" x="594" y="262" fill="${COLORS.gauge}" font-family="${MONO}" ` +
  `font-size="19" font-weight="700" text-anchor="end" data-g="1">0</text>` +
  /* BEST */
  `<text x="406" y="283" fill="${COLORS.gaugeDim}" font-family="${MONO}" font-size="9.5" ` +
  `letter-spacing="1.5">BEST</text>` +
  `<text data-n="best" x="594" y="284" fill="${COLORS.gauge}" font-family="${MONO}" ` +
  `font-size="15" text-anchor="end" opacity="0.72">0</text>` +
  `</g>` +
  `</g>` +
  /* ---------- 4. дефлекторы слева и консоль справа ---------- */
  `<g>` +
  /* левый дефлектор */
  `<rect x="40" y="218" width="150" height="78" rx="12" fill="#02040a" ` +
  `stroke="${COLORS.cabinEdge}" stroke-width="1.2"/>` +
  slats(52) +
  `<circle cx="64" cy="318" r="5" fill="${COLORS.gauge}" opacity="0.75" data-g="1"/>` +
  `<circle cx="86" cy="318" r="5" fill="${COLORS.gaugeDim}"/>` +
  /* правый дефлектор */
  `<rect x="812" y="218" width="150" height="78" rx="12" fill="#02040a" ` +
  `stroke="${COLORS.cabinEdge}" stroke-width="1.2"/>` +
  slats(824) +
  /* центральная консоль: анонимные красные сегменты и глухие кнопки */
  `<rect x="738" y="330" width="220" height="130" rx="16" fill="#02040b" ` +
  `stroke="${COLORS.cabinEdge}" stroke-width="1.5"/>` +
  `<g data-g="1">` +
  CONSOLE_SEGS.map(
    (s) =>
      `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="6" rx="2" ` +
      `fill="${COLORS.gauge}" opacity="${s.o}"/>`,
  ).join("") +
  `</g>` +
  consoleButton(0) +
  consoleButton(1) +
  consoleButton(2) +
  consoleButton(3) +
  /* красная полоса подсвета вдоль консоли */
  `<rect x="744" y="412" width="4" height="40" rx="2" fill="${COLORS.gauge}" ` +
  `opacity="0.5" data-g="1"/>` +
  `</g>` +
  /* ---------- 5. руль и руки ---------- */
  /* Внешняя группа — только перспектива: круг, сжатый по вертикали. Крутится
     внутренняя, поэтому обод остаётся неподвижным эллипсом, а спицы и руки
     поворачиваются внутри него, как в жизни. */
  `<g transform="translate(${WHEEL_CX} ${WHEEL_CY}) scale(1 ${WHEEL_SQUASH})">` +
  `<g data-n="wheel" transform="rotate(0)">` +
  /* обод */
  `<circle r="${WHEEL_R - 17}" fill="none" stroke="url(#srd-rim)" stroke-width="34"/>` +
  `<circle r="${WHEEL_R}" fill="none" stroke="#01030a" stroke-width="2" opacity="0.8"/>` +
  `<path d="${arcPath(WHEEL_R - 24, -62, 62)}" fill="none" stroke="${COLORS.neon}" ` +
  `stroke-width="2.6" opacity="0.34"/>` +
  `<path d="${arcPath(WHEEL_R - 3, -46, 46)}" fill="none" stroke="${COLORS.neon}" ` +
  `stroke-width="1.4" opacity="0.18"/>` +
  /* Три спицы: две низкие широкие и одна вниз по центру. Углы почти
     горизонтальные — при таком кадре только они и попадают в поле зрения,
     всё, что ниже, срезано нижней кромкой viewBox. */
  spoke(-98) +
  spoke(98) +
  spoke(180) +
  /* ступица со звездой */
  `<circle r="52" fill="#080b12" stroke="${COLORS.cabinEdge}" stroke-width="2"/>` +
  `<circle r="40" fill="none" stroke="#b9c8d8" stroke-width="4.5" opacity="0.85"/>` +
  starRay(0) +
  starRay(120) +
  starRay(240) +
  `<circle r="40" fill="none" stroke="${COLORS.neon}" stroke-width="1.6" opacity="0.3"/>` +
  /* Руки. Группа сжата перспективой вместе с рулём, поэтому внутри кисть
     распрямляем обратным масштабом — иначе она сплющится. */
  hand(1) +
  hand(-1) +
  `</g>` +
  `</g>` +
  /* ---------- 6. заливка нитро поверх всего салона ---------- */
  `<path data-n="wash" d="${CABIN_D}" fill-rule="evenodd" fill="${COLORS.nitro}" opacity="0"/>` +
  `</svg>`;

/* ---------- оверлей ---------- */

export function createDashboard(host: HTMLElement): Overlay {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = WRAP_CSS;
  el.innerHTML = MARKUP;
  host.appendChild(el);

  const pick = <T extends Element>(name: string): T => {
    const node = el.querySelector<T>(`[data-n="${name}"]`);
    if (!node) throw new Error(`приборка: нет узла ${name}`);
    return node;
  };

  /* Живые узлы находим один раз: в кадре только setAttribute по ссылке. */
  const wheel = pick<SVGGElement>("wheel");
  const speedNeedle = pick<SVGGElement>("speed");
  const tachNeedle = pick<SVGGElement>("tach");
  const distText = pick<SVGTextElement>("dist");
  const distGhost = pick<SVGTextElement>("distGhost");
  const scoreText = pick<SVGTextElement>("score");
  const scoreGhost = pick<SVGTextElement>("scoreGhost");
  const bestText = pick<SVGTextElement>("best");
  const kmhText = pick<SVGTextElement>("kmh");
  const gearText = pick<SVGTextElement>("gear");
  const nitroWash = pick<SVGPathElement>("wash");
  const clusterGlow = pick<SVGGElement>("cluster");
  const redline = pick<SVGGElement>("redline");

  const svg = el.firstElementChild as SVGSVGElement;
  const glowNodes = Array.from(el.querySelectorAll<SVGElement>('[data-g="1"]'));
  const glowWideNodes = Array.from(el.querySelectorAll<SVGElement>('[data-g="w"]'));
  const streaks = Array.from(el.querySelectorAll<SVGRectElement>('[data-n="streak"]'));

  /** `<style>` с анимацией зеркала: живёт только пока движение разрешено. */
  const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
  styleEl.textContent = STREAK_CSS;

  /* Пресет качества и «уменьшенное движение» приходят из `Game`, а он есть
     только в кадре. Первый кадр случается до первой отрисовки, так что оба
     применяются раньше, чем что-либо будет видно. */
  let bloomOn: boolean | null = null;
  let motionOff: boolean | null = null;

  function applyGlow(on: boolean): void {
    for (const n of glowNodes) {
      if (on) n.setAttribute("filter", "url(#srd-glow)");
      else n.removeAttribute("filter");
    }
    for (const n of glowWideNodes) {
      if (on) n.setAttribute("filter", "url(#srd-glow-w)");
      else n.removeAttribute("filter");
    }
  }

  function applyMotion(reduced: boolean): void {
    if (reduced) {
      styleEl.remove();
      for (const s of streaks) {
        s.removeAttribute("class");
        s.setAttribute("opacity", s.getAttribute("data-still") ?? "0");
      }
    } else {
      svg.appendChild(styleEl);
      for (const s of streaks) s.setAttribute("opacity", "0");
    }
  }

  /* Сглаженные для графики величины плюс кэш последнего ЗАПИСАННОГО в DOM
     значения (в целых «корзинах»). Ни то, ни другое не живёт в разметке. */
  let rpm = RPM_IDLE;
  let kmh = 0;
  let wash = 0;
  /** Накопленные миллисекунды: дрожь стрелки должна идти от dt, не от часов. */
  let clockMs = 0;
  /** Сколько прошло с последней записи цифр, с. Первый кадр пишет сразу. */
  let textAcc = 1;
  let wSpeed = NaN;
  let wTach = NaN;
  let wWheel = NaN;
  let wWash = NaN;
  let wCluster = NaN;
  let wRed = NaN;

  return {
    el,

    /** Приборка читает `Game` напрямую в `frame`; снимок ей не нужен. */
    sync(): void {},

    frame(g: Game, dt: number): void {
      const bloom = QUALITY[g.quality].bloom;
      if (bloom !== bloomOn) {
        bloomOn = bloom;
        applyGlow(bloom);
      }
      if (g.reducedMotion !== motionOff) {
        motionOff = g.reducedMotion;
        applyMotion(g.reducedMotion);
      }

      clockMs += dt * 1000;

      /* Обороты. Весь диапазон скоростей (включая нитро) делим на шесть равных
         ступеней — та же модель, что у звука двигателя. Внутри ступени обороты
         линейно идут от холостых к отсечке, на переключении падают обратно. */
      const frac = clamp01(g.speed / (PHYS.speedMax + PHYS.nitroBoost));
      const gear = Math.min(GEARS - 1, Math.floor(frac * GEARS));
      const inGear = clamp01(frac * GEARS - gear);
      rpm = damp(rpm, RPM_IDLE + inGear * (RPM_TOP - RPM_IDLE), 9, dt);
      kmh = damp(kmh, g.speed * 3.6, 11, dt);
      /* Нитро: холодная заливка салона и приборка светит сильнее. */
      wash = damp(wash, g.nitroActive ? 1 : 0, 6, dt);

      /* Дрожь стрелки тахометра от вибрации мотора. */
      const jitter = g.reducedMotion ? 0 : Math.sin(clockMs * 0.05) * 0.7 * (rpm / RPM_TOP);

      /* Каждый setAttribute инвалидирует кусок SVG вместе со всеми фильтрами,
         которые его перекрывают. Поэтому значение сначала квантуется в целую
         «корзину», и в DOM уходит, только если корзина сменилась: на ровном
         газу и на прямой цикл не трогает DOM вообще. */
      const sDeg = Math.round((START + clamp01(kmh / SPEED_TOP) * SWEEP) * DEG_Q);
      if (sDeg !== wSpeed) {
        wSpeed = sDeg;
        speedNeedle.setAttribute("transform", `rotate(${(sDeg / DEG_Q).toFixed(2)})`);
      }

      const tDeg = Math.round((START + clamp01(rpm / RPM_TOP) * SWEEP + jitter) * DEG_Q);
      if (tDeg !== wTach) {
        wTach = tDeg;
        tachNeedle.setAttribute("transform", `rotate(${(tDeg / DEG_Q).toFixed(2)})`);
      }

      const wDeg = Math.round(g.steer * WHEEL_STEER * DEG_Q);
      if (wDeg !== wWheel) {
        wWheel = wDeg;
        wheel.setAttribute("transform", `rotate(${(wDeg / DEG_Q).toFixed(2)})`);
      }

      const washOp = Math.round(wash * 0.055 * OP_Q);
      if (washOp !== wWash) {
        wWash = washOp;
        nitroWash.setAttribute("opacity", (washOp / OP_Q).toFixed(3));
      }

      const clusterOp = Math.round((0.4 + wash * 0.5) * OP_Q);
      if (clusterOp !== wCluster) {
        wCluster = clusterOp;
        clusterGlow.setAttribute("opacity", (clusterOp / OP_Q).toFixed(3));
      }

      /* Прозрачность красной зоны живёт на ОБЁРТКЕ, а не на светящемся пути:
         так размытие под ним не пересчитывается на каждое изменение. */
      const redOp = Math.round((0.28 + inv(REDLINE, 1, rpm / RPM_TOP) * 0.72) * OP_Q);
      if (redOp !== wRed) {
        wRed = redOp;
        redline.setAttribute("opacity", (redOp / OP_Q).toFixed(3));
      }

      /* Цифры — десять раз в секунду: мельтешение шестьюдесятью нечитаемо. */
      textAcc += dt;
      if (textAcc >= 0.1) {
        textAcc = 0;
        const dist = String(Math.max(0, Math.round(g.s)));
        const score = String(Math.round(g.score));
        setText(distGhost, ghostFor(dist));
        setText(distText, dist);
        setText(scoreGhost, ghostFor(score));
        setText(scoreText, score);
        setText(bestText, String(Math.round(Math.max(g.best, g.score))));
        setText(kmhText, String(Math.round(kmh)));
        setText(gearText, g.speed < 1.5 ? "N" : String(gear + 1));
      }
    },

    dispose(): void {
      styleEl.remove();
      el.remove();
    },
  };
}
