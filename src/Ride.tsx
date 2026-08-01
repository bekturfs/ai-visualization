/**
 * «Starry Ride» — ночной заезд. Сборка страницы: Canvas, цикл кадра, оверлеи.
 *
 * Здесь и только здесь модули игры знакомятся друг с другом. Сами они друг о
 * друге не знают (см. docs/GAME.md): worldGen подключается к engine через хук,
 * генераторы декораций приходят в сцену пропсами, ввод и звук живут в ref.
 *
 * Три правила, которые эта страница держит и которые легко сломать правкой:
 *
 * 1. `startRun` и `resetWorld` вызываются только парой и только в этом порядке
 *    (курсоры мира считаются от уже сброшенного `g.s`). Единственное место, где
 *    это написано, — `beginRun`; никто больше их не зовёт.
 * 2. `commitBest` срабатывает ровно один раз на закончившийся заезд. Сторож —
 *    номер заезда `g.runs`, а не «прошлая фаза» в замыкании таймера: таймер
 *    может не увидеть фазу `over` вовсе, если игрок нажал R быстрее, чем через
 *    84 мс, а после перемонтирования эффекта замыкание вообще начинается с нуля.
 * 3. Пока показан оверлей, всё под ним выключено атрибутом `inert` — ни мышью,
 *    ни Tab-ом до кнопок HUD и до канваса не добраться. Признак «оверлей
 *    показан» берётся из той же `overlayScreen`, по которой рисуется сам
 *    оверлей, иначе эти двое однажды разъедутся.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";

import { CAM, COLORS, QUALITY, STORE } from "./game/config";
import type { Game, HudSnapshot, Phase, Quality } from "./game/types";
import {
  commitBest,
  createGame,
  setWorldHook,
  snapshot,
  startRun,
  step,
  togglePause,
} from "./game/engine";
import { ensureWorld, forEachLamp, forEachTownLight, forEachTree, resetWorld, ridgeHeight } from "./game/worldGen";
import { bindInput, bindTouchSurface, setTouchButton, setTouchSteer } from "./game/input";
import { createAudio, type RideAudio } from "./game/audio";

import { Sky } from "./game/scene/Sky";
import { Road } from "./game/scene/Road";
import { Terrain } from "./game/scene/Terrain";
import { Lights } from "./game/scene/Lights";
import { Traffic } from "./game/scene/Traffic";
import { Pickups } from "./game/scene/Pickups";
import { Effects } from "./game/scene/Effects";
import { Rig } from "./game/scene/Rig";

import { Dashboard } from "./game/ui/Dashboard";
import { Hud } from "./game/ui/Hud";
import { Screens, overlayScreen } from "./game/ui/Screens";

/* ---------- сохранённые настройки ---------- */

function readStore(): { best: number; muted: boolean; quality: Quality } {
  const out = { best: 0, muted: false, quality: 1 as Quality };
  try {
    out.best = Number(localStorage.getItem(STORE.best)) || 0;
    out.muted = localStorage.getItem(STORE.muted) === "1";
    // Именно так, а не Number(...): getItem даёт null, а Number(null) === 0 —
    // и настройка «экономно» молча включалась бы всем при первом запуске.
    const raw = localStorage.getItem(STORE.quality);
    if (raw === "0" || raw === "1" || raw === "2") out.quality = Number(raw) as Quality;
  } catch {
    /* приватный режим — играем с настройками по умолчанию */
  }
  return out;
}

function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* игнорируем: не сохранить настройку не повод ломать заезд */
  }
}

/* ---------- снимок для HUD ---------- */

/**
 * Снимки сравниваем по значению и не публикуем одинаковые. Пока игра стоит
 * (меню, пауза, конец заезда) в `Game` не меняется ничего — а раньше React
 * перерисовывал HUD и открытый диалог двенадцать раз в секунду просто потому,
 * что `snapshot()` каждый раз возвращает новый объект. Именно в эти моменты на
 * экране висит полноэкранное размытие подложки, так что перерисовка была самой
 * дорогой ровно тогда, когда она не нужна вовсе.
 */
