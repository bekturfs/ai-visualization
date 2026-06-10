import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Layout, Card, Seg, Btn } from "../components/ui";
import { StoryPanel, useStory, type StoryStep } from "../components/StoryMode";
import { FlowDotsPath } from "../components/FlowDots";
import { EMB } from "../lib/embeddings";

/* предложения составлены только из слов словаря эмбеддингов */
const SENTENCES: { label: string; words: string[] }[] = [
  { label: "про кошку", words: ["кошка", "любит", "молоко", "из", "миски"] },
  { label: "про зиму", words: ["зимой", "часто", "идёт", "снег"] },
  { label: "про нейросеть", words: ["нейросеть", "предсказывает", "следующее", "слово"] },
  { label: "сказка", words: ["жили", "были", "дед", "и", "баба"] },
];

const STEPS: StoryStep[] = [
  {
    emoji: "🔦",
    title: "Слово само по себе значит слишком мало",
    text: (
      <>
        «Ключ» — это железка, родник или нота? «Она устала» — кто «она»?
        Смысл слова прячется в его соседях. Эмбеддинг с прошлой страницы даёт
        слову значение «в среднем», а{" "}
        <b className="text-ink">внимание (attention) уточняет его по
        контексту</b> — это главный механизм внутри трансформеров, на которых
        построены все современные LLM.
      </>
    ),
  },
  {
    emoji: "👀",
    title: "Каждое слово смотрит на все остальные",
    text: (
      <>
        Смотри на лучи: подсвеченное слово «осматривает» соседей по
        предложению, и я переключаю слова по очереди. Это происходит со всеми
        словами одновременно — каждое собирает информацию у каждого. В GPT
        такой «осмотр» повторяется в каждом из ~100 слоёв.
      </>
    ),
  },
  {
    emoji: "⚖️",
    title: "Взгляд — с весами, и в сумме ровно 100%",
    text: (
      <>
        Не все соседи одинаково интересны. Внимание раздаёт каждому соседу{" "}
        <b className="text-ink">вес</b> — насколько он важен для понимания
        этого слова, — и веса всегда дают в сумме 100% (это делает softmax).
        Толщина луча = вес. <b className="text-ink">Кликай по словам</b> и
        смотри на проценты справа.
      </>
    ),
  },
  {
    emoji: "🧮",
    title: "Откуда берутся веса? Из похожести «интересов»",
    text: (
      <>
        Мы честно считаем: насколько похожи эмбеддинги двух слов (та самая
        карта со страницы 06) — это «сырой балл интереса», потом softmax
        превращает баллы в проценты. В настоящих трансформерах балл считают
        обученные матрицы Query и Key («что я ищу» × «что у меня есть») — но
        суть та же: число «насколько слову i интересно слово j».
      </>
    ),
  },
  {
    emoji: "🗺",
    title: "Матрица внимания: вся картина сразу",
    text: (
      <>
        Внизу — карта всех взглядов: строка — кто смотрит, столбец — на кого,
        яркость — вес. Такие картинки исследователи реально разглядывают,
        когда изучают, что выучила модель: в них видно, как местоимения
        находят своих хозяев, а глаголы — свои дополнения.{" "}
        <b className="text-ink">Кликни по строке</b> — лучи переключатся.
      </>
    ),
  },
  {
    emoji: "🌀",
    title: "Новый смысл = смесь старых",
    text: (
      <>
        Зачем эти веса? Слово собирает{" "}
        <b className="text-ink">взвешенную смесь значений</b> тех, на кого
        смотрело, — и это становится его новым, уточнённым значением. Справа
        внизу видно, на что похожа смесь для выбранного слова: смысл реально
        сдвигается в сторону контекста. Слой за слоем слова всё точнее
        понимают, о чём предложение.
      </>
    ),
  },
  {
    emoji: "⬅️",
    title: "В GPT смотреть можно только назад",
    text: (
      <>
        Я включил «причинную маску» (causal mask): теперь каждое слово видит
        только тех, кто стоит <b className="text-ink">до него</b>. Почему? При
        генерации будущих слов ещё не существует! Посмотри на матрицу — правый
        верхний угол погас. Именно поэтому GPT пишет текст строго слева
        направо.
      </>
    ),
  },
  {
    emoji: "🎚",
    title: "Резкость взгляда — и задания",
    text: (
      <>
        Слайдер «резкость» управляет softmax: мягкий взгляд распыляется на
        всех поровну, резкий — упирается в одного самого интересного соседа.
        Дальше песочница: покликай слова, проверь все предложения и выполни
        задания. Внимание — последний «кирпичик», которого не хватало общей
        картине со страницы 00!
      </>
    ),
  },
];

