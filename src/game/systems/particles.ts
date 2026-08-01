/**
 * Частицы «Starry Ride»: искры, обломки и пыль — один слой, один материал.
 *
 * Три вида живут в общем пуле и рисуются одним `THREE.Points`:
 *
 *   1. **искры от задира** — машину прижало к отбойнику, движок прислал `scrape`;
 *      горсть янтарных искр отлетает внутрь дороги, дугой уходит назад и гаснет
 *      за полсекунды. До этого задир только тряс камеру и шуршал в динамике;
 *   2. **сноп при аварии** — то же, но ярче, короче и с несколькими медленными
 *      угольками, которые ещё секунду тлеют, уплывая назад;
 *   3. **пыль с обочины** — очень слабый непрерывный снос, пока `offPavement(g.x)`
 *      больше нуля. Это визуальная пара к шуршанию покрышек, которое уже звучит.
 *
 * Три решения, на которых всё держится.
 *
 * **Мир едет мимо камеры.** Частица не «приклеена» к машине: сразу после
 * рождения её продольная скорость через `damp` тянется к `g.speed` — то есть к
 * скорости, с которой мимо камеры уезжает асфальт. Искра рождается почти
 * неподвижной относительно капота и на глазах отстаёт, как и положено тому, что
 * уже осталось позади.
 *
 * **Живые частицы упакованы в начало буфера.** Смерть — это обмен слота с
 * последним живым и `live -= 1`; `setDrawRange(0, live)` не даёт видеокарте
 * обрабатывать мёртвые вершины, а при пустом пуле объект просто невидим и не
 * стоит ни одного вызова отрисовки. Аддитивный блендинг не зависит от порядка,
 * поэтому перестановка слотов ничего не портит.
 *
 * **Ни одной текстуры и ни одной аллокации.** Форма спрайта считается во
 * фрагментном шейдере из `gl_PointCoord`: одна варьирующая «мягкость» превращает
 * тугую точку искры в размытый ком пыли, поэтому обоим хватает одного материала.
 * Все типизированные массивы выделены при сборке, в кадре только записи в них.
 *
 * Качество: на 0 система не создаёт вообще ничего и выходит из `update` первой
 * строкой; на 1 живут искры (пул вдвое меньше); пыль — непрерывный источник, и
 * поэтому она только на 2.
 */

import * as THREE from "three";

import { COLORS, PHYS, ROAD } from "../config";
import type { RenderCtx, System } from "../ctx";
import { clamp01, damp } from "../num";
import { offPavement } from "../road";
import { mulberry32 } from "../rng";
import type { Game, Phase, Quality } from "../types";

/* ---------- размеры пула и порции ---------- */

/** Ёмкость пула по качеству. На 0 частиц нет вовсе. */
const POOL: Record<Quality, number> = { 0: 0, 1: 130, 2: 280 };
/** Сколько искр в одном задире. */
const N_SCRAPE: Record<Quality, number> = { 0: 0, 1: 12, 2: 22 };
/** Сколько искр в аварии. */
const N_CRASH: Record<Quality, number> = { 0: 0, 1: 24, 2: 46 };
/** Сколько медленных угольков в аварии. */
const N_EMBER: Record<Quality, number> = { 0: 0, 1: 4, 2: 8 };
/** Пылинок в секунду при полном сходе на обочину и полной скорости. */
const DUST_RATE = 20;

/**
 * Свой антидребезг задира: прижатая к отбойнику машина не должна сыпать искрами
 * каждый кадр. Чуть короче движковых 0.25 с намеренно — иначе наш таймер мог бы
 * на пару миллисекунд не успеть и проглотить каждое второе настоящее событие.
 */
const SCRAPE_GAP = 0.22;
/** Порог по |x|, с которого считаем, что машина скребёт отбойник. */
const SCRAPE_EDGE = ROAD.railX - 0.38;
/** Пауза после снопа, чтобы событие и смена фазы не дали два снопа подряд. */
const CRASH_GAP = 0.35;

/* ---------- виды и их поведение ---------- */

const SPARK = 0;
const EMBER = 1;
const DUST = 2;

/** Вертикальное ускорение по виду, м/с². */
const GRAV = [-15, -1.7, -0.12] as const;
/** Скорость, с которой продольная скорость догоняет уезжающий мир, 1/с. */
const DRAG_Z = [2.4, 1.5, 3.4] as const;
/** Затухание боковой (и для несобственно баллистических — вертикальной) скорости, 1/с. */
const DRAG_X = [1.1, 0.6, 1.6] as const;
/** Мягкость спрайта: 0 — тугая искра, 1 — размытый ком. */
const SOFT = [0, 0.35, 1] as const;

