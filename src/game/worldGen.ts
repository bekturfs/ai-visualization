/**
 * Процедурное содержимое мира. Две принципиально разные половины файла.
 *
 * 1. ДЕКОРАЦИИ (деревья, фонари, огни городка, силуэт хребта) — чистые функции
 *    от индекса ячейки. Ничего не хранится: любой модуль в любой кадр спрашивает
 *    «что стоит между s0 и s1» и получает один и тот же ответ, без всякой
 *    синхронизации между сценой, миникартой и звуком.
 *
 * 2. ТРАФИК И БОНУСЫ — состояние, живёт в пулах `Game`. Здесь только появление и
 *    исчезновение; движение, столкновения и очки — дело `engine.ts`.
 *
 * Аллокаций в кадре нет. Итераторы декораций переиспользуют один
 * модульный объект-черновик: колбэк ОБЯЗАН прочитать поля сразу и НЕ сохранять
 * ссылку — на следующей итерации те же поля будут перезаписаны.
 */

import type {
  Car,
  CarKind,
  Game,
  Lamp,
  Pickup,
  PickupKind,
  TownLight,
  Tree,
} from "./types";
import { LIMITS, PHYS, PICKUPS, ROAD, TRAFFIC } from "./config";
import { laneCenter } from "./road";
import { clamp, lerp, smoothstep } from "./num";
import { fbm1, hash1, hash2, hashInt, noise1, pick, range } from "./rng";

/* ==================================================================== */
/*  1. ДЕКОРАЦИИ — чистые функции от ячейки                             */
/* ==================================================================== */

/** Шаг сетки ячеек деревьев, м. */
export const TREE_CELL = 9;

/** Шаг сетки фонарей, м (с дрожанием даёт интервал ~70…110 м). */
const LAMP_CELL = 90;

/** Шаг сетки огней городка, м. */
const TOWN_CELL = 18;

/** Ближняя кромка лесополосы: заведомо за отбойником. */
const TREE_NEAR = ROAD.railX + 1.5;
/** Дальняя кромка лесополосы. */
const TREE_FAR = 34;

/**
 * Индексы цветов в `COLORS.town` с весами: в референсе городок в основном
 * тёплый, с редкими красными и совсем редкими бирюзовыми огнями.
 */
const TOWN_TINTS: readonly number[] = [0, 0, 0, 0, 0, 3, 3, 1, 1, 2];

/* Черновики: по одному на итератор, перезаписываются перед каждым cb. */
const treeOut: Tree = { s: 0, lane: 0, h: 0, v: 0 };
const lampOut: Lamp = { s: 0, side: 1 };
const townOut: TownLight = { s: 0, lane: 0, y: 0, tint: 0 };

/**
 * Деревья на обеих обочинах в диапазоне дистанций [s0, s1].
 *
 * Два ряда на каждую сторону: близкий (плотная стена у отбойника) и внешний
 * (редкие высокие силуэты). Плотность плывёт вдоль дороги через `fbm1`, поэтому
 * лес то смыкается коридором, то расходится прогалиной, открывая хребет.
 *
 * ВНИМАНИЕ: `cb` получает один и тот же объект каждый раз — не сохранять.
 */
export function forEachTree(s0: number, s1: number, cb: (t: Tree) => void): void {
  const c0 = Math.floor(s0 / TREE_CELL);
  const c1 = Math.floor(s1 / TREE_CELL);
  for (let c = c0; c <= c1; c++) {
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      // Ключ ячейки для хешей: сторона вплетена в индекс, а не в номер свойства.
      const key = c * 2 + k;
      // Крупномасштабная плотность: период ~18 ячеек ≈ 160 м.
      const dens = fbm1((c + (k === 0 ? 0 : 911)) * 0.055, 3);
      // Гладкая «линия кроны»: высоты соседних деревьев связаны, а не рваные.
      const wall = noise1(c * 0.11 + (k === 0 ? 5.3 : 31.7));
      for (let row = 0; row < 2; row++) {
        // Прореживание: где плотность низкая — ячейка пропускается целиком.
        const keep = row === 0 ? 0.34 + 0.62 * dens : 0.12 + 0.55 * dens;
        if (hash1(key * 3 + row * 977) > keep) continue;

        const s = c * TREE_CELL + range(hash2(key, row * 8 + 1), 0.6, TREE_CELL - 0.6);
        if (s < s0 || s > s1) continue;

        // Смещение: ближний ряд жмётся к отбойнику, внешний уходит вглубь.
        const u = row === 0
          ? range(hash2(key, row * 8 + 2), 0, 0.42)
          : range(hash2(key, row * 8 + 2), 0.38, 1);
        const off = TREE_NEAR + (TREE_FAR - TREE_NEAR) * Math.pow(u, 1.7);
        const deep = (off - TREE_NEAR) / (TREE_FAR - TREE_NEAR);

        treeOut.s = s;
        treeOut.lane = side * off;
        // Дальние деревья выше: строят силуэт стены, а не частокол.
        treeOut.h = clamp(
          lerp(4.5, 13, hash2(key, row * 8 + 3)) + 4 * deep + 3 * (wall - 0.5),
          4,
          17,
        );
        treeOut.v = hash2(key, row * 8 + 4);
        cb(treeOut);
      }
    }
  }
}