function sameSnap(a: HudSnapshot, b: HudSnapshot): boolean {
  return (
    a.phase === b.phase &&
    a.speedKmh === b.speedKmh &&
    a.score === b.score &&
    a.best === b.best &&
    a.lives === b.lives &&
    a.nitro === b.nitro &&
    a.combo === b.combo &&
    a.multiplier === b.multiplier &&
    a.distance === b.distance &&
    a.stars === b.stars &&
    a.chapter === b.chapter &&
    a.muted === b.muted
  );
}

/* ---------- цикл кадра ---------- */

/**
 * Единственное место, где двигается время. Стоит первым ребёнком Canvas, чтобы
 * подписаться на useFrame раньше сцены: тогда в одном кадре сначала считается
 * физика, а потом сцена рисует уже свежее состояние.
 *
 * Он же — единственный, кто видит смену фазы в тот же кадр, когда она случилась.
 * Фазу меняет не только кнопка: `crashed` и `over` рождаются внутри `step`, и
 * если ждать тика таймера, экран конца заезда опаздывает на восемьдесят
 * миллисекунд, а рекорд может не записаться вовсе.
 */
function Loop({
  g,
  audio,
  onPhase,
}: {
  g: Game;
  audio: { current: RideAudio | null };
  onPhase: () => void;
}) {
  const seen = useRef<Phase>(g.phase);
  useFrame((_, dt) => {
    step(g, dt);
    audio.current?.update(g, dt);
    // Очередь событий разбирают все желающие в этом же кадре, а чистит её тот,
    // кто ей владеет, — то есть страница.
    if (g.events.length) g.events.length = 0;
    if (g.phase !== seen.current) {
      seen.current = g.phase;
      onPhase();
    }
  });
  return null;
}

/* ---------- страница ---------- */

