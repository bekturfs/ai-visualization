/**
 * Экраны вне заезда: меню, пауза, конец заезда и панель управления.
 *
 * Оверлей без единого кадра в секунду: экран показывается, когда игра стоит, и
 * исчезает, когда она едет. Поэтому здесь есть только `sync` (снимок HUD,
 * ~12 Гц) и нет `frame` — живое состояние `Game` этому слою не нужно вовсе, а
 * его отсутствие делает обновление дешёвым.
 *
 * Какой экран показан, решает `snap.phase`:
 *
 * - `menu` / `paused` / `over` — оверлей;
 * - `playing` / `crashed` — ничего, экран отдан дороге.
 *
 * Пересборка поддерева — только при смене экрана. Снимок приходит двенадцать
 * раз в секунду, а под диалогом висит полноэкранное размытие подложки: собирать
 * разметку заново на каждый снимок значило бы платить за самый дорогой пиксель
 * кадра двенадцать раз в секунду впустую. Пока экран тот же, в готовые узлы
 * пишутся только цифры и стили.
 *
 * Клавиши здесь не слушаются вообще: Esc, R, M и Enter принадлежат `input.ts`,
 * дублировать их — значит однажды получить двойной рестарт с одного нажатия.
 * Единственное, что оверлей делает с вводом, — глушит `pointerdown`, чтобы
 * палец на кнопке не считался рулением (рулевая поверхность ловит всплывающие
 * события со всей страницы).
 *
 * Модальность держится на двух вещах, и обе обязательны:
 *
 * - страница выключает всё под оверлеем атрибутом `inert`, и решает она это по
 *   `overlayScreen()` — той же функции, что выбирает экран здесь. Один источник
 *   правды: «показан диалог» и «фон выключен» не могут разъехаться;
 * - фокус заперт внутри диалога (Tab с последней кнопки уходит на первую).
 *   При закрытии оверлей отдаёт фокус тому, у кого он был до открытия, но
 *   последнее слово за `main.ts`: оверлей закрывается всегда в едущий заезд, и
 *   клавиатура в этот момент должна принадлежать игровой поверхности, а не
 *   кнопке HUD (иначе Space нажимал бы «паузу» вместо нитро).
 *
 * Анимацию появления раньше делала `motion`. Она ушла вместе с React, вместо
 * неё — обычные `@keyframes` в одном `<style>`, который живёт ровно столько же,
 * сколько оверлей; «уменьшенное движение» разбирается прямо в CSS, поэтому
 * системная настройка действует и без перезагрузки.
 */

import type { Overlay } from "../ctx";
import type { HudSnapshot, Phase, Quality } from "../types";
import { COLORS, QUALITY } from "../config";

/* ---------- контракт ---------- */

export type ScreenKey = "menu" | "paused" | "over" | "help";

/**
 * Какой экран должен быть показан — единственный источник правды и для самого
 * оверлея, и для страницы, которая по нему гасит фон. Панель управления
 * перекрывает всё: её открывают и из меню, и из паузы.
 */
export function overlayScreen(phase: Phase, showHelp: boolean): ScreenKey | null {
  if (showHelp) return "help";
  if (phase === "menu" || phase === "paused" || phase === "over") return phase;
  return null;
}

/**
 * Всё, что оверлей просит у владельца состояния.
 *
 * Действия — обычные колбэки. А `quality`, `showHelp` и `prevBest` намеренно
 * сделаны читалками, а не полями: оверлей ничего из этого у себя не хранит и
 * спрашивает заново на каждом обновлении. Подсветка пресета берётся из того же
 * значения, по которому рисует сцена (`g.quality`), — разъехаться им нечем.
 * Это ровно тот баг, который уже был однажды: меню показывало один пресет,
 * а сцена рисовала другой.
 */
