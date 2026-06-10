/**
 * Крошечная языковая модель-игрушка: триграммы со сглаживающим откатом
 * к биграммам. Обучается на встроенном корпусе прямо в браузере —
 * все вероятности на странице «Общая картина» считаются честно отсюда.
 */

export const CORPUS: string[] = [
  // сказка
  "жили были дед и баба",
  "жили были кот и пёс",
  "жили были мышка и кошка",
  "дед и баба жили в маленьком доме",
  "дед пошёл в лес за грибами",
  "дед нашёл в лесу много грибов",
  "баба испекла вкусный пирог с яблоками",
  "баба сварила кашу из топора",
  "кот поймал серую мышку",
  "кот выпил всё молоко из миски",
  "пёс громко лаял на чужих",
  "пёс охранял маленький дом",
  "мышка убежала в норку",
  "мышка нашла кусочек сыра",
  // погода
  "сегодня на улице светит яркое солнце",
  "сегодня на улице идёт сильный дождь",
  "сегодня на улице очень холодно",
  "завтра будет тепло и солнечно",
  "завтра будет сильный ветер",
  "зимой часто идёт белый снег",
  "зимой дети лепят снеговика",
  "летом дети купаются в реке",
  "летом солнце светит очень ярко",
  "осенью листья падают на землю",
  "осенью часто идёт холодный дождь",
  "весной тает снег и бегут ручьи",
  "после дождя на небе появилась радуга",
  // кошки и собаки
  "кошка любит спать на тёплом диване",
  "кошка любит играть с клубком ниток",
  "кошка пьёт молоко из миски",
  "кошка ловит мышей по ночам",
  "кошка спит на тёплом подоконнике",
  "собака любит гулять в парке",
  "собака грызёт большую кость",
  "собака радостно виляет хвостом",
  "собака бежит за красным мячиком",
  // про нейросети
  "нейросеть учится на миллионах примеров",
  "нейросеть предсказывает следующее слово",
  "нейросеть превращает слова в числа",
  "модель учится находить закономерности в данных",
  "модель предсказывает следующее слово в тексте",
  "модель учится на своих ошибках",
  "компьютер превращает слова в числа",
  "компьютер считает очень быстро",
  "градиентный спуск уменьшает ошибку модели",
  "ошибка модели уменьшается с каждым шагом",
];

export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^а-яё\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean);

type Counts = Map<string, Map<string, number>>;

function addCount(m: Counts, key: string, word: string) {
  const inner = m.get(key) ?? new Map<string, number>();
  inner.set(word, (inner.get(word) ?? 0) + 1);
  m.set(key, inner);
}

const tri: Counts = new Map(); // «два слова» → следующее
const bi: Counts = new Map(); // «одно слово» → следующее
for (const sent of CORPUS) {
  const w = tokenize(sent);
  for (let i = 0; i < w.length - 1; i++) {
    addCount(bi, w[i], w[i + 1]);
    if (i < w.length - 2) addCount(tri, `${w[i]} ${w[i + 1]}`, w[i + 2]);
  }
}

export type Candidate = { word: string; p: number; count: number };
export type Prediction = {
  /** на какой контекст модель посмотрела */
  source: "trigram" | "bigram" | "none";
  contextUsed: string[];
  candidates: Candidate[]; // отсортированы по убыванию вероятности
};

/**
 * Распределение следующего слова. Температура честная:
 * p_i ∝ count_i^(1/T); T→0 — почти всегда самое частое, T большая — лотерея.
 */
export function predict(context: string[], temperature: number): Prediction {
  const t = Math.max(temperature, 0.05);
  const last2 = context.slice(-2);
  let counts: Map<string, number> | undefined;
  let source: Prediction["source"] = "none";
  let used: string[] = [];
  if (last2.length === 2) {
    counts = tri.get(last2.join(" "));
    if (counts) {
      source = "trigram";
      used = last2;
    }
  }
  if (!counts && context.length >= 1) {
    counts = bi.get(context[context.length - 1]);
    if (counts) {
      source = "bigram";
      used = context.slice(-1);
    }
  }
  if (!counts) return { source: "none", contextUsed: [], candidates: [] };

  const entries = [...counts.entries()];
  const weights = entries.map(([, c]) => Math.pow(c, 1 / t));
  const sum = weights.reduce((a, b) => a + b, 0);
  const candidates = entries
    .map(([word, count], i) => ({ word, count, p: weights[i] / sum }))
    .sort((a, b) => b.p - a.p);
  return { source, contextUsed: used, candidates };
}

/** Честная лотерея по вероятностям. */
export function sample(candidates: Candidate[]): Candidate {
  const r = Math.random();
  let acc = 0;
  for (const c of candidates) {
    acc += c.p;
    if (r <= acc) return c;
  }
  return candidates[candidates.length - 1];
}

/** Детерминированный псевдо-эмбеддинг для картинки «слово → числа». */
export function fakeEmbedding(word: string, dims = 4): number[] {
  let h = 2166136261;
  for (const ch of word) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out.push(Math.round(((h >>> 8) / 0xffffff - 0.5) * 2 * 100) / 100);
  }
  return out;
}

export const PRESETS: { label: string; tokens: string[] }[] = [
  { label: "жили были…", tokens: ["жили", "были"] },
  { label: "сегодня на улице…", tokens: ["сегодня", "на", "улице"] },
  { label: "кошка любит…", tokens: ["кошка", "любит"] },
  { label: "нейросеть…", tokens: ["нейросеть"] },
];
