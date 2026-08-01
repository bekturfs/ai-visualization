/**
 * Кузов на настоящей физике (rapier).
 *
 * ЧТО ОТДАНО RAPIER и что нет — это главное решение в файле, и оно осознанное.
 *
 * Отдано: подвеска, крен в повороте, клевок при разгоне и торможении, вертикаль
 * на неровностях и импульс от удара. То есть всё, что игрок чувствует как «кузов
 * живой».
 *
 * Не отдано: продольная скорость, положение на дороге, столкновения и правила.
 * Их по-прежнему считает `engine.ts`. Причина не в лени: на чистом движке держатся
 * четыре свойства, записанные в PROGRESS как «нельзя потерять» — он гоняется в
 * node без браузера, заезд воспроизводим по сиду, шаг фиксирован 1/120, и всё это
 * проверяет `npm run soak`. Отдать модель движения физическому солверу — значит
 * разом лишиться всех четырёх ради ощущения, которое и так достигается.
 *
 * Поэтому здесь стенд: кузов на пружинах стоит над «трясущейся» землёй, его
 * тянет вбок туда, где игру уже поставил движок, и толкает вперёд-назад тем
 * ускорением, которое движок посчитал. Тело честно отрабатывает это массой и
 * инерцией, а мы читаем с него крен, клевок, ход подвески и занос.
 *
 * Модуль целиком необязателен: rapier весит больше всей остальной сборки и
 * грузится динамическим импортом. Пока он не приехал — и если не приедет вовсе —
 * игра работает ровно как раньше, просто кузов не качается.
 */

import { CAM, PHYS, ROAD } from "./config";
import { clamp, damp } from "./num";
import { noise1 } from "./rng";
import type { Game } from "./types";

export interface CarPhysics {
  /** Тело собрано и считается. До этого `update` ничего не делает. */
  readonly ready: boolean;
  /** Вызывать ПОСЛЕ `engine.step` и ДО обновления систем сцены. */
  update(g: Game, dt: number): void;
  dispose(): void;
}

/* ---------- параметры стенда ---------- */

/** Масса кузова, кг. */
const MASS = 1450;
/** Половина габарита кузова, м: ширина, высота, длина. */
const HW = 0.9;
const HH = 0.55;
const HL = 2.2;
/** Высота, на которой кузов висит над землёй в покое, м. */
const REST_Y = 0.75;
/** Половина толщины «земли», м. */
const GROUND_H = 2;

/**
 * Пружина, тянущая кузов туда, где машина по мнению движка.
 *
 * Считается от собственной частоты, а не подбирается на глаз: `k = m·ω²`,
 * `c = 2ζmω`. Три герца и затухание 0.85 — кузов приходит к цели за пару
 * десятых секунды, без перелёта и без ватности.
 */
const LAT_FREQ = 2 * Math.PI * 3;
const LAT_ZETA = 0.85;
const LAT_K = MASS * LAT_FREQ * LAT_FREQ;
const LAT_C = 2 * LAT_ZETA * MASS * LAT_FREQ;

/**
 * На какой высоте относительно центра масс прикладываются продольная и боковая
 * силы, м (отрицательное — ниже). Это и есть источник крена и клевка: приложи
 * их в центр масс — тело поедет вбок, но не наклонится, как оно и было в первой
 * версии. Настоящая машина упирается в дорогу пятном контакта, то есть заметно
 * ниже своего центра тяжести, и потому валится наружу поворота.
 */
const CONTACT_DY = -0.62;
/** Доля продольного ускорения, уходящая в силу. Единица — «как в жизни». */
const LONG_GAIN = 1;
/** Потолок продольного ускорения, м/с², чтобы удар не сложил кузов пополам. */
const LONG_CLAMP = 14;

/** Амплитуда неровностей полотна, м, и её пространственный период. */
const BUMP_AMP = 0.016;
const BUMP_SCALE = 1 / 7;
/** Насколько сильнее трясёт на обочине. */
const OFFROAD_BUMP = 5.5;

/** Импульс от аварии и от задира об отбойник, Н·с на единицу силы события. */
const CRASH_IMPULSE = 5200;
const SCRAPE_IMPULSE = 900;

/** Пределы, за которые снятые с тела величины не выпускаем. */
const MAX_ROLL = 0.1;
const MAX_PITCH = 0.13;
const MAX_HEAVE = 0.16;
/** Сглаживание считанных величин, 1/с. */
const READ_RATE = 14;

/** Ниже этой боковой скорости заносом это не считается, м/с. */
const SKID_MIN = 1.5;
const SKID_FULL = 4.5;

/**
 * Собрать физику. Импорт rapier — динамический, поэтому функция асинхронная и
 * возвращает `null`, если модуль не приехал или окружение его не тянет.
 */
