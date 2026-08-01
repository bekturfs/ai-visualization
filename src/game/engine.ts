/**
 * Симуляция «Starry Ride»: продольная и боковая физика, столкновения, near-miss,
 * бонусы, очки, главы неба и обратная связь для камеры.
 *
 * Ни React, ни THREE: файл можно запустить в тесте на голом node. Всё живое
 * состояние — один мутируемый `Game`, который создаётся ровно один раз; `step`
 * не создаёт ни одного объекта, кроме событий (они ограничены сверху).
 *
 * Зависимость от генератора мира вывернута наизнанку: движок не импортирует
 * `worldGen`, а вызывает хук, который ему кто-то зарегистрировал через
 * `setWorldHook`. Так ни один модуль игры не зависит от другого.
 */

import type { Car, Game, GameEventType, HudSnapshot, Pickup, Quality } from "./types";
import {
  BOX,
  CAM,
  LIMITS,
  NITRO,
  PHYS,
  PICKUPS,
  ROAD,
  SCORE,
  SKY,
  STORE,
  TRAFFIC,
} from "./config";
import { clamp, clamp01, damp, decayTo0, lerp, smoothstep } from "./num";
import { offPavement, roadCurv, roadHeading } from "./road";

/* ---------- локальные константы движка ---------- */

/** Больше этого шага не считаем: возврат на вкладку не должен телепортировать заезд. */
const MAX_DT = 1 / 20;
/** Жизней на заезд (GAME.md: три). В config их нет — это правило режима, не тюнинг. */
const LIVES = 3;
/** Стартовый запас нитро: первое ускорение должно быть доступно сразу. */
const START_NITRO = 0.4;
/** Неуязвимость в первые секунды заезда, с. */
const START_INVULN = 1.2;
/** Ниже этого в «playing» не опускаемся: заезд не должен встать намертво. */
const MIN_SPEED = 7;
/** Нижний предел скорости в состоянии «crashed». */
const MIN_SPEED_CRASH = 5;
/** Насколько сильно «жмём тормоз» за игрока, пока идёт авария. */
const CRASH_BRAKE = 0.5;
/** Доля разгона, работающая без газа: газ только «поддаёт», аркада едет сама. */
const THROTTLE_FLOOR = 0.62;
/** Ширина зоны подхода к потолку скорости, м/с: в ней разгон гаснет. */
const SPEED_APPROACH = 10;
/** Снос наружу поворота: м/с² на (кривизна × скорость²). */
const CORNER_PULL = 0.14;
/** Довесок к курсу камеры от руля, рад на единицу руля. */
const YAW_PER_STEER = 0.045;
/** Скорости сглаживания камеры, 1/с. */
const YAW_RATE = 3.4;
const ROLL_RATE = 5.5;
/** Затухание тряски и вспышки, единиц в секунду. */
const SHAKE_DECAY = 1.9;
const FLASH_DECAY = 2.6;
/** Тряска от задира об отбойник и от near-miss (соседняя полоса случается часто —
 * толчок должен читаться как «вжух», а не как постоянная болтанка). */
const SCRAPE_SHAKE = 0.42;
const NEARMISS_SHAKE = 0.1;
const NEARMISS_SHAKE_ONCOMING = 0.18;
/** Минимальный интервал между событиями «scrape», с (≈4 в секунду). */
const SCRAPE_GAP = 0.25;
/** Вспышка удара, когда включён режим «меньше движения». */
const FLASH_CALM = 0.3;
/** Скорость набега фазы покачивания машин трафика, рад/с. */
const CAR_WOBBLE_RATE = 1.7;
/** Потолок очереди событий: потребитель, забывший её вычерпать, не должен течь. */
const EVENT_CAP = 32;

/* ---------- хук генератора мира ---------- */

let worldHook: ((g: Game) => void) | null = null;

/**
 * Зарегистрировать функцию заселения мира (в проекте это `ensureWorld` из
 * `worldGen`). Вызывается интегратором один раз; `null` снимает хук.
 */
export function setWorldHook(fn: ((g: Game) => void) | null): void {
  worldHook = fn;
}

