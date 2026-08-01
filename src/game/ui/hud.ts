/**
 * HUD — читаемое состояние заезда поверх сцены и тач-управление.
 *
 * Два разных источника данных, и их нельзя путать:
 *
 * - `snap` (HudSnapshot) приходит в `sync` примерно двенадцать раз в секунду.
 *   Всё, что можно отрисовать «ступеньками» — очки, рекорд, жизни, множитель,
 *   комбо, — обновляется оттуда. Разметка при этом НЕ пересобирается: дерево
 *   строится один раз в фабрике, дальше пишутся только `textContent` и стили по
 *   заранее найденным ссылкам.
 * - `g` (мутируемый объект игры) читается в `frame`. Полоса нитро должна ползти
 *   плавно, поэтому её ширину пишем каждый кадр напрямую из `g.nitro`. HUD
 *   ничего в `g` не пишет — это дело `input.ts`, до которого `main.ts`
 *   пробрасывает мост `touch`.
 *
 * Верх экрана целиком наш, низ (≈42vh) принадлежит приборке, поэтому всё
 * информационное прижато к верхней кромке, а тач-кнопки живут выше линии панели.
 * Приоритет по месту: центр верха — только жизни (их ловят боковым зрением),
 * слева — счёт и ресурсы, справа — кнопки и множитель. Всё разовое (смена главы,
 * комбо) вспыхивает и уходит, постоянного места не занимая.
 *
 * Контейнер `pointer-events: none` — сквозь него проходит драг по канвасу
 * (рулевая поверхность из `input.ts`). Интерактивные элементы включают
 * `pointer-events: auto` точечно и гасят всплытие, чтобы палец на кнопке не
 * считался одновременно рулением.
 *
 * Три вспышки (смена главы, потеря жизни, комбо) раньше рисовала `motion`.
 * Библиотека ушла вместе с React, вместо неё — обычные `@keyframes` в одном
 * `<style>`, который живёт ровно столько же, сколько оверлей. Анимация
 * перезапускается снятием и повторной установкой класса; фаза «уменьшенного
 * движения» выбирает второй, спокойный набор классов.
 */

import type { Overlay } from "../ctx";
import type { Game, HudSnapshot } from "../types";
import { COLORS, NITRO } from "../config";
import { clamp01, damp } from "../num";

/* ---------- внешний контракт ---------- */

export interface HudHooks {
  onPause(): void;
  onMute(): void;
  /** Не передан — тач-управление просто не рисуется. */
  touch?: {
    steer(v: number): void;
    button(b: "throttle" | "brake" | "nitro", down: boolean): void;
  };
}

/* ---------- константы оформления ---------- */

/** Тонкий пробел для разрядов: обычный слишком широко разваливает число. */
const THIN = " ";

const SHADOW_SCORE = "0 2px 12px rgba(0,0,0,0.9), 0 0 26px rgba(94,203,255,0.35)";
const SHADOW_SOFT = "0 1px 6px rgba(0,0,0,0.9)";
const SHADOW_NEON = "0 1px 6px rgba(0,0,0,0.9), 0 0 14px rgba(94,203,255,0.45)";
const SHADOW_COMBO = "0 1px 8px rgba(0,0,0,0.9), 0 0 20px rgba(255,209,92,0.55)";

/** Ореол плашки жизней: обычный и «последняя жизнь». */
const PLATE_CALM = "inset 0 0 0 1px rgba(94,203,255,0.24), 0 0 16px rgba(4,8,26,0.85)";
const PLATE_LAST = "inset 0 0 0 1px rgba(255,74,58,0.5), 0 0 18px rgba(255,74,58,0.35)";

/** Насколько быстро полоса нитро догоняет `g.nitro`, 1/с. */
const NITRO_TRACK = 14;
/** Насколько быстро тач-зона докручивает руль до упора, 1/с. */
const STEER_TRACK = 16;

/** Сколько миллисекунд висит вспышка смены главы. */
const CHAPTER_FLASH_MS = 2400;

/**
 * Имена глав неба — ровно те слои, что включает система неба (см. docs/GAME.md).
 * Номер главы растёт бесконечно, имя берётся по модулю, как и в самой сцене.
 */
const CHAPTER_NAMES = ["метеоры", "туманность", "воронка", "чистое небо"] as const;

/** Сколько жизней рисуем слотами. Совпадает с `LIVES` в движке. */
const LIFE_COUNT = 3;

/**
 * Габарит значка жизни. Одинаков у целой и потерянной — строка не должна дёргаться.
 * Нижняя граница подобрана так, чтобы на 390 px плашка жизней не наехала на
 * шестизначный счёт слева: там между колонками остаётся всего пара десятков px.
 */
