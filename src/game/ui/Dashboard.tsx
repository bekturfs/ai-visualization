/**
 * Кабина — SVG-оверлей поверх canvas: рама лобового стекла, приборка в красном
 * свечении, зеркало, консоль, руль с трёхлучевой звездой и руки на ободе.
 *
 * Главное правило файла: React рисует эту разметку ОДИН раз. Всё живое —
 * стрелки, руль, цифры, подсветка нитро — двигается императивно в собственном
 * requestAnimationFrame-цикле, который читает мутируемый `Game` и пишет
 * атрибуты по ссылкам. Ни одного setState, ни одного перерендера в кадре.
 *
 * Геометрия задана в координатах viewBox 1000×460. Оверлей прижат к низу и
 * масштабируется «на покрытие» (`slice`), поэтому на широких экранах верх
 * кадра обрезается, а на узких — бока. Всё существенное (приборка, руль)
 * живёт в прямоугольнике x ∈ [200, 800], y ∈ [200, 460], который виден при
 * любом разумном соотношении сторон.
 */

import { useEffect, useRef, type CSSProperties } from "react";
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

const WRAP: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  // Нижняя граница здесь не вкусовая. `slice` масштабирует SVG по ширине, так
  // что видно ровно нижние `высота_контейнера / (ширина_экрана / 1000)` единиц
  // viewBox; циферблаты начинаются на y ≈ 186, и всё, что ниже ~42vh на 16:9,
  // срезает им верх вместе со строкой DIST. 46vh при этом съедало почти всё
  // место под горизонтом — дороги оставалось тридцать пикселей.
  height: "min(42vh, 62vw)",
  pointerEvents: "none",
};