export interface ScreenHooks {
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  onQuality(q: Quality): void;
  onMute(): void;
  onExitHelp(): void;
  /** Уйти в меню с экрана конца заезда. Не передан — кнопки просто нет. */
  onMenu?(): void;
  /** Открыть панель управления. Не передан — кнопки «как играть» нет. */
  onHelp?(): void;
  /** Текущее качество. Источник правды — игра, а не копия внутри оверлея. */
  quality(): Quality;
  /** Открыта ли панель управления. */
  showHelp(): boolean;
  /**
   * Рекорд, каким он был ДО этого заезда. В снимке рекорд уже побит (движок
   * поднимает `best` прямо в кадре), поэтому «новый рекорд» без этой подсказки
   * можно только угадывать. Не передан — сравниваем со снимком, как раньше.
   */
  prevBest?(): number;
}

/* ---------- оформление ---------- */

const QLIST: readonly Quality[] = [0, 1, 2];

/** Тонкий пробел для разрядов — обычный слишком широко разваливает число. */
const THIN = " ";

const CARD_BG =
  "linear-gradient(180deg, rgba(18,30,56,0.74) 0%, rgba(5,9,22,0.90) 100%)";
const CARD_EDGE = "rgba(94,203,255,0.20)";
const CARD_SHADOW =
  "0 34px 90px rgba(0,0,0,0.72), 0 0 70px rgba(43,140,255,0.10), inset 0 1px 0 rgba(255,255,255,0.05)";

const BACK_BG =
  "radial-gradient(120% 80% at 50% 30%, rgba(10,26,58,0.72) 0%, rgba(4,8,26,0.90) 60%, rgba(2,4,12,0.95) 100%)";

const GLOW_TITLE =
  "0 2px 18px rgba(0,0,0,0.9), 0 0 34px rgba(94,203,255,0.45), 0 0 90px rgba(43,140,255,0.30)";
const GLOW_SOFT = "0 1px 8px rgba(0,0,0,0.85)";

/** Общая часть всех кнопок: без цвета, цвет добавляет вариант. */
const BTN =
  "rounded-xl border px-4 py-2.5 text-[13px] font-bold transition-colors active:scale-[0.98]";

/** Подпись слева в строке настроек и в таблице управления. */
const LABEL_CSS = "letter-spacing:0.12em;color:#8ba3c2";

const LABELS: Record<ScreenKey, string> = {
  menu: "Главное меню Starry Ride",
  paused: "Пауза",
  over: "Заезд закончен",
  help: "Управление",
};

/**
 * Что вообще может получить фокус. Кнопками список не ограничиваем: стоит
 * появиться в диалоге ссылке или ползунку — и ловушка тихо перестала бы
 * замыкаться именно на нём.
 */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Замена `motion`: подложка проявляется, карточка вплывает снизу. Длительности
 * и кривая — те же, что были у `motion` (`easeOut` там и `ease-out` здесь —
 * одна и та же `cubic-bezier(0,0,.58,1)`). Спокойный набор оставляет только
 * прозрачность, как и раньше, но теперь решает это сам браузер: медиазапрос
 * работает и при смене системной настройки на лету.
 */
const ANIM_CSS = `
@keyframes sr-scr-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes sr-scr-rise {
  from { opacity: 0; transform: translateY(22px) }
  to { opacity: 1; transform: none }
}
.sr-scr-back { animation: sr-scr-fade .22s ease-out both }
.sr-scr-card { animation: sr-scr-rise .32s ease-out both }
@media (prefers-reduced-motion: reduce) {
  .sr-scr-back { animation-duration: .12s }
  .sr-scr-card { animation-name: sr-scr-fade; animation-duration: .14s }
}
`;

/* ---------- форматирование ---------- */