/**
 * Фонари на обочине в диапазоне [s0, s1]: редкие, стороны чередуются, но с
 * периодическими сбоями ритма — иначе читается как гребёнка.
 *
 * ВНИМАНИЕ: `cb` получает один и тот же объект каждый раз — не сохранять.
 */
export function forEachLamp(s0: number, s1: number, cb: (l: Lamp) => void): void {
  // Ячейка начинается раньше s0: дрожание может вынести фонарь назад в кадр.
  const c0 = Math.floor((s0 - LAMP_CELL) / LAMP_CELL);
  const c1 = Math.floor(s1 / LAMP_CELL);
  for (let c = c0; c <= c1; c++) {
    const s = c * LAMP_CELL + LAMP_CELL * 0.5 + range(hash2(c, 51), -10, 10);
    if (s < s0 || s > s1) continue;
    const alt: -1 | 1 = (c & 1) === 0 ? 1 : -1;
    const flip = hash2(c, 52) < 0.22;
    lampOut.s = s;
    lampOut.side = flip ? (alt === 1 ? -1 : 1) : alt;
    cb(lampOut);
  }
}

/**
 * Огни далёкого городка на склоне в диапазоне [s0, s1]. Целые участки дороги
 * гейтятся через `fbm1`: городок наплывает, разрастается и снова уходит в
 * темноту. Вся гроздь сидит на одной стороне — как в кадре референса.
 *
 * ВНИМАНИЕ: `cb` получает один и тот же объект каждый раз — не сохранять.
 */
export function forEachTownLight(
  s0: number,
  s1: number,
  cb: (t: TownLight) => void,
): void {
  const c0 = Math.floor(s0 / TOWN_CELL);
  const c1 = Math.floor(s1 / TOWN_CELL);
  for (let c = c0; c <= c1; c++) {
    // Период ~24 ячейки ≈ 440 м: городок держится несколько секунд заезда.
    // Пик плотности подобран под пул `QUALITY.townLights` самого высокого пресета.
    const gate = fbm1(c * 0.0249 + 12.4, 3);
    if (gate < 0.5) continue;
    const dens = smoothstep(0.5, 0.8, gate);
    const n = 1 + Math.floor(dens * 3.99);
    // Сторона склона фиксирована на весь участок ~200 м, а не на ячейку.
    const region = Math.floor(c / 11);
    const side = hash2(region, 61) < 0.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const j = 70 + i * 5;
      const s = c * TOWN_CELL + range(hash2(c, j), 0, TOWN_CELL);
      if (s < s0 || s > s1) continue;
      // Одно и то же число задаёт и удаление, и высоту: огни ложатся на склон.
      const u = hash2(c, j + 1);
      townOut.s = s;
      townOut.lane = side * range(u, 120, 420);
      townOut.y = clamp(lerp(26, 118, u) + range(hash2(c, j + 2), -16, 16), 20, 140);
      townOut.tint = pick(hash2(c, j + 3), TOWN_TINTS);
      cb(townOut);
    }
  }
}

/**
 * Высота силуэта хребта на дистанции `s` для левой (−1) или правой (+1)
 * стороны, м. Две шкалы шума: крупный массив ~900 м и вершины ~200 м.
 * Стороны получают разный сдвиг входа, поэтому не зеркалят друг друга.
 */
export function ridgeHeight(s: number, side: -1 | 1): number {
  const o = side < 0 ? 0 : 137.7;
  const big = fbm1(s / 620 + o, 3);
  const peaks = fbm1(s / 145 + o * 2.3 + 61.1, 2);
  return 45 + (big * 0.78 + peaks * 0.22) * 215;
}

/* ==================================================================== */
/*  2. ТРАФИК И БОНУСЫ — работа с пулами Game                           */
/* ==================================================================== */

/**
 * Свернуть сид и индекс спавна в небольшое целое.
 *
 * `hash2` умножает первый аргумент обычным умножением, а не `Math.imul`, и на
 * аргументах больше ~1e7 теряет младшие биты. Поэтому сначала смешиваем всё
 * через `imul` и берём 20 старших бит — на них `hash2` считается точно.
 */
