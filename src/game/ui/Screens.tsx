/**
 * Экраны вне заезда: меню, пауза, конец заезда и панель управления.
 *
 * Всё здесь — обычный React, без единого кадра в секунду: экран показывается,
 * когда игра стоит, и исчезает, когда она едет. Поэтому компонент читает только
 * `snap` (снимок HUD, ~12 Гц) и никогда не трогает мутируемый `Game`: живое
 * состояние ему просто не нужно, а его отсутствие делает перерисовку дешёвой.
 *
 * Какой экран показан, решает `snap.phase`:
 *
 * - `menu` / `paused` / `over` — оверлей;
 * - `playing` / `crashed` — ничего, экран отдан дороге.
 *
 * Клавиши здесь не слушаются вообще: Esc, R, M и Enter принадлежат `input.ts`,
 * дублировать их — значит однажды получить двойной рестарт с одного нажатия.
 * Единственное, что оверлей делает с вводом, — глушит `pointerdown`, чтобы
 * палец на кнопке не считался рулением (рулевая поверхность висит на обёртке
 * страницы и ловит всплывающие события).
 *
 * Модальность держится на двух вещах, и обе обязательны:
 *
 * - страница выключает всё под оверлеем атрибутом `inert` (см. `Ride.tsx`), и
 *   решает она это по `overlayScreen()` — той же функции, что выбирает экран
 *   здесь. Один источник правды: «показан диалог» и «фон выключен» не могут
 *   разъехаться;
 * - фокус заперт внутри диалога (Tab с последней кнопки уходит на первую),
 *   а возвращает его на игровую поверхность страница — оверлей закрывается
 *   всегда в едущий заезд, и клавиатура в этот момент должна принадлежать игре,
 *   а не кнопке HUD, на которой иначе остался бы фокус (тогда Space нажимал бы
 *   «паузу» вместо нитро).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import { motion } from "motion/react";

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

export interface ScreensProps {
  snap: HudSnapshot;
  quality: Quality;
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  onQuality(q: Quality): void;
  onMute(): void;
  onExitHelp(): void;
  showHelp: boolean;
  /** Уйти в меню с экрана конца заезда. Не передан — кнопки просто нет. */
  onMenu?(): void;
  /** Открыть панель управления. Не передан — кнопки «как играть» нет. */
  onHelp?(): void;
  /**
   * Рекорд, каким он был ДО этого заезда. В снимке рекорд уже побит (движок
   * поднимает `best` прямо в кадре), поэтому «новый рекорд» без этой подсказки
   * можно только угадывать. Не передан — сравниваем со снимком, как раньше.
   */
  prevBest?: number;
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

const GLOW_TITLE =
  "0 2px 18px rgba(0,0,0,0.9), 0 0 34px rgba(94,203,255,0.45), 0 0 90px rgba(43,140,255,0.30)";
const GLOW_SOFT = "0 1px 8px rgba(0,0,0,0.85)";

/** Общая часть всех кнопок: без цвета, цвет добавляет вариант. */
const BTN =
  "rounded-xl border px-4 py-2.5 text-[13px] font-bold transition-colors active:scale-[0.98]";

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

/* ---------- мелкие кирпичи ---------- */

function SoundIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 18 16"
      width="14"
      height="13"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 6h2.6L8.4 3v10L4.6 10H2z" fill="currentColor" stroke="none" />
      {muted ? (
        <>
          <path d="M11.4 6.2 15.6 9.8" />
          <path d="M15.6 6.2 11.4 9.8" />
        </>
      ) : (
        <>
          <path d="M11.3 5.6a4.2 4.2 0 0 1 0 4.8" />
          <path d="M13.6 3.6a7 7 0 0 1 0 8.8" />
        </>
      )}
    </svg>
  );
}

/** Клавиша в тексте. */
function Key({ children }: { children: ReactNode }) {
  return (
    <kbd
      className="tnum rounded-md border px-1.5 py-[1px] text-[11px] font-bold not-italic"
      style={{
        borderColor: "rgba(94,203,255,0.26)",
        background: "rgba(94,203,255,0.07)",
        color: "#cfe2f7",
        fontFamily: "inherit",
      }}
    >
      {children}
    </kbd>
  );
}