/** Разряды тонкими пробелами: 1234567 → «1 234 567». */
function groupNum(n: number): string {
  const s = String(Math.max(0, Math.round(n)));
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

/* ---------- кирпичи разметки ---------- */

/** Клавиша в тексте. */
function keyCap(text: string): string {
  return (
    `<kbd class="tnum rounded-md border px-1.5 py-[1px] text-[11px] font-bold not-italic" ` +
    `style="border-color:rgba(94,203,255,0.26);background:rgba(94,203,255,0.07);` +
    `color:#cfe2f7;font-family:inherit">${text}</kbd>`
  );
}

/** Строка таблицы управления: действие — клавиши — тач. */
function ctl(action: string, keys: readonly string[], touch?: string): string {
  return (
    `<div class="flex items-baseline gap-2 py-[3px]">` +
    `<span class="w-[64px] shrink-0 text-[11px] font-bold uppercase" style="${LABEL_CSS}">${action}</span>` +
    `<span class="flex flex-wrap items-baseline gap-1">${keys.map(keyCap).join("")}</span>` +
    (touch === undefined
      ? ""
      : `<span class="ml-auto shrink-0 text-[11px]" style="color:#5b7ba0">${touch}</span>`) +
    `</div>`
  );
}

/** Ячейка итогов заезда. Значение и подпись меняются, поэтому у них имена. */
function statCell(name: string, label: string, tint: string): string {
  return (
    `<div class="rounded-xl border px-3 py-2.5" ` +
    `style="border-color:rgba(94,203,255,0.14);background:rgba(8,14,30,0.55)">` +
    `<div data-n="${name}-l" class="text-[10px] font-bold uppercase" ` +
    `style="letter-spacing:0.2em;color:#5b7ba0">${label}</div>` +
    `<div data-n="${name}-v" class="tnum mt-1 text-[20px] font-black leading-none" ` +
    `style="color:${tint};text-shadow:${GLOW_SOFT}">0</div>` +
    `</div>`
  );
}

/** Заголовок экрана. */
function titleTag(text: string, size: string): string {
  return (
    `<h2 class="font-black leading-[1.02]" ` +
    `style="font-size:${size};letter-spacing:-0.03em;color:${COLORS.star};text-shadow:${GLOW_TITLE}">` +
    `${text}</h2>`
  );
}

/** Главная кнопка экрана. Именно она получает фокус при появлении диалога. */
function primaryBtn(extraCls: string, label: string, shadow: string): string {
  return (
    `<button data-n="primary" type="button" class="${BTN} ${extraCls}" ` +
    `style="border-color:rgba(94,203,255,0.55);` +
    `background:linear-gradient(180deg, ${COLORS.neon} 0%, ${COLORS.neonDeep} 100%);` +
    `color:#02060f;box-shadow:${shadow};letter-spacing:0.04em">${label}</button>`
  );
}

/** Второстепенная кнопка. */
function ghostBtn(name: string, label: string): string {
  return (
    `<button data-n="${name}" type="button" class="${BTN}" ` +
    `style="border-color:rgba(94,203,255,0.22);background:rgba(8,14,30,0.6);color:#c2d4ea">` +
    `${label}</button>`
  );
}

const PRIMARY_SHADOW = "0 10px 34px rgba(43,140,255,0.42)";
const PRIMARY_SHADOW_MENU =
  "0 10px 34px rgba(43,140,255,0.42), 0 0 26px rgba(94,203,255,0.35)";

const SOUND_ICON =
  `<svg viewBox="0 0 18 16" width="14" height="13" aria-hidden="true" fill="none" ` +
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

/* ---------- настройки, общие для меню и паузы ---------- */

const SETTINGS_MARKUP =
  `<div class="mt-4 flex flex-col gap-2">` +
  `<div class="flex items-center gap-2">` +
  `<span class="w-[64px] shrink-0 text-[11px] font-bold uppercase" style="${LABEL_CSS}">картинка</span>` +
  `<div role="group" aria-label="Качество картинки" class="flex flex-1 gap-1.5">` +
  QLIST.map(
    (q) =>
      `<button data-n="q${q}" type="button" aria-pressed="false" ` +
      `class="flex-1 rounded-lg border px-2 py-1.5 text-[12px] font-bold transition-colors">` +
      `${QUALITY[q].label}</button>`,
  ).join("") +
  `</div>` +
  `</div>` +
  `<div class="flex items-center gap-2">` +
  `<span class="w-[64px] shrink-0 text-[11px] font-bold uppercase" style="${LABEL_CSS}">звук</span>` +
  `<button data-n="mute" type="button" aria-pressed="false" ` +
  `class="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-bold transition-colors">` +
  `${SOUND_ICON}<span data-n="mute-t">включён</span></button>` +
  `</div>` +
  `</div>`;

/* ---------- разметка экранов ---------- */

function menuMarkup(withHelp: boolean): string {
  return (
    `<div class="text-[10px] font-bold uppercase" ` +
    `style="letter-spacing:0.34em;color:${COLORS.neon};text-shadow:${GLOW_SOFT}">ночной заезд</div>` +
    `<div class="mt-1.5">${titleTag("Starry Ride", "clamp(34px, 9vw, 52px)")}</div>` +
    `<p class="mt-2.5 text-[13px] leading-snug" style="color:#c2d4ea">` +
    `ночная дорога, неон и звёздное небо — доедь как можно дальше</p>` +
    `<p data-n="bestline" class="mt-2 text-[12px] font-bold" ` +
    `style="color:${COLORS.combo};display:none">лучший заезд — ` +
    `<span data-n="best" class="tnum">0</span></p>` +
    `<div class="mt-4 rounded-xl border px-3 py-2" ` +
    `style="border-color:rgba(94,203,255,0.14);background:rgba(8,14,30,0.45)">` +
    ctl("руль", ["←", "→", "A", "D"]) +
    ctl("нитро", ["Space", "Shift"]) +
    ctl("тормоз", ["↓", "S"]) +
    ctl("пауза", ["Esc", "P"]) +
    `<p class="mt-1.5 text-[11px] leading-snug" style="color:#5b7ba0">` +
    `с телефона: веди пальцем по экрану — это руль, кнопки справа — нитро и стоп</p>` +
    `</div>` +
    SETTINGS_MARKUP +
    `<div class="mt-5 flex items-center gap-2">` +
    primaryBtn("flex-1 text-[15px]", "поехали", PRIMARY_SHADOW_MENU) +
    (withHelp ? ghostBtn("help", "как играть") : "") +
    `</div>` +
    `<p class="mt-2.5 text-[11px]" style="color:#5b7ba0">` +
    `${keyCap("Enter")} или ${keyCap("Space")} — тоже старт</p>`
  );
}

const PAUSED_MARKUP =
  titleTag("пауза", "clamp(28px, 7vw, 38px)") +
  `<p class="mt-2 text-[12px]" style="color:#8ba3c2">` +
  `<span data-n="score" class="tnum">0</span> очков · ` +
  `<span data-n="dist" class="tnum">0</span> · жизней <span data-n="lives">3</span></p>` +
  SETTINGS_MARKUP +
  `<div class="mt-5 flex flex-wrap items-center gap-2">` +
  primaryBtn("flex-1 text-[15px]", "продолжить", PRIMARY_SHADOW) +
  ghostBtn("restart", "начать заново") +
  `</div>` +
  `<p class="mt-2.5 text-[11px]" style="color:#5b7ba0">` +
  `${keyCap("Esc")} — вернуться в заезд, ${keyCap("R")} — заново</p>`;

function overMarkup(withMenu: boolean): string {
  return (
    titleTag("заезд закончен", "clamp(26px, 6.6vw, 36px)") +
    `<p data-n="rec" class="mt-2 text-[15px] font-black uppercase" ` +
    `style="letter-spacing:0.2em;color:${COLORS.combo};` +
    `text-shadow:0 1px 8px rgba(0,0,0,0.9), 0 0 26px rgba(255,209,92,0.6);display:none">новый рекорд` +
    `<span data-n="prior" class="ml-2 text-[11px] font-bold normal-case" ` +
    `style="letter-spacing:0.06em;color:#8ba3c2;text-shadow:${GLOW_SOFT}">было ` +
    `<span data-n="prior-n" class="tnum">0</span></span></p>` +
    `<p data-n="norec" class="mt-2 text-[12px]" style="color:#8ba3c2">рекорд — ` +
    `<span data-n="best" class="tnum">0</span></p>` +
    `<div class="mt-4 grid grid-cols-2 gap-2">` +
    statCell("sc", "очки", COLORS.star) +
    statCell("ds", "дистанция", COLORS.neon) +
    statCell("st", "звёзды", COLORS.starWarm) +
    statCell("mu", "множитель", COLORS.combo) +
    `</div>` +
    `<div class="mt-5 flex flex-wrap items-center gap-2">` +
    primaryBtn("flex-1 text-[15px]", "ещё раз", PRIMARY_SHADOW) +
    (withMenu ? ghostBtn("menu", "в меню") : "") +
    `</div>` +
    `<p class="mt-2.5 text-[11px]" style="color:#5b7ba0">${keyCap("R")} — сразу ещё раз</p>`
  );
}

const HELP_MARKUP =
  titleTag("как играть", "clamp(24px, 6vw, 32px)") +
  `<p class="mt-2 text-[12px] leading-snug" style="color:#c2d4ea">` +
  `скорость растёт сама. встречные фары — смерть, отбойник — только потеря ` +
  `скорости. звёзды дают очки и нитро, проезд вплотную — комбо. жизней три.</p>` +
  `<div class="mt-3.5 rounded-xl border px-3 py-2" ` +
  `style="border-color:rgba(94,203,255,0.14);background:rgba(8,14,30,0.45)">` +
  ctl("руль", ["ArrowLeft", "ArrowRight", "KeyA", "KeyD"], "драг по экрану") +
  ctl("газ", ["ArrowUp", "KeyW"], "авто-газ") +
  ctl("тормоз", ["ArrowDown", "KeyS"], "кнопка «стоп»") +
  ctl("нитро", ["Space", "ShiftLeft", "ShiftRight"], "кнопка «нитро»") +
  ctl("пауза", ["Escape", "KeyP"], "кнопка ⏸") +
  ctl("звук", ["KeyM"], "кнопка звука") +
  ctl("заново", ["KeyR"], "кнопка «ещё раз»") +
  ctl("старт", ["Enter", "Space"], "кнопка «поехали»") +
  `</div>` +
  primaryBtn("mt-5 w-full text-[15px]", "понятно", PRIMARY_SHADOW);

/* ---------- живая часть экрана ---------- */

/** Собранный экран: узел карточки, её главная кнопка и обновление цифр. */
interface Live {
  card: HTMLElement;
  primary: HTMLButtonElement;
  update(snap: HudSnapshot, quality: Quality, prevBest?: number): void;
}

function pick<T extends Element>(root: ParentNode, name: string): T {
  const node = root.querySelector<T>(`[data-n="${name}"]`);
  if (node === null) throw new Error(`Screens: нет узла ${name}`);
  return node;
}

/** Кнопки настроек: подсветка пресета и состояние звука. */
function wireSettings(
  card: HTMLElement,
  hooks: ScreenHooks,
  refresh: () => void,
): (quality: Quality, muted: boolean) => void {
  const qBtns = QLIST.map((q) => {
    const b = pick<HTMLButtonElement>(card, `q${q}`);
    b.addEventListener("click", () => {
      hooks.onQuality(q);
      refresh();
    });
    return b;
  });

  const mute = pick<HTMLButtonElement>(card, "mute");
  const muteText = pick<HTMLElement>(card, "mute-t");
  const iconMute = pick<SVGElement>(card, "ic-mute");
  const iconWaves = pick<SVGElement>(card, "ic-waves");
  mute.addEventListener("click", () => {
    hooks.onMute();
    refresh();
  });

  return (quality, muted) => {
    for (let i = 0; i < qBtns.length; i++) {
      const on = QLIST[i] === quality;
      const b = qBtns[i];
      b.style.borderColor = on ? "rgba(94,203,255,0.55)" : "rgba(94,203,255,0.16)";
      b.style.background = on ? "rgba(94,203,255,0.14)" : "rgba(8,14,30,0.5)";
      b.style.color = on ? COLORS.neon : "#8ba3c2";
      b.style.textShadow = on ? "0 0 14px rgba(94,203,255,0.5)" : "none";
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    mute.style.borderColor = muted ? "rgba(255,74,58,0.35)" : "rgba(122,255,200,0.30)";
    mute.style.background = muted ? "rgba(255,74,58,0.10)" : "rgba(122,255,200,0.10)";
    mute.style.color = muted ? COLORS.danger : COLORS.nitro;
    mute.setAttribute("aria-pressed", muted ? "true" : "false");
    iconMute.style.display = muted ? "" : "none";
    iconWaves.style.display = muted ? "none" : "";
    muteText.textContent = muted ? "выключен" : "включён";
  };
}

function buildMenu(card: HTMLElement, hooks: ScreenHooks, refresh: () => void): Live {
  card.innerHTML = menuMarkup(hooks.onHelp !== undefined);

  const primary = pick<HTMLButtonElement>(card, "primary");
  primary.addEventListener("click", () => {
    hooks.onStart();
    refresh();
  });

  const onHelp = hooks.onHelp;
  if (onHelp !== undefined) {
    pick<HTMLButtonElement>(card, "help").addEventListener("click", () => {
      onHelp();
      refresh();
    });
  }

  const bestLine = pick<HTMLElement>(card, "bestline");
  const best = pick<HTMLElement>(card, "best");
  const setts = wireSettings(card, hooks, refresh);

  return {
    card,
    primary,
    update(snap, quality) {
      bestLine.style.display = snap.best > 0 ? "" : "none";
      best.textContent = groupNum(snap.best);
      setts(quality, snap.muted);
    },
  };
}

function buildPaused(card: HTMLElement, hooks: ScreenHooks, refresh: () => void): Live {
  card.innerHTML = PAUSED_MARKUP;

  const primary = pick<HTMLButtonElement>(card, "primary");
  primary.addEventListener("click", () => {
    hooks.onResume();
    refresh();
  });
  pick<HTMLButtonElement>(card, "restart").addEventListener("click", () => {
    hooks.onRestart();
    refresh();
  });

  const score = pick<HTMLElement>(card, "score");
  const dist = pick<HTMLElement>(card, "dist");
  const lives = pick<HTMLElement>(card, "lives");
  const setts = wireSettings(card, hooks, refresh);

  return {
    card,
    primary,
    update(snap, quality) {
      score.textContent = groupNum(snap.score);
      dist.textContent = formatDistance(snap.distance);
      lives.textContent = String(snap.lives);
      setts(quality, snap.muted);
    },
  };
}

function buildOver(card: HTMLElement, hooks: ScreenHooks, refresh: () => void): Live {
  card.innerHTML = overMarkup(hooks.onMenu !== undefined);

  const primary = pick<HTMLButtonElement>(card, "primary");
  primary.addEventListener("click", () => {
    hooks.onRestart();
    refresh();
  });

  const onMenu = hooks.onMenu;
  if (onMenu !== undefined) {
    pick<HTMLButtonElement>(card, "menu").addEventListener("click", () => {
      onMenu();
      refresh();
    });
  }

  const rec = pick<HTMLElement>(card, "rec");
  const prior = pick<HTMLElement>(card, "prior");
  const priorNum = pick<HTMLElement>(card, "prior-n");
  const norec = pick<HTMLElement>(card, "norec");
  const best = pick<HTMLElement>(card, "best");
  const scoreV = pick<HTMLElement>(card, "sc-v");
  const distV = pick<HTMLElement>(card, "ds-v");
  const starsV = pick<HTMLElement>(card, "st-v");
  const multL = pick<HTMLElement>(card, "mu-l");
  const multV = pick<HTMLElement>(card, "mu-v");

  return {
    card,
    primary,
    update(snap, _quality, prevBest) {
      /* Рекорд до заезда: страница помнит его до `startRun`, потому что движок
         поднимает `best` прямо в кадре и к концу заезда он уже равен счёту. */
      const before = prevBest ?? snap.best;
      const record = snap.score > 0 && snap.score >= before;
      rec.style.display = record ? "" : "none";
      norec.style.display = record ? "none" : "";
      if (record) {
        prior.style.display = before > 0 ? "" : "none";
        if (before > 0) priorNum.textContent = groupNum(before);
      } else {
        best.textContent = groupNum(snap.best);
      }
      scoreV.textContent = groupNum(snap.score);
      distV.textContent = formatDistance(snap.distance);
      starsV.textContent = String(snap.stars);
      multL.textContent = snap.combo > 1 ? `комбо ${snap.combo}` : "множитель";
      multV.textContent = `×${snap.multiplier.toFixed(1)}`;
    },
  };
}

function buildHelp(card: HTMLElement, hooks: ScreenHooks, refresh: () => void): Live {
  card.innerHTML = HELP_MARKUP;
  const primary = pick<HTMLButtonElement>(card, "primary");
  primary.addEventListener("click", () => {
    hooks.onExitHelp();
    refresh();
  });
  // Панель управления статична: обновлять в ней нечего.
  return { card, primary, update() {} };
}

/* ---------- оверлей ---------- */

export function createScreens(host: HTMLElement, hooks: ScreenHooks): Overlay {
  const styleEl = document.createElement("style");
  styleEl.textContent = ANIM_CSS;
  document.head.appendChild(styleEl);

  /* Корень живёт всё время существования оверлея: `main.ts` держит на него
     ссылку. Показ и скрытие — это `display`, а вся анимируемая часть (подложка
     с размытием и карточка) собирается заново на каждую смену экрана, поэтому
     появление проигрывается всегда, а не только при первом открытии. */
  const el = document.createElement("div");
  // `pointer-events-auto` обязателен: оверлей монтируется внутрь контейнера с
  // `pointer-events: none` (он пропускает драг по экрану на канвас), и без
  // явного включения клики по кнопкам диалога проваливались бы сквозь него в
  // канвас. Пока диалога нет, элемент скрыт и ничего не перехватывает.
  el.className = "pointer-events-auto fixed inset-0 z-40";
  el.style.display = "none";
  host.appendChild(el);

  /* Оверлей ест `pointerdown`: иначе рулевая поверхность страницы примет
     нажатие на кнопку за драг руля. */
  const swallow = (e: PointerEvent): void => e.stopPropagation();
  el.addEventListener("pointerdown", swallow);

  let current: ScreenKey | null = null;
  let live: Live | null = null;
  let back: HTMLElement | null = null;
  let lastSnap: HudSnapshot | null = null;
  let blurNow = "";
  let focusRaf = 0;
  /** Кому вернуть фокус, когда диалог закроется. */
  let prevFocus: HTMLElement | null = null;

  /**
   * Ловушка фокуса, страховочный контур. Tab обрабатывается на самой карточке,
   * а `focusin` ловит случай, когда фокус утёк наружу мимо Tab (клик по кнопке
   * HUD, автофокус браузера после перерисовки).
   */
  const onFocusIn = (e: FocusEvent): void => {
    if (live === null) return;
    const t = e.target as Node | null;
    if (t !== null && live.card.contains(t)) return;
    live.primary.focus();
  };
  document.addEventListener("focusin", onFocusIn);

  function onTab(e: KeyboardEvent): void {
    if (e.key !== "Tab" || live === null) return;
    const root = live.card;
    const items = root.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (items.length === 0) {
      // Фокусировать нечего — но и выпускать Tab наружу нельзя.
      e.preventDefault();
      root.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && root.contains(active) && active !== root;
    if (e.shiftKey) {
      // С первого (и с самого диалога) назад — на последний.
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      // С последнего (и из ниоткуда) вперёд — на первый. Круг замкнулся.
      e.preventDefault();
      first.focus();
    }
  }

  /**
   * Размытие подложки — самый дорогой пиксель на экране: оно пересчитывается
   * поверх живого canvas каждый кадр, во весь экран, и ровно тогда, когда сцена
   * всё равно рисуется зря (игра стоит). На «экономно» его нет вовсе — градиент
   * и так кроет фон на 90%, а `saturate` на такой темноте не виден ни в одном
   * из пресетов.
   */
  function paintBackdrop(quality: Quality, force: boolean): void {
    const blur = quality === 0 ? "none" : "blur(10px)";
    if (!force && blur === blurNow) return;
    blurNow = blur;
    if (back === null) return;
    back.style.setProperty("backdrop-filter", blur);
    back.style.setProperty("-webkit-backdrop-filter", blur);
  }

  function swap(key: ScreenKey | null, snap: HudSnapshot, quality: Quality): void {
    if (focusRaf !== 0) {
      cancelAnimationFrame(focusRaf);
      focusRaf = 0;
    }

    if (current === null && key !== null) {
      // Открываемся: запоминаем, кому вернуть фокус.
      const a = document.activeElement;
      prevFocus =
        a instanceof HTMLElement && a !== document.body && !el.contains(a) ? a : null;
    }

    // Проверяем ДО удаления узла: после него активным станет `body`.
    const takeBack =
      key === null &&
      document.activeElement instanceof HTMLElement &&
      el.contains(document.activeElement);

    if (back !== null) {
      back.remove();
      back = null;
    }
    live = null;
    current = key;

    if (key === null) {
      el.style.display = "none";
      if (takeBack) {
        const to = prevFocus;
        if (to !== null && to.isConnected && !el.contains(to)) {
          to.focus({ preventScroll: true });
        }
      }
      prevFocus = null;
      return;
    }

    const node = document.createElement("div");
    node.className = "absolute inset-0 flex items-center justify-center px-4 py-6 sr-scr-back";
    node.style.background = BACK_BG;

    const card = document.createElement("div");
    card.className =
      "sr-scr-card max-h-full w-full max-w-[440px] overflow-y-auto overscroll-contain rounded-3xl border p-5 sm:p-7";
    card.style.borderColor = CARD_EDGE;
    card.style.background = CARD_BG;
    card.style.boxShadow = CARD_SHADOW;
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", LABELS[key]);
    card.tabIndex = -1;
    card.addEventListener("keydown", onTab);

    live =
      key === "menu"
        ? buildMenu(card, hooks, refresh)
        : key === "paused"
          ? buildPaused(card, hooks, refresh)
          : key === "over"
            ? buildOver(card, hooks, refresh)
            : buildHelp(card, hooks, refresh);

    live.update(snap, quality, hooks.prevBest?.());

    node.appendChild(card);
    back = node;
    paintBackdrop(quality, true);
    el.appendChild(node);
    el.style.display = "block";

    /* Кадр отсрочки: узел только что вставлен, и браузеру нужно дать его
       разложить — иначе `focus()` на элементе внутри `overflow-y-auto` уводит
       карточку в прокрутку ещё до того, как она получила свою высоту. */
    const target = live.primary;
    focusRaf = requestAnimationFrame(() => {
      focusRaf = 0;
      target.focus();
    });
  }

  function apply(): void {
    const snap = lastSnap;
    if (snap === null) return;
    const quality = hooks.quality();
    const key = overlayScreen(snap.phase, hooks.showHelp());
    if (key !== current) {
      swap(key, snap, quality);
      return;
    }
    if (live === null) return;
    live.update(snap, quality, hooks.prevBest?.());
    paintBackdrop(quality, false);
  }

  /**
   * Кнопка изменила состояние у владельца — перечитываем его сразу, не дожидаясь
   * следующего снимка. Восемьдесят четыре миллисекунды задержки на нажатии
   * «как играть» или на переключении пресета читались бы как подтормаживание.
   */
  function refresh(): void {
    apply();
  }

  return {
    el,
    sync(snap: HudSnapshot): void {
      lastSnap = snap;
      apply();
    },
    dispose(): void {
      if (focusRaf !== 0) {
        cancelAnimationFrame(focusRaf);
        focusRaf = 0;
      }
      document.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("pointerdown", swallow);
      if (back !== null) {
        back.remove();
        back = null;
      }
      live = null;
      current = null;
      lastSnap = null;
      prevFocus = null;
      styleEl.remove();
      el.remove();
    },
  };
}
