/**
 * Детерминированная случайность. Два разных инструмента:
 *
 * - `mulberry32` — поток случайных чисел с состоянием, для спавна трафика;
 * - `hash1` / `hash2` — чистая функция от индекса, для декораций. Дерево у дороги
 *   не хранится нигде: любой модуль в любой кадр спрашивает «что в ячейке 417?»
 *   и получает один и тот же ответ. Это то, что позволяет сцене не синхронизироваться.
 */

/** Генератор потока: маленький, быстрый, с полным периодом 2³². */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Хеш целого в [0, 1). */
export function hash1(i: number): number {
  let t = (i | 0) + 0x9e3779b9;
  t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
  t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
  return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
}

/** Хеш пары целых в [0, 1) — индекс ячейки + номер свойства. */
export function hash2(i: number, j: number): number {
  return hash1((i | 0) * 0x27d4eb2d + (j | 0) * 0x165667b1);
}

/** Целое из хеша, `lo` … `hi` включительно. */
export function hashInt(i: number, j: number, lo: number, hi: number): number {
  return lo + Math.floor(hash2(i, j) * (hi - lo + 1));
}

/** Растянуть [0, 1) в [lo, hi). */
export function range(r: number, lo: number, hi: number): number {
  return lo + r * (hi - lo);
}

/** Выбрать элемент по числу из [0, 1). */
export function pick<T>(r: number, arr: readonly T[]): T {
  const i = Math.min(arr.length - 1, Math.floor(r * arr.length));
  return arr[i];
}

/** Гладкий value-noise по одной оси; период — 1 единица входа. */
export function noise1(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return hash1(i) * (1 - s) + hash1(i + 1) * s;
}

/** Сумма октав `noise1` — рваный, но детерминированный рельеф. */
export function fbm1(x: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(x * freq + o * 17.13) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}
