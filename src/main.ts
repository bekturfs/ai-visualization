/// <reference types="vite/client" />
/**
 * «Starry Ride» — точка входа и цикл кадра.
 *
 * Здесь и только здесь модули игры знакомятся друг с другом. Раньше эту роль
 * играл React-компонент страницы; теперь это обычная функция, и работы у неё
 * ровно столько же, сколько было у него: собрать рендерер, создать системы,
 * крутить кадры, раздать снимки интерфейсу и всё за собой убрать.
 *
 * Что осталось неизменным с версии на React и не должно меняться дальше:
 *
 *  1. Всё состояние — один мутируемый `Game`. Он не в сторе и не в сигналах.
 *  2. `startRun` и `resetWorld` вызываются только парой и только в этом порядке.
 *  3. `commitBest` срабатывает ровно один раз на закончившийся заезд; сторож —
 *     номер заезда, а не «прошлая фаза», потому что заезд можно начать заново
 *     быстрее, чем придёт следующий снимок.
 *  4. Пока открыт оверлей, всё под ним выключено атрибутом `inert` — ни мышью,
 *     ни Tab-ом до кнопок HUD и до холста не добраться.
 */

import * as THREE from "three";

import { CAM, COLORS, QUALITY, STORE } from "./game/config";
import type { RenderCtx, System } from "./game/ctx";
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
import {
  ensureWorld,
  forEachLamp,
  forEachTownLight,
  forEachTree,
  resetWorld,
  ridgeHeight,
} from "./game/worldGen";
import { bindInput, bindTouchSurface, setTouchButton, setTouchSteer } from "./game/input";
import { createAudio, type RideAudio } from "./game/audio";

import { createSky } from "./game/systems/sky";
import { createRoad } from "./game/systems/road";
import { createTerrain } from "./game/systems/terrain";
import { createLights } from "./game/systems/lights";
import { createTraffic } from "./game/systems/traffic";
import { createPickups } from "./game/systems/pickups";
import { createParticles } from "./game/systems/particles";
import { createRig } from "./game/systems/rig";
import { createEffects, type EffectsSystem } from "./game/systems/effects";

import { createDashboard } from "./game/ui/dashboard";
import { createHud } from "./game/ui/hud";
import { createScreens, overlayScreen } from "./game/ui/screens";

import "./index.css";

/* ---------- сохранённые настройки ---------- */

function readStore(): { best: number; muted: boolean; quality: Quality } {
  const out = { best: 0, muted: false, quality: 1 as Quality };
  try {
    out.best = Number(localStorage.getItem(STORE.best)) || 0;
    out.muted = localStorage.getItem(STORE.muted) === "1";
    // Именно сравнение со строкой: `getItem` отдаёт null, а `Number(null)` — ноль,
    // и качество «экономно» молча включалось бы всем при первом запуске.
    const raw = localStorage.getItem(STORE.quality);
    if (raw === "0" || raw === "1" || raw === "2") out.quality = Number(raw) as Quality;
  } catch {
    /* приватный режим — играем с настройками по умолчанию */
  }
  return out;
}

function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* не сохранить настройку — не повод ломать заезд */
  }
}

/* ---------- запуск ---------- */

const host = document.getElementById("root");
if (!host) throw new Error("нет #root");

const stored = readStore();
const reducedMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const g: Game = createGame({
  best: stored.best,
  muted: stored.muted,
  quality: stored.quality,
  reducedMotion,
});

setWorldHook(ensureWorld);

/* --- холст и рендерер --- */

const canvas = document.createElement("canvas");
canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
host.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false, // сглаживание делает SMAA внутри цепочки эффектов
  alpha: false,
  powerPreference: "high-performance",
  stencil: false,
});
renderer.setClearColor(COLORS.night0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.3, 3600);
camera.position.set(0, CAM.height, 0);

const ctx: RenderCtx = {
  renderer,
  scene,
  camera,
  size: { w: 1, h: 1, dpr: 1 },
  quality: g.quality,
};

/* --- интерфейс --- */

const ui = document.createElement("div");
ui.style.cssText = "position:absolute;inset:0;pointer-events:none";
host.appendChild(ui);

const audio: { current: RideAudio | null } = { current: null };

