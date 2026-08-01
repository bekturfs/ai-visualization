/**
 * HUD — читаемое состояние заезда поверх сцены и тач-управление.
 *
 * Два разных источника данных, и их нельзя путать:
 *
 * - `snap` (HudSnapshot) страница обновляет ~12 раз в секунду. Всё, что можно
 *   отрисовать «ступеньками» — очки, рекорд, жизни, глава, множитель, комбо, —
 *   рендерится из него обычным React-ом. React здесь дёшев: 12 Гц, не 60.
 * - `g` (мутируемый объект игры) читается только в rAF-цикле и в тач-обработчиках.
 *   Полоса нитро должна ползти плавно, поэтому её ширину пишем императивно в ref,
 *   а не через состояние: перерисовка React на 60 Гц — это то, чего вся
 *   архитектура игры избегает.
 *
 * Верх экрана целиком наш, низ (≈46vh) принадлежит приборке, поэтому всё
 * информационное прижато к верхней кромке, а тач-кнопки живут выше линии панели.
 *
 * Контейнер `pointer-events: none` — сквозь него проходит драг по канвасу
 * (рулевая поверхность из `input.ts`). Интерактивные элементы включают
 * `pointer-events: auto` точечно и гасят всплытие, чтобы палец на кнопке не
 * считался одновременно рулением.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";

import type { Game, HudSnapshot } from "../types";
import { COLORS, NITRO } from "../config";
import { clamp01, damp } from "../num";

/* ---------- внешний контракт ---------- */

/**
 * Мост к `input.ts`. Сам HUD модуль ввода не импортирует (модули игры не знают
 * друг о друге), поэтому страница передаёт две функции пропсом.
 */
export interface HudTouch {
  steer(v: number): void;
  button(b: "throttle" | "brake" | "nitro", down: boolean): void;
}

export interface HudProps {
  g: Game;
  snap: HudSnapshot;
  onPause(): void;
  onMute(): void;
  /** Не передан — тач-управление просто не рисуется. */
  touch?: HudTouch;
}

/* ---------- константы оформления ---------- */

/** Тонкий пробел для разрядов: обычный слишком широко разваливает число. */
const THIN = " ";

const SHADOW_SCORE = "0 2px 12px rgba(0,0,0,0.9), 0 0 26px rgba(94,203,255,0.35)";
const SHADOW_SOFT = "0 1px 6px rgba(0,0,0,0.9)";
const SHADOW_NEON = "0 1px 6px rgba(0,0,0,0.9), 0 0 14px rgba(94,203,255,0.45)";

/** Насколько быстро полоса нитро догоняет `g.nitro`, 1/с. */
const NITRO_TRACK = 14;
/** Насколько быстро тач-зона докручивает руль до упора, 1/с. */
const STEER_TRACK = 16;

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

/** Силуэт машинки для счётчика жизней. */
function CarGlyph({ lost, tint }: { lost: boolean; tint: string }) {
  return (
    <svg
      viewBox="0 0 24 14"
      width="19"
      height="11"
      aria-hidden="true"
      style={{
        opacity: lost ? 0.22 : 1,
        filter: lost ? "none" : `drop-shadow(0 0 6px ${tint})`,
      }}
    >
      <path
        d="M2.4 10.2 3.6 6.4C4 5.2 4.6 4.2 6 4.2h12c1.4 0 2 1 2.4 2.2l1.2 3.8z"
        fill={lost ? "#1a2740" : tint}
        opacity={lost ? 1 : 0.9}
      />
      <rect x="1" y="9.6" width="22" height="2.6" rx="1.3" fill={lost ? "#1a2740" : tint} />
      <circle cx="5.6" cy="12.6" r="1.3" fill={lost ? "#101a2c" : "#04081a"} />
      <circle cx="18.4" cy="12.6" r="1.3" fill={lost ? "#101a2c" : "#04081a"} />
    </svg>
  );
}