const LIFE_BOX = "width:clamp(24px, 6.2vw, 34px);height:auto;display:block";

/* Крыша с задним стеклом. Контур намеренно не замкнут: заливка закроет его сама,
   а обводке потерянной жизни лишняя линия по верху корпуса только мешала бы. */
const LIFE_ROOF = "M9 9.2 10.9 4.4C11.3 3.2 12 2.7 13.1 2.7h3.8c1.1 0 1.8.5 2.2 1.7L21 9.2";

/* ---------- анимации ---------- */

/**
 * Замена `motion`. Смысл каждой кривой тот же, что был у пружины: комбо и удар
 * по жизням выпрыгивают с небольшим перелётом, глава въезжает слева и тает.
 * Спокойный набор (`-calm`) — только прозрачность, как и раньше.
 */
const ANIM_CSS = `
@keyframes sr-hud-ch-in {
  from { opacity: 0; transform: translateX(-12px) }
  to { opacity: .9; transform: none }
}
@keyframes sr-hud-ch-in-calm { from { opacity: 0 } to { opacity: .9 } }
@keyframes sr-hud-ch-out { from { opacity: .9 } to { opacity: 0 } }
.sr-hud-ch-in { animation: sr-hud-ch-in .42s cubic-bezier(0,0,.2,1) forwards }
.sr-hud-ch-in-calm { animation: sr-hud-ch-in-calm .16s cubic-bezier(0,0,.2,1) forwards }
.sr-hud-ch-out { animation: sr-hud-ch-out .42s cubic-bezier(0,0,.2,1) forwards }
.sr-hud-ch-out-calm { animation: sr-hud-ch-out .16s cubic-bezier(0,0,.2,1) forwards }

@keyframes sr-hud-hit {
  0% { opacity: .5; transform: scale(1.28) }
  46% { opacity: 1; transform: scale(.962) }
  72% { transform: scale(1.014) }
  88% { transform: scale(.997) }
  100% { opacity: 1; transform: none }
}
@keyframes sr-hud-hit-calm { from { opacity: .45 } to { opacity: 1 } }
.sr-hud-hit { animation: sr-hud-hit .42s cubic-bezier(.2,.7,.3,1) }
.sr-hud-hit-calm { animation: sr-hud-hit-calm .18s linear }

@keyframes sr-hud-combo-in {
  0% { opacity: 0; transform: translateX(18px) scale(.55) rotate(-6deg) }
  52% { opacity: 1; transform: translateX(-3px) scale(1.075) rotate(1.6deg) }
  76% { transform: translateX(1px) scale(.985) rotate(-.5deg) }
  100% { opacity: 1; transform: none }
}
@keyframes sr-hud-combo-out {
  from { opacity: 1; transform: none }
  to { opacity: 0; transform: translateY(-10px) scale(.85) }
}
@keyframes sr-hud-combo-in-calm { from { opacity: 0 } to { opacity: 1 } }
@keyframes sr-hud-combo-out-calm { from { opacity: 1 } to { opacity: 0 } }
.sr-hud-combo-in { animation: sr-hud-combo-in .4s cubic-bezier(.2,.7,.3,1) forwards }
.sr-hud-combo-out { animation: sr-hud-combo-out .26s cubic-bezier(.4,0,1,1) forwards }
.sr-hud-combo-in-calm { animation: sr-hud-combo-in-calm .15s linear forwards }
.sr-hud-combo-out-calm { animation: sr-hud-combo-out-calm .15s linear forwards }
`;

const CH_ANIM = ["sr-hud-ch-in", "sr-hud-ch-in-calm", "sr-hud-ch-out", "sr-hud-ch-out-calm"];
const HIT_ANIM = ["sr-hud-hit", "sr-hud-hit-calm"];
const COMBO_ANIM = [
  "sr-hud-combo-in",
  "sr-hud-combo-in-calm",
  "sr-hud-combo-out",
  "sr-hud-combo-out-calm",
];

/** Перезапуск анимации: снять класс, дать браузеру пересчитать стиль, вернуть. */
function playAnim(node: HTMLElement, cls: string, group: readonly string[]): void {
  node.classList.remove(...group);
  // Без чтения layout браузер не увидит промежуточного состояния и анимацию
  // не перезапустит — это и есть цена перезапуска, платится только на событии.
  void node.offsetWidth;
  node.classList.add(cls);
}

/* ---------- форматирование ---------- */

/** Разряды тонкими пробелами: 1234567 → «1 234 567». */
function groupNum(n: number): string {
  const v = Math.max(0, Math.round(n));
  const s = String(v);
  if (s.length < 5) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const left = s.length - i;
    out += s[i];
    if (left > 1 && (left - 1) % 3 === 0) out += THIN;
  }
  return out;
}