/** Уровень асфальта, ниже которого частица отскакивает или замирает, м. */
const GROUND_Y = 0.03;

/** Порядок отрисовки: выше всего, что есть в сцене (максимум там — 11). */
const RENDER_ORDER = 14;

/* ---------- шейдер ---------- */

const VERT = /* glsl */ `
attribute vec3 aColor;
// x — диаметр в метрах, y — непрозрачность 0…1, z — мягкость спрайта
attribute vec3 aPar;
uniform float uPx;
uniform float uMaxPx;
varying vec3 vCol;
varying float vA;
varying float vSoft;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(0.25, -mv.z);
  vCol = aColor;
  // Подлетевшую вплотную частицу гасим: один спрайт пыли у самого объектива
  // иначе заливает половину кадра.
  vA = aPar.y * smoothstep(0.4, 2.0, d);
  vSoft = aPar.z;
  gl_PointSize = clamp(uPx * aPar.x / d, 1.0, uMaxPx);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
varying float vSoft;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 >= 1.0) discard;
  float f = 1.0 - r2;
  float f2 = f * f;
  // Тугое ядро для искры, широкий гауссоподобный ком для пыли — без текстуры
  // и без pow: два умножения и смешивание.
  float a = vA * mix(f2 * f, f2 * f2, vSoft);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol, a);
  #include <colorspace_fragment>
}
`;

/* ---------- палитра в линейном пространстве ---------- */

/**
 * `THREE.Color` из `#rrggbb` уже переводит sRGB в рабочее линейное пространство,
 * поэтому компоненты можно складывать и умножать как яркости. Раскладываем один
 * раз при сборке: в кадре нужны только числа.
 */
function linear(hex: string, out: Float32Array): Float32Array {
  const c = new THREE.Color(hex);
  out[0] = c.r;
  out[1] = c.g;
  out[2] = c.b;
  return out;
}

/* ---------- система ---------- */