/**
 * Ограничитель частоты события «scrape», по значению на каждую игру. Живёт снаружи
 * контракта `Game`, чтобы не расширять тип ради одной служебной цифры, и в WeakMap,
 * чтобы две одновременные игры не мешали друг другу и ничего не утекало.
 */
const scrapeGate = new WeakMap<Game, number>();

/* ---------- события ---------- */

function push(g: Game, type: GameEventType, value?: number): void {
  g.events.push({ type, value });
  if (g.events.length > EVENT_CAP) g.events.shift();
}

/* ---------- создание и сброс ---------- */

/**
 * Собрать игру со всеми пулами сразу: дальше ни одна машина и ни один бонус не
 * аллоцируются, слоты только переиспользуются.
 *
 * Функция ничего не читает из окружения — `best`, `muted`, `quality` и
 * `reducedMotion` передаёт вызывающий (он один знает про localStorage и
 * media-query). Это делает её пригодной для юнит-теста.
 */
export function createGame(opts?: {
  seed?: number;
  quality?: Quality;
  muted?: boolean;
  best?: number;
  reducedMotion?: boolean;
}): Game {
  const seed = (opts?.seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;

  const cars: Car[] = new Array<Car>(LIMITS.cars);
  for (let i = 0; i < LIMITS.cars; i++) {
    cars[i] = {
      id: 0,
      active: false,
      s: 0,
      lane: 0,
      speed: 0,
      oncoming: false,
      kind: 0,
      wobble: 0,
      scored: false,
    };
  }

  const pickups: Pickup[] = new Array<Pickup>(LIMITS.pickups);
  for (let i = 0; i < LIMITS.pickups; i++) {
    pickups[i] = { id: 0, active: false, taken: false, s: 0, lane: 0, kind: "star", spin: 0 };
  }

  return {
    phase: "menu",
    t: 0,
    runs: 0,

    s: 0,
    speed: 0,
    x: ROAD.laneCenters[0],
    vx: 0,
    steer: 0,
    // Камера сразу смотрит вдоль дороги, иначе первый кадр меню «доворачивает».
    yaw: -roadHeading(0) * CAM.headingFollow,
    roll: 0,
    bob: 0,

    nitro: START_NITRO,
    nitroActive: false,
    lives: LIVES,
    score: 0,
    best: Math.max(0, Math.floor(opts?.best ?? 0)),
    combo: 0,
    comboTimer: 0,
    multiplier: 1,
    stars: 0,

    shake: 0,
    flash: 0,
    crashTimer: 0,
    invuln: 0,

    chapter: 0,
    chapterT: 0,

    input: { steer: 0, throttle: 1, brake: 0, nitro: false },
    cars,
    pickups,
    events: [],

    acc: 0,

    seed,
    quality: opts?.quality ?? 1,
    reducedMotion: opts?.reducedMotion ?? false,
    muted: opts?.muted ?? false,
    spawnCursor: 0,
    pickupCursor: 0,
    nextId: 1,
  };
}

/**
 * Полный сброс заезда. Сохраняются только «настройки сессии»: рекорд, качество,
 * звук, режим меньшего движения и счётчик заездов.
 *
 * Из «playing» — no-op (случайный вызов не должен обнулить живой заезд); из меню,
 * паузы, аварии и экрана конца — стартует новый.
 */
export function startRun(g: Game): void {
  if (g.phase === "playing") return;

  g.runs += 1;
  // Пересев: детерминированно от прошлого сида и номера заезда — сессия
  // воспроизводима целиком, но два заезда подряд не совпадают.
  g.seed = (Math.imul(g.seed ^ 0x9e3779b9, 0x85ebca6b) + g.runs) >>> 0;

  g.phase = "playing";
  g.t = 0;

  g.s = 0;
  g.speed = PHYS.speedStart;
  g.x = ROAD.laneCenters[0];
  g.vx = 0;
  g.steer = 0;
  g.yaw = -roadHeading(0) * CAM.headingFollow;
  g.roll = 0;
  g.bob = 0;

  g.nitro = START_NITRO;
  g.nitroActive = false;
  g.lives = LIVES;
  g.score = 0;
  g.combo = 0;
  g.comboTimer = 0;
  g.multiplier = 1;
  g.stars = 0;

  g.shake = 0;
  g.flash = 0;
  g.crashTimer = 0;
  g.invuln = START_INVULN;

  g.chapter = 0;
  g.chapterT = 0;

  for (let i = 0; i < g.cars.length; i++) {
    const c = g.cars[i];
    c.active = false;
    c.scored = false;
  }
  for (let i = 0; i < g.pickups.length; i++) {
    const p = g.pickups[i];
    p.active = false;
    p.taken = false;
  }

  // Первые метры оставляем пустыми: игрок должен успеть понять, где он.
  g.spawnCursor = TRAFFIC.gapStart;
  g.pickupCursor = PICKUPS.gap[0];
  g.nextId = 1;

  g.acc = 0;
  g.events.length = 0;
  scrapeGate.set(g, 0);
  push(g, "start");
}

/** «playing» ⇄ «paused». В остальных фазах ничего не делает. */
export function togglePause(g: Game): void {
  if (g.phase === "playing") g.phase = "paused";
  else if (g.phase === "paused") g.phase = "playing";
}

/* ---------- шаг симуляции ---------- */

/** Шаг симуляции, одинаковый на любом мониторе. */
const FIXED_DT = 1 / 120;
/** Больше шести подшагов за кадр не считаем: MAX_DT их столько и покрывает. */
const MAX_SUBSTEPS = 6;

/**
 * Кадр снаружи. Внутри симуляция всегда идёт шагами по `FIXED_DT`, а остаток
 * копится до следующего раза.
 *
 * Так сделано не из любви к порядку. Скорость интегрируется явным Эйлером, и в
 * ней есть квадратичное сопротивление — при разной длине шага получается разный
 * результат. Замер `npm run soak` на пятиминутном заезде: 30 Гц давали 16784 м,
 * 240 Гц — 16440 м, расхождение 2 %. То есть на мониторе 30 Гц игрок проезжал
 * дальше и набирал больше очков за то же время. С фиксированным шагом обе
 * частоты считают ровно одно и то же.
 */
export function step(g: Game, dt: number): void {
  if (!(dt > 0)) return;
  if (g.phase !== "playing" && g.phase !== "crashed") {
    // На паузе и в меню долг не копим, иначе после снятия паузы симуляция
    // рванёт навёрстывать простой.
    g.acc = 0;
    return;
  }
  if (dt > MAX_DT) dt = MAX_DT;
  g.acc += dt;
  let n = 0;
  while (g.acc >= FIXED_DT && n < MAX_SUBSTEPS) {
    stepFixed(g, FIXED_DT);
    g.acc -= FIXED_DT;
    n++;
    if (g.phase !== "playing" && g.phase !== "crashed") {
      g.acc = 0;
      return;
    }
  }
  if (n >= MAX_SUBSTEPS) g.acc = 0;
}

/**
 * Один шаг симуляции. Порядок разделов важен: скорость считается до продвижения
 * по дороге, мир заселяется до движения трафика, трафик двигается до столкновений.
 */
function stepFixed(g: Game, dt: number): void {
  /* 1. Защита от прыжка времени и фазовый фильтр. */
  if (!(dt > 0)) return;
  if (dt > MAX_DT) dt = MAX_DT;
  if (g.phase !== "playing" && g.phase !== "crashed") return;

  if (g.phase === "crashed") {
    g.crashTimer -= dt;
    if (g.crashTimer <= 0) {
      g.crashTimer = 0;
      if (g.lives <= 0) {
        g.phase = "over";
        g.nitroActive = false;
        push(g, "over", Math.floor(g.score));
        return;
      }
      // Жизни ещё есть — доигрываем этот кадр уже как обычный.
      g.phase = "playing";
    }
  }
  const crashed = g.phase === "crashed";

  /* 2. Время и ввод. В аварии руль и газ у игрока отобраны. */
  g.t += dt;
  const steerIn = crashed ? 0 : clamp(g.input.steer, -1, 1);
  const throttle = crashed ? 0 : clamp01(g.input.throttle);
  const brake = crashed ? CRASH_BRAKE : clamp01(g.input.brake);
  const wantNitro = !crashed && g.input.nitro;

  /* 3. Нитро. Считается до продольной динамики: оно входит и в потолок, и в разгон. */
  const wasNitro = g.nitroActive;
  if (!g.nitroActive && wantNitro && g.nitro > NITRO.minToFire) g.nitroActive = true;
  if (g.nitroActive) {
    g.nitro -= NITRO.drain * dt;
    if (g.nitro <= 0) {
      g.nitro = 0;
      g.nitroActive = false;
    } else if (!wantNitro) {
      g.nitroActive = false;
    }
  } else {
    g.nitro = clamp01(g.nitro + NITRO.regen * dt);
  }
  if (g.nitroActive !== wasNitro) push(g, g.nitroActive ? "nitro-on" : "nitro-off");

  /* 4. Продольная динамика.
   *
   * Потолок растёт с дистанцией, нитро его приподнимает. Тяга подобрана так, чтобы
   * равновесие с квадратичным сопротивлением приходилось ровно на потолок: иначе
   * drag (0.0016·v² — почти 10 м/с² на 78 м/с) съел бы весь разгон и до speedMax
   * заезд не добрался бы никогда. Разгон гаснет в зоне SPEED_APPROACH, чтобы
   * подход к потолку был мягким, а не срезанным клампом.
   */
  const ramp = smoothstep(0, PHYS.rampDistance, g.s);
  const top =
    PHYS.speedStart +
    (PHYS.speedMax - PHYS.speedStart) * ramp +
    (g.nitroActive ? PHYS.nitroBoost : 0);

  let v = g.speed;
  // accelNitro в config — именно добавка к базовому разгону, а не замена.
  const accel = (PHYS.accel + (g.nitroActive ? PHYS.accelNitro : 0)) * lerp(THROTTLE_FLOOR, 1, throttle);
  const approach = clamp01((top - v) / SPEED_APPROACH);
  const off = offPavement(g.x);
  const offK = clamp01(off / ROAD.shoulder);

  v +=
    (PHYS.drag * top * top - PHYS.drag * v * v +
      accel * approach -
      PHYS.brakeDecel * brake -
      PHYS.offroadDrag * offK) *
    dt;

  /* 5. Боковая динамика. Руль тяжелеет со скоростью, дорога сносит наружу поворота. */
  const steerPower = Math.max(PHYS.steerAccelMin, PHYS.steerAccel - PHYS.steerHeavy * v);
  g.vx += steerIn * steerPower * dt;
  // roadCurv > 0 — дорога загибается в +x (вправо), центробежная сила тянет влево.
  g.vx -= roadCurv(g.s) * v * v * CORNER_PULL * dt;
  g.vx = damp(g.vx, 0, PHYS.vxDamp, dt);
  g.x += g.vx * dt;

  const limX = ROAD.railX - 0.35;
  if (g.x > limX || g.x < -limX) {
    g.x = g.x > 0 ? limX : -limX;
    g.vx = 0;
    if (!g.reducedMotion && g.shake < SCRAPE_SHAKE) g.shake = SCRAPE_SHAKE;
    // Не чаще ~4 раз в секунду, иначе звук превращается в пулемёт. К этому же
    // такту привязана и потеря скорости: если снимать scrapeLoss каждый кадр,
    // прижатая к отбойнику машина теряет 12% шестьдесят раз в секунду и мгновенно
    // встаёт. Раз в 0.25 с — это ощутимые ~40% в секунду, но заезд продолжается.
    const gate = scrapeGate.get(g) ?? 0;
    if (g.t >= gate) {
      scrapeGate.set(g, g.t + SCRAPE_GAP);
      v *= 1 - PHYS.scrapeLoss;
      push(g, "scrape", clamp01(v / PHYS.speedMax));
    }
  }

  if (v < (crashed ? MIN_SPEED_CRASH : MIN_SPEED)) v = crashed ? MIN_SPEED_CRASH : MIN_SPEED;
  const vMax = PHYS.speedMax + PHYS.nitroBoost + 6;
  if (v > vMax) v = vMax;
  g.speed = v;

  /* 6. Графика руля и продвижение по дороге. */
  g.steer = damp(g.steer, steerIn, PHYS.steerSmooth, dt);
  g.s += v * dt;
  g.bob += v * CAM.bobRate * dt;

  /* 7. Заселение мира (worldGen через хук — движок его не импортирует). */
  if (worldHook) worldHook(g);

  /* 8. Движение трафика. */
  for (let i = 0; i < g.cars.length; i++) {
    const c = g.cars[i];
    if (!c.active) continue;
    c.s += c.speed * dt;
    c.wobble += dt * CAR_WOBBLE_RATE;
  }

  /* 9. Столкновения и near-miss.
   *
   * Проверка «заметающая»: на встречке скорость сближения доходит до 120 м/с, и при
   * dt = 1/20 машина за кадр проскакивает мимо длиннее собственного габарита. Поэтому
   * пересечение по дистанции считается не по текущему кадру, а по отрезку между
   * прошлым и нынешним положением — тоннелировать сквозь фуру нельзя.
   */
  if (!crashed) {
    for (let i = 0; i < g.cars.length; i++) {
      const c = g.cars[i];
      if (!c.active) continue;

      const rel = c.s - g.s;
      const closing = v - c.speed;
      const relPrev = rel + closing * dt;
      // Далёкие машины отсекаем сразу, не считая габаритов.
      if (rel > 120 || rel < -120) continue;

      const box = BOX.cars[c.kind];
      // Зазор считаем между бортами, а не между осями: TRAFFIC.nearMissGap — это
      // именно просвет. По осям окно near-miss выродилось бы в 26 см для седана,
      // а для фуры (hw 1.32) стало бы отрицательным — рядом с фурой пронестись
      // было бы физически нельзя, только врезаться.
      const clearance = Math.abs(c.lane - g.x) - (BOX.player.hw + box.hw);
      const hitLat = clearance < 0;
      const lonLimit = BOX.player.hl + box.hl;
      const crossed = rel <= 0 ? relPrev > 0 : relPrev <= 0;
      const hitLon = crossed || (rel < lonLimit && rel > -lonLimit);

      if (hitLon && hitLat) {
        if (g.invuln > 0) {
          // Прошли «сквозь» на неуязвимости: ни удара, ни награды.
          c.scored = true;
          continue;
        }
        const impact = Math.abs(closing);
        g.lives -= 1;
        v *= 1 - PHYS.crashLoss;
        if (v < MIN_SPEED_CRASH) v = MIN_SPEED_CRASH;
        g.speed = v;
        g.phase = "crashed";
        g.crashTimer = PHYS.crashTime;
        g.invuln = PHYS.invulnTime;
        g.shake = g.reducedMotion ? 0 : 1;
        g.flash = g.reducedMotion ? FLASH_CALM : 1;
        g.combo = 0;
        g.comboTimer = 0;
        c.active = false;
        // value — скорость сближения, м/с: лобовой удар звучит и трясёт сильнее попутного.
        push(g, "crash", impact);
        break;
      }

      if (crossed && !c.scored) {
        c.scored = true;
        if (clearance < TRAFFIC.nearMissGap) {
          g.combo += 1;
          g.comboTimer = SCORE.comboWindow;
          g.nitro = clamp01(g.nitro + NITRO.fromNearMiss);
          g.score += SCORE.nearMiss * Math.min(g.combo, SCORE.comboCap);
          const kick = c.oncoming ? NEARMISS_SHAKE_ONCOMING : NEARMISS_SHAKE;
          if (!g.reducedMotion && g.shake < kick) g.shake = kick;
          push(g, "nearmiss", g.combo);
        }
      }
    }
  }

  /* 10. Бонусы. Окно подбора тоже заметающее — на 280 км/ч звезда не должна
   * проскакивать между кадрами. */
  if (g.phase === "playing") {
    for (let i = 0; i < g.pickups.length; i++) {
      const p = g.pickups[i];
      if (!p.active || p.taken) continue;
      const ds = p.s - g.s;
      if (ds > PICKUPS.grabS) continue;
      if (ds + v * dt < -PICKUPS.grabS) continue;
      if (Math.abs(p.lane - g.x) > PICKUPS.grabLane) continue;

      p.taken = true;
      if (p.kind === "star") {
        g.stars += 1;
        g.score += SCORE.star;
        g.nitro = clamp01(g.nitro + NITRO.fromStar);
        push(g, "pickup-star", SCORE.star);
      } else {
        g.nitro = clamp01(g.nitro + NITRO.fromCan);
        push(g, "pickup-nitro", NITRO.fromCan);
      }
    }
  }

  /* 11. Очки и множитель. */
  g.score += SCORE.perMeter * v * dt * g.multiplier;
  if (g.comboTimer > 0) {
    g.comboTimer -= dt;
    if (g.comboTimer <= 0) {
      g.comboTimer = 0;
      g.combo = 0;
    }
  }
  g.multiplier =
    1 + Math.min(g.combo, SCORE.comboCap) * SCORE.comboMul + (v / PHYS.speedMax) * SCORE.speedMul;
  const scoreInt = Math.floor(g.score);
  if (scoreInt > g.best) g.best = scoreInt;

  /* 12. Главы неба: копим дистанцию в chapterT, на переполнении переносим остаток. */
  const chapLen = SKY.chapters[g.chapter % SKY.chapters.length];
  let chapDist = g.chapterT * chapLen + v * dt;
  if (chapDist >= chapLen) {
    chapDist -= chapLen;
    g.chapter += 1;
    push(g, "chapter", g.chapter);
  }
  g.chapterT = clamp01(chapDist / SKY.chapters[g.chapter % SKY.chapters.length]);

  /* 13. Камера.
   *
   * Знак курса. Точка впереди проецируется в localX = roadX(s) − roadX(camS) + …,
   * значит на правом повороте (roadX растёт с s, roadHeading > 0) дорога уезжает в +x.
   * Камера смотрит в −Z, и поворот вокруг Y на угол θ уводит взгляд в
   * (−sin θ, 0, −cos θ): при θ > 0 — влево. Чтобы смотреть вправо, yaw должен быть
   * отрицательным — отсюда минус перед roadHeading, и дорога остаётся в центре кадра.
   * По той же причине минус и перед steer: руль вправо — взгляд ведём в поворот,
   * а не против него.
   */
  const yawTo = -roadHeading(g.s) * CAM.headingFollow - g.steer * YAW_PER_STEER;
  g.yaw = damp(g.yaw, yawTo, YAW_RATE, dt);
  g.roll = damp(g.roll, -g.steer * CAM.rollPerSteer, ROLL_RATE, dt);

  g.shake = g.reducedMotion ? 0 : decayTo0(g.shake, SHAKE_DECAY, dt);
  g.flash = decayTo0(g.flash, g.reducedMotion ? FLASH_DECAY * 2 : FLASH_DECAY, dt);
  if (g.invuln > 0) g.invuln = decayTo0(g.invuln, 1, dt);

  /* 14. Страховка очереди событий (push уже режет её, но фаза «over» могла добавить). */
  while (g.events.length > EVENT_CAP) g.events.shift();
}

/* ---------- наружу ---------- */

/**
 * Снимок для HUD. Аллоцирует объект — поэтому его зовут ~12 раз в секунду из
 * React-таймера, а не из кадра.
 */
export function snapshot(g: Game): HudSnapshot {
  return {
    phase: g.phase,
    speedKmh: g.speed * 3.6,
    score: Math.floor(g.score),
    best: Math.floor(g.best),
    lives: g.lives,
    nitro: clamp01(g.nitro),
    combo: g.combo,
    multiplier: g.multiplier,
    distance: g.s,
    stars: g.stars,
    chapter: g.chapter,
    muted: g.muted,
  };
}

/** Записать рекорд в localStorage. Единственное место в движке, знающее про хранилище. */
export function commitBest(g: Game): number {
  const best = Math.max(0, Math.floor(g.best));
  g.best = best;
  try {
    localStorage.setItem(STORE.best, String(best));
  } catch {
    // Приватный режим, отключённые куки, переполненная квота — рекорд просто не переживёт сессию.
  }
  return best;
}