function PauseIcon({ paused }: { paused: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      {paused ? (
        <path d="M4 2.5 13 8l-9 5.5z" />
      ) : (
        <>
          <rect x="3.5" y="2.5" width="3.2" height="11" rx="1" />
          <rect x="9.3" y="2.5" width="3.2" height="11" rx="1" />
        </>
      )}
    </svg>
  );
}

function SoundIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 18 16"
      width="15"
      height="14"
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

/* ---------- компонент ---------- */

export function Hud({ g, snap, onPause, onMute, touch }: HudProps) {
  // Флаг постоянен на всё время жизни игры, читать его в рендере безопасно.
  const calm = g.reducedMotion;
  const playing = snap.phase === "playing" || snap.phase === "crashed";
  const idle = snap.phase === "menu" || snap.phase === "over";

  /* --- грубый указатель определяем один раз, после монтирования --- */
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: coarse)");
    setCoarse(mq.matches);
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /* --- плавные штуки живут в ref, а не в состоянии --- */
  const fillRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(0);
  const lastWidthRef = useRef(-1);
  const lastPulseRef = useRef(-1);

  /**
   * Состояние тач-руля. Две зоны могут быть зажаты одновременно (палец соскочил
   * с одной на другую), поэтому храним id пойманных указателей, а не «нажато».
   */
  const steerRef = useRef({ leftId: -1, rightId: -1, target: 0, value: 0, sent: 0 });

  // Свежий `touch` в ref: обработчики остаются стабильными между рендерами.
  const touchRef = useRef<HudTouch | undefined>(touch);
  useEffect(() => {
    touchRef.current = touch;
  }, [touch]);

  /* --- один rAF-цикл на всё непрерывное --- */
  useEffect(() => {
    let raf = 0;
    let prev =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // Дельту зажимаем: после возврата вкладки из фона она может быть в секундах.
      const dt = Math.min(0.05, (now - prev) * 0.001);
      prev = now;

      /* полоса нитро */
      const bar = fillRef.current;
      if (bar !== null) {
        const shown = damp(shownRef.current, clamp01(g.nitro), NITRO_TRACK, dt);
        shownRef.current = shown;
        // Пишем в стиль только при заметном изменении: строки в кадре — мусор.
        if (Math.abs(shown - lastWidthRef.current) > 0.003) {
          lastWidthRef.current = shown;
          bar.style.transform = `scaleX(${shown.toFixed(3)})`;
        }

        // Пульс на активном нитро. При reduced-motion — ровное свечение без строба.
        let pulse = 0;
        if (g.nitroActive) pulse = calm ? 0.6 : 0.5 + 0.5 * Math.sin(now * 0.013);
        const q = Math.round(pulse * 8) / 8;
        if (q !== lastPulseRef.current) {
          lastPulseRef.current = q;
          bar.style.opacity = (0.8 + 0.2 * q).toFixed(2);
          bar.style.filter = q > 0 ? `brightness(${(1 + 0.55 * q).toFixed(2)})` : "none";
        }
      }

      /* руль от тач-зон: доводим до упора плавно, иначе машину рвёт */
      const st = steerRef.current;
      if (st.target !== 0 || st.value !== 0) {
        const next =
          Math.abs(st.target - st.value) < 0.004
            ? st.target
            : damp(st.value, st.target, STEER_TRACK, dt);
        st.value = next;
        if (next !== st.sent) {
          st.sent = next;
          touchRef.current?.steer(next);
        }
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [g, calm]);

  /* --- отпустить всё: при паузе, конце заезда и размонтировании --- */
  const releaseTouch = useCallback(() => {
    const st = steerRef.current;
    st.leftId = -1;
    st.rightId = -1;
    st.target = 0;
    st.value = 0;
    st.sent = 0;
    const api = touchRef.current;
    if (api === undefined) return;
    api.steer(0);
    api.button("brake", false);
    api.button("nitro", false);
  }, []);

  useEffect(() => {
    if (!playing) releaseTouch();
  }, [playing, releaseTouch]);

  useEffect(() => releaseTouch, [releaseTouch]);

  /* --- тач-зоны руля --- */

  const applySteerTarget = useCallback(() => {
    const st = steerRef.current;
    st.target = (st.rightId >= 0 ? 1 : 0) - (st.leftId >= 0 ? 1 : 0);
  }, []);

  const onZoneDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // preventDefault — чтобы браузер не забрал жест под скролл/зум;
      // stopPropagation — чтобы рулевая поверхность канваса не приняла тот же
      // палец за драг и не переписала ось руля нулём.
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      const st = steerRef.current;
      if (el.dataset.dir === "r") st.rightId = e.pointerId;
      else st.leftId = e.pointerId;
      applySteerTarget();
      // Захват указателя: отпускание за пределами зоны всё равно придёт нам.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* указатель уже мог исчезнуть — тогда сработает pointercancel */
      }
    },
    [applySteerTarget],
  );

  const onZoneUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const st = steerRef.current;
      if (st.rightId === e.pointerId) st.rightId = -1;
      if (st.leftId === e.pointerId) st.leftId = -1;
      applySteerTarget();
    },
    [applySteerTarget],
  );

  /* --- тач-кнопки тормоза и нитро --- */

  const onPedalDown = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const b = el.dataset.btn === "nitro" ? "nitro" : "brake";
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* см. выше */
    }
    el.dataset.on = "1";
    touchRef.current?.button(b, true);
  }, []);

  const onPedalUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const el = e.currentTarget;
    const b = el.dataset.btn === "nitro" ? "nitro" : "brake";
    el.dataset.on = "0";
    touchRef.current?.button(b, false);
  }, []);

  /* --- кнопки-оверлеи не должны считаться рулением --- */
  const swallow = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    e.stopPropagation();
  }, []);

  /* --- данные для рендера --- */
  const lowNitro = snap.nitro < NITRO.minToFire;
  const lastLife = snap.lives <= 1;
  const lifeTint = lastLife ? COLORS.danger : COLORS.neon;
  const statsStyle = { opacity: idle ? 0 : 1 } as const;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-20 select-none"
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {/* ------ слева: очки, рекорд, дистанция, нитро ------ */}
      <div
        className="absolute left-3 top-3 transition-opacity duration-300 sm:left-5 sm:top-4"
        style={statsStyle}
        aria-hidden={idle}
      >
        <div
          className="tnum font-black leading-none"
          style={{
            fontSize: "clamp(30px, 7.6vw, 54px)",
            letterSpacing: "-0.02em",
            color: COLORS.star,
            textShadow: SHADOW_SCORE,
          }}
        >
          {groupNum(snap.score)}
        </div>

        <div
          className="mt-1.5 text-[10px] font-bold uppercase"
          style={{
            letterSpacing: "0.26em",
            color: "#8ba3c2",
            textShadow: SHADOW_SOFT,
          }}
        >
          рекорд <span className="tnum">{groupNum(snap.best)}</span>
        </div>

        <div
          className="tnum mt-1 text-[12px] font-bold"
          style={{
            letterSpacing: "0.14em",
            color: COLORS.neon,
            textShadow: SHADOW_NEON,
          }}
        >
          {formatDistance(snap.distance)}
        </div>

        {/* полоса нитро — единственное, что живёт на 60 Гц */}
        <div className="mt-2.5 flex items-center gap-2">
          <span
            className="text-[9px] font-black uppercase"
            style={{
              letterSpacing: "0.3em",
              color: COLORS.nitro,
              opacity: lowNitro ? 0.4 : 0.85,
              textShadow: SHADOW_SOFT,
            }}
          >
            нитро
          </span>
          <div
            className="relative h-[7px] w-[clamp(92px,27vw,190px)] overflow-hidden rounded-full"
            style={{
              background: "rgba(122,255,200,0.10)",
              boxShadow: "inset 0 0 0 1px rgba(122,255,200,0.22)",
            }}
          >
            <div
              ref={fillRef}
              className="h-full w-full origin-left rounded-full"
              style={{
                transform: "scaleX(0)",
                background: `linear-gradient(90deg, ${COLORS.neonDeep}, ${COLORS.nitro})`,
                boxShadow: `0 0 12px ${COLORS.nitro}`,
                willChange: "transform",
              }}
            />
          </div>
        </div>
      </div>

      {/* ------ центр: жизни и глава неба ------ */}
      <div
        className="absolute left-1/2 top-3 flex -translate-x-1/2 flex-col items-center gap-1.5 transition-opacity duration-300 sm:top-4"
        style={statsStyle}
        aria-hidden={idle}
      >
        <div className="flex items-center gap-1.5" aria-label={`жизни: ${snap.lives}`} role="img">
          <CarGlyph lost={snap.lives < 1} tint={lifeTint} />
          <CarGlyph lost={snap.lives < 2} tint={lifeTint} />
          <CarGlyph lost={snap.lives < 3} tint={lifeTint} />
        </div>

        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={snap.chapter}
            initial={calm ? { opacity: 0 } : { opacity: 0, scale: 1.25, filter: "blur(3px)" }}
            animate={calm ? { opacity: 0.85 } : { opacity: 0.85, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0 }}
            transition={{ duration: calm ? 0.18 : 0.5, ease: "easeOut" }}
            className="text-[10px] font-bold uppercase"
            style={{
              letterSpacing: "0.34em",
              color: COLORS.neon,
              textShadow: SHADOW_NEON,
            }}
          >
            глава {snap.chapter + 1}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ------ справа: кнопки, множитель, комбо ------ */}
      <div className="absolute right-3 top-3 flex flex-col items-end gap-2 sm:right-5 sm:top-4">
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onPause}
            onPointerDown={swallow}
            aria-label={snap.phase === "paused" ? "Продолжить заезд" : "Пауза"}
            className="grid h-9 w-9 place-items-center rounded-full border text-soft transition-colors active:scale-95"
            style={{
              borderColor: "rgba(94,203,255,0.28)",
              background: "rgba(10,18,36,0.62)",
              backdropFilter: "blur(6px)",
            }}
          >
            <PauseIcon paused={snap.phase === "paused"} />
          </button>

          <button
            type="button"
            onClick={onMute}
            onPointerDown={swallow}
            aria-label={snap.muted ? "Включить звук" : "Выключить звук"}
            aria-pressed={snap.muted}
            className="grid h-9 w-9 place-items-center rounded-full border transition-colors active:scale-95"
            style={{
              borderColor: "rgba(94,203,255,0.28)",
              background: "rgba(10,18,36,0.62)",
              backdropFilter: "blur(6px)",
              color: snap.muted ? COLORS.danger : "#c2d4ea",
            }}
          >
            <SoundIcon muted={snap.muted} />
          </button>
        </div>

        <div
          className="flex flex-col items-end gap-1 transition-opacity duration-300"
          style={statsStyle}
          aria-hidden={idle}
        >
          <div
            className="tnum font-black leading-none"
            style={{
              fontSize: "clamp(18px, 4.6vw, 28px)",
              letterSpacing: "-0.01em",
              color: snap.multiplier >= 2 ? COLORS.combo : COLORS.star,
              textShadow:
                snap.multiplier >= 2
                  ? "0 1px 8px rgba(0,0,0,0.9), 0 0 20px rgba(255,209,92,0.55)"
                  : SHADOW_SCORE,
            }}
          >
            ×{snap.multiplier.toFixed(1)}
          </div>

          {/* Комбо — главная награда за риск: выпрыгивает и тает. */}
          <div className="h-[26px]">
            <AnimatePresence initial={false} mode="popLayout">
              {snap.combo > 1 && (
                <motion.div
                  key={snap.combo}
                  initial={
                    calm ? { opacity: 0 } : { opacity: 0, scale: 0.55, x: 18, rotate: -6 }
                  }
                  animate={calm ? { opacity: 1 } : { opacity: 1, scale: 1, x: 0, rotate: 0 }}
                  exit={calm ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: -10 }}
                  transition={
                    calm
                      ? { duration: 0.15 }
                      : { type: "spring", stiffness: 620, damping: 18, mass: 0.6 }
                  }
                  className="flex items-baseline gap-1 rounded-full px-2.5 py-0.5"
                  style={{
                    background: "rgba(255,209,92,0.10)",
                    boxShadow: "inset 0 0 0 1px rgba(255,209,92,0.35)",
                    color: COLORS.combo,
                    textShadow: "0 1px 8px rgba(0,0,0,0.9), 0 0 18px rgba(255,209,92,0.6)",
                  }}
                >
                  <span className="tnum text-[17px] font-black leading-none">
                    {snap.combo}
                  </span>
                  <span
                    className="text-[9px] font-bold uppercase"
                    style={{ letterSpacing: "0.22em" }}
                  >
                    подряд
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* ------ тач-управление: только на грубом указателе ------ */}
      {coarse && touch !== undefined && (
        <>
          {/* Невидимые зоны руления по нижним углам. Держать = выкрутить руль. */}
          <div
            data-dir="l"
            onPointerDown={onZoneDown}
            onPointerUp={onZoneUp}
            onPointerCancel={onZoneUp}
            onLostPointerCapture={onZoneUp}
            aria-hidden="true"
            className="pointer-events-auto absolute bottom-0 left-0 h-[34vh] w-[38vw]"
            style={{ touchAction: "none", WebkitTapHighlightColor: "transparent" }}
          />
          <div
            data-dir="r"
            onPointerDown={onZoneDown}
            onPointerUp={onZoneUp}
            onPointerCancel={onZoneUp}
            onLostPointerCapture={onZoneUp}
            aria-hidden="true"
            className="pointer-events-auto absolute bottom-0 right-0 h-[34vh] w-[38vw]"
            style={{ touchAction: "none", WebkitTapHighlightColor: "transparent" }}
          />

          {/* Педали — выше линии приборки, чтобы не спорить с рулём и кабиной. */}
          <div
            className="pointer-events-auto absolute right-3 flex flex-col items-end gap-3"
            style={{ bottom: "48vh" }}
          >
            <button
              type="button"
              data-btn="nitro"
              data-on="0"
              onPointerDown={onPedalDown}
              onPointerUp={onPedalUp}
              onPointerCancel={onPedalUp}
              onLostPointerCapture={onPedalUp}
              onContextMenu={(e) => e.preventDefault()}
              aria-label="Нитро"
              className="grid h-16 w-16 place-items-center rounded-full text-[10px] font-black uppercase active:scale-95"
              style={{
                letterSpacing: "0.14em",
                touchAction: "none",
                color: COLORS.nitro,
                background: "rgba(122,255,200,0.10)",
                boxShadow: `inset 0 0 0 1.5px ${COLORS.nitro}66, 0 0 18px rgba(122,255,200,0.25)`,
              }}
            >
              нитро
            </button>

            <button
              type="button"
              data-btn="brake"
              data-on="0"
              onPointerDown={onPedalDown}
              onPointerUp={onPedalUp}
              onPointerCancel={onPedalUp}
              onLostPointerCapture={onPedalUp}
              onContextMenu={(e) => e.preventDefault()}
              aria-label="Тормоз"
              className="grid h-14 w-14 place-items-center rounded-full text-[10px] font-black uppercase active:scale-95"
              style={{
                letterSpacing: "0.14em",
                touchAction: "none",
                color: COLORS.gaugeGlow,
                background: "rgba(255,42,26,0.10)",
                boxShadow: `inset 0 0 0 1.5px ${COLORS.gauge}66, 0 0 18px rgba(255,42,26,0.22)`,
              }}
            >
              стоп
            </button>
          </div>
        </>
      )}
    </div>
  );
}