/** Строка таблицы управления: действие — клавиши — тач. */
function Ctl({
  action,
  keys,
  touch,
}: {
  action: string;
  keys: ReactNode;
  touch?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 py-[3px]">
      <span
        className="w-[64px] shrink-0 text-[11px] font-bold uppercase"
        style={{ letterSpacing: "0.12em", color: "#8ba3c2" }}
      >
        {action}
      </span>
      <span className="flex flex-wrap items-baseline gap-1">{keys}</span>
      {touch !== undefined && (
        <span className="ml-auto shrink-0 text-[11px]" style={{ color: "#5b7ba0" }}>
          {touch}
        </span>
      )}
    </div>
  );
}

/** Ячейка итогов заезда. */
function Stat({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div
      className="rounded-xl border px-3 py-2.5"
      style={{
        borderColor: "rgba(94,203,255,0.14)",
        background: "rgba(8,14,30,0.55)",
      }}
    >
      <div
        className="text-[10px] font-bold uppercase"
        style={{ letterSpacing: "0.2em", color: "#5b7ba0" }}
      >
        {label}
      </div>
      <div
        className="tnum mt-1 text-[20px] font-black leading-none"
        style={{ color: tint, textShadow: GLOW_SOFT }}
      >
        {value}
      </div>
    </div>
  );
}

/** Заголовок экрана. */
function Title({ text, size }: { text: string; size: string }) {
  return (
    <h2
      className="font-black leading-[1.02]"
      style={{
        fontSize: size,
        letterSpacing: "-0.03em",
        color: COLORS.star,
        textShadow: GLOW_TITLE,
      }}
    >
      {text}
    </h2>
  );
}

/* ---------- настройки, общие для меню и паузы ---------- */