export default function Ride() {
  const stored = useMemo(readStore, []);
  const wrapRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<RideAudio | null>(null);

  const reducedMotion = useMemo(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Игра создаётся один раз и живёт в ref: её мутируют 60 раз в секунду, и React
  // об этом знать не должен.
  const gameRef = useRef<Game | null>(null);
  if (gameRef.current === null) {
    gameRef.current = createGame({
      best: stored.best,
      muted: stored.muted,
      quality: stored.quality,
      reducedMotion,
    });
  }
  const g = gameRef.current;

  const [snap, setSnap] = useState<HudSnapshot>(() => snapshot(g));
  // Источник правды по качеству — сама игра: сцена читает `g.quality`, а меню
  // подсвечивает пресет по этому состоянию. Инициализация из `g`, а не из
  // `stored`, чтобы подсветка не могла показывать одно, а сцена рисовать другое.
  const [quality, setQuality] = useState<Quality>(() => g.quality);
  const [showHelp, setShowHelp] = useState(false);
  // Рекорд до текущего заезда: движок поднимает `g.best` прямо в кадре, поэтому
  // к концу заезда «что было побито» знает только страница.
  const [prevBest, setPrevBest] = useState<number>(() => Math.floor(g.best));

  /* Справка живёт и в состоянии (её рисуют), и в ref (её читают обработчики
     ввода) — так все колбэки остаются стабильными и не переподписывают
     клавиатуру на каждое открытие панели. */
  const helpRef = useRef(false);
  const setHelp = useCallback((v: boolean) => {
    helpRef.current = v;
    setShowHelp(v);
  }, []);

  /* --- worldGen подключается к engine --- */
  useEffect(() => {
    setWorldHook(ensureWorld);
    return () => setWorldHook(null);
  }, []);

  /* --- публикация снимка --- */
  const pushSnap = useCallback(() => {
    const next = snapshot(g);
    setSnap((prev) => (sameSnap(prev, next) ? prev : next));
  }, [g]);

  /* --- звук создаётся только после первого жеста (политика автоплея) --- */
  const wakeAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = createAudio();
      audioRef.current.setMuted(g.muted);
    }
    // resume() гасит свои ошибки внутри, но обещание всё равно нельзя ронять
    // «в никуда»: непойманный reject — это console error, а на нём падает
    // проверочный прогон.
    void audioRef.current.resume().catch(() => {});
  }, [g]);

  /* --- рекорд: ровно одна запись на закончившийся заезд --- */
  const committedRun = useRef(-1);
  const commitIfOver = useCallback(() => {
    if (g.phase !== "over") return;
    if (committedRun.current === g.runs) return;
    committedRun.current = g.runs;
    // commitBest сам пишет в localStorage — второй раз ту же строку не пишем.
    commitBest(g);
  }, [g]);

  /* --- действия, общие для клавиш и кнопок --- */

  /** Единственное место, где начинается заезд. Пара `startRun` + `resetWorld`. */
  const beginRun = useCallback(() => {
    // Предыдущий заезд закрываем ДО сброса: `startRun` обнуляет счёт.
    commitIfOver();
    wakeAudio();
    setHelp(false);
    setPrevBest(Math.floor(g.best));
    startRun(g);
    resetWorld(g);
    pushSnap();
  }, [g, commitIfOver, wakeAudio, setHelp, pushSnap]);

  const doStart = useCallback(() => {
    if (g.phase !== "menu" && g.phase !== "over") return;
    beginRun();
  }, [g, beginRun]);

  const doRestart = useCallback(() => {
    // Из «playing» — не рестартуем. `startRun` в этой фазе сам ничего не делает,
    // и раньше сюда доезжал только `resetWorld`: заезд продолжался, но дорога
    // молча пустела. Заново — из паузы, аварии, меню и экрана конца (R там и
    // обещан); случайная R посреди заезда чужой рекорд не убьёт.
    if (g.phase === "playing") return;
    beginRun();
  }, [g, beginRun]);

  const doPause = useCallback(() => {
    // Esc при открытой справке закрывает справку, а не снимает паузу: иначе
    // заезд поехал бы под панелью управления, которая перекрывает весь экран.
    if (helpRef.current) {
      setHelp(false);
      return;
    }
    togglePause(g);
    pushSnap();
  }, [g, setHelp, pushSnap]);

  const doMute = useCallback(() => {
    g.muted = !g.muted;
    audioRef.current?.setMuted(g.muted);
    writeStore(STORE.muted, g.muted ? "1" : "0");
    pushSnap();
  }, [g, pushSnap]);

  const doQuality = useCallback(
    (q: Quality) => {
      g.quality = q;
      setQuality(q);
      writeStore(STORE.quality, String(q));
    },
    [g],
  );

  const doMenu = useCallback(() => {
    // Движок «меню» не умеет — фазу выставляет страница, она же владелец режима.
    commitIfOver();
    setHelp(false);
    g.phase = "menu";
    pushSnap();
  }, [g, commitIfOver, setHelp, pushSnap]);

  const doHelp = useCallback(() => setHelp(true), [setHelp]);
  const doExitHelp = useCallback(() => setHelp(false), [setHelp]);

  /* Смена фазы изнутри кадра: авария, возврат в заезд, конец. */
  const onPhaseChange = useCallback(() => {
    commitIfOver();
    pushSnap();
  }, [commitIfOver, pushSnap]);

  /* --- ввод --- */
  useEffect(() => {
    const off = bindInput(g, {
      onPause: doPause,
      onRestart: doRestart,
      onMute: doMute,
      onStart: doStart,
      onFirstGesture: wakeAudio,
    });
    return off;
  }, [g, doPause, doRestart, doMute, doStart, wakeAudio]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    return bindTouchSurface(g, el);
  }, [g]);

  /* --- снимок для HUD: 12 раз в секунду, не 60 --- */
  useEffect(() => {
    const id = setInterval(() => {
      // Сторож по номеру заезда делает вызов идемпотентным: это страховка на
      // случай, если фаза как-то сменилась мимо кадра, а не второй путь записи.
      commitIfOver();
      pushSnap();
    }, 84);
    return () => clearInterval(id);
  }, [commitIfOver, pushSnap]);

  /* --- страница на весь экран, без прокрутки --- */
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.overflow;
    const prevBody = document.body.style.overflow;
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, []);

  /* --- ручка для Playwright и отладки --- */
  useEffect(() => {
    (globalThis as unknown as { __ride?: Game }).__ride = g;
    return () => {
      delete (globalThis as unknown as { __ride?: Game }).__ride;
    };
  }, [g]);

  /* --- звук выключается вместе со страницей --- */
  useEffect(
    () => () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    },
    [],
  );

  /* --- модальность: пока висит оверлей, под ним ничего не нажимается --- */
  const overlayOpen = overlayScreen(snap.phase, showHelp) !== null;

  /**
   * Оверлей закрылся — значит заезд поехал. Фокус в этот момент обязан уйти с
   * кнопок: останься он на кнопке паузы в HUD, и Space нажимал бы её вместо
   * нитро (`input.ts` намеренно отдаёт Space и Enter кнопке под фокусом).
   * Забирает фокус сама игровая поверхность, tabIndex −1 — в обход Tab.
   */
  useEffect(() => {
    if (overlayOpen) return;
    const el = wrapRef.current;
    if (el === null) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    el.focus({ preventScroll: true });
  }, [overlayOpen]);

  const touch = useMemo(
    () => ({
      steer: (v: number) => setTouchSteer(g, v),
      button: (b: "throttle" | "brake" | "nitro", down: boolean) =>
        setTouchButton(g, b, down),
    }),
    [g],
  );

  /**
   * Сцена собирается один раз. Страница перерисовывается на каждом снимке HUD, а
   * дерево r3f от снимка не зависит вовсе — без этого memo React сверял бы всю
   * сцену (и пересоздавал литералы `gl`/`camera`) двенадцать раз в секунду.
   * Зависимость от `quality` (а не от одного `dprMax`) намеренна: смена пресета
   * обязана дойти до каждого компонента сцены, а не только до плотности пикселей.
   */
  const scene = useMemo(
    () => (
      <Canvas
        dpr={[1, QUALITY[quality].dprMax]}
        gl={{ antialias: false, alpha: false, powerPreference: "high-performance" }}
        camera={{ fov: CAM.fov, near: 0.3, far: 3600, position: [0, CAM.height, 0] }}
        onCreated={({ gl }) => gl.setClearColor(COLORS.night0)}
      >
        <Loop g={g} audio={audioRef} onPhase={onPhaseChange} />
        <Rig g={g} />
        <Sky g={g} />
        <Terrain g={g} trees={forEachTree} ridge={ridgeHeight} />
        <Lights g={g} lamps={forEachLamp} town={forEachTownLight} />
        <Road g={g} />
        <Traffic g={g} />
        <Pickups g={g} />
        <Effects g={g} />
      </Canvas>
    ),
    [g, quality, onPhaseChange],
  );

  /* Приборка тоже не зависит от снимка: стрелки она крутит сама, из ref. От
     качества зависит — она включает по нему свои SVG-фильтры, — поэтому смена
     пресета её перерисовывает, а тик HUD больше нет. */
  const dashboard = useMemo(() => <Dashboard g={g} />, [g, quality]);

  return (
    <div
      ref={wrapRef}
      tabIndex={-1}
      className="fixed inset-0 overflow-hidden bg-black outline-none select-none"
      style={{ touchAction: "none" }}
    >
      {/* Всё, что оверлей обязан закрыть собой. `inert` — единственный способ
          убрать это и из попадания указателя, и из порядка обхода Tab, и из
          дерева доступности разом. `aria-hidden` рядом с ним — не украшение:
          инструменты, которые ищут элемент по роли и имени (в том числе тест
          на Playwright), inert моделируют не все, и кнопка «Продолжить заезд» в
          HUD снова стала бы находиться из-под открытого диалога. Пары
          «focusable внутри aria-hidden» здесь не возникает: inert уже вынес всё
          поддерево из порядка обхода. */}
      <div
        className="absolute inset-0"
        inert={overlayOpen || undefined}
        aria-hidden={overlayOpen || undefined}
      >
        {scene}
        {dashboard}
        <Hud g={g} snap={snap} onPause={doPause} onMute={doMute} touch={touch} />
      </div>

      <Screens
        snap={snap}
        quality={quality}
        prevBest={prevBest}
        showHelp={showHelp}
        onStart={doStart}
        onResume={doPause}
        onRestart={doRestart}
        onMenu={doMenu}
        onQuality={doQuality}
        onMute={doMute}
        onHelp={doHelp}
        onExitHelp={doExitHelp}
      />
    </div>
  );
}