/** Дистанция: до километра — в метрах, дальше — в километрах с сотыми. */
function formatDistance(m: number): string {
  if (m < 1000) return `${Math.floor(m)}${THIN}м`;
  return `${(m / 1000).toFixed(2)}${THIN}км`;
}

/* ---------- мелкая графика ---------- */

/**
 * Значок жизни — машина сзади с горящими стопами. Разница «целая/потерянная»
 * несёт не цвет, а форма: целая — сплошной силуэт с фонарями и колёсами,
 * потерянная — пустой контур. Значит счёт читается и в оттенках серого, и
 * боковым зрением, ради чего этот индикатор вообще существует.
 *
 * Обе версии лежат в разметке рядом, видимая переключается `display`: пересборка
 * SVG двенадцать раз в секунду обошлась бы дороже, чем шесть лишних узлов.
 */
const LIFE_WHOLE =
  `<svg data-n="whole" viewBox="0 0 30 22" style="${LIFE_BOX}" aria-hidden="true">` +
  /* колёса — тот же тон, приглушённый: силуэт «стоит», а не висит */
  `<g data-t="1" fill="${COLORS.neon}" opacity="0.45">` +
  `<rect x="5.6" y="15.8" width="5.4" height="3.4" rx="1.4"/>` +
  `<rect x="19" y="15.8" width="5.4" height="3.4" rx="1.4"/>` +
  `</g>` +
  `<g data-t="1" fill="${COLORS.neon}">` +
  `<path d="${LIFE_ROOF}"/>` +
  `<rect x="2.6" y="8.6" width="24.8" height="8.2" rx="2.6"/>` +
  `</g>` +
  /* номерной знак — тёмный вырез, он и делает силуэт «машиной сзади» */
  `<rect x="12.4" y="11.2" width="5.2" height="3" rx="0.9" fill="${COLORS.night0}" opacity="0.85"/>` +
  /* стопы. Тёмная обводка держит их читаемыми и когда корпус сам красный */
  `<g fill="${COLORS.tail}" stroke="${COLORS.night0}" stroke-width="0.9">` +
  `<rect x="4.6" y="10.6" width="6.4" height="3.6" rx="1.4"/>` +
  `<rect x="19" y="10.6" width="6.4" height="3.6" rx="1.4"/>` +
  `</g>` +
  `</svg>`;

const LIFE_LOST =
  `<svg data-n="lost" viewBox="0 0 30 22" style="${LIFE_BOX};display:none" aria-hidden="true" ` +
  `fill="none" stroke="rgba(186,210,242,0.32)" stroke-width="1.5" stroke-linejoin="round">` +
  `<path d="${LIFE_ROOF}"/>` +
  `<rect x="3.4" y="9" width="23.2" height="7.8" rx="2.5"/>` +
  `</svg>`;

const PAUSE_ICON =
  `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">` +
  `<path data-n="ic-play" d="M4 2.5 13 8l-9 5.5z" style="display:none"/>` +
  `<g data-n="ic-bars">` +
  `<rect x="3.5" y="2.5" width="3.2" height="11" rx="1"/>` +
  `<rect x="9.3" y="2.5" width="3.2" height="11" rx="1"/>` +
  `</g>` +
  `</svg>`;

const SOUND_ICON =
  `<svg viewBox="0 0 18 16" width="15" height="14" aria-hidden="true" fill="none" ` +
  `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M2 6h2.6L8.4 3v10L4.6 10H2z" fill="currentColor" stroke="none"/>` +
  `<g data-n="ic-mute" style="display:none">` +
  `<path d="M11.4 6.2 15.6 9.8"/>` +
  `<path d="M15.6 6.2 11.4 9.8"/>` +
  `</g>` +
  `<g data-n="ic-waves">` +
  `<path d="M11.3 5.6a4.2 4.2 0 0 1 0 4.8"/>` +
  `<path d="M13.6 3.6a7 7 0 0 1 0 8.8"/>` +
  `</g>` +
  `</svg>`;

/* ---------- разметка ---------- */

