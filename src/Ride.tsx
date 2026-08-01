/**
 * «Starry Ride» — ночной заезд. Сборка страницы: Canvas, цикл кадра, оверлеи.
 *
 * Здесь и только здесь модули игры знакомятся друг с другом. Сами они друг о
 * друге не знают (см. docs/GAME.md): worldGen подключается к engine через хук,
 * генераторы декораций приходят в сцену пропсами, ввод и звук живут в ref.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";

import { CAM, COLORS, QUALITY, STORE } from "./game/config";
import type { Game, HudSnapshot, Quality } from "./game/types";
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
import { Screens } from "./game/ui/Screens";

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

/* ---------- цикл кадра ---------- */

/**
 * Единственное место, где двигается время. Стоит первым ребёнком Canvas, чтобы
 * подписаться на useFrame раньше сцены: тогда в одном кадре сначала считается
 * физика, а потом сцена рисует уже свежее состояние.
 */
function Loop({ g, audio }: { g: Game; audio: { current: RideAudio | null } }) {
  useFrame((_, dt) => {
    step(g, dt);
    audio.current?.update(g, dt);
    // Очередь событий разбирают все желающие в этом же кадре, а чистит её тот,
    // кто ей владеет, — то есть страница.
    if (g.events.length) g.events.length = 0;
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
  const [quality, setQuality] = useState<Quality>(stored.quality);
  const [showHelp, setShowHelp] = useState(false);

  /* --- worldGen подключается к engine --- */
  useEffect(() => {
    setWorldHook(ensureWorld);
    return () => setWorldHook(null);
  }, []);

  /* --- звук создаётся только после первого жеста (политика автоплея) --- */
  const wakeAudio = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = createAudio();
      audioRef.current.setMuted(g.muted);
    }
    void audioRef.current.resume();
  }, [g]);

  /* --- действия, общие для клавиш и кнопок --- */
  const doStart = useCallback(() => {
    if (g.phase !== "menu" && g.phase !== "over") return;
    wakeAudio();
    startRun(g);
    resetWorld(g);
    setSnap(snapshot(g));
  }, [g, wakeAudio]);

  const doRestart = useCallback(() => {
    wakeAudio();
    startRun(g);
    resetWorld(g);
    setSnap(snapshot(g));
  }, [g, wakeAudio]);

  const doPause = useCallback(() => {
    togglePause(g);
    setSnap(snapshot(g));
  }, [g]);

  const doMute = useCallback(() => {
    g.muted = !g.muted;
    audioRef.current?.setMuted(g.muted);
    writeStore(STORE.muted, g.muted ? "1" : "0");
    setSnap(snapshot(g));
  }, [g]);

  const doQuality = useCallback(
    (q: Quality) => {
      g.quality = q;
      setQuality(q);
      writeStore(STORE.quality, String(q));
    },
    [g],
  );

  const doMenu = useCallback(() => {
    g.phase = "menu";
    setSnap(snapshot(g));
  }, [g]);

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
    let lastPhase = g.phase;
    const id = setInterval(() => {
      if (g.phase === "over" && lastPhase !== "over") {
        const best = commitBest(g);
        writeStore(STORE.best, String(best));
      }
      lastPhase = g.phase;
      setSnap(snapshot(g));
    }, 84);
    return () => clearInterval(id);
  }, [g]);

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

  const preset = QUALITY[quality];
  const touch = useMemo(
    () => ({
      steer: (v: number) => setTouchSteer(g, v),
      button: (b: "throttle" | "brake" | "nitro", down: boolean) =>
        setTouchButton(g, b, down),
    }),
    [g],
  );

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 overflow-hidden bg-black select-none"
      style={{ touchAction: "none" }}
    >
      <Canvas
        dpr={[1, preset.dprMax]}
        gl={{ antialias: false, alpha: false, powerPreference: "high-performance" }}
        camera={{ fov: CAM.fov, near: 0.3, far: 3600, position: [0, CAM.height, 0] }}
        onCreated={({ gl }) => gl.setClearColor(COLORS.night0)}
      >
        <Loop g={g} audio={audioRef} />
        <Rig g={g} />
        <Sky g={g} />
        <Terrain g={g} trees={forEachTree} ridge={ridgeHeight} />
        <Lights g={g} lamps={forEachLamp} town={forEachTownLight} />
        <Road g={g} />
        <Traffic g={g} />
        <Pickups g={g} />
        <Effects g={g} />
      </Canvas>

      <Dashboard g={g} />
      <Hud g={g} snap={snap} onPause={doPause} onMute={doMute} touch={touch} />
      <Screens
        snap={snap}
        quality={quality}
        showHelp={showHelp}
        onStart={doStart}
        onResume={doPause}
        onRestart={doRestart}
        onMenu={doMenu}
        onQuality={doQuality}
        onMute={doMute}
        onHelp={() => setShowHelp(true)}
        onExitHelp={() => setShowHelp(false)}
      />
    </div>
  );
}