export default function Attention() {
  const [sentIdx, setSentIdx] = useState(0);
  const [selected, setSelected] = useState(2);
  const [sharp, setSharp] = useState(4);
  const [causal, setCausal] = useState(false);
  const [pickedWords, setPickedWords] = useState<Set<string>>(new Set());
  const [sentencesUsed, setSentencesUsed] = useState<Set<number>>(new Set([0]));
  const [causalUsed, setCausalUsed] = useState(false);
  const [sharpWeightSeen, setSharpWeightSeen] = useState(false);
  const cycleTimer = useRef<number | null>(null);

  const story = useStory(STEPS.length);
  const st = story.step;
  const words = SENTENCES[sentIdx].words;

  /* честные веса внимания: cosine эмбеддингов → softmax (без взгляда на себя) */
  const attn = useMemo(() => {
    const n = words.length;
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) {
      const scores: number[] = [];
      for (let j = 0; j < n; j++) {
        const visible = j !== i && (!causal || j < i);
        scores.push(visible ? EMB.cosine(words[i], words[j]) : NaN);
      }
      const exps = scores.map((s) => (Number.isNaN(s) ? 0 : Math.exp(s * sharp)));
      const sum = exps.reduce((a, b) => a + b, 0);
      rows.push(exps.map((e) => (sum > 0 ? e / sum : 0)));
    }
    return rows;
  }, [words, sharp, causal]);

  const sel = Math.min(selected, words.length - 1);
  const rowW = attn[sel];
  const maxW = Math.max(...attn.flatMap((r) => r));
  useEffect(() => {
    if (maxW >= 0.6) setSharpWeightSeen(true);
  }, [maxW]);

  /* смесь значений для выбранного слова и её ближайшие соседи */
  const mixture = useMemo(() => {
    const base = EMB.vector(words[0]);
    if (!base) return null;
    const mix = new Float64Array(base.length);
    let total = 0;
    words.forEach((w, j) => {
      const v = EMB.vector(w);
      if (!v || rowW[j] === 0) return;
      for (let k = 0; k < mix.length; k++) mix[k] += rowW[j] * v[k];
      total += rowW[j];
    });
    if (total === 0) return null;
    return EMB.nearestToVec(mix, 3, [words[sel]]);
  }, [words, rowW, sel]);

  /* шаги истории */
  useEffect(() => {
    if (cycleTimer.current) clearInterval(cycleTimer.current);
    if (st === 1) {
      let i = 0;
      cycleTimer.current = window.setInterval(() => {
        i = (i + 1) % words.length;
        setSelected(i);
      }, 950);
      return () => {
        if (cycleTimer.current) clearInterval(cycleTimer.current);
      };
    }
    if (st === 2) setSelected(2 % words.length);
    if (st === 6) {
      setCausal(true);
      setCausalUsed(true);
    }
    if (st === 7) setCausal(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  const pick = (i: number) => {
    setSelected(i);
    setPickedWords((s) => new Set(s).add(words[i]));
  };
  const pickSentence = (i: number) => {
    setSentIdx(i);
    setSelected(Math.min(2, SENTENCES[i].words.length - 1));
    setSentencesUsed((s) => new Set(s).add(i));
  };

  /* геометрия лучей */
  const geo = useMemo(() => {
    let x = 24;
    const boxes = words.map((w) => {
      const width = 22 + w.length * 10.5;
      const b = { x, width, cx: x + width / 2 };
      x += width + 14;
      return b;
    });
    return { boxes, total: x + 10 };
  }, [words]);
  const Y = 132;

  const arcPath = (i: number, j: number) => {
    const a = geo.boxes[i].cx;
    const b = geo.boxes[j].cx;
    const lift = 30 + Math.abs(i - j) * 22;
    return `M ${a} ${Y - 18} Q ${(a + b) / 2} ${Y - 18 - lift}, ${b} ${Y - 18}`;
  };

  const tasks = [
    { label: "Выбери 4 разных слова (кликами)", done: pickedWords.size >= 4 },
    { label: "Посмотри все 4 предложения", done: sentencesUsed.size >= 4 },
    { label: "Включи маску «только назад»", done: causalUsed },
    { label: "Добейся веса ≥ 60% на одном луче (резкость!)", done: sharpWeightSeen },
  ];
  const glow = (on: boolean) => (on ? "ring-2 ring-accent/70" : "");

  const topDots = rowW
    .map((w, j) => ({ w, j }))
    .filter((x) => x.w > 0.02)
    .sort((a, b) => b.w - a.w)
    .slice(0, 3);

  return (
    <Layout crumb="07 · Механизм внимания" crumbEn="attention">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Как слова смотрят друг на друга
      </h1>
      <p className="mb-4 max-w-[940px] text-muted">
        <b className="text-ink">Внимание отвечает за контекст:</b> каждое слово
        раздаёт соседям веса «насколько ты мне важен» и собирает из их значений
        своё новое, уточнённое значение. Веса ниже честные: похожесть наших
        эмбеддингов со страницы 06 + softmax.
      </p>

      <StoryPanel
        steps={STEPS}
        step={story.step}
        setStep={story.setStep}
        next={story.next}
        prev={story.prev}
        sandboxText="Кликай по словам и строкам матрицы, крути резкость, включай маску — лучи и проценты пересчитываются вживую."
      />

      <div className="grid grid-cols-[1.1fr_.9fr] items-start gap-4 max-lg:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Card title="Лучи внимания" className={glow(st !== null && st <= 2)}>
            <svg viewBox={`0 0 ${geo.total} 168`} aria-label="Лучи внимания между словами">
              {words.map((_, j) => {
                if (j === sel || rowW[j] === 0) return null;
                return (
                  <g key={j}>
                    <path
                      d={arcPath(sel, j)}
                      fill="none"
                      stroke="#58a6ff"
                      strokeWidth={1 + rowW[j] * 9}
                      strokeOpacity={0.18 + rowW[j] * 0.75}
                    />
                    {rowW[j] >= 0.12 && (
                      <text
                        x={(geo.boxes[sel].cx + geo.boxes[j].cx) / 2}
                        y={Y - 26 - (30 + Math.abs(sel - j) * 22) / 2}
                        textAnchor="middle"
                        fontSize="11"
                        fill="#9fc4ff"
                      >
                        {Math.round(rowW[j] * 100)}%
                      </text>
                    )}
                  </g>
                );
              })}
              {topDots.map(({ w, j }) => (
                <FlowDotsPath
                  key={`${sel}-${j}-${sentIdx}`}
                  d={arcPath(j, sel)}
                  count={2}
                  r={2.6}
                  color="#9fc4ff"
                  speed={0.5 + w * 0.6}
                  opacity={0.3 + w * 0.7}
                />
              ))}
              {words.map((w, i) => {
                const isSel = i === sel;
                const masked = causal && i > sel;
                return (
                  <g
                    key={i}
                    onClick={() => pick(i)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pick(i);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`слово «${w}» — показать его внимание`}
                    aria-pressed={isSel}
                    style={{ cursor: "pointer", outline: "none" }}
                    opacity={masked ? 0.45 : 1}
                  >
                    <rect
                      x={geo.boxes[i].x}
                      y={Y - 16}
                      width={geo.boxes[i].width}
                      height={34}
                      rx={9}
                      fill={isSel ? "#1f3a5f" : "#1b2330"}
                      stroke={isSel ? "#58a6ff" : "#3a465c"}
                      strokeWidth={isSel ? 2 : 1.3}
                    />
                    <text
                      x={geo.boxes[i].cx}
                      y={Y + 6}
                      textAnchor="middle"
                      fontSize="14.5"
                      fill={isSel ? "#cfe5ff" : "#c2cdda"}
                    >
                      {w}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="mt-1 text-[12.5px] text-muted">
              толщина луча — вес внимания; точки бегут от соседей к выбранному
              слову (оно «собирает» их значения)
            </div>
          </Card>

          <Card title="Матрица внимания (кто на кого смотрит)" className={glow(st === 4)}>
            <svg
              viewBox={`0 0 ${110 + words.length * 44} ${64 + words.length * 40}`}
              className="max-w-[480px]"
              aria-label="Матрица весов внимания"
            >
              {words.map((w, j) => (
                <text
                  key={`c${j}`}
                  x={120 + j * 44}
                  y={50}
                  textAnchor="start"
                  fontSize="11"
                  fill={j === sel ? "#9fc4ff" : "#8b98ab"}
                  transform={`rotate(-38 ${120 + j * 44} 50)`}
                >
                  {w}
                </text>
              ))}
              {words.map((wi, i) => (
                <g key={`r${i}`} onClick={() => pick(i)} style={{ cursor: "pointer" }}>
                  <text
                    x={102}
                    y={64 + i * 40 + 20}
                    textAnchor="end"
                    fontSize="12"
                    fontWeight={i === sel ? 700 : 400}
                    fill={i === sel ? "#cfe5ff" : "#8b98ab"}
                  >
                    {wi}
                  </text>
                  {words.map((_, j) => {
                    const masked = j === i || (causal && j > i);
                    const w = attn[i][j];
                    return (
                      <g key={j}>
                        <rect
                          x={110 + j * 44}
                          y={64 + i * 40}
                          width={40}
                          height={36}
                          rx={6}
                          fill={
                            masked
                              ? "#151b24"
                              : `rgba(88,166,255,${(0.06 + w * 0.9).toFixed(3)})`
                          }
                          stroke={i === sel ? "#2d68b8" : "#2b3444"}
                          strokeWidth={i === sel ? 1.5 : 1}
                        />
                        {!masked && w >= 0.13 && (
                          <text
                            x={130 + j * 44}
                            y={64 + i * 40 + 23}
                            textAnchor="middle"
                            fontSize="11"
                            fill={w > 0.45 ? "#0d1117" : "#c2cdda"}
                          >
                            {Math.round(w * 100)}
                          </text>
                        )}
                        {masked && j !== i && (
                          <text
                            x={130 + j * 44}
                            y={64 + i * 40 + 23}
                            textAnchor="middle"
                            fontSize="11"
                            fill="#3a465c"
                          >
                            ✕
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              ))}
            </svg>
            <div className="mt-1 text-[12.5px] text-muted">
              строка — кто смотрит, столбец — на кого; числа — проценты.
              {causal && " ✕ — будущее скрыто причинной маской."}
            </div>
          </Card>

          {st === null && (
            <Card title="Что здесь происходит">
              <p className="my-2 max-w-[1000px] text-soft">
                Self-attention: каждое слово формирует запрос «что мне нужно»
                (Query), предложение «что у меня есть» (Key) и содержимое
                (Value). Балл интереса — скалярное произведение Query и Key,
                softmax превращает баллы в веса, и слово забирает смесь Values.
                У нас вместо обученных Q и K — похожесть эмбеддингов, и «голова»
                одна, а в настоящих трансформерах таких голов десятки в каждом
                слое: одна следит за синтаксисом, другая за именами, третья за
                запятыми. Плюс причинная маска — поэтому GPT и пишет слева
                направо.
              </p>
              <p className="my-2 text-sm text-muted">
                📺 К видео: 3Blue1Brown — «Attention in transformers, visually
                explained» и Karpathy — «Let's build GPT» (там attention
                пишется кодом с нуля).
              </p>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Управление" className={glow(st === 7)}>
            <Seg
              options={SENTENCES.map((s, i) => ({ value: String(i), label: s.label }))}
              value={String(sentIdx)}
              onChange={(v) => pickSentence(Number(v))}
            />
            <div className="mt-3.5">
              <div
                className="grid items-center gap-2.5"
                style={{ gridTemplateColumns: "140px 1fr 48px" }}
              >
                <label className="text-[13.5px] text-muted">🎚 резкость взгляда</label>
                <input
                  type="range"
                  className="amber"
                  min={1}
                  max={12}
                  step={0.5}
                  value={sharp}
                  onChange={(e) => setSharp(parseFloat(e.target.value))}
                />
                <output className="text-right font-mono text-[13.5px]">{sharp}</output>
              </div>
              <div className="mt-0.5 text-[12px] text-faint">
                мягко — смотрит на всех почти поровну · резко — упирается в одного
              </div>
            </div>
            <div className="mt-3">
              <Btn
                variant={causal ? "warm" : "normal"}
                onClick={() => {
                  setCausal((c) => !c);
                  setCausalUsed(true);
                }}
              >
                {causal ? "⬅️ маска «только назад» включена" : "включить маску «только назад»"}
              </Btn>
            </div>
          </Card>

          <Card title={`Куда смотрит «${words[sel]}»`} className={glow(st === 2 || st === 3)}>
            {rowW.every((w) => w === 0) ? (
              <div className="text-sm text-muted">
                «{words[sel]}» — первое слово, а маска прячет будущее: смотреть
                не на кого. Ему остаётся собственное значение.
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {words
                  .map((w, j) => ({ w, j }))
                  .filter(({ j }) => j !== sel)
                  .sort((a, b) => rowW[b.j] - rowW[a.j])
                  .map(({ w, j }) => (
                    <div key={j} className="flex items-center gap-2">
                      <span className="w-[110px] truncate text-right font-mono text-[13px] text-soft">
                        {w}
                      </span>
                      <div className="h-[14px] flex-1 overflow-hidden rounded-md bg-[#202938]">
                        <motion.div
                          className="h-full rounded-md bg-accent/80"
                          animate={{ width: `${Math.max(1.5, rowW[j] * 100)}%` }}
                        />
                      </div>
                      <span className="w-[40px] font-mono text-[12px] text-muted">
                        {Math.round(rowW[j] * 100)}%
                      </span>
                    </div>
                  ))}
                <div className="mt-0.5 text-[12px] text-faint">в сумме всегда 100%</div>
              </div>
            )}
          </Card>

          <Card title="Смысл после внимания 🌀" className={glow(st === 5)}>
            {mixture ? (
              <>
                <div className="text-[13.5px] text-soft">
                  смесь, которую собрало «{words[sel]}», ближе всего к словам:
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <AnimatePresence mode="popLayout">
                    {mixture.map((m) => (
                      <motion.span
                        key={m.word}
                        layout
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="rounded-lg border border-[#2d68b8]/50 bg-[#1f3a5f]/50 px-2.5 py-1 font-mono text-[13.5px] text-[#cfe5ff]"
                      >
                        {m.word} <span className="text-muted">{m.sim.toFixed(2)}</span>
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </div>
                <div className="mt-2 text-[12.5px] text-muted">
                  значение слова сдвинулось в сторону контекста — это и есть
                  «понимание» предложения
                </div>
              </>
            ) : (
              <div className="text-sm text-muted">смешивать нечего — нет видимых соседей</div>
            )}
          </Card>

          <Card title="Задания 🏆" className={glow(st === 7)}>
            <ul className="m-0 list-none p-0 text-[14px]">
              {tasks.map((t, i) => (
                <li key={i} className="my-1.5 flex items-start gap-2.5">
                  <motion.span
                    animate={t.done ? { scale: [1, 1.4, 1] } : { scale: 1 }}
                    className={t.done ? "text-ok" : "text-faint"}
                  >
                    {t.done ? "✅" : "⬜"}
                  </motion.span>
                  <span className={t.done ? "text-ok" : "text-soft"}>{t.label}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="🤏 Насколько это честно?">
            <p className="my-1 text-[13.5px] leading-relaxed text-soft">
              Веса честно считаются из наших эмбеддингов + softmax. Упрощено:
              в настоящих трансформерах «интерес» считают обученные матрицы
              Query/Key (а не сырая похожесть), слово смотрит и на себя, голов
              внимания — десятки на слой, и слоёв ~100. Но картинка весов и
              принцип «новый смысл = взвешенная смесь» — ровно те же.
            </p>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