function wakeAudio(): void {
  try {
    if (!audio.current) audio.current = createAudio();
    audio.current.setMuted(g.muted);
    void audio.current.resume();
  } catch {
    // Звук — не причина не играть.
    audio.current = null;
  }
}

/** Заезд начинается только отсюда: пара `startRun` + `resetWorld` живёт в одном месте. */
function beginRun(): void {
  wakeAudio();
  prevBest = Math.floor(g.best);
  startRun(g);
  resetWorld(g);
  pushSnap();
}

let prevBest = Math.floor(g.best);
let showHelp = false;

const dashboard = createDashboard(ui);
const hud = createHud(ui, {
  onPause: () => {
    togglePause(g);
    pushSnap();
  },
  onMute: () => {
    g.muted = !g.muted;
    audio.current?.setMuted(g.muted);
    writeStore(STORE.muted, g.muted ? "1" : "0");
    pushSnap();
  },
  touch: {
    steer: (v) => setTouchSteer(g, v),
    button: (b, down) => setTouchButton(g, b, down),
  },
});
const screens = createScreens(ui, {
  onStart: () => {
    if (g.phase === "menu" || g.phase === "over") beginRun();
  },
  onResume: () => {
    togglePause(g);
    pushSnap();
  },
  onRestart: beginRun,
  onMenu: () => {
    g.phase = "menu";
    pushSnap();
  },
  onQuality: (q: Quality) => {
    if (q === g.quality) return;
    g.quality = q;
    writeStore(STORE.quality, String(q));
    rebuildSystems();
    pushSnap();
  },
  onMute: () => {
    g.muted = !g.muted;
    audio.current?.setMuted(g.muted);
    writeStore(STORE.muted, g.muted ? "1" : "0");
    pushSnap();
  },
  onHelp: () => {
    showHelp = true;
    pushSnap();
  },
  onExitHelp: () => {
    showHelp = false;
    pushSnap();
  },
  // Геттеры, а не копии: оверлей спрашивает состояние в момент отрисовки. Копия
  // однажды уже разъехалась с игрой — меню подсвечивало одно качество, а сцена
  // рисовала другое.
  quality: () => g.quality,
  showHelp: () => showHelp,
  prevBest: () => prevBest,
});

const overlays = [dashboard, hud, screens];

/* --- системы сцены --- */

let systems: System[] = [];
let effects: EffectsSystem | null = null;

/**
 * Пулы инстансов и число сегментов дороги берутся из пресета качества в момент
 * создания, поэтому смена качества — это пересоздание систем, а не подкрутка на
 * лету. Так проще и честнее, чем городить изменение размеров пулов.
 */
function buildSystems(): void {
  ctx.quality = g.quality;
  const fx = createEffects(ctx);
  effects = fx;
  systems = [
    createRig(ctx),
    createSky(ctx),
    createTerrain(ctx, { trees: forEachTree, ridge: ridgeHeight }),
    createLights(ctx, { lamps: forEachLamp, town: forEachTownLight }),
    createRoad(ctx),
    createTraffic(ctx),
    createPickups(ctx),
    // Искры и пыль — поверх трафика и бонусов: они аддитивные и должны ложиться
    // на уже нарисованное, а не под него.
    createParticles(ctx),
    fx,
  ];
  for (const s of systems) if (s.object) scene.add(s.object);
  // Тональную компрессию делает ToneMappingEffect внутри цепочки. Если оставить
  // её ещё и рендереру, кадр сожмётся дважды и выцветет.
  renderer.toneMapping = fx.active ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  applySize();
}

function disposeSystems(): void {
  for (const s of systems) {
    if (s.object) scene.remove(s.object);
    s.dispose();
  }
  systems = [];
  effects = null;
}

function rebuildSystems(): void {
  disposeSystems();
  buildSystems();
}

/* --- размер --- */

function applySize(): void {
  const w = Math.max(1, host!.clientWidth);
  const h = Math.max(1, host!.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, QUALITY[g.quality].dprMax);
  ctx.size.w = w;
  ctx.size.h = h;
  ctx.size.dpr = dpr;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  for (const s of systems) s.resize?.(ctx);
}