const SVG_STYLE: CSSProperties = { width: "100%", height: "100%", display: "block" };

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
function setText(node: SVGTextElement | null, v: string): void {
  if (node && node.textContent !== v) node.textContent = v;
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

export function Dashboard({ g }: { g: Game }) {
  /* Пресет читаем один раз на монтировании: разметка статична, фильтры в ней —
     тоже. Смена качества на лету потребует перемонтировать оверлей. */
  const glow = QUALITY[g.quality].bloom ? "url(#srd-glow)" : undefined;
  /* Тот же ореол, но с узкой рамкой фильтра — для широких групп, где −70%/240%
     раздували бы поверхность размытия вчетверо без единого лишнего пикселя. */
  const glowW = QUALITY[g.quality].bloom ? "url(#srd-glow-w)" : undefined;

  const wheelRef = useRef<SVGGElement>(null);
  const speedNeedle = useRef<SVGGElement>(null);
  const tachNeedle = useRef<SVGGElement>(null);
  const distText = useRef<SVGTextElement>(null);
  const distGhost = useRef<SVGTextElement>(null);
  const scoreText = useRef<SVGTextElement>(null);
  const scoreGhost = useRef<SVGTextElement>(null);
  const bestText = useRef<SVGTextElement>(null);
  const kmhText = useRef<SVGTextElement>(null);
  const gearText = useRef<SVGTextElement>(null);
  const nitroWash = useRef<SVGPathElement>(null);
  const clusterGlow = useRef<SVGGElement>(null);
  const redline = useRef<SVGGElement>(null);

  /* Сглаженные для графики величины плюс кэш последнего ЗАПИСАННОГО в DOM
     значения (в целых «корзинах»). Всё в ref, React про них не знает. */
  const anim = useRef({
    rpm: RPM_IDLE,
    kmh: 0,
    wash: 0,
    last: 0,
    textAt: 0,
    wSpeed: NaN,
    wTach: NaN,
    wWheel: NaN,
    wWash: NaN,
    wCluster: NaN,
    wRed: NaN,
  });

  useEffect(() => {
    const a = anim.current;
    a.last = 0;
    let raf = 0;

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      const dt = a.last === 0 ? 1 / 60 : Math.min(0.05, (now - a.last) * 0.001);
      a.last = now;

      /* Обороты. Весь диапазон скоростей (включая нитро) делим на шесть равных
         ступеней — та же модель, что у звука двигателя. Внутри ступени обороты
         линейно идут от холостых к отсечке, на переключении падают обратно. */
      const frac = clamp01(g.speed / (PHYS.speedMax + PHYS.nitroBoost));
      const gear = Math.min(GEARS - 1, Math.floor(frac * GEARS));
      const inGear = clamp01(frac * GEARS - gear);
      a.rpm = damp(a.rpm, RPM_IDLE + inGear * (RPM_TOP - RPM_IDLE), 9, dt);
      a.kmh = damp(a.kmh, g.speed * 3.6, 11, dt);
      /* Нитро: холодная заливка салона и приборка светит сильнее. */
      a.wash = damp(a.wash, g.nitroActive ? 1 : 0, 6, dt);

      /* Дрожь стрелки тахометра от вибрации мотора. */
      const jitter = g.reducedMotion ? 0 : Math.sin(now * 0.05) * 0.7 * (a.rpm / RPM_TOP);

      /* Каждый setAttribute инвалидирует кусок SVG вместе со всеми фильтрами,
         которые его перекрывают. Поэтому значение сначала квантуется в целую
         «корзину», и в DOM уходит, только если корзина сменилась: на ровном
         газу и на прямой цикл не трогает DOM вообще. */
      const sDeg = Math.round((START + clamp01(a.kmh / SPEED_TOP) * SWEEP) * DEG_Q);
      const sn = speedNeedle.current;
      if (sn && sDeg !== a.wSpeed) {
        a.wSpeed = sDeg;
        sn.setAttribute("transform", `rotate(${(sDeg / DEG_Q).toFixed(2)})`);
      }

      const tDeg = Math.round((START + clamp01(a.rpm / RPM_TOP) * SWEEP + jitter) * DEG_Q);
      const tn = tachNeedle.current;
      if (tn && tDeg !== a.wTach) {
        a.wTach = tDeg;
        tn.setAttribute("transform", `rotate(${(tDeg / DEG_Q).toFixed(2)})`);
      }

      const wDeg = Math.round(g.steer * WHEEL_STEER * DEG_Q);
      const wr = wheelRef.current;
      if (wr && wDeg !== a.wWheel) {
        a.wWheel = wDeg;
        wr.setAttribute("transform", `rotate(${(wDeg / DEG_Q).toFixed(2)})`);
      }

      const washOp = Math.round(a.wash * 0.055 * OP_Q);
      const nw = nitroWash.current;
      if (nw && washOp !== a.wWash) {
        a.wWash = washOp;
        nw.setAttribute("opacity", (washOp / OP_Q).toFixed(3));
      }

      const clusterOp = Math.round((0.4 + a.wash * 0.5) * OP_Q);
      const cg = clusterGlow.current;
      if (cg && clusterOp !== a.wCluster) {
        a.wCluster = clusterOp;
        cg.setAttribute("opacity", (clusterOp / OP_Q).toFixed(3));
      }

      /* Прозрачность красной зоны живёт на ОБЁРТКЕ, а не на светящемся пути:
         так размытие под ним не пересчитывается на каждое изменение. */
      const redOp = Math.round((0.28 + inv(REDLINE, 1, a.rpm / RPM_TOP) * 0.72) * OP_Q);
      const rl = redline.current;
      if (rl && redOp !== a.wRed) {
        a.wRed = redOp;
        rl.setAttribute("opacity", (redOp / OP_Q).toFixed(3));
      }

      /* Цифры — десять раз в секунду: мельтешение шестьюдесятью нечитаемо. */
      if (now - a.textAt >= 100) {
        a.textAt = now;
        const dist = String(Math.max(0, Math.round(g.s)));
        const score = String(Math.round(g.score));
        setText(distGhost.current, ghostFor(dist));
        setText(distText.current, dist);
        setText(scoreGhost.current, ghostFor(score));
        setText(scoreText.current, score);
        setText(bestText.current, String(Math.round(Math.max(g.best, g.score))));
        setText(kmhText.current, String(Math.round(a.kmh)));
        setText(gearText.current, g.speed < 1.5 ? "N" : String(gear + 1));
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [g]);

  return (
    <div aria-hidden="true" style={WRAP}>
      <svg viewBox="0 0 1000 460" preserveAspectRatio="xMidYMax slice" style={SVG_STYLE}>
        <defs>
          <filter
            id="srd-glow"
            x="-70%"
            y="-70%"
            width="240%"
            height="240%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Тот же ореол для крупных групп: рамка фильтра задаётся в долях
              bbox, и для циферблата 160×160 хватает 12% (≈19 единиц при
              stdDeviation 2.4). Поверхность вчетверо меньше, чем у −70%/240%. */}
          <filter
            id="srd-glow-w"
            x="-12%"
            y="-12%"
            width="124%"
            height="124%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Ореол вокруг приборов — градиентом, а не фильтром: он меняет
              прозрачность каждый кадр, фильтр тут был бы дорог. */}
          <radialGradient id="srd-halo">
            <stop offset="0" stopColor={COLORS.gaugeGlow} stopOpacity="0.5" />
            <stop offset="0.45" stopColor={COLORS.gauge} stopOpacity="0.18" />
            <stop offset="1" stopColor={COLORS.gauge} stopOpacity="0" />
          </radialGradient>

          {/* Циферблат: подсвеченная красным глубина. */}
          <radialGradient id="srd-face" cx="50%" cy="38%" r="72%">
            <stop offset="0" stopColor="#280804" />
            <stop offset="0.68" stopColor="#0c0206" />
            <stop offset="1" stopColor="#01030a" />
          </radialGradient>

          <linearGradient id="srd-dash" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={COLORS.neon} stopOpacity="0.24" />
            <stop offset="1" stopColor={COLORS.neon} stopOpacity="0" />
          </linearGradient>

          {/* Обод руля: сверху ловит свет лобового, снизу глухая тень. */}
          <linearGradient id="srd-rim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#26303f" />
            <stop offset="0.32" stopColor="#111823" />
            <stop offset="1" stopColor="#04060b" />
          </linearGradient>

          <linearGradient id="srd-spoke" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1b2432" />
            <stop offset="1" stopColor="#070a11" />
          </linearGradient>

          {/* Кисть: почти силуэт. Сверху холодный отблеск лобового, к низу уходит
              в чёрное с еле заметным тёплым подмесом от приборки. Ничего
              «телесного» — в кадре рука не должна спорить с дорогой. */}
          <linearGradient id="srd-skin" x1="0" y1="0" x2="0.18" y2="1">
            <stop offset="0" stopColor="#2b3947" />
            <stop offset="0.38" stopColor="#151d27" />
            <stop offset="0.78" stopColor="#0a0d14" />
            <stop offset="1" stopColor="#150c0e" />
          </linearGradient>

          {/* Рукав: ещё темнее кисти, он дальше от стекла. */}
          <linearGradient id="srd-sleeve" x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="#141c26" />
            <stop offset="1" stopColor="#04060c" />
          </linearGradient>

          <linearGradient id="srd-mirror" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#071228" />
            <stop offset="1" stopColor="#030711" />
          </linearGradient>

          <clipPath id="srd-mirror-clip">
            <rect x={566} y={16} width={190} height={52} rx={10} />
          </clipPath>

          {/* Всё, что светится на панели, обрезаем кромкой панели: выше неё
              стекло, и красный ореол не должен ложиться на дорогу. */}
          <clipPath id="srd-dash-clip">
            <path d={DASH_CLIP_D} />
          </clipPath>
        </defs>

        {!g.reducedMotion && <style>{STREAK_CSS}</style>}

        {/* ---------- 1. силуэт кабины ---------- */}
        <path d={CABIN_D} fillRule="evenodd" fill={COLORS.cabin} />
        <path d={APERTURE_D} fill="none" stroke={COLORS.cabinEdge} strokeWidth={1.5} />
        <path d={DASH_SHEEN_D} fill="url(#srd-dash)" />
        <path
          d="M 96 152 C 300 208 700 208 904 152"
          fill="none"
          stroke={COLORS.neon}
          strokeWidth={1.2}
          opacity={0.22}
        />

        {/* ---------- 2. зеркало заднего вида ---------- */}
        <g>
          <rect x={648} y={2} width={16} height={16} fill="#080c14" />
          <rect
            x={556}
            y={8}
            width={210}
            height={68}
            rx={16}
            fill="#05080f"
            stroke={COLORS.cabinEdge}
            strokeWidth={1.5}
          />
          <rect x={566} y={16} width={190} height={52} rx={10} fill="url(#srd-mirror)" />
          <g clipPath="url(#srd-mirror-clip)" opacity={0.9}>
            <rect
              className="srd-streak"
              x={566}
              y={26}
              width={54}
              height={5}
              rx={2.5}
              fill={COLORS.neon}
              opacity={g.reducedMotion ? 0.35 : 0}
            />
            <rect
              className="srd-streak srd-streak-b"
              x={566}
              y={40}
              width={78}
              height={4}
              rx={2}
              fill={COLORS.neonDeep}
              opacity={g.reducedMotion ? 0.3 : 0}
            />
            <rect
              className="srd-streak srd-streak-c"
              x={566}
              y={53}
              width={40}
              height={3}
              rx={1.5}
              fill={COLORS.head}
              opacity={g.reducedMotion ? 0.22 : 0}
            />
          </g>
          <rect
            x={566}
            y={16}
            width={190}
            height={52}
            rx={10}
            fill="none"
            stroke={COLORS.cabinEdge}
            strokeWidth={1}
            opacity={0.7}
          />
        </g>

        {/* ---------- 3. приборка ---------- */}
        <g clipPath="url(#srd-dash-clip)">
          {/* козырёк приборки */}
          <rect
            x={206}
            y={200}
            width={588}
            height={226}
            rx={44}
            fill="#02040c"
            stroke={COLORS.cabinEdge}
            strokeWidth={1.5}
          />
          <path
            d="M 250 202 C 360 194 640 194 750 202"
            fill="none"
            stroke={COLORS.neon}
            strokeWidth={1.2}
            opacity={0.18}
          />

          {/* мягкий ореол — им же играем на нитро */}
          <g ref={clusterGlow} opacity={0.4}>
            <circle cx={TACH_CX} cy={DIAL_CY} r={132} fill="url(#srd-halo)" />
            <circle cx={SPEED_CX} cy={DIAL_CY} r={132} fill="url(#srd-halo)" />
            <circle cx={500} cy={248} r={104} fill="url(#srd-halo)" />
          </g>

          {/* --- тахометр --- */}
          <g transform={`translate(${TACH_CX} ${DIAL_CY})`}>
            <circle r={DIAL_R + 7} fill="#01030a" stroke={COLORS.cabinEdge} strokeWidth={2} />
            <circle r={DIAL_R} fill="url(#srd-face)" />
            {/* Короткие риски не светятся — фильтр им не нужен. */}
            <g stroke={COLORS.gaugeDim} strokeWidth={1.4}>
              {TACH_MINOR.map((t, i) => (
                <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
              ))}
            </g>
            {/* Шкала и длинные риски — один фильтр на всю статику циферблата. */}
            <g filter={glowW}>
              <path
                d={SCALE_ARC}
                fill="none"
                stroke={COLORS.gauge}
                strokeWidth={2}
                opacity={0.45}
              />
              <g stroke={COLORS.gauge} strokeWidth={2.6} opacity={0.8}>
                {TACH_MAJOR.map((t, i) => (
                  <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
                ))}
              </g>
            </g>
            <g ref={redline} opacity={0.3}>
              <path
                d={REDLINE_ARC}
                fill="none"
                stroke={COLORS.gauge}
                strokeWidth={5}
                strokeLinecap="round"
                filter={glowW}
              />
            </g>
            {TACH_NUMS.map((n) => (
              <text
                key={n.label}
                x={n.x}
                y={n.y}
                fill={COLORS.gaugeDim}
                fontFamily={MONO}
                fontSize={13}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {n.label}
              </text>
            ))}
            <text
              x={0}
              y={38}
              fill={COLORS.gaugeDim}
              fontFamily={MONO}
              fontSize={9}
              letterSpacing={1.6}
              textAnchor="middle"
            >
              x1000
            </text>
            {/* индикатор передачи */}
            <text
              ref={gearText}
              x={0}
              y={-32}
              fill={COLORS.gauge}
              fontFamily={MONO}
              fontSize={23}
              fontWeight={700}
              textAnchor="middle"
              filter={glow}
            >
              N
            </text>
            <text
              x={0}
              y={-16}
              fill={COLORS.gaugeDim}
              fontFamily={MONO}
              fontSize={8}
              letterSpacing={2}
              textAnchor="middle"
            >
              GEAR
            </text>
            <g ref={tachNeedle} transform={`rotate(${START})`}>
              <path
                d={`M -3.6 14 L -1.6 ${-DIAL_R + 18} L 0 ${-DIAL_R + 12} L 1.6 ${
                  -DIAL_R + 18
                } L 3.6 14 Z`}
                fill={COLORS.gauge}
                filter={glow}
              />
            </g>
            <circle r={8} fill="#180402" stroke={COLORS.gauge} strokeWidth={1.6} />
          </g>

          {/* --- спидометр --- */}
          <g transform={`translate(${SPEED_CX} ${DIAL_CY})`}>
            <circle r={DIAL_R + 7} fill="#01030a" stroke={COLORS.cabinEdge} strokeWidth={2} />
            <circle r={DIAL_R} fill="url(#srd-face)" />
            <g stroke={COLORS.gaugeDim} strokeWidth={1.4}>
              {SPEED_MINOR.map((t, i) => (
                <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
              ))}
            </g>
            <g filter={glowW}>
              <path
                d={SCALE_ARC}
                fill="none"
                stroke={COLORS.gauge}
                strokeWidth={2}
                opacity={0.45}
              />
              <g stroke={COLORS.gauge} strokeWidth={2.6} opacity={0.8}>
                {SPEED_MAJOR.map((t, i) => (
                  <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
                ))}
              </g>
            </g>
            {SPEED_NUMS.map((n) => (
              <text
                key={n.label}
                x={n.x}
                y={n.y}
                fill={COLORS.gaugeDim}
                fontFamily={MONO}
                fontSize={12}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {n.label}
              </text>
            ))}
            <text
              x={0}
              y={44}
              fill={COLORS.gaugeDim}
              fontFamily={MONO}
              fontSize={9.5}
              letterSpacing={2}
              textAnchor="middle"
            >
              km/h
            </text>
            <text
              ref={kmhText}
              x={0}
              y={-28}
              fill={COLORS.gauge}
              fontFamily={MONO}
              fontSize={24}
              fontWeight={700}
              textAnchor="middle"
              filter={glow}
            >
              0
            </text>
            <g ref={speedNeedle} transform={`rotate(${START})`}>
              <path
                d={`M -3.6 14 L -1.6 ${-DIAL_R + 18} L 0 ${-DIAL_R + 12} L 1.6 ${
                  -DIAL_R + 18
                } L 3.6 14 Z`}
                fill={COLORS.gauge}
                filter={glow}
              />
            </g>
            <circle r={8} fill="#180402" stroke={COLORS.gauge} strokeWidth={1.6} />
          </g>

          {/* --- центральный сегментный блок --- */}
          <g>
            <rect
              x={396}
              y={204}
              width={208}
              height={86}
              rx={10}
              fill="#01030a"
              stroke={COLORS.gaugeDim}
              strokeWidth={1.2}
            />
            {/* DIST */}
            <text x={406} y={232} fill={COLORS.gaugeDim} fontFamily={MONO} fontSize={9.5} letterSpacing={1.5}>
              DIST
            </text>
            <text
              ref={distGhost}
              x={594}
              y={234}
              fill={COLORS.gaugeDim}
              fontFamily={MONO}
              fontSize={23}
              fontWeight={700}
              textAnchor="end"
              opacity={0.15}
            >
              8
            </text>
            <text
              ref={distText}
              x={594}
              y={234}
              fill={COLORS.gauge}
              fontFamily={MONO}
              fontSize={23}
              fontWeight={700}
              textAnchor="end"
              filter={glow}
            >
              0
            </text>
            {/* SCORE */}
            <text x={406} y={261} fill={COLORS.gaugeDim} fontFamily={MONO} fontSize={9.5} letterSpacing={1.5}>
              SCORE
            </text>
            <text
              ref={scoreGhost}
              x={594}
              y={262}
              fill={COLORS.gaugeDim}
              fontFamily={MONO}
              fontSize={19}
              fontWeight={700}
              textAnchor="end"
              opacity={0.15}
            >
              8
            </text>
            <text
              ref={scoreText}
              x={594}
              y={262}
              fill={COLORS.gauge}
              fontFamily={MONO}
              fontSize={19}
              fontWeight={700}
              textAnchor="end"
              filter={glow}
            >
              0
            </text>
            {/* BEST */}
            <text x={406} y={283} fill={COLORS.gaugeDim} fontFamily={MONO} fontSize={9.5} letterSpacing={1.5}>
              BEST
            </text>
            <text
              ref={bestText}
              x={594}
              y={284}
              fill={COLORS.gauge}
              fontFamily={MONO}
              fontSize={15}
              textAnchor="end"
              opacity={0.72}
            >
              0
            </text>
          </g>
        </g>

        {/* ---------- 4. дефлекторы слева и консоль справа ---------- */}
        <g>
          {/* левый дефлектор */}
          <rect
            x={40}
            y={218}
            width={150}
            height={78}
            rx={12}
            fill="#02040a"
            stroke={COLORS.cabinEdge}
            strokeWidth={1.2}
          />
          {[0, 1, 2, 3].map((i) => (
            <rect
              key={i}
              x={52}
              y={230 + i * 16}
              width={126}
              height={5}
              rx={2.5}
              fill="#0a1020"
              stroke={COLORS.cabinEdge}
              strokeWidth={0.6}
            />
          ))}
          <circle cx={64} cy={318} r={5} fill={COLORS.gauge} opacity={0.75} filter={glow} />
          <circle cx={86} cy={318} r={5} fill={COLORS.gaugeDim} />

          {/* правый дефлектор */}
          <rect
            x={812}
            y={218}
            width={150}
            height={78}
            rx={12}
            fill="#02040a"
            stroke={COLORS.cabinEdge}
            strokeWidth={1.2}
          />
          {[0, 1, 2, 3].map((i) => (
            <rect
              key={i}
              x={824}
              y={230 + i * 16}
              width={126}
              height={5}
              rx={2.5}
              fill="#0a1020"
              stroke={COLORS.cabinEdge}
              strokeWidth={0.6}
            />
          ))}

          {/* центральная консоль: анонимные красные сегменты и глухие кнопки */}
          <rect
            x={738}
            y={330}
            width={220}
            height={130}
            rx={16}
            fill="#02040b"
            stroke={COLORS.cabinEdge}
            strokeWidth={1.5}
          />
          <g filter={glow}>
            {CONSOLE_SEGS.map((s, i) => (
              <rect
                key={i}
                x={s.x}
                y={s.y}
                width={s.w}
                height={6}
                rx={2}
                fill={COLORS.gauge}
                opacity={s.o}
              />
            ))}
          </g>
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <circle
                cx={772 + i * 48}
                cy={428}
                r={16}
                fill="#070a12"
                stroke={COLORS.cabinEdge}
                strokeWidth={1.2}
              />
              <circle
                cx={772 + i * 48}
                cy={428}
                r={3.2}
                fill={COLORS.gauge}
                opacity={0.55 + hash1(i * 31 + 9) * 0.4}
                filter={glow}
              />
            </g>
          ))}
          {/* красная полоса подсвета вдоль консоли */}
          <rect
            x={744}
            y={412}
            width={4}
            height={40}
            rx={2}
            fill={COLORS.gauge}
            opacity={0.5}
            filter={glow}
          />
        </g>

        {/* ---------- 5. руль и руки ---------- */}
        {/* Внешняя группа — только перспектива: круг, сжатый по вертикали.
            Крутится внутренняя, поэтому обод остаётся неподвижным эллипсом,
            а спицы и руки поворачиваются внутри него, как в жизни. */}
        <g transform={`translate(${WHEEL_CX} ${WHEEL_CY}) scale(1 ${WHEEL_SQUASH})`}>
          <g ref={wheelRef} transform="rotate(0)">
            {/* обод */}
            <circle
              r={WHEEL_R - 17}
              fill="none"
              stroke="url(#srd-rim)"
              strokeWidth={34}
            />
            <circle
              r={WHEEL_R}
              fill="none"
              stroke="#01030a"
              strokeWidth={2}
              opacity={0.8}
            />
            <path
              d={arcPath(WHEEL_R - 24, -62, 62)}
              fill="none"
              stroke={COLORS.neon}
              strokeWidth={2.6}
              opacity={0.34}
            />
            <path
              d={arcPath(WHEEL_R - 3, -46, 46)}
              fill="none"
              stroke={COLORS.neon}
              strokeWidth={1.4}
              opacity={0.18}
            />

            {/* Три спицы: две низкие широкие и одна вниз по центру. Углы почти
                горизонтальные — при таком кадре только они и попадают в поле
                зрения, всё, что ниже, срезано нижней кромкой viewBox. */}
            {[-98, 98, 180].map((a) => (
              <g key={a} transform={`rotate(${a})`}>
                <path
                  d={`M -27 -44 L -20 ${-WHEEL_R + 26} Q 0 ${-WHEEL_R + 16} 20 ${
                    -WHEEL_R + 26
                  } L 27 -44 Q 0 -32 -27 -44 Z`}
                  fill="url(#srd-spoke)"
                  stroke="#01030a"
                  strokeWidth={1.5}
                />
                <path
                  d={`M -19 -48 L -13 ${-WHEEL_R + 30}`}
                  fill="none"
                  stroke={COLORS.neon}
                  strokeWidth={1.4}
                  opacity={0.16}
                />
              </g>
            ))}

            {/* ступица со звездой */}
            <circle r={52} fill="#080b12" stroke={COLORS.cabinEdge} strokeWidth={2} />
            <circle r={40} fill="none" stroke="#b9c8d8" strokeWidth={4.5} opacity={0.85} />
            {[0, 120, 240].map((a) => (
              <line
                key={a}
                x1={0}
                y1={0}
                x2={ax(38, a)}
                y2={ay(38, a)}
                stroke="#b9c8d8"
                strokeWidth={6.5}
                strokeLinecap="round"
                opacity={0.85}
              />
            ))}
            <circle r={40} fill="none" stroke={COLORS.neon} strokeWidth={1.6} opacity={0.3} />

            {/* Руки. Группа сжата перспективой вместе с рулём, поэтому внутри
                кисть распрямляем обратным масштабом — иначе она сплющится. */}
            {[1, -1].map((side) => (
              <g
                key={side}
                transform={
                  `translate(${(side * ax(RIM_MID, HAND_ANGLE)).toFixed(1)} ` +
                  `${ay(RIM_MID, HAND_ANGLE).toFixed(1)}) ` +
                  `scale(${side * HAND_SCALE} ${(WHEEL_UNSQUASH * HAND_SCALE).toFixed(3)}) ` +
                  `rotate(${HAND_TILT})`
                }
              >
                <path d={ARM_D} fill="url(#srd-sleeve)" />
                <path d={WATCH_D} fill="#080d15" />
                <circle cx={64} cy={61} r={6} fill="#101823" />
                <circle cx={64} cy={61} r={2.4} fill={COLORS.neon} opacity={0.5} />
                {/* Большой палец уходит под хват — виден только его верх. */}
                <path
                  d={THUMB_D}
                  fill="none"
                  stroke="#18212c"
                  strokeWidth={13}
                  strokeLinecap="round"
                />
                <path d={GRIP_D} fill="url(#srd-skin)" />
                {/* Пальцы — не формы, а борозды между ними. */}
                {FINGERS.map((fy) => (
                  <line
                    key={fy}
                    x1={GROOVE_X0}
                    y1={fy}
                    x2={GROOVE_X1}
                    y2={fy + 2}
                    stroke="#03060c"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    opacity={0.75}
                  />
                ))}
                {/* Холодная кромка сверху — свет с лобового стекла. */}
                <path
                  d={GRIP_RIM_D}
                  fill="none"
                  stroke={COLORS.neon}
                  strokeWidth={2}
                  strokeLinecap="round"
                  opacity={0.5}
                />
                {/* Тёплый отсвет снизу — красная приборка. */}
                <path
                  d={GRIP_BOUNCE_D}
                  fill="none"
                  stroke={COLORS.gauge}
                  strokeWidth={2}
                  strokeLinecap="round"
                  opacity={0.28}
                />
              </g>
            ))}
          </g>
        </g>

        {/* ---------- 6. заливка нитро поверх всего салона ---------- */}
        <path
          ref={nitroWash}
          d={CABIN_D}
          fillRule="evenodd"
          fill={COLORS.nitro}
          opacity={0}
        />
      </svg>
    </div>
  );
}