const MARKUP =
  /* ------ слева: очки, рекорд, дистанция, нитро ------ */
  `<div data-n="left" class="absolute left-3 top-3 transition-opacity duration-300 sm:left-5 sm:top-4">` +
  `<div data-n="score" class="tnum font-black leading-none" ` +
  `style="font-size:clamp(30px, 7.6vw, 54px);letter-spacing:-0.02em;color:${COLORS.star};text-shadow:${SHADOW_SCORE}">0</div>` +
  `<div class="mt-1.5 text-[10px] font-bold uppercase" ` +
  `style="letter-spacing:0.26em;color:#8ba3c2;text-shadow:${SHADOW_SOFT}">` +
  `рекорд <span data-n="best" class="tnum">0</span></div>` +
  `<div data-n="dist" class="tnum mt-1 text-[12px] font-bold" ` +
  `style="letter-spacing:0.14em;color:${COLORS.neon};text-shadow:${SHADOW_NEON}">0${THIN}м</div>` +
  /* полоса нитро — единственное, что живёт на 60 Гц */
  `<div class="mt-2.5 flex items-center gap-2">` +
  `<span data-n="nlabel" class="text-[9px] font-black uppercase" ` +
  `style="letter-spacing:0.3em;color:${COLORS.nitro};opacity:0.85;text-shadow:${SHADOW_SOFT}">нитро</span>` +
  `<div class="relative h-[7px] w-[clamp(92px,27vw,190px)] overflow-hidden rounded-full" ` +
  `style="background:rgba(122,255,200,0.10);box-shadow:inset 0 0 0 1px rgba(122,255,200,0.22)">` +
  `<div data-n="nfill" class="h-full w-full origin-left rounded-full" ` +
  `style="transform:scaleX(0);background:linear-gradient(90deg, ${COLORS.neonDeep}, ${COLORS.nitro});` +
  `box-shadow:0 0 12px ${COLORS.nitro};will-change:transform"></div>` +
  `</div>` +
  `</div>` +
  /*
    Глава неба. Раньше она стояла постоянной плашкой под жизнями и отбирала
    у них и место, и внимание, хотя смысла несёт куда меньше: это событие, а
    не показатель. Теперь — короткая вспышка в тихом углу, на смене главы и
    с именем слоя, который в этот момент включается в небе. Стоит последней
    в колонке, поэтому её появление ничего не двигает.
  */
  `<div data-n="chapter" class="mt-2.5 whitespace-nowrap text-[10px] font-bold uppercase" ` +
  `style="letter-spacing:0.22em;color:${COLORS.neon};text-shadow:${SHADOW_NEON};opacity:0">` +
  `глава <span data-n="chnum" class="tnum">1</span><span data-n="chname" style="opacity:0.6"></span></div>` +
  `</div>` +
  /* ------ центр: жизни ------ */
  `<div data-n="center" class="absolute left-1/2 top-3 -translate-x-1/2 transition-opacity duration-300 sm:top-4">` +
  /*
    Тёмная плашка обязательна: над этим местом проходят и блик-звезда, и
    туманность, и на светлом небе одни только силуэты тонут. Класс-«удар»
    переигрывается на каждой потере жизни — её должно быть видно, даже если
    смотреть на дорогу.
  */
  `<div data-n="plate" role="img" aria-label="жизни: ${LIFE_COUNT} из ${LIFE_COUNT}" ` +
  `class="flex items-center rounded-full" ` +
  `style="gap:clamp(3px, 1vw, 7px);padding:5px clamp(7px, 2vw, 11px);background:rgba(4,8,26,0.55);` +
  // Ореол делаем box-shadow, а не drop-shadow: тот же вид, но без фильтра,
  // то есть без отдельного слоя на каждый значок.
  `box-shadow:${PLATE_CALM}">` +
  (LIFE_WHOLE + LIFE_LOST).repeat(LIFE_COUNT) +
  `</div>` +
  `</div>` +
  /* ------ справа: кнопки, множитель, комбо ------ */
  `<div class="absolute right-3 top-3 flex flex-col items-end gap-2 sm:right-5 sm:top-4">` +
  `<div class="pointer-events-auto flex items-center gap-2">` +
  // Без backdrop-filter: он пересчитывает размытие подложки в каждом кадре
  // живого canvas — на мобильном это заметная цена за эффект, которого на
  // почти чёрном небе всё равно не видно.
  `<button data-n="pause" type="button" aria-label="Пауза" ` +
  `class="grid h-9 w-9 place-items-center rounded-full border text-soft transition-colors active:scale-95" ` +
  `style="border-color:rgba(94,203,255,0.28);background:rgba(7,13,30,0.8)">${PAUSE_ICON}</button>` +
  `<button data-n="mute" type="button" aria-label="Выключить звук" aria-pressed="false" ` +
  `class="grid h-9 w-9 place-items-center rounded-full border transition-colors active:scale-95" ` +
  `style="border-color:rgba(94,203,255,0.28);background:rgba(7,13,30,0.8);color:#c2d4ea">${SOUND_ICON}</button>` +
  `</div>` +
  `<div data-n="right" class="flex flex-col items-end gap-1 transition-opacity duration-300">` +
  `<div data-n="mult" class="tnum font-black leading-none" ` +
  `style="font-size:clamp(18px, 4.6vw, 28px);letter-spacing:-0.01em;color:${COLORS.star};` +
  `text-shadow:${SHADOW_SCORE}">×1.0</div>` +
  /* Комбо — главная награда за риск: выпрыгивает и тает. */
  `<div class="h-[26px]">` +
  `<div data-n="combo" class="flex items-baseline gap-1 rounded-full px-2.5 py-0.5" ` +
  `style="background:rgba(255,209,92,0.10);box-shadow:inset 0 0 0 1px rgba(255,209,92,0.35);` +
  `color:${COLORS.combo};text-shadow:0 1px 8px rgba(0,0,0,0.9), 0 0 18px rgba(255,209,92,0.6);opacity:0">` +
  `<span data-n="cnum" class="tnum text-[17px] font-black leading-none">2</span>` +
  `<span class="text-[9px] font-bold uppercase" style="letter-spacing:0.22em">подряд</span>` +
  `</div>` +
  `</div>` +
  `</div>` +
  `</div>`;