export async function createPhysics(): Promise<CarPhysics | null> {
  let RAPIER: typeof import("@dimforge/rapier3d-compat");
  try {
    RAPIER = await import("@dimforge/rapier3d-compat");
    await RAPIER.init();
  } catch (e) {
    console.warn("физика не поднялась, играем без неё:", e);
    return null;
  }

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  // Шаг солвера привязан к шагу симуляции игры, а не к кадру: одна и та же
  // причина, по которой у движка фиксированный шаг.
  world.timestep = 1 / 120;

  /* --- земля: широкая плита, которую мы двигаем по вертикали --- */
  const groundBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -GROUND_H, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(40, GROUND_H, 60).setFriction(1.1),
    groundBody,
  );

  /* --- кузов --- */
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, REST_Y, 0)
      .setLinearDamping(0.35)
      .setAngularDamping(2.2)
      .setCanSleep(false),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(HW, HH, HL).setMass(MASS).setFriction(0.9),
    chassis,
  );

  /* --- подвеска: четыре колеса на лучах --- */
  const vehicle = world.createVehicleController(chassis);
  vehicle.indexUpAxis = 1;
  vehicle.setIndexForwardAxis = 2;
  const WHEEL_X = HW * 0.95;
  const WHEEL_Z = HL * 0.7;
  for (const [wx, wz] of [
    [-WHEEL_X, -WHEEL_Z],
    [WHEEL_X, -WHEEL_Z],
    [-WHEEL_X, WHEEL_Z],
    [WHEEL_X, WHEEL_Z],
  ]) {
    vehicle.addWheel(
      { x: wx, y: -HH * 0.4, z: wz },
      { x: 0, y: -1, z: 0 },
      { x: -1, y: 0, z: 0 },
      0.35,
      0.34,
    );
  }
  for (let i = 0; i < vehicle.numWheels(); i++) {
    vehicle.setWheelSuspensionStiffness(i, 28);
    vehicle.setWheelSuspensionCompression(i, 0.85);
    vehicle.setWheelSuspensionRelaxation(i, 0.95);
    vehicle.setWheelMaxSuspensionTravel(i, 0.22);
    vehicle.setWheelFrictionSlip(i, 1.6);
  }

  /* --- состояние между кадрами --- */
  let acc = 0;
  let prevSpeed = 0;
  let readRoll = 0;
  let readPitch = 0;
  let disposed = false;

  const impulse = { x: 0, y: 0, z: 0 };
  const force = { x: 0, y: 0, z: 0 };
  const point = { x: 0, y: 0, z: 0 };
  const groundPos = { x: 0, y: -GROUND_H, z: 0 };

  /**
   * Высота, на которой кузов реально встаёт на своих пружинах. Считать её от
   * `REST_Y` нельзя: подвеска держит тело выше, и `heave` получил бы постоянное
   * смещение в семь сантиметров — камера просто всегда висела бы выше, никаких
   * колебаний. Поэтому даём телу отстояться и запоминаем, где оно село.
   */
  let restY = REST_Y;
  for (let i = 0; i < 240; i++) {
    vehicle.updateVehicle(world.timestep);
    world.step();
  }
  restY = chassis.translation().y;

  /** Разложить кватернион тела в крен и тангаж. Без аллокаций. */
  function readAttitude(): void {
    const q = chassis.rotation();
    const { x, y, z, w } = q;
    // крен вокруг оси Z и тангаж вокруг X, порядок для нас неважен: углы малы
    const sinRoll = 2 * (w * z + x * y);
    const cosRoll = 1 - 2 * (y * y + z * z);
    const sinPitch = 2 * (w * x - y * z);
    readRoll = Math.atan2(sinRoll, cosRoll);
    readPitch = Math.asin(clamp(sinPitch, -1, 1));
  }

  function update(g: Game, dt: number): void {
    if (disposed) return;
    if (g.phase !== "playing" && g.phase !== "crashed") {
      // На паузе физику не крутим и долг не копим.
      acc = 0;
      prevSpeed = g.speed;
      return;
    }

    /* --- земля трясётся под колёсами --- */
    // Полотно не стекло: мелкая неровность, детерминированная от дистанции,
    // усиленная скоростью и многократно — обочиной. Это и есть источник хода
    // подвески: настоящий рельеф дороги слишком пологий, чтобы его почувствовать.
    const off = Math.abs(g.x) > ROAD.halfWidth ? OFFROAD_BUMP : 1;
    const rough =
      (noise1(g.s * BUMP_SCALE) - 0.5 + (noise1(g.s * BUMP_SCALE * 3.7) - 0.5) * 0.5) *
      BUMP_AMP *
      off *
      Math.min(1, g.speed / 25);
    groundPos.y = -GROUND_H + rough;
    groundBody.setNextKinematicTranslation(groundPos);

    /* --- боковая пружина к игровому положению --- */
    const p = chassis.translation();
    const v = chassis.linvel();
    force.x = (g.x - p.x) * LAT_K - v.x * LAT_C;
    // Продольная сила из ускорения, которое посчитал движок: она и даёт клевок.
    const accelLong = dt > 0 ? (g.speed - prevSpeed) / dt : 0;
    force.z = -clamp(accelLong, -LONG_CLAMP, LONG_CLAMP) * MASS * LONG_GAIN;
    force.y = 0;
    chassis.resetForces(false);
    // Прикладываем ниже центра масс — иначе тело поедет, но не наклонится.
    point.x = p.x;
    point.y = p.y + CONTACT_DY;
    point.z = p.z;
    chassis.addForceAtPoint(force, point, true);

    /* --- удары --- */
    for (let i = 0; i < g.events.length; i++) {
      const e = g.events[i];
      if (e.type === "crash") {
        const power = clamp((e.value ?? 30) / 60, 0.3, 1.6);
        impulse.x = -Math.sign(g.x || 1) * CRASH_IMPULSE * power * 0.35;
        impulse.y = CRASH_IMPULSE * power * 0.25;
        impulse.z = CRASH_IMPULSE * power;
        chassis.applyImpulse(impulse, true);
      } else if (e.type === "scrape") {
        const side = g.x > 0 ? -1 : 1;
        impulse.x = side * SCRAPE_IMPULSE * (0.4 + (e.value ?? 0.5));
        impulse.y = SCRAPE_IMPULSE * 0.12;
        impulse.z = 0;
        chassis.applyImpulse(impulse, true);
      }
    }

    /* --- шаг солвера, фиксированный --- */
    acc += Math.min(dt, 1 / 20);
    let n = 0;
    while (acc >= world.timestep && n < 6) {
      vehicle.updateVehicle(world.timestep);
      world.step();
      acc -= world.timestep;
      n++;
    }
    if (n >= 6) acc = 0;

    /* --- снимаем с тела то, ради чего всё это --- */
    readAttitude();
    const pos = chassis.translation();
    const vel = chassis.linvel();

    const rollTo = clamp(readRoll, -MAX_ROLL, MAX_ROLL);
    const pitchTo = clamp(readPitch, -MAX_PITCH, MAX_PITCH);
    // Отсчёт хода подвески — от медленно плывущего среднего, а не от высоты,
    // измеренной один раз при сборке. Куда именно сядет тело, зависит от того,
    // как солвер уравновесит пружины с массой и приложенными силами, и это
    // «куда» дрейфует; при жёстком отсчёте `heave` просто упирался в потолок
    // постоянным смещением, и камера всегда висела выше. Камере интересны
    // колебания, а не абсолютная высота, — вот их и оставляем.
    restY = damp(restY, pos.y, 0.7, dt);
    const heaveTo = clamp(pos.y - restY, -MAX_HEAVE, MAX_HEAVE);
    const lat = Math.abs(vel.x - (g.vx || 0));
    const skidTo = clamp((lat - SKID_MIN) / (SKID_FULL - SKID_MIN), 0, 1);

    // В режиме «меньше движения» кузов не качаем вовсе — это ровно та болтанка,
    // от которой человек и включает эту настройку.
    const calm = g.reducedMotion;
    g.heave = calm ? 0 : damp(g.heave, heaveTo, READ_RATE, dt);
    g.pitchBody = calm ? 0 : damp(g.pitchBody, pitchTo, READ_RATE, dt);
    g.skid = damp(g.skid, skidTo, 8, dt);
    // В своё поле, а не в `g.roll`: движок на следующем шаге демпфирует `roll`
    // от предыдущего значения, и подмешивание туда физики дало бы накопление —
    // в замере крен доходил до четырнадцати градусов вместо девяти.
    g.rollBody = calm ? 0 : damp(g.rollBody, rollTo, READ_RATE, dt);

    prevSpeed = g.speed;

    // Кузов не должен уползать: удерживаем его около начала координат, скорость
    // при этом не трогаем — иначе погасим ту самую инерцию, ради которой всё.
    if (Math.abs(pos.z) > 0.4 || Math.abs(pos.y - restY) > 1.2 || Math.abs(pos.x - g.x) > 3) {
      chassis.setTranslation({ x: clamp(pos.x, g.x - 3, g.x + 3), y: restY, z: 0 }, true);
    }
  }

  return {
    get ready() {
      return !disposed;
    },
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      world.free();
    },
  };
}

/** Высота глаз с учётом хода подвески — для камеры. */
export function eyeHeight(g: Game): number {
  return CAM.height + g.heave;
}

/** Насколько шины визжат прямо сейчас: 0…1. Пригодится звуку. */
export function skidLevel(g: Game): number {
  return g.speed > PHYS.speedStart * 0.4 ? g.skid : 0;
}
