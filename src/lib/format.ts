/** Числа в формулах: 2 знака, настоящий минус, без «−0.00». */
export function fmt(v: number, digits = 2): string {
  if (!isFinite(v)) return v > 0 ? "∞" : "−∞";
  const m = 10 ** digits;
  let r = Math.round(v * m) / m;
  if (Object.is(r, -0) || r === 0) r = 0;
  return r < 0 ? "−" + Math.abs(r).toFixed(digits) : r.toFixed(digits);
}

/** Отрицательные значения — в скобках (для произведений в формулах). */
export const par = (v: number, digits = 2): string =>
  v < 0 ? `(${fmt(v, digits)})` : fmt(v, digits);

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;