const ro = new ResizeObserver(() => applySize());
ro.observe(host);

buildSystems();

/* --- снимок для интерфейса --- */

let snap: HudSnapshot = snapshot(g);
let lastRunCommitted = -1;
let lastScreen = overlayScreen(g.phase, showHelp);

function pushSnap(): void {
  snap = snapshot(g);
  // Рекорд пишем ровно один раз на заезд: сторожим номером заезда, а не фазой.
  if (g.phase === "over" && lastRunCommitted !== g.runs) {
    lastRunCommitted = g.runs;
    writeStore(STORE.best, String(commitBest(g)));
    snap = snapshot(g);
  }
  for (const o of overlays) o.sync(snap);

  // Пока открыт диалог, всё под ним недоступно ни мышью, ни с клавиатуры.
  const screen = overlayScreen(g.phase, showHelp);
  if (screen !== lastScreen) {
    lastScreen = screen;
    const blocked = screen !== null;
    dashboard.el.inert = blocked;
    hud.el.inert = blocked;
    canvas.inert = blocked;
  }
}

const snapTimer = window.setInterval(pushSnap, 84);
pushSnap();

/* --- ввод --- */

const offInput = bindInput(g, {
  onPause: () => {
    togglePause(g);
    pushSnap();
  },
  onRestart: () => {
    if (g.phase !== "playing") beginRun();
  },
  onMute: () => {
    g.muted = !g.muted;
    audio.current?.setMuted(g.muted);
    writeStore(STORE.muted, g.muted ? "1" : "0");
    pushSnap();
  },
  onStart: () => {
    if (g.phase === "menu" || g.phase === "over") beginRun();
  },
  onFirstGesture: wakeAudio,
});
const offTouch = bindTouchSurface(g, host);

/* --- цикл --- */

/** Больше этого шага не пропускаем: возврат на вкладку не должен телепортировать заезд. */
const MAX_FRAME = 1 / 20;
let last = performance.now();
let raf = 0;

function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  dev?.begin();
  const dt = Math.min(MAX_FRAME, Math.max(0, (now - last) * 0.001));
  last = now;

  const phaseBefore = g.phase;
  step(g, dt);
  // Физика идёт строго после движка и до сцены: она читает уже посчитанное
  // состояние и дописывает к нему поведение кузова. Пока rapier не догрузился
  // (а он весит больше всей остальной сборки), её просто нет — и это нормально.
  physics?.update(g, dt);
  audio.current?.update(g, dt);
  // Очередь событий разбирают все желающие в этом же кадре, чистит её владелец.
  if (g.events.length) g.events.length = 0;
  // Фазу меняет и сам кадр: авария и конец заезда рождаются внутри `step`, и
  // ждать тика таймера здесь нельзя — экран опоздает, а рекорд может не записаться.
  if (g.phase !== phaseBefore) pushSnap();

  for (const s of systems) s.update(g, dt, ctx);
  for (const o of overlays) o.frame?.(g, dt);

  if (effects && effects.active) effects.render();
  else renderer.render(scene, camera);
  dev?.end();
}
raf = requestAnimationFrame(frame);

/* --- физика кузова: приезжает отдельным чанком и подключается на ходу --- */

let physics: import("./game/physics").CarPhysics | null = null;
void import("./game/physics").then(({ createPhysics }) =>
  createPhysics().then((p) => {
    physics = p;
  }),
);

/* --- панель настройки: только в разработке --- */

let dev: import("./game/devtools").DevTools | null = null;
if (import.meta.env.DEV) {
  void import("./game/devtools").then(({ createDevTools }) =>
    createDevTools(g, { rebuild: rebuildSystems }).then((d) => {
      dev = d;
    }),
  );
}

/* --- отладочная ручка для Playwright --- */

(globalThis as unknown as { __ride?: Game }).__ride = g;

/* --- уборка (важна для hot reload в dev) --- */

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    cancelAnimationFrame(raf);
    clearInterval(snapTimer);
    ro.disconnect();
    offInput();
    offTouch();
    for (const o of overlays) o.dispose();
    disposeSystems();
    physics?.dispose();
    audio.current?.dispose();
    renderer.dispose();
    host.replaceChildren();
  });
}
