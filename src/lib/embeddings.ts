/**
 * Честные мини-эмбеддинги: PPMI-векторы по совместной встречаемости слов
 * в корпусе tinylm (окно ±3) + проекция в 2D степенным методом.
 */
import { CORPUS, tokenize } from "./tinylm";

export type WordPoint = {
  word: string;
  x: number;
  y: number;
  theme: string;
  freq: number;
};

const THEMES: { name: string; from: number; to: number }[] = [
  { name: "сказка", from: 0, to: 13 },
  { name: "погода", from: 14, to: 26 },
  { name: "животные", from: 27, to: 35 },
  { name: "нейросети", from: 36, to: 45 },
];

const STOP = new Set([
  "и", "в", "на", "с", "из", "за", "по", "всё", "очень", "часто", "своих",
  "каждым", "будет",
]);

function build() {
  const freq = new Map<string, number>();
  const themeCount = new Map<string, Map<string, number>>();
  CORPUS.forEach((sent, si) => {
    const theme =
      THEMES.find((t) => si >= t.from && si <= t.to)?.name ?? "другое";
    for (const w of tokenize(sent)) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
      const tc = themeCount.get(w) ?? new Map<string, number>();
      tc.set(theme, (tc.get(theme) ?? 0) + 1);
      themeCount.set(w, tc);
    }
  });

  const vocab = [...freq].filter(([, f]) => f >= 2).map(([w]) => w);
  const idx = new Map(vocab.map((w, i) => [w, i]));
  const V = vocab.length;

  // совместная встречаемость, окно ±3, вес 1/расстояние
  const C = Array.from({ length: V }, () => new Float64Array(V));
  const WIN = 3;
  for (const sent of CORPUS) {
    const ws = tokenize(sent);
    for (let i = 0; i < ws.length; i++)
      for (
        let j = Math.max(0, i - WIN);
        j <= Math.min(ws.length - 1, i + WIN);
        j++
      ) {
        if (i === j) continue;
        const a = idx.get(ws[i]);
        const b = idx.get(ws[j]);
        if (a !== undefined && b !== undefined)
          C[a][b] += 1 / Math.abs(i - j);
      }
  }

  // PPMI
  let total = 0;
  const rowSum = new Float64Array(V);
  for (let i = 0; i < V; i++)
    for (let j = 0; j < V; j++) {
      total += C[i][j];
      rowSum[i] += C[i][j];
    }
  const M = Array.from({ length: V }, () => new Float64Array(V));
  for (let i = 0; i < V; i++)
    for (let j = 0; j < V; j++)
      if (C[i][j] > 0)
        M[i][j] = Math.max(0, Math.log((C[i][j] * total) / (rowSum[i] * rowSum[j])));

  // 2D: два главных направления симметричной матрицы (степенной метод + дефляция)
  const matVec = (A: Float64Array[], v: Float64Array) => {
    const out = new Float64Array(V);
    for (let i = 0; i < V; i++) {
      let s = 0;
      for (let j = 0; j < V; j++) s += A[i][j] * v[j];
      out[i] = s;
    }
    return out;
  };
  const norm = (v: Float64Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const powerIter = (A: Float64Array[]) => {
    let v = new Float64Array(V).map((_, i) => Math.sin(i + 1)); // детерминированный старт
    for (let it = 0; it < 60; it++) {
      v = matVec(A, v);
      const n = norm(v) || 1;
      for (let i = 0; i < V; i++) v[i] /= n;
    }
    const Av = matVec(A, v);
    const lambda = v.reduce((s, x, i) => s + x * Av[i], 0);
    return { v, lambda };
  };
  const e1 = powerIter(M);
  // дефляция: убираем первое направление и ищем второе
  const D = M.map((row, i) =>
    row.map((x, j) => x - e1.lambda * e1.v[i] * e1.v[j]),
  );
  const e2 = powerIter(D);

  const xs = vocab.map((_, i) =>
    M[i].reduce((s, x, j) => s + x * e1.v[j], 0),
  );
  const ys = vocab.map((_, i) =>
    M[i].reduce((s, x, j) => s + x * e2.v[j], 0),
  );

  const dominantTheme = (w: string) => {
    if (STOP.has(w)) return "служебные";
    const tc = themeCount.get(w)!;
    const totalW = [...tc.values()].reduce((a, b) => a + b, 0);
    const top = [...tc.entries()].sort((a, b) => b[1] - a[1])[0];
    return top[1] / totalW >= 0.6 ? top[0] : "общие";
  };

  const points: WordPoint[] = vocab.map((w, i) => ({
    word: w,
    x: xs[i],
    y: ys[i],
    theme: dominantTheme(w),
    freq: freq.get(w)!,
  }));

  const cosine = (a: string, b: string): number => {
    const i = idx.get(a);
    const j = idx.get(b);
    if (i === undefined || j === undefined) return 0;
    let d = 0,
      na = 0,
      nb = 0;
    for (let k = 0; k < V; k++) {
      d += M[i][k] * M[j][k];
      na += M[i][k] ** 2;
      nb += M[j][k] ** 2;
    }
    return na && nb ? d / Math.sqrt(na * nb) : 0;
  };

  const neighbors = (w: string, k = 5) =>
    vocab
      .filter((v) => v !== w)
      .map((v) => ({ word: v, sim: cosine(w, v) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);

  /** PPMI-вектор слова (копия — внутреннюю матрицу мутировать нельзя). */
  const vector = (w: string): Float64Array | undefined => {
    const i = idx.get(w);
    return i === undefined ? undefined : Float64Array.from(M[i]);
  };

  const cosVec = (a: Float64Array, b: Float64Array): number => {
    if (a.length !== b.length) return 0;
    let d = 0,
      na = 0,
      nb = 0;
    for (let k = 0; k < V; k++) {
      d += a[k] * b[k];
      na += a[k] ** 2;
      nb += b[k] ** 2;
    }
    return na && nb ? d / Math.sqrt(na * nb) : 0;
  };

  /** Ближайшие слова словаря к произвольному вектору (длины V). */
  const nearestToVec = (vec: Float64Array, k = 3, exclude: string[] = []) =>
    vec.length !== V
      ? []
      : vocab
      .filter((w) => !exclude.includes(w))
      .map((w) => ({ word: w, sim: cosVec(vec, M[idx.get(w)!]) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);

  return { points, vocab, cosine, neighbors, vector, nearestToVec };
}

export const EMB = build();

export const THEME_COLORS: Record<string, string> = {
  сказка: "#ffa657",
  погода: "#58a6ff",
  животные: "#56d364",
  нейросети: "#d2a8ff",
  служебные: "#5b6878",
  общие: "#8b98ab",
};