function key2(seed: number, idx: number): number {
  return (Math.imul(idx | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)) >>> 12;
}

/** Случайное [0, 1) для свойства `j` спавна `idx` при сиде `seed`. */
function rnd(seed: number, idx: number, j: number): number {
  return hash2(key2(seed, idx), j);
}

/**
 * Достроить пулы до размеров из `LIMITS`, если `engine.ts` отдал короткие
 * массивы. Аллоцирует только один раз за жизнь объекта `Game`: в установившемся
 * режиме это просто сравнение длин.
 */
function growPools(g: Game): void {
  while (g.cars.length < LIMITS.cars) {
    g.cars.push({
      id: 0,
      active: false,
      s: 0,
      lane: 0,
      speed: 0,
      oncoming: false,
      kind: 0,
      wobble: 0,
      scored: false,
    });
  }
  while (g.pickups.length < LIMITS.pickups) {
    g.pickups.push({ id: 0, active: false, taken: false, s: 0, lane: 0, kind: "star", spin: 0 });
  }
}

/** Свободный слот пула машин или `null`, если все заняты. */
function freeCar(g: Game): Car | null {
  const cars = g.cars;
  for (let i = 0; i < cars.length; i++) if (!cars[i].active) return cars[i];
  return null;
}

/** Свободный слот пула бонусов или `null`. */
function freePickup(g: Game): Pickup | null {
  const ps = g.pickups;
  for (let i = 0; i < ps.length; i++) if (!ps[i].active) return ps[i];
  return null;
}

/** В этой же полосе уже стоит машина ближе 25 м? */
function laneBlocked(g: Game, s: number, lane: number): boolean {
  const cars = g.cars;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (!c.active) continue;
    if (Math.abs(c.lane - lane) > 0.6) continue;
    if (Math.abs(c.s - s) < 25) return true;
  }
  return false;
}

/** Габарит по классу: фуры только во внешней (медленной) полосе. */
function pickKind(r: number, li: 0 | 1): CarKind {
  if (r < 0.7) return 0;
  if (r < 0.91) return 1;
  return li === 1 ? 2 : 1;
}

/** Занять слот и выставить машину. Молча выходит, если места нет или полоса занята. */
function spawnCar(
  g: Game,
  s: number,
  lane: number,
  oncoming: boolean,
  kind: CarKind,
  rWobble: number,
  rSpeed: number,
): void {
  if (laneBlocked(g, s, lane)) return;
  const c = freeCar(g);
  if (!c) return;
  // Фура тяжелее и медленнее — это она и создаёт пробку, которую надо обходить.
  const heavy = kind === 2 ? 0.84 : 1;
  c.id = g.nextId++;
  c.active = true;
  c.s = s;
  c.lane = lane;
  c.oncoming = oncoming;
  c.kind = kind;
  c.wobble = rWobble * Math.PI * 2;
  c.scored = false;
  c.speed = oncoming
    ? -range(rSpeed, TRAFFIC.oncomingSpeed[0], TRAFFIC.oncomingSpeed[1]) * heavy
    : range(rSpeed, TRAFFIC.leadSpeedFrac[0], TRAFFIC.leadSpeedFrac[1]) *
      PHYS.speedMax *
      heavy;
}

/** Занять слот и выставить бонус. */
function spawnPickup(
  g: Game,
  s: number,
  lane: number,
  kind: PickupKind,
  rSpin: number,
): void {
  const p = freePickup(g);
  if (!p) return;
  p.id = g.nextId++;
  p.active = true;
  p.taken = false;
  p.s = s;
  p.lane = lane;
  p.kind = kind;
  p.spin = rSpin * Math.PI * 2;
}

/**
 * Заселить дорогу машинами до `g.s + TRAFFIC.spawnAhead`.
 *
 * Вся случайность выводится из `g.seed` и целой части курсора — не из `g.s` и не
 * из `Math.random`. Поэтому заезд с тем же сидом воспроизводится покадрово
 * независимо от частоты кадров: содержимое мира зависит только от того, докуда
 * дошёл курсор, а не от того, за сколько кадров он туда дошёл.
 */