/** Тач-часть: невидимые зоны руления по нижним углам и педали над приборкой. */
const TOUCH_MARKUP =
  `<div data-n="zl" aria-hidden="true" class="pointer-events-auto absolute bottom-0 left-0 h-[34vh] w-[38vw]" ` +
  `style="touch-action:none;-webkit-tap-highlight-color:transparent"></div>` +
  `<div data-n="zr" aria-hidden="true" class="pointer-events-auto absolute bottom-0 right-0 h-[34vh] w-[38vw]" ` +
  `style="touch-action:none;-webkit-tap-highlight-color:transparent"></div>` +
  /* Педали — выше линии приборки, чтобы не спорить с рулём и кабиной. */
  `<div class="pointer-events-auto absolute right-3 flex flex-col items-end gap-3" style="bottom:48vh">` +
  `<button data-n="p-nitro" type="button" data-on="0" aria-label="Нитро" ` +
  `class="grid h-16 w-16 place-items-center rounded-full text-[10px] font-black uppercase active:scale-95" ` +
  `style="letter-spacing:0.14em;touch-action:none;color:${COLORS.nitro};background:rgba(122,255,200,0.10);` +
  `box-shadow:inset 0 0 0 1.5px ${COLORS.nitro}66, 0 0 18px rgba(122,255,200,0.25)">нитро</button>` +
  `<button data-n="p-brake" type="button" data-on="0" aria-label="Тормоз" ` +
  `class="grid h-14 w-14 place-items-center rounded-full text-[10px] font-black uppercase active:scale-95" ` +
  `style="letter-spacing:0.14em;touch-action:none;color:${COLORS.gaugeGlow};background:rgba(255,42,26,0.10);` +
  `box-shadow:inset 0 0 0 1.5px ${COLORS.gauge}66, 0 0 18px rgba(255,42,26,0.22)">стоп</button>` +
  `</div>`;

/* ---------- оверлей ---------- */

