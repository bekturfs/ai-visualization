/**
 * HUD — читаемое состояние заезда поверх сцены и тач-управление.
 *
 * Два разных источника данных, и их нельзя путать:
 *
 * - `snap` (HudSnapshot) страница обновляет ~12 раз в секунду. Всё, что можно
 *   отрисовать «ступеньками» — очки, рекорд, жизни, множитель, комбо, — рендерится
 *   из него обычным React-ом. React здесь дёшев: 12 Гц, не 60.
 * - `g` (мутируемый объект игры) читается только в rAF-цикле и в тач-обработчиках.
 *   Полоса нитро должна ползти плавно, поэтому её ширину пишем императивно в ref,
 *   а не через состояние: перерисовка React на 60 Гц — это то, чего вся
 *   архитектура игры избегает. HUD ничего в `g` не пишет — это дело `input.ts`,
 *   до которого страница пробрасывает мост `touch`.
 *
 * Верх экрана целиком наш, низ (≈46vh) принадлежит приборке, поэтому всё
 * информационное прижато к верхней кромке, а тач-кнопки живут выше линии панели.
 * Приоритет по месту: центр верха — только жизни (их ловят боковым зрением),
 * слева — счёт и ресурсы, справа — кнопки и множитель. Всё разовое (смена главы,
 * комбо) вспыхивает и уходит, постоянного места не занимая.
 *
 * Контейнер `pointer-events: none` — сквозь него проходит драг по канвасу
 * (рулевая поверхность из `input.ts`). Интерактивные элементы включают
 * `pointer-events: auto` точечно и гасят всплытие, чтобы палец на кнопке не
 * считался одновременно рулением.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
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

/** Сколько миллисекунд висит вспышка смены главы. */
const CHAPTER_FLASH_MS = 2400;

/**
 * Имена глав неба — ровно те слои, что включает `Sky` (см. docs/GAME.md).
 * Номер главы растёт бесконечно, имя берётся по модулю, как и в самой сцене.
 */
const CHAPTER_NAMES = ["метеоры", "туманность", "воронка", "чистое небо"] as const;

/** Сколько жизней рисуем слотами. Совпадает с `LIVES` в движке. */
const LIFE_SLOTS = [0, 1, 2] as const;

/**
 * Габарит значка жизни. Одинаков у целой и потерянной — строка не должна дёргаться.
 * Нижняя граница подобрана так, чтобы на 390 px плашка жизней не наехала на
 * шестизначный счёт слева: там между колонками остаётся всего пара десятков px.
 */
const LIFE_BOX = { width: "clamp(24px, 6.2vw, 34px)", height: "auto", display: "block" } as const;

/* Крыша с задним стеклом. Контур намеренно не замкнут: заливка закроет его сама,
   а обводке потерянной жизни лишняя линия по верху корпуса только мешала бы. */
const LIFE_ROOF = "M9 9.2 10.9 4.4C11.3 3.2 12 2.7 13.1 2.7h3.8c1.1 0 1.8.5 2.2 1.7L21 9.2";

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
 */