function spawnCars(g: Game): void {
  const limit = g.s + TRAFFIC.spawnAhead;
  let guard = 0;
  while (g.spawnCursor < limit && guard++ < 64) {
    // Пул кончился — выходим НЕ сдвинув курсор. Иначе точка спавна была бы
    // потрачена впустую и в потоке осталась бы дыра; так мы просто заселяем
    // мир не так далеко вперёд и продолжим с того же места, когда слот
    // освободится позади.
    if (!freeCar(g)) break;

    const at = g.spawnCursor;
    const idx = Math.floor(at) | 0;

    // Интервал сжимается от gapStart к gapMin по мере продвижения по трассе.
    const ramp = smoothstep(0, TRAFFIC.gapRamp, at);
    const base = lerp(TRAFFIC.gapStart, TRAFFIC.gapMin, ramp);
    g.spawnCursor = at + base * range(rnd(g.seed, idx, 0), 0.78, 1.32);

    const oncoming = rnd(g.seed, idx, 1) < TRAFFIC.oncomingShare;
    const dir: 1 | -1 = oncoming ? -1 : 1;
    const li: 0 | 1 = rnd(g.seed, idx, 2) < 0.5 ? 0 : 1;

    spawnCar(
      g,
      at,
      laneCenter(dir, li),
      oncoming,
      pickKind(rnd(g.seed, idx, 3), li),
      rnd(g.seed, idx, 4),
      rnd(g.seed, idx, 5),
    );

    // Пара в соседней полосе того же направления: ряд перекрыт, обгон возможен
    // только через встречку. Ради этого конфликта и сделана вся игра.
    if (rnd(g.seed, idx, 6) < TRAFFIC.pairChance) {
      const lj: 0 | 1 = li === 0 ? 1 : 0;
      const sign = rnd(g.seed, idx, 8) < 0.5 ? -1 : 1;
      spawnCar(
        g,
        at + sign * range(rnd(g.seed, idx, 7), 4, 15),
        laneCenter(dir, lj),
        oncoming,
        pickKind(rnd(g.seed, idx, 9), lj),
        rnd(g.seed, idx, 10),
        rnd(g.seed, idx, 11),
      );
    }
  }
}

/** Расставить бонусы до `g.s + TRAFFIC.spawnAhead`. */
function spawnPickups(g: Game): void {
  const limit = g.s + TRAFFIC.spawnAhead;
  let guard = 0;
  while (g.pickupCursor < limit && guard++ < 64) {
    // Как и с машинами: нет слота — стоим на месте, а не теряем точку.
    if (!freePickup(g)) break;

    const at = g.pickupCursor;
    const idx = Math.floor(at) | 0;
    g.pickupCursor = at + range(rnd(g.seed, idx, 20), PICKUPS.gap[0], PICKUPS.gap[1]);

    // Иногда дорожка уводит на встречную полосу — приманка, а не подарок.
    const tempt = rnd(g.seed, idx, 21) < 0.26;
    const li: 0 | 1 = rnd(g.seed, idx, 22) < 0.5 ? 0 : 1;
    const lane = laneCenter(tempt ? -1 : 1, li);

    if (rnd(g.seed, idx, 23) < PICKUPS.nitroShare) {
      spawnPickup(g, at, lane, "nitro", rnd(g.seed, idx, 24));
      continue;
    }

    const n = hashInt(key2(g.seed, idx), 25, PICKUPS.chain[0], PICKUPS.chain[1]);
    for (let i = 0; i < n; i++) {
      spawnPickup(g, at + i * PICKUPS.chainStep, lane, "star", rnd(g.seed, idx, 26 + i));
    }
  }
}

/** Убрать всё, что уехало назад. Освобождает слоты до спавна новых. */
function despawn(g: Game): void {
  const back = g.s - TRAFFIC.despawnBehind;
  const cars = g.cars;
  for (let i = 0; i < cars.length; i++) {
    const c = cars[i];
    if (c.active && c.s < back) c.active = false;
  }
  const ps = g.pickups;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!p.active) continue;
    // Собранный бонус уже за камерой — слот можно вернуть сразу.
    if (p.s < back || (p.taken && p.s < g.s - 6)) p.active = false;
  }
}

/**
 * Один шаг заселения мира: убрать уехавшее, добить трафик и бонусы вперёд.
 * Вызывается из `engine.ts` один раз за кадр ПОСЛЕ обновления `g.s`.
 * Ничего не двигает и не считает столкновений.
 */
export function ensureWorld(g: Game): void {
  growPools(g);
  despawn(g);
  spawnCars(g);
  spawnPickups(g);
}

/**
 * Полный сброс мира под новый заезд. Курсоры уводятся на `g.s + 140`: первые
 * полторы секунды дорога пустая, игрока не убивает на старте.
 * Вызывать ПОСЛЕ того, как `g.s` выставлен в стартовое значение.
 */
export function resetWorld(g: Game): void {
  growPools(g);
  const cars = g.cars;
  for (let i = 0; i < cars.length; i++) {
    cars[i].active = false;
    cars[i].scored = false;
  }
  const ps = g.pickups;
  for (let i = 0; i < ps.length; i++) {
    ps[i].active = false;
    ps[i].taken = false;
  }
  g.spawnCursor = g.s + 140;
  g.pickupCursor = g.s + 140;
}