export function createParticles(ctx: RenderCtx): System {
  const quality = ctx.quality;
  const n = POOL[quality];

  // Качество 0: ни геометрии, ни материала, ни объекта в сцене.
  if (n === 0) {
    return {
      update() {
        /* на «экономно» частиц нет */
      },
      dispose() {
        /* нечего освобождать */
      },
    };
  }

  /* --- буферы: всё выделено здесь и больше нигде --- */

  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const par = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const age = new Float32Array(n);
  const lif = new Float32Array(n);
  /** Базовый диаметр, м. */
  const sz0 = new Float32Array(n);
  /** Пиковая непрозрачность. */
  const op0 = new Float32Array(n);
  const knd = new Uint8Array(n);

  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3);
  const aCol = new THREE.BufferAttribute(col, 3);
  const aPar = new THREE.BufferAttribute(par, 3);
  aPos.setUsage(THREE.DynamicDrawUsage);
  aCol.setUsage(THREE.DynamicDrawUsage);
  aPar.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", aPos);
  geo.setAttribute("aColor", aCol);
  geo.setAttribute("aPar", aPar);
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPx: { value: 400 },
      uMaxPx: { value: 120 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });

  const points = new THREE.Points(geo, mat);
  points.name = "particles";
  // Частицы всегда в паре десятков метров от камеры, а границы буфера меняются
  // каждый кадр: считать их заново дороже, чем всегда рисовать 280 точек.
  points.frustumCulled = false;
  points.renderOrder = RENDER_ORDER;
  points.visible = false;

  /* --- цвета --- */

  const C_HOT = linear(COLORS.headWarm, new Float32Array(3));
  const C_AMBER = linear(COLORS.railStud, new Float32Array(3));
  const C_RED = linear(COLORS.tail, new Float32Array(3));
  const C_DUST = linear(COLORS.markSide, new Float32Array(3));

  /* --- состояние --- */

  /** Сколько слотов занято. Живые всегда лежат подряд с начала буфера. */
  let live = 0;
  /** Секунды до следующего разрешённого задира. */
  let scrapeCool = 0;
  /** Секунды до следующего разрешённого снопа. */
  let crashCool = 0;
  /** Накопитель дробных пылинок. */
  let dustAcc = 0;
  let prevPhase: Phase = "menu";
  let prevRuns = -1;
  /**
   * Первый кадр объект показан с пустым диапазоном отрисовки. Это не украшение:
   * `setProgram` вызывается до проверки числа вершин, поэтому шейдер собирается
   * на старте, а не в момент первой аварии — иначе именно там был бы рывок.
   */
  let warm = true;

  // Поток случайных чисел: замыкание создано один раз, вызов ничего не выделяет.
  // Заезд от него не зависит — искры на детерминизм симуляции не влияют.
  const rnd = mulberry32(0x5c1f7a3b);

  /* --- пул --- */

  /** Занять слот. −1, если пул полон: лишнюю искру честнее потерять, чем растить буфер. */
  function alloc(): number {
    return live < n ? live++ : -1;
  }

  /** Убить слот обменом с последним живым. Порядок аддитивному блендингу безразличен. */
  function kill(i: number): void {
    live -= 1;
    if (i === live) return;
    const a = i * 3;
    const b = live * 3;
    pos[a] = pos[b];
    pos[a + 1] = pos[b + 1];
    pos[a + 2] = pos[b + 2];
    vel[a] = vel[b];
    vel[a + 1] = vel[b + 1];
    vel[a + 2] = vel[b + 2];
    col[a] = col[b];
    col[a + 1] = col[b + 1];
    col[a + 2] = col[b + 2];
    par[a] = par[b];
    par[a + 1] = par[b + 1];
    par[a + 2] = par[b + 2];
    age[i] = age[live];
    lif[i] = lif[live];
    sz0[i] = sz0[live];
    op0[i] = op0[live];
    knd[i] = knd[live];
  }

  /* --- рождение --- */

  /**
   * Общая часть всех трёх видов. Цвет приходит как смесь двух заготовок: `tint`
   * — доля второй, `bright` — множитель яркости. Значения выше единицы попадают
   * в bloom, ниже 0.8 — просто светятся.
   */
  function emit(
    kind: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    opacity: number,
    ca: Float32Array,
    cb: Float32Array,
    tint: number,
    bright: number,
  ): void {
    const i = alloc();
    if (i < 0) return;
    const a = i * 3;
    pos[a] = x;
    pos[a + 1] = y;
    pos[a + 2] = z;
    vel[a] = vx;
    vel[a + 1] = vy;
    vel[a + 2] = vz;
    col[a] = (ca[0] + (cb[0] - ca[0]) * tint) * bright;
    col[a + 1] = (ca[1] + (cb[1] - ca[1]) * tint) * bright;
    col[a + 2] = (ca[2] + (cb[2] - ca[2]) * tint) * bright;
    par[a] = size;
    par[a + 1] = 0;
    par[a + 2] = SOFT[kind];
    age[i] = 0;
    lif[i] = life;
    sz0[i] = size;
    op0[i] = opacity;
    knd[i] = kind;
  }

  /**
   * Сноп от задира. `force` 0…1 — доля от `PHYS.speedMax`.
   *
   * Отбойник стоит на `±ROAD.railX`, камера — в нуле и уже сдвинута на `g.x`,
   * поэтому в локальных координатах точка касания находится на
   * `side * railX − g.x`: при прижатой машине это примерно 0.35 м вбок. Искры
   * рождаются впереди, на 4.5…11 м, — ближе их закрывает кабина, дальше они
   * сливаются с горизонтом.
   */
  function burstScrape(g: Game, force: number, count: number, calm: boolean): void {
    const side = g.x >= 0 ? 1 : -1;
    const rx = side * ROAD.railX - g.x;
    const f = 0.35 + 0.65 * force;
    const m = calm ? 0.5 : 1;
    for (let j = 0; j < count; j++) {
      emit(
        SPARK,
        rx + (rnd() - 0.5) * 0.14,
        0.4 + rnd() * 0.34,
        -(4.5 + rnd() * 6.5),
        // Внутрь дороги: искра отскакивает от отбойника, а не пронзает его.
        -side * (0.7 + rnd() * 3.2 * f) * m,
        (0.7 + rnd() * 3 * f) * m,
        (1.2 + rnd() * 6 * f) * m,
        (0.34 + rnd() * 0.3) * (calm ? 1.25 : 1),
        0.07 + rnd() * 0.055,
        1,
        C_HOT,
        C_AMBER,
        0.35 + rnd() * 0.65,
        (0.72 + 0.45 * f * rnd()) * (calm ? 0.75 : 1),
      );
    }
  }

  /** Сноп при аварии: ярче и короче, плюс несколько долго тлеющих угольков. */
  function burstCrash(impact: number, calm: boolean): void {
    const f = clamp01(impact / 70);
    const m = calm ? 0.5 : 1;
    const sparks = Math.round(N_CRASH[quality] * (calm ? 0.5 : 1) * (0.55 + 0.45 * f));
    for (let j = 0; j < sparks; j++) {
      emit(
        SPARK,
        (rnd() - 0.5) * 2.2,
        0.45 + rnd() * 0.9,
        -(4.8 + rnd() * 3.6),
        (rnd() - 0.5) * 12 * m,
        (0.5 + rnd() * 5.5) * m,
        (rnd() - 0.35) * 9 * m,
        (0.22 + rnd() * 0.26) * (calm ? 1.3 : 1),
        0.08 + rnd() * 0.07,
        1,
        C_HOT,
        C_AMBER,
        rnd() * 0.8,
        (0.95 + 0.55 * rnd() * (0.4 + 0.6 * f)) * (calm ? 0.7 : 1),
      );
    }
    const embers = Math.round(N_EMBER[quality] * (calm ? 0.5 : 1));
    for (let j = 0; j < embers; j++) {
      emit(
        EMBER,
        (rnd() - 0.5) * 3,
        0.5 + rnd() * 1.1,
        -(4.5 + rnd() * 4),
        (rnd() - 0.5) * 2.4 * m,
        (0.3 + rnd() * 1.4) * m,
        (rnd() - 0.5) * 2 * m,
        1.2 + rnd() * 1,
        0.11 + rnd() * 0.06,
        0.85,
        C_AMBER,
        C_RED,
        0.3 + rnd() * 0.7,
        (0.3 + rnd() * 0.24) * (calm ? 0.75 : 1),
      );
    }
  }

  /**
   * Одна пылинка с обочины. Холодная, почти прозрачная и крупная: на настоящем
   * экране её видно как лёгкое помутнение у колеса, а не как облако.
   */
  function emitDust(g: Game, calm: boolean): void {
    const side = g.x >= 0 ? 1 : -1;
    emit(
      DUST,
      side * (0.35 + rnd() * 1.25),
      0.05 + rnd() * 0.2,
      -(3.6 + rnd() * 6),
      side * (0.15 + rnd() * 0.6),
      (0.45 + rnd() * 1.2) * (calm ? 0.6 : 1),
      (rnd() - 0.6) * 2.5,
      0.85 + rnd() * 0.7,
      0.45 + rnd() * 0.55,
      0.75 + rnd() * 0.25,
      C_DUST,
      C_DUST,
      0,
      // Яркость подобрана так, чтобы центр кома был примерно вдвое светлее
      // асфальта под ним, и не ярче: пыль должна угадываться, а не клубиться.
      0.017 + rnd() * 0.014,
    );
  }

  /* --- кадр --- */

  function update(g: Game, dt: number, c: RenderCtx): void {
    // Новый заезд — пул чистый: искры от прошлой аварии не должны висеть в кадре.
    if (g.runs !== prevRuns) {
      prevRuns = g.runs;
      live = 0;
      dustAcc = 0;
      scrapeCool = 0;
      crashCool = 0;
    }

    const calm = g.reducedMotion;
    const playing = g.phase === "playing";
    const paused = g.phase === "paused";

    if (scrapeCool > 0) scrapeCool -= dt;
    if (crashCool > 0) crashCool -= dt;

    /* 1. События. Очередь чужая: читаем и не трогаем — её чистит main.ts. */
    let wantScrape = 0;
    let wantCrash = -1;
    const evs = g.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.type === "scrape") wantScrape = Math.max(wantScrape, e.value ?? 0.5);
      else if (e.type === "crash") wantCrash = Math.max(wantCrash, e.value ?? 40);
    }
    // Запасной путь на случай, если очередь вычерпали раньше нас: задир виден по
    // прижатому к отбойнику `x`, авария — по переходу фазы. Оба пути идут через
    // один и тот же антидребезг, поэтому двух снопов подряд не будет.
    if (wantScrape === 0 && playing && Math.abs(g.x) >= SCRAPE_EDGE) {
      wantScrape = clamp01(g.speed / PHYS.speedMax);
    }
    if (wantCrash < 0 && g.phase === "crashed" && prevPhase !== "crashed") wantCrash = 40;
    prevPhase = g.phase;

    if (wantScrape > 0 && scrapeCool <= 0 && (playing || g.phase === "crashed")) {
      scrapeCool = SCRAPE_GAP;
      burstScrape(g, wantScrape, Math.round(N_SCRAPE[quality] * (calm ? 0.5 : 1)), calm);
    }
    if (wantCrash >= 0 && crashCool <= 0) {
      crashCool = CRASH_GAP;
      burstCrash(wantCrash, calm);
    }

    /* 2. Пыль с обочины — только на «красиво»: это единственный непрерывный источник. */
    if (quality === 2 && playing) {
      const off = offPavement(g.x);
      if (off > 0.02) {
        dustAcc +=
          DUST_RATE *
          clamp01(off / ROAD.shoulder) *
          clamp01(g.speed / 30) *
          (calm ? 0.55 : 1) *
          dt;
        // Больше четырёх пылинок за кадр не выпускаем: при просадке частоты
        // накопитель иначе выплюнет весь пул разом.
        let emitN = dustAcc | 0;
        if (emitN > 4) emitN = 4;
        dustAcc -= emitN;
        for (let j = 0; j < emitN; j++) emitDust(g, calm);
      } else {
        dustAcc = 0;
      }
    }

    /* 3. Интегрирование. На паузе мир стоит — частицы тоже. */
    if (!paused && live > 0) {
      // Асфальт уезжает назад со скоростью `g.speed` и вбок со скоростью `−g.vx`:
      // к этому и стремится частица, отставая от машины.
      const windZ = g.speed;
      const windX = -g.vx;
      for (let i = 0; i < live; ) {
        const t = (age[i] += dt);
        const l = lif[i];
        if (t >= l) {
          kill(i);
          continue;
        }
        const k = knd[i];
        const a = i * 3;

        vel[a + 1] += GRAV[k] * dt;
        vel[a] = damp(vel[a], windX, DRAG_X[k], dt);
        vel[a + 2] = damp(vel[a + 2], windZ, DRAG_Z[k], dt);
        // Искра летит баллистически, у пыли и уголька вертикаль тоже вязнет.
        if (k !== SPARK) vel[a + 1] = damp(vel[a + 1], 0, DRAG_X[k], dt);

        pos[a] += vel[a] * dt;
        pos[a + 1] += vel[a + 1] * dt;
        pos[a + 2] += vel[a + 2] * dt;

        if (pos[a + 1] < GROUND_Y && vel[a + 1] < 0) {
          pos[a + 1] = GROUND_Y;
          if (k === SPARK && !calm && vel[a + 1] < -1.2) {
            // Отскок от асфальта — половина обаяния задира. Стоит части жизни,
            // иначе искры скачут дольше, чем горят.
            vel[a + 1] = -vel[a + 1] * 0.32;
            vel[a] *= 0.55;
            age[i] = t + l * 0.16;
          } else {
            vel[a + 1] = 0;
          }
        }

        const u = t / l;
        const fade = 1 - u;
        if (k === DUST) {
          // Плавно проявиться и так же уйти: резкое включение читается как мусор.
          par[a] = sz0[i] * (0.7 + 0.85 * u);
          par[a + 1] = op0[i] * 4 * u * fade;
        } else {
          par[a] = sz0[i] * (0.58 + 0.42 * fade);
          par[a + 1] = op0[i] * fade * fade;
        }
        i += 1;
      }
    }

    /* 4. Выгрузка. Пустой пул не стоит ни одного вызова отрисовки. */
    const shown = live > 0;
    points.visible = shown || warm;
    warm = false;
    if (shown) {
      geo.setDrawRange(0, live);
      aPos.needsUpdate = true;
      aCol.needsUpdate = true;
      aPar.needsUpdate = true;
      // Размер точки в пикселях: половина высоты буфера, умноженная на
      // projectionMatrix[1][1]. Берём из камеры каждый кадр — FOV раскрывается
      // на нитро, и константа тут разъехалась бы с картинкой.
      const hPx = c.size.h * c.size.dpr;
      mat.uniforms.uPx.value = 0.5 * hPx * c.camera.projectionMatrix.elements[5];
      mat.uniforms.uMaxPx.value = hPx * 0.18;
    }
  }

  return {
    object: points,
    update,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
