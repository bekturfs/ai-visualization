/**
 * Форма дороги и проекция мира в локальные координаты сцены.
 *
 * Дорога бесконечна и детерминирована: `roadX(s)` — увод в сторону (повороты),
 * `roadY(s)` — рельеф (подъёмы и спуски). Сумма синусов с несоизмеримыми
 * периодами, поэтому «трасса» не повторяется на обозримой дистанции, но при
 * этом её можно посчитать в любой точке без состояния.
 *
 * Камера стоит в начале координат и смотрит в −Z, мир проезжает мимо. Поэтому
 * абсолютная дистанция никогда не попадает в координаты вершин: в шейдер уходят
 * только разности, и точность float не деградирует ни на десятом километре, ни
 * на сотом.
 */

import { ROAD } from "./config";

/* ---------- форма ---------- */

/** Увод осевой линии в сторону на дистанции `s`, м. */
export function roadX(s: number): number {
  return (
    26 * Math.sin(s / 340) +
    13 * Math.sin(s / 121 + 1.7) +
    5.5 * Math.sin(s / 47 + 0.4)
  );
}

/** Производная `roadX` — тангенс курса. */
export function roadDX(s: number): number {
  return (
    (26 / 340) * Math.cos(s / 340) +
    (13 / 121) * Math.cos(s / 121 + 1.7) +
    (5.5 / 47) * Math.cos(s / 47 + 0.4)
  );
}

/** Кривизна: вторая производная `roadX`. Знак — сторона поворота. */
export function roadCurv(s: number): number {
  return (
    -(26 / (340 * 340)) * Math.sin(s / 340) -
    (13 / (121 * 121)) * Math.sin(s / 121 + 1.7) -
    (5.5 / (47 * 47)) * Math.sin(s / 47 + 0.4)
  );
}

/** Высота полотна на дистанции `s`, м. */
export function roadY(s: number): number {
  return 9 * Math.sin(s / 470 + 0.9) + 3.2 * Math.sin(s / 173 + 2.3);
}

/** Производная `roadY` — тангенс уклона. */
export function roadDY(s: number): number {
  return (9 / 470) * Math.cos(s / 470 + 0.9) + (3.2 / 173) * Math.cos(s / 173 + 2.3);
}

/** Курс дороги в точке `s`, рад. Положительный — уходит вправо. */
export function roadHeading(s: number): number {
  return Math.atan(roadDX(s));
}

/** Уклон дороги в точке `s`, рад. Положительный — в горку. */
export function roadPitch(s: number): number {
  return Math.atan(roadDY(s));
}

/* ---------- проекция в сцену ---------- */

/**
 * Локальный X точки, стоящей на дистанции `s` с боковым смещением `lane`,
 * если камера находится на `camS` со смещением `camX`.
 *
 * Боковое смещение прибавляется без поворота на курс дороги — классическое
 * упрощение аркадных гонок. При |lane| ≤ 8.4 м и курсе до ~17° поперечная
 * ошибка меньше 0.4 м и в перспективе не читается, зато любой модуль может
 * спроецировать точку одним умножением, без матриц и без синхронизации.
 */
export function localX(s: number, lane: number, camS: number, camX: number): number {
  return roadX(s) - roadX(camS) + lane - camX;
}

/** Локальный Y точки на высоте `y` над полотном. */
export function localY(s: number, y: number, camS: number): number {
  return roadY(s) - roadY(camS) + y;
}

/** Локальный Z: впереди — отрицательный. */
export function localZ(s: number, camS: number): number {
  return camS - s;
}

/* ---------- полосы и границы ---------- */

/** Центр полосы: `dir` = +1 наши полосы, −1 встречные; `i` = 0 (у осевой) или 1. */
export function laneCenter(dir: 1 | -1, i: 0 | 1): number {
  return dir * ROAD.laneCenters[i];
}

/** Все четыре центра полос, от левой встречной к правой нашей. */
export const ALL_LANES: readonly number[] = [
  -ROAD.laneCenters[1],
  -ROAD.laneCenters[0],
  ROAD.laneCenters[0],
  ROAD.laneCenters[1],
];

/** Машина на этом смещении едет нам навстречу? */
export function isOncomingLane(lane: number): boolean {
  return lane < 0;
}

/** Колёса на полотне (не на обочине)? */
export function onPavement(x: number): boolean {
  return Math.abs(x) <= ROAD.halfWidth;
}

/** Насколько глубоко ушли за полотно, м (0 — ещё на асфальте). */
export function offPavement(x: number): number {
  const d = Math.abs(x) - ROAD.halfWidth;
  return d > 0 ? d : 0;
}