const LifeGlyph = memo(function LifeGlyph({ lost, tint }: { lost: boolean; tint: string }) {
  if (lost) {
    return (
      <svg
        viewBox="0 0 30 22"
        style={LIFE_BOX}
        aria-hidden="true"
        fill="none"
        stroke="rgba(186,210,242,0.32)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <path d={LIFE_ROOF} />
        <rect x="3.4" y="9" width="23.2" height="7.8" rx="2.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 30 22" style={LIFE_BOX} aria-hidden="true">
      {/* колёса — тот же тон, приглушённый: силуэт «стоит», а не висит */}
      <g fill={tint} opacity="0.45">
        <rect x="5.6" y="15.8" width="5.4" height="3.4" rx="1.4" />
        <rect x="19" y="15.8" width="5.4" height="3.4" rx="1.4" />
      </g>
      <g fill={tint}>
        <path d={LIFE_ROOF} />
        <rect x="2.6" y="8.6" width="24.8" height="8.2" rx="2.6" />
      </g>
      {/* номерной знак — тёмный вырез, он и делает силуэт «машиной сзади» */}
      <rect
        x="12.4"
        y="11.2"
        width="5.2"
        height="3"
        rx="0.9"
        fill={COLORS.night0}
        opacity="0.85"
      />
      {/* стопы. Тёмная обводка держит их читаемыми и когда корпус сам красный */}
      <g fill={COLORS.tail} stroke={COLORS.night0} strokeWidth="0.9">
        <rect x="4.6" y="10.6" width="6.4" height="3.6" rx="1.4" />
        <rect x="19" y="10.6" width="6.4" height="3.6" rx="1.4" />
      </g>
    </svg>
  );
});

const PauseIcon = memo(function PauseIcon({ paused }: { paused: boolean }) {
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
});

const SoundIcon = memo(function SoundIcon({ muted }: { muted: boolean }) {
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
});

/* ---------- компонент ---------- */

export function Hud({ g, snap, onPause, onMute, touch }: HudProps) {
  // Единственное чтение `g` вне rAF — и то один раз, ленивым инициализатором
  // состояния: дальше рендер живёт только на `snap`, как и договаривались.
  const [calm] = useState(() => g.reducedMotion);
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

  /* --- потеря жизни: короткий «удар» по индикатору --- */
  const [hitKey, setHitKey] = useState(0);
  const prevLivesRef = useRef(snap.lives);
  useEffect(() => {
    const prev = prevLivesRef.current;
    prevLivesRef.current = snap.lives;
    // Рестарт возвращает жизни вверх — это не удар, анимацию не гоняем.
    if (snap.lives < prev) setHitKey((k) => k + 1);
  }, [snap.lives]);

  /* --- смена главы: момент, а не постоянный показатель --- */
  const [chapterFlash, setChapterFlash] = useState(-1);
  const prevChapterRef = useRef(snap.chapter);
  useEffect(() => {
    const prev = prevChapterRef.current;
    prevChapterRef.current = snap.chapter;
    if (snap.chapter !== prev) setChapterFlash(snap.chapter);
  }, [snap.chapter]);

  // Отдельный эффект под таймер: иначе его сбрасывала бы любая другая зависимость,
  // и вспышка залипала бы на экране навсегда.
  useEffect(() => {
    if (chapterFlash < 0) return;
    const id = window.setTimeout(() => setChapterFlash(-1), CHAPTER_FLASH_MS);
    return () => window.clearTimeout(id);
  }, [chapterFlash]);

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
    // В меню, на паузе и на экране конца ничего не течёт: ни нитро, ни руль.
    // Держать ради этого 60 колбэков в секунду незачем.
    if (!playing) return;

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
        // Только opacity: её крутит композитор. Фильтр brightness стоил бы
        // отдельного прохода по слою на каждом изменении, а разницы не видно.
        // −1 — «нитро выключено», полоса на полной непрозрачности.
        let q = -1;
        if (g.nitroActive) {
          const pulse = calm ? 0.7 : 0.5 + 0.5 * Math.sin(now * 0.013);
          q = Math.round(pulse * 6) / 6;
        }
        if (q !== lastPulseRef.current) {
          lastPulseRef.current = q;
          bar.style.opacity = q < 0 ? "1" : (0.6 + 0.4 * q).toFixed(2);
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
    return () => {
      cancelAnimationFrame(raf);
      // Снимаем пульс, иначе полоса застынет приглушённой на паузе.
      lastPulseRef.current = -1;
      const bar = fillRef.current;
      if (bar !== null) bar.style.opacity = "1";
    };
  }, [g, calm, playing]);

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

  /**
   * Отпускание. Висит и на `pointerleave`: если захват указателя не встал
   * (см. catch в `onZoneDown`), палец, ушедший за границу зоны, иначе оставил бы
   * руль выкрученным до упора навсегда. При живом захвате `pointerleave` до
   * отпускания не приходит, так что лишних срабатываний это не даёт.
   */
  const onZoneUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const st = steerRef.current;
      if (st.rightId !== e.pointerId && st.leftId !== e.pointerId) return;
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

  /** То же самое для педалей: `pointerleave` — страховка на случай сорванного захвата. */
  const onPedalUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const el = e.currentTarget;
    if (el.dataset.on !== "1") return;
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

        {/*
          Глава неба. Раньше она стояла постоянной плашкой под жизнями и отбирала
          у них и место, и внимание, хотя смысла несёт куда меньше: это событие, а
          не показатель. Теперь — короткая вспышка в тихом углу, на смене главы и
          с именем слоя, который в этот момент включается в небе. Стоит последней
          в колонке, поэтому её появление ничего не двигает.
        */}
        <AnimatePresence initial={false} mode="wait">
          {playing && chapterFlash >= 0 && (
            <motion.div
              key={chapterFlash}
              initial={calm ? { opacity: 0 } : { opacity: 0, x: -12 }}
              animate={calm ? { opacity: 0.9 } : { opacity: 0.9, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: calm ? 0.16 : 0.42, ease: "easeOut" }}
              className="mt-2.5 whitespace-nowrap text-[10px] font-bold uppercase"
              style={{
                letterSpacing: "0.22em",
                color: COLORS.neon,
                textShadow: SHADOW_NEON,
              }}
            >
              глава <span className="tnum">{chapterFlash + 1}</span>
              <span style={{ opacity: 0.6 }}>
                {" · "}
                {CHAPTER_NAMES[chapterFlash % CHAPTER_NAMES.length]}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ------ центр: жизни ------ */}
      <div
        className="absolute left-1/2 top-3 -translate-x-1/2 transition-opacity duration-300 sm:top-4"
        style={statsStyle}
        aria-hidden={idle}
      >
        {/*
          Тёмная плашка обязательна: над этим местом проходят и блик-звезда, и
          туманность, и на светлом небе одни только силуэты тонут.
          Ключ по `hitKey` перемонтирует строку и переигрывает «удар» — потеря
          жизни должна быть видна, даже если смотреть на дорогу.
        */}
        <motion.div
          key={hitKey}
          initial={calm ? { opacity: 0.45 } : { opacity: 0.5, scale: 1.28 }}
          animate={calm ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          transition={
            calm
              ? { duration: 0.18 }
              : { type: "spring", stiffness: 520, damping: 17, mass: 0.6 }
          }
          role="img"
          aria-label={`жизни: ${snap.lives} из ${LIFE_SLOTS.length}`}
          className="flex items-center rounded-full"
          style={{
            gap: "clamp(3px, 1vw, 7px)",
            padding: "5px clamp(7px, 2vw, 11px)",
            background: "rgba(4,8,26,0.55)",
            // Ореол делаем box-shadow, а не drop-shadow: тот же вид, но без
            // фильтра, то есть без отдельного слоя на каждый значок.
            boxShadow: lastLife
              ? "inset 0 0 0 1px rgba(255,74,58,0.5), 0 0 18px rgba(255,74,58,0.35)"
              : "inset 0 0 0 1px rgba(94,203,255,0.24), 0 0 16px rgba(4,8,26,0.85)",
          }}
        >
          {LIFE_SLOTS.map((i) => (
            <LifeGlyph key={i} lost={snap.lives <= i} tint={lifeTint} />
          ))}
        </motion.div>
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
              // Без backdrop-filter: он пересчитывает размытие подложки в каждом
              // кадре живого canvas — на мобильном это заметная цена за эффект,
              // которого на почти чёрном небе всё равно не видно.
              background: "rgba(7,13,30,0.8)",
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
              background: "rgba(7,13,30,0.8)",
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
            onPointerLeave={onZoneUp}
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
            onPointerLeave={onZoneUp}
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
              onPointerLeave={onPedalUp}
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
              onPointerLeave={onPedalUp}
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
