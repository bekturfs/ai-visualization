/** Мелкая математика, нужная всем модулям игры. Без зависимостей. */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Обратная линейная интерполяция с зажимом: где `v` между `a` и `b`. */
export function inv(a: number, b: number, v: number): number {
  return clamp01((v - a) / (b - a || 1e-9));
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = inv(a, b, v);
  return t * t * (3 - 2 * t);
}

/**
 * Кадронезависимое приближение `cur` к `to`. `rate` — «скорость сходимости» в
 * единицах 1/с: за 1/rate секунды отставание падает в e раз. Именно так, а не
 * `cur += (to - cur) * 0.1`, иначе поведение зависит от частоты кадров.
 */
export function damp(cur: number, to: number, rate: number, dt: number): number {
  return to + (cur - to) * Math.exp(-rate * dt);
}

/** Приближение к нулю с постоянной скоростью (для затухания тряски и вспышек). */
export function decayTo0(cur: number, perSecond: number, dt: number): number {
  const next = cur - perSecond * dt;
  return next < 0 ? 0 : next;
}

/** Положительный остаток: `wrap(-1, 4) === 3`. */
export function wrap(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** Кратчайшее расстояние между двумя углами, в (−π, π]. */
export function angleDelta(a: number, b: number): number {
  return wrap(b - a + Math.PI, Math.PI * 2) - Math.PI;
}