export function createHud(host: HTMLElement, hooks: HudHooks): Overlay {
  const touch = hooks.touch;

  /* Грубый указатель спрашиваем один раз при создании. Раньше это жило в
     эффекте ради SSR; SSR больше нет, а менять тип указателя посреди заезда
     некому — планшет с мышью и так попадает в «coarse» по основному вводу. */
  const coarse =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  /* «Уменьшенное движение» — тот же запрос, из которого его берёт `main.ts` для
     `g.reducedMotion`. В кадре значение подтверждается из самой игры. */
  let calm =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  const styleEl = document.createElement("style");
  styleEl.textContent = ANIM_CSS;
  document.head.appendChild(styleEl);

  const el = document.createElement("div");
  el.className = "pointer-events-none fixed inset-0 z-20 select-none";
  el.style.fontVariantNumeric = "tabular-nums";
  el.innerHTML = coarse && touch !== undefined ? MARKUP + TOUCH_MARKUP : MARKUP;
  host.appendChild(el);

  const pick = <T extends Element>(name: string): T => {
    const node = el.querySelector<T>(`[data-n="${name}"]`);
    if (!node) throw new Error(`HUD: нет узла ${name}`);
    return node;
  };

  /* Живые узлы находим один раз: дальше в них только пишут. */
  const left = pick<HTMLElement>("left");
  const center = pick<HTMLElement>("center");
  const right = pick<HTMLElement>("right");
  const scoreEl = pick<HTMLElement>("score");
  const bestEl = pick<HTMLElement>("best");
  const distEl = pick<HTMLElement>("dist");
  const nitroLabel = pick<HTMLElement>("nlabel");
  const nitroFill = pick<HTMLElement>("nfill");
  const chapterEl = pick<HTMLElement>("chapter");
  const chapterNum = pick<HTMLElement>("chnum");
  const chapterName = pick<HTMLElement>("chname");
  const plate = pick<HTMLElement>("plate");
  const multEl = pick<HTMLElement>("mult");
  const comboEl = pick<HTMLElement>("combo");
  const comboNum = pick<HTMLElement>("cnum");
  const pauseBtn = pick<HTMLButtonElement>("pause");
  const muteBtn = pick<HTMLButtonElement>("mute");
  const iconPlay = pick<SVGElement>("ic-play");
  const iconBars = pick<SVGElement>("ic-bars");
  const iconMute = pick<SVGElement>("ic-mute");
  const iconWaves = pick<SVGElement>("ic-waves");

  const wholeGlyphs = Array.from(el.querySelectorAll<SVGElement>('[data-n="whole"]'));
  const lostGlyphs = Array.from(el.querySelectorAll<SVGElement>('[data-n="lost"]'));
  const tintNodes = Array.from(el.querySelectorAll<SVGElement>('[data-t="1"]'));

  /* ---------- слушатели ---------- */

  const offs: Array<() => void> = [];

  function on<K extends keyof HTMLElementEventMap>(
    node: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    node.addEventListener(type, fn, opts);
    offs.push(() => node.removeEventListener(type, fn, opts));
  }

  /* Кнопки-оверлеи не должны считаться рулением: гасим всплытие, но не
     `preventDefault` — иначе кнопка перестанет получать фокус. */
  const swallow = (e: PointerEvent): void => e.stopPropagation();

  on(pauseBtn, "click", () => hooks.onPause());
  on(pauseBtn, "pointerdown", swallow);
  on(muteBtn, "click", () => hooks.onMute());
  on(muteBtn, "pointerdown", swallow);

  /* ---------- тач-управление ---------- */

  /**
   * Состояние тач-руля. Две зоны могут быть зажаты одновременно (палец соскочил
   * с одной на другую), поэтому храним id пойманных указателей, а не «нажато».
   */
  const steer = { leftId: -1, rightId: -1, target: 0, value: 0, sent: 0 };

  function applySteerTarget(): void {
    steer.target = (steer.rightId >= 0 ? 1 : 0) - (steer.leftId >= 0 ? 1 : 0);
  }

  /** Отпустить всё: при паузе, конце заезда и уничтожении оверлея. */
  function releaseTouch(): void {
    steer.leftId = -1;
    steer.rightId = -1;
    steer.target = 0;
    steer.value = 0;
    steer.sent = 0;
    if (touch === undefined) return;
    touch.steer(0);
    touch.button("brake", false);
    touch.button("nitro", false);
  }

  function bindZone(node: HTMLElement, isRight: boolean): void {
    on(
      node,
      "pointerdown",
      (e) => {
        // preventDefault — чтобы браузер не забрал жест под скролл/зум;
        // stopPropagation — чтобы рулевая поверхность канваса не приняла тот же
        // палец за драг и не переписала ось руля нулём.
        e.preventDefault();
        e.stopPropagation();
        if (isRight) steer.rightId = e.pointerId;
        else steer.leftId = e.pointerId;
        applySteerTarget();
        // Захват указателя: отпускание за пределами зоны всё равно придёт нам.
        try {
          node.setPointerCapture(e.pointerId);
        } catch {
          /* указатель уже мог исчезнуть — тогда сработает pointercancel */
        }
      },
      { passive: false },
    );

    /**
     * Отпускание. Висит и на `pointerleave`: если захват указателя не встал,
     * палец, ушедший за границу зоны, иначе оставил бы руль выкрученным до
     * упора навсегда. При живом захвате `pointerleave` до отпускания не
     * приходит, так что лишних срабатываний это не даёт.
     */
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      if (steer.rightId !== e.pointerId && steer.leftId !== e.pointerId) return;
      if (steer.rightId === e.pointerId) steer.rightId = -1;
      if (steer.leftId === e.pointerId) steer.leftId = -1;
      applySteerTarget();
    };
    on(node, "pointerup", up);
    on(node, "pointercancel", up);
    on(node, "pointerleave", up);
    on(node, "lostpointercapture", up);
  }

  function bindPedal(node: HTMLElement, b: "brake" | "nitro"): void {
    on(
      node,
      "pointerdown",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          node.setPointerCapture(e.pointerId);
        } catch {
          /* см. выше */
        }
        node.dataset.on = "1";
        touch?.button(b, true);
      },
      { passive: false },
    );

    /** `pointerleave` — страховка на случай сорванного захвата. */
    const up = (e: PointerEvent): void => {
      e.stopPropagation();
      if (node.dataset.on !== "1") return;
      node.dataset.on = "0";
      touch?.button(b, false);
    };
    on(node, "pointerup", up);
    on(node, "pointercancel", up);
    on(node, "pointerleave", up);
    on(node, "lostpointercapture", up);
    on(node, "contextmenu", (e) => e.preventDefault());
  }

  if (coarse && touch !== undefined) {
    bindZone(pick<HTMLElement>("zl"), false);
    bindZone(pick<HTMLElement>("zr"), true);
    bindPedal(pick<HTMLElement>("p-nitro"), "nitro");
    bindPedal(pick<HTMLElement>("p-brake"), "brake");
  }

  /* ---------- вспышка смены главы ---------- */

  let chapterTimer = 0;
  let chapterOn = false;

  function hideChapter(): void {
    if (chapterTimer !== 0) {
      window.clearTimeout(chapterTimer);
      chapterTimer = 0;
    }
    if (!chapterOn) return;
    chapterOn = false;
    playAnim(chapterEl, calm ? "sr-hud-ch-out-calm" : "sr-hud-ch-out", CH_ANIM);
  }

  function showChapter(ch: number): void {
    chapterNum.textContent = String(ch + 1);
    chapterName.textContent = ` · ${CHAPTER_NAMES[ch % CHAPTER_NAMES.length]}`;
    if (chapterTimer !== 0) window.clearTimeout(chapterTimer);
    chapterOn = true;
    playAnim(chapterEl, calm ? "sr-hud-ch-in-calm" : "sr-hud-ch-in", CH_ANIM);
    chapterTimer = window.setTimeout(hideChapter, CHAPTER_FLASH_MS);
  }

  /* ---------- запомненное состояние ---------- */

  /** Полоса нитро: сглаженное значение и последнее ЗАПИСАННОЕ в стиль. */
  let shown = 0;
  let lastWidth = -1;
  let lastPulse = -1;

  let playing = false;
  let firstSync = true;
  let lastIdle: boolean | null = null;
  let lastScore = "";
  let lastBest = "";
  let lastDist = "";
  let lastLow: boolean | null = null;
  let lastLives = -1;
  let lastTint = "";
  let lastChapter = -1;
  let lastCombo = -1;
  let comboOn = false;
  let lastMult = -1;
  let lastHot: boolean | null = null;
  let lastPaused: boolean | null = null;
  let lastMuted: boolean | null = null;

  return {
    el,

    sync(snap: HudSnapshot): void {
      // В меню, на паузе и на экране конца ничего не течёт: ни нитро, ни руль.
      const nowPlaying = snap.phase === "playing" || snap.phase === "crashed";
      if (nowPlaying !== playing) {
        playing = nowPlaying;
        if (!nowPlaying) {
          // Снимаем пульс, иначе полоса застынет приглушённой на паузе.
          lastPulse = -1;
          nitroFill.style.opacity = "1";
          hideChapter();
          releaseTouch();
        }
      }

      const idle = snap.phase === "menu" || snap.phase === "over";
      if (idle !== lastIdle) {
        lastIdle = idle;
        const op = idle ? "0" : "1";
        const hidden = idle ? "true" : "false";
        for (const node of [left, center, right]) {
          node.style.opacity = op;
          node.setAttribute("aria-hidden", hidden);
        }
      }

      const score = groupNum(snap.score);
      if (score !== lastScore) {
        lastScore = score;
        scoreEl.textContent = score;
      }

      const best = groupNum(snap.best);
      if (best !== lastBest) {
        lastBest = best;
        bestEl.textContent = best;
      }

      const dist = formatDistance(snap.distance);
      if (dist !== lastDist) {
        lastDist = dist;
        distEl.textContent = dist;
      }

      const low = snap.nitro < NITRO.minToFire;
      if (low !== lastLow) {
        lastLow = low;
        nitroLabel.style.opacity = low ? "0.4" : "0.85";
      }

      /* жизни: форма слотов, тон плашки и короткий «удар» на потере */
      if (snap.lives !== lastLives) {
        const prev = lastLives;
        lastLives = snap.lives;
        const lastLife = snap.lives <= 1;
        plate.setAttribute("aria-label", `жизни: ${snap.lives} из ${LIFE_COUNT}`);
        plate.style.boxShadow = lastLife ? PLATE_LAST : PLATE_CALM;

        const tint = lastLife ? COLORS.danger : COLORS.neon;
        if (tint !== lastTint) {
          lastTint = tint;
          for (const node of tintNodes) node.setAttribute("fill", tint);
        }

        for (let i = 0; i < LIFE_COUNT; i++) {
          const lost = snap.lives <= i;
          wholeGlyphs[i].style.display = lost ? "none" : "block";
          lostGlyphs[i].style.display = lost ? "block" : "none";
        }

        // Рестарт возвращает жизни вверх — это не удар, анимацию не гоняем.
        if (prev >= 0 && snap.lives < prev) {
          playAnim(plate, calm ? "sr-hud-hit-calm" : "sr-hud-hit", HIT_ANIM);
        }
      }

      /* глава неба: момент, а не постоянный показатель */
      if (snap.chapter !== lastChapter) {
        const prev = lastChapter;
        lastChapter = snap.chapter;
        if (!firstSync && prev !== snap.chapter && playing) showChapter(snap.chapter);
      }

      /* комбо */
      if (snap.combo !== lastCombo) {
        lastCombo = snap.combo;
        if (snap.combo > 1) {
          comboNum.textContent = String(snap.combo);
          comboOn = true;
          if (firstSync) comboEl.style.opacity = "1";
          else playAnim(comboEl, calm ? "sr-hud-combo-in-calm" : "sr-hud-combo-in", COMBO_ANIM);
        } else if (comboOn) {
          comboOn = false;
          playAnim(comboEl, calm ? "sr-hud-combo-out-calm" : "sr-hud-combo-out", COMBO_ANIM);
        }
      }

      /* множитель */
      if (snap.multiplier !== lastMult) {
        lastMult = snap.multiplier;
        multEl.textContent = `×${snap.multiplier.toFixed(1)}`;
        const hot = snap.multiplier >= 2;
        if (hot !== lastHot) {
          lastHot = hot;
          multEl.style.color = hot ? COLORS.combo : COLORS.star;
          multEl.style.textShadow = hot ? SHADOW_COMBO : SHADOW_SCORE;
        }
      }

      /* кнопки */
      const paused = snap.phase === "paused";
      if (paused !== lastPaused) {
        lastPaused = paused;
        pauseBtn.setAttribute("aria-label", paused ? "Продолжить заезд" : "Пауза");
        iconPlay.style.display = paused ? "" : "none";
        iconBars.style.display = paused ? "none" : "";
      }

      if (snap.muted !== lastMuted) {
        lastMuted = snap.muted;
        muteBtn.setAttribute("aria-label", snap.muted ? "Включить звук" : "Выключить звук");
        muteBtn.setAttribute("aria-pressed", snap.muted ? "true" : "false");
        muteBtn.style.color = snap.muted ? COLORS.danger : "#c2d4ea";
        iconMute.style.display = snap.muted ? "" : "none";
        iconWaves.style.display = snap.muted ? "none" : "";
      }

      firstSync = false;
    },

    frame(g: Game, dt: number): void {
      // Игра — источник правды по «уменьшенному движению»; вспышки берут флаг
      // в момент запуска, так что достаточно держать его свежим.
      calm = g.reducedMotion;
      if (!playing) return;
      // Дельту зажимаем: после возврата вкладки из фона она может быть в секундах.
      const d = dt < 0.05 ? dt : 0.05;

      /* полоса нитро */
      shown = damp(shown, clamp01(g.nitro), NITRO_TRACK, d);
      // Пишем в стиль только при заметном изменении: строки в кадре — мусор.
      if (Math.abs(shown - lastWidth) > 0.003) {
        lastWidth = shown;
        nitroFill.style.transform = `scaleX(${shown.toFixed(3)})`;
      }

      // Пульс на активном нитро. При reduced-motion — ровное свечение без строба.
      // Только opacity: её крутит композитор. Фильтр brightness стоил бы
      // отдельного прохода по слою на каждом изменении, а разницы не видно.
      // −1 — «нитро выключено», полоса на полной непрозрачности.
      let q = -1;
      if (g.nitroActive) {
        const pulse = calm ? 0.7 : 0.5 + 0.5 * Math.sin(performance.now() * 0.013);
        q = Math.round(pulse * 6) / 6;
      }
      if (q !== lastPulse) {
        lastPulse = q;
        nitroFill.style.opacity = q < 0 ? "1" : (0.6 + 0.4 * q).toFixed(2);
      }

      /* руль от тач-зон: доводим до упора плавно, иначе машину рвёт */
      if (steer.target !== 0 || steer.value !== 0) {
        const next =
          Math.abs(steer.target - steer.value) < 0.004
            ? steer.target
            : damp(steer.value, steer.target, STEER_TRACK, d);
        steer.value = next;
        if (next !== steer.sent) {
          steer.sent = next;
          touch?.steer(next);
        }
      }
    },

    dispose(): void {
      if (chapterTimer !== 0) window.clearTimeout(chapterTimer);
      chapterTimer = 0;
      for (const off of offs) off();
      offs.length = 0;
      releaseTouch();
      styleEl.remove();
      el.remove();
    },
  };
}