function Settings({
  quality,
  muted,
  onQuality,
  onMute,
}: {
  quality: Quality;
  muted: boolean;
  onQuality(q: Quality): void;
  onMute(): void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className="w-[64px] shrink-0 text-[11px] font-bold uppercase"
          style={{ letterSpacing: "0.12em", color: "#8ba3c2" }}
        >
          картинка
        </span>
        <div role="group" aria-label="Качество картинки" className="flex flex-1 gap-1.5">
          {QLIST.map((q) => {
            const on = q === quality;
            return (
              <button
                key={q}
                type="button"
                onClick={() => onQuality(q)}
                aria-pressed={on}
                className="flex-1 rounded-lg border px-2 py-1.5 text-[12px] font-bold transition-colors"
                style={{
                  borderColor: on ? "rgba(94,203,255,0.55)" : "rgba(94,203,255,0.16)",
                  background: on ? "rgba(94,203,255,0.14)" : "rgba(8,14,30,0.5)",
                  color: on ? COLORS.neon : "#8ba3c2",
                  textShadow: on ? "0 0 14px rgba(94,203,255,0.5)" : "none",
                }}
              >
                {QUALITY[q].label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span
          className="w-[64px] shrink-0 text-[11px] font-bold uppercase"
          style={{ letterSpacing: "0.12em", color: "#8ba3c2" }}
        >
          звук
        </span>
        <button
          type="button"
          onClick={onMute}
          aria-pressed={muted}
          className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] font-bold transition-colors"
          style={{
            borderColor: muted ? "rgba(255,74,58,0.35)" : "rgba(122,255,200,0.30)",
            background: muted ? "rgba(255,74,58,0.10)" : "rgba(122,255,200,0.10)",
            color: muted ? COLORS.danger : COLORS.nitro,
          }}
        >
          <SoundIcon muted={muted} />
          {muted ? "выключен" : "включён"}
        </button>
      </div>
    </div>
  );
}

/* ---------- содержимое экранов ---------- */

function MenuBody({
  snap,
  quality,
  primaryRef,
  onStart,
  onQuality,
  onMute,
  onHelp,
}: {
  snap: HudSnapshot;
  quality: Quality;
  primaryRef: RefObject<HTMLButtonElement | null>;
  onStart(): void;
  onQuality(q: Quality): void;
  onMute(): void;
  onHelp?(): void;
}) {
  return (
    <>
      <div
        className="text-[10px] font-bold uppercase"
        style={{ letterSpacing: "0.34em", color: COLORS.neon, textShadow: GLOW_SOFT }}
      >
        ночной заезд
      </div>

      <div className="mt-1.5">
        <Title text="Starry Ride" size="clamp(34px, 9vw, 52px)" />
      </div>

      <p className="mt-2.5 text-[13px] leading-snug" style={{ color: "#c2d4ea" }}>
        ночная дорога, неон и звёздное небо — доедь как можно дальше
      </p>

      {snap.best > 0 && (
        <p className="mt-2 text-[12px] font-bold" style={{ color: COLORS.combo }}>
          лучший заезд — <span className="tnum">{groupNum(snap.best)}</span>
        </p>
      )}

      <div
        className="mt-4 rounded-xl border px-3 py-2"
        style={{ borderColor: "rgba(94,203,255,0.14)", background: "rgba(8,14,30,0.45)" }}
      >
        <Ctl action="руль" keys={<><Key>←</Key><Key>→</Key><Key>A</Key><Key>D</Key></>} />
        <Ctl action="нитро" keys={<><Key>Space</Key><Key>Shift</Key></>} />
        <Ctl action="тормоз" keys={<><Key>↓</Key><Key>S</Key></>} />
        <Ctl action="пауза" keys={<><Key>Esc</Key><Key>P</Key></>} />
        <p className="mt-1.5 text-[11px] leading-snug" style={{ color: "#5b7ba0" }}>
          с телефона: веди пальцем по экрану — это руль, кнопки справа — нитро и стоп
        </p>
      </div>

      <Settings quality={quality} muted={snap.muted} onQuality={onQuality} onMute={onMute} />

      <div className="mt-5 flex items-center gap-2">
        <button
          ref={primaryRef}
          type="button"
          onClick={onStart}
          className={`${BTN} flex-1 text-[15px]`}
          style={{
            borderColor: "rgba(94,203,255,0.55)",
            background: `linear-gradient(180deg, ${COLORS.neon} 0%, ${COLORS.neonDeep} 100%)`,
            color: "#02060f",
            boxShadow: "0 10px 34px rgba(43,140,255,0.42), 0 0 26px rgba(94,203,255,0.35)",
            letterSpacing: "0.04em",
          }}
        >
          поехали
        </button>

        {onHelp !== undefined && (
          <button
            type="button"
            onClick={onHelp}
            className={BTN}
            style={{
              borderColor: "rgba(94,203,255,0.22)",
              background: "rgba(8,14,30,0.6)",
              color: "#c2d4ea",
            }}
          >
            как играть
          </button>
        )}
      </div>

      <p className="mt-2.5 text-[11px]" style={{ color: "#5b7ba0" }}>
        <Key>Enter</Key> или <Key>Space</Key> — тоже старт
      </p>
    </>
  );
}

function PausedBody({
  snap,
  quality,
  primaryRef,
  onResume,
  onRestart,
  onQuality,
  onMute,
}: {
  snap: HudSnapshot;
  quality: Quality;
  primaryRef: RefObject<HTMLButtonElement | null>;
  onResume(): void;
  onRestart(): void;
  onQuality(q: Quality): void;
  onMute(): void;
}) {
  return (
    <>
      <Title text="пауза" size="clamp(28px, 7vw, 38px)" />

      <p className="mt-2 text-[12px]" style={{ color: "#8ba3c2" }}>
        <span className="tnum">{groupNum(snap.score)}</span> очков ·{" "}
        <span className="tnum">{formatDistance(snap.distance)}</span> · жизней {snap.lives}
      </p>

      <Settings quality={quality} muted={snap.muted} onQuality={onQuality} onMute={onMute} />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          ref={primaryRef}
          type="button"
          onClick={onResume}
          className={`${BTN} flex-1 text-[15px]`}
          style={{
            borderColor: "rgba(94,203,255,0.55)",
            background: `linear-gradient(180deg, ${COLORS.neon} 0%, ${COLORS.neonDeep} 100%)`,
            color: "#02060f",
            boxShadow: "0 10px 34px rgba(43,140,255,0.42)",
            letterSpacing: "0.04em",
          }}
        >
          продолжить
        </button>
        <button
          type="button"
          onClick={onRestart}
          className={BTN}
          style={{
            borderColor: "rgba(94,203,255,0.22)",
            background: "rgba(8,14,30,0.6)",
            color: "#c2d4ea",
          }}
        >
          начать заново
        </button>
      </div>

      <p className="mt-2.5 text-[11px]" style={{ color: "#5b7ba0" }}>
        <Key>Esc</Key> — вернуться в заезд, <Key>R</Key> — заново
      </p>
    </>
  );
}

function OverBody({
  snap,
  prevBest,
  primaryRef,
  onRestart,
  onMenu,
}: {
  snap: HudSnapshot;
  prevBest?: number;
  primaryRef: RefObject<HTMLButtonElement | null>;
  onRestart(): void;
  onMenu?(): void;
}) {
  /* Рекорд до заезда: страница помнит его до `startRun`, потому что движок
     поднимает `best` прямо в кадре и к концу заезда он уже равен счёту. */
  const prior = prevBest ?? snap.best;
  const record = snap.score > 0 && snap.score >= prior;
  return (
    <>
      <Title text="заезд закончен" size="clamp(26px, 6.6vw, 36px)" />

      {record ? (
        <p
          className="mt-2 text-[15px] font-black uppercase"
          style={{
            letterSpacing: "0.2em",
            color: COLORS.combo,
            textShadow: "0 1px 8px rgba(0,0,0,0.9), 0 0 26px rgba(255,209,92,0.6)",
          }}
        >
          новый рекорд
          {prior > 0 && (
            <span
              className="ml-2 text-[11px] font-bold normal-case"
              style={{ letterSpacing: "0.06em", color: "#8ba3c2", textShadow: GLOW_SOFT }}
            >
              было <span className="tnum">{groupNum(prior)}</span>
            </span>
          )}
        </p>
      ) : (
        <p className="mt-2 text-[12px]" style={{ color: "#8ba3c2" }}>
          рекорд — <span className="tnum">{groupNum(snap.best)}</span>
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Stat label="очки" value={groupNum(snap.score)} tint={COLORS.star} />
        <Stat label="дистанция" value={formatDistance(snap.distance)} tint={COLORS.neon} />
        <Stat label="звёзды" value={String(snap.stars)} tint={COLORS.starWarm} />
        <Stat
          label={snap.combo > 1 ? `комбо ${snap.combo}` : "множитель"}
          value={`×${snap.multiplier.toFixed(1)}`}
          tint={COLORS.combo}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          ref={primaryRef}
          type="button"
          onClick={onRestart}
          className={`${BTN} flex-1 text-[15px]`}
          style={{
            borderColor: "rgba(94,203,255,0.55)",
            background: `linear-gradient(180deg, ${COLORS.neon} 0%, ${COLORS.neonDeep} 100%)`,
            color: "#02060f",
            boxShadow: "0 10px 34px rgba(43,140,255,0.42)",
            letterSpacing: "0.04em",
          }}
        >
          ещё раз
        </button>
        {onMenu !== undefined && (
          <button
            type="button"
            onClick={onMenu}
            className={BTN}
            style={{
              borderColor: "rgba(94,203,255,0.22)",
              background: "rgba(8,14,30,0.6)",
              color: "#c2d4ea",
            }}
          >
            в меню
          </button>
        )}
      </div>

      <p className="mt-2.5 text-[11px]" style={{ color: "#5b7ba0" }}>
        <Key>R</Key> — сразу ещё раз
      </p>
    </>
  );
}

function HelpBody({
  primaryRef,
  onExitHelp,
}: {
  primaryRef: RefObject<HTMLButtonElement | null>;
  onExitHelp(): void;
}) {
  return (
    <>
      <Title text="как играть" size="clamp(24px, 6vw, 32px)" />

      <p className="mt-2 text-[12px] leading-snug" style={{ color: "#c2d4ea" }}>
        скорость растёт сама. встречные фары — смерть, отбойник — только потеря
        скорости. звёзды дают очки и нитро, проезд вплотную — комбо. жизней три.
      </p>

      <div
        className="mt-3.5 rounded-xl border px-3 py-2"
        style={{ borderColor: "rgba(94,203,255,0.14)", background: "rgba(8,14,30,0.45)" }}
      >
        <Ctl
          action="руль"
          keys={<><Key>ArrowLeft</Key><Key>ArrowRight</Key><Key>KeyA</Key><Key>KeyD</Key></>}
          touch="драг по экрану"
        />
        <Ctl
          action="газ"
          keys={<><Key>ArrowUp</Key><Key>KeyW</Key></>}
          touch="авто-газ"
        />
        <Ctl
          action="тормоз"
          keys={<><Key>ArrowDown</Key><Key>KeyS</Key></>}
          touch="кнопка «стоп»"
        />
        <Ctl
          action="нитро"
          keys={<><Key>Space</Key><Key>ShiftLeft</Key><Key>ShiftRight</Key></>}
          touch="кнопка «нитро»"
        />
        <Ctl action="пауза" keys={<><Key>Escape</Key><Key>KeyP</Key></>} touch="кнопка ⏸" />
        <Ctl action="звук" keys={<Key>KeyM</Key>} touch="кнопка звука" />
        <Ctl action="заново" keys={<Key>KeyR</Key>} touch="кнопка «ещё раз»" />
        <Ctl
          action="старт"
          keys={<><Key>Enter</Key><Key>Space</Key></>}
          touch="кнопка «поехали»"
        />
      </div>

      <button
        ref={primaryRef}
        type="button"
        onClick={onExitHelp}
        className={`${BTN} mt-5 w-full text-[15px]`}
        style={{
          borderColor: "rgba(94,203,255,0.55)",
          background: `linear-gradient(180deg, ${COLORS.neon} 0%, ${COLORS.neonDeep} 100%)`,
          color: "#02060f",
          boxShadow: "0 10px 34px rgba(43,140,255,0.42)",
          letterSpacing: "0.04em",
        }}
      >
        понятно
      </button>
    </>
  );
}

/* ---------- сам компонент ---------- */

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

export function Screens({
  snap,
  quality,
  onStart,
  onResume,
  onRestart,
  onQuality,
  onMute,
  onExitHelp,
  showHelp,
  onMenu,
  onHelp,
  prevBest,
}: ScreensProps) {
  const screen = overlayScreen(snap.phase, showHelp);

  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  /* --- prefers-reduced-motion: узнаём один раз после монтирования --- */
  const [calm, setCalm] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setCalm(mq.matches);
    const onChange = () => setCalm(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* --- фокус переезжает на главную кнопку появившегося экрана --- */
  useEffect(() => {
    if (screen === null) return;
    // Кадр отсрочки: motion может успеть смонтировать узел позже эффекта.
    const id = requestAnimationFrame(() => {
      const el = primaryRef.current ?? dialogRef.current;
      el?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [screen]);

  /**
   * Ловушка фокуса. Tab по кругу обрабатываем сами, а `focusin` страхует от
   * случая, когда фокус утёк наружу мимо Tab (клик по кнопке HUD, автофокус
   * браузера после перерисовки).
   */
  useEffect(() => {
    if (screen === null) return;
    const onFocusIn = (e: FocusEvent): void => {
      const root = dialogRef.current;
      if (root === null) return;
      const t = e.target as Node | null;
      if (t !== null && root.contains(t)) return;
      (primaryRef.current ?? root).focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [screen]);

  const onTab = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (root === null) return;
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
  }, []);

  /* Оверлей ест `pointerdown`: иначе рулевая поверхность страницы примет
     нажатие на кнопку за драг руля. */
  const swallow = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
  }, []);

  if (screen === null) return null;

  const blur = quality === 0 ? undefined : "blur(10px)";

  return (
    <motion.div
      key={screen}
      className="absolute inset-0 z-40 flex items-center justify-center px-4 py-6"
      onPointerDown={swallow}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: calm ? 0.12 : 0.22, ease: "easeOut" }}
      style={{
        background:
          "radial-gradient(120% 80% at 50% 30%, rgba(10,26,58,0.72) 0%, rgba(4,8,26,0.90) 60%, rgba(2,4,12,0.95) 100%)",
        // Размытие подложки — самый дорогой пиксель на экране: оно
        // пересчитывается поверх живого canvas каждый кадр, во весь экран, и
        // ровно тогда, когда сцена всё равно рисуется зря (игра стоит). На
        // «экономно» его нет вовсе — градиент выше и так кроет фон на 90%, а
        // `saturate` на такой темноте не виден ни в одном из пресетов.
        backdropFilter: blur,
        WebkitBackdropFilter: blur,
      }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={LABELS[screen]}
        tabIndex={-1}
        onKeyDown={onTab}
        initial={calm ? { opacity: 0 } : { opacity: 0, y: 22 }}
        animate={calm ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={{ duration: calm ? 0.14 : 0.32, ease: "easeOut" }}
        className="max-h-full w-full max-w-[440px] overflow-y-auto overscroll-contain rounded-3xl border p-5 sm:p-7"
        style={{
          borderColor: CARD_EDGE,
          background: CARD_BG,
          boxShadow: CARD_SHADOW,
        }}
      >
        {screen === "menu" && (
          <MenuBody
            snap={snap}
            quality={quality}
            primaryRef={primaryRef}
            onStart={onStart}
            onQuality={onQuality}
            onMute={onMute}
            onHelp={onHelp}
          />
        )}

        {screen === "paused" && (
          <PausedBody
            snap={snap}
            quality={quality}
            primaryRef={primaryRef}
            onResume={onResume}
            onRestart={onRestart}
            onQuality={onQuality}
            onMute={onMute}
          />
        )}

        {screen === "over" && (
          <OverBody
            snap={snap}
            prevBest={prevBest}
            primaryRef={primaryRef}
            onRestart={onRestart}
            onMenu={onMenu}
          />
        )}

        {screen === "help" && (
          <HelpBody primaryRef={primaryRef} onExitHelp={onExitHelp} />
        )}
      </motion.div>
    </motion.div>
  );
}
