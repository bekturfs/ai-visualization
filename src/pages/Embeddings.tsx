import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Layout, Card } from "../components/ui";
import { StoryPanel, useStory, type StoryStep } from "../components/StoryMode";
import { EMB, THEME_COLORS } from "../lib/embeddings";

const STEPS: StoryStep[] = [
  {
    emoji: "🗺",
    title: "Слова надо превратить в числа — но не как попало",
    text: (
      <>
        Компьютер умеет сравнивать только числа. Если выдать словам случайные
        номера, «кот» и «кошка» окажутся такими же чужими, как «кот» и
        «трактор». Эмбеддинг (embedding) — это{" "}
        <b className="text-ink">координаты слова на карте смыслов</b>: похожие
        по смыслу слова должны оказаться рядом. Перед тобой такая карта —
        настоящая, построенная прямо в браузере.
      </>
    ),
  },
  {
    emoji: "🧦",
    title: "Откуда берётся смысл? «Скажи, кто твои соседи»",
    text: (
      <>
        Секрет: слова, которые встречаются{" "}
        <b className="text-ink">в одинаковом окружении</b>, обычно близки по
        смыслу. «Зимой идёт снег», «осенью идёт дождь» — у «зимой» и «осенью»
        одинаковая компания. Мы взяли корпус из ~50 предложений с прошлых
        страниц, посчитали, кто с кем стоит рядом, — и координаты получились
        сами, без единой подсказки о смысле.
      </>
    ),
  },
  {
    emoji: "🎨",
    title: "Смотри: темы сами собрались в кучки",
    text: (
      <>
        Цвет точки — тема предложений, откуда слово пришло:{" "}
        <span style={{ color: THEME_COLORS["сказка"] }}>сказка</span>,{" "}
        <span style={{ color: THEME_COLORS["погода"] }}>погода</span>,{" "}
        <span style={{ color: THEME_COLORS["животные"] }}>животные</span>,{" "}
        <span style={{ color: THEME_COLORS["нейросети"] }}>нейросети</span>.
        Алгоритму никто не говорил, что «снег» и «зимой» — родня. Он увидел
        это в текстах. Серые точки — слова без своей темы: служебные («и»,
        «на») и «общие», кочующие между темами. У GPT так же — только текстов
        в миллиард раз больше.
      </>
    ),
  },
  {
    emoji: "🖱",
    title: "Кликни любое слово",
    text: (
      <>
        Клик по слову подсвечивает его ближайших соседей, а справа появляется
        список с числами похожести.{" "}
        <b className="text-ink">Попробуй «нейросеть»</b> — её лучший друг
        «модель» со сходством 0.82, хотя в этих словах нет ни одной общей
        буквы. Сходство — про смысл, не про написание.
      </>
    ),
  },
  {
    emoji: "📏",
    title: "Похожесть — это просто число",
    text: (
      <>
        В карточке «Сравни два слова» можно измерить похожесть любой пары:
        1.00 — близнецы, около нуля — ничего общего. Именно так ИИ-поиск
        находит документы «по смыслу», а не по совпадению слов: сравнивает
        эмбеддинги запроса и документов.
      </>
    ),
  },
  {
    emoji: "🏆",
    title: "Честность и задания",
    text: (
      <>
        У настоящих моделей у каждого слова{" "}
        <b className="text-ink">тысячи координат</b>, а не две — наша карта это
        проекция-«тень» на плоскость, и она выучена всего на 50 предложениях.
        Но принцип ровно тот же: смысл — из соседства. Дальше песочница:
        выполни задания справа.
      </>
    ),
  },
];

export default function Embeddings() {
  const { points, vocab, cosine, neighbors } = EMB;

  /* нормализация координат в видимую область */
  const layout = useMemo(() => {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const W = 640,
      H = 440,
      pad = 46;
    return points.map((p, i) => ({
      ...p,
      px: pad + ((p.x - x0) / (x1 - x0 + 1e-9)) * (W - 2 * pad) + ((i % 5) - 2) * 2,
      py: pad + ((p.y - y0) / (y1 - y0 + 1e-9)) * (H - 2 * pad) + ((i % 3) - 1) * 3,
    }));
  }, [points]);

  const [selected, setSelected] = useState<string | null>(null);
  const [pairA, setPairA] = useState("зимой");
  const [pairB, setPairB] = useState("летом");
  const [clickedThemes, setClickedThemes] = useState<Set<string>>(new Set());
  const [hiSimSeen, setHiSimSeen] = useState(false);
  const [loSimSeen, setLoSimSeen] = useState(false);

  const story = useStory(STEPS.length);
  const st = story.step;

  // на шаге 3 истории заранее выбираем «нейросеть»
  useEffect(() => {
    if (st === 3) setSelected("нейросеть");
  }, [st]);

  const pairSim = cosine(pairA, pairB);
  useEffect(() => {
    if (pairSim >= 0.7) setHiSimSeen(true);
    if (pairSim <= 0.05) setLoSimSeen(true);
  }, [pairSim]);

  const nbrs = selected ? neighbors(selected, 5) : [];
  const nbrSet = new Map(nbrs.map((n) => [n.word, n.sim]));
  const selPoint = layout.find((p) => p.word === selected);

  const pick = (w: string, theme: string) => {
    setSelected((s) => (s === w ? null : w));
    setClickedThemes((s) => new Set(s).add(theme));
  };

  const themesNeeded = ["сказка", "погода", "животные", "нейросети"];
  const tasks = [
    { label: "Кликни слово и изучи его соседей", done: clickedThemes.size > 0 },
    {
      label: "Кликни по слову из каждой из 4 тем",
      done: themesNeeded.every((t) => clickedThemes.has(t)),
    },
    { label: "Найди пару слов со сходством ≥ 0.7", done: hiSimSeen },
    { label: "Найди пару со сходством ≤ 0.05 (чужие слова)", done: loSimSeen },
  ];

  const glow = (on: boolean) => (on ? "ring-2 ring-accent/70" : "");
  const sortedVocab = useMemo(() => [...vocab].sort(), [vocab]);

  return (
    <Layout crumb="06 · Эмбеддинги" crumbEn="embeddings">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Слова как точки на карте смыслов
      </h1>
      <p className="mb-4 max-w-[940px] text-muted">
        <b className="text-ink">Эмбеддинги отвечают за «понимание» похожести:</b>{" "}
        каждое слово получает координаты так, чтобы близкие по смыслу слова
        оказались рядом. Карта ниже честно вычислена из корпуса: совместная
        встречаемость → PPMI → проекция в 2D.
      </p>

      <StoryPanel
        steps={STEPS}
        step={story.step}
        setStep={story.setStep}
        next={story.next}
        prev={story.prev}
        sandboxText="Кликай по словам, сравнивай пары. Цвет — тема, расстояние — похожесть употребления."
      />

      <div className="grid grid-cols-[1.15fr_.85fr] items-start gap-4 max-lg:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Card title={`Карта смыслов (${points.length} слов корпуса)`} className={glow(st !== null && st <= 3)}>
            <svg viewBox="0 0 640 440" aria-label="Карта эмбеддингов слов">
              {/* линии к соседям выбранного слова */}
              {selPoint &&
                nbrs.map((n) => {
                  const np = layout.find((p) => p.word === n.word)!;
                  return (
                    <line
                      key={n.word}
                      x1={selPoint.px}
                      y1={selPoint.py}
                      x2={np.px}
                      y2={np.py}
                      stroke="#58a6ff"
                      strokeWidth={1 + n.sim * 3}
                      strokeOpacity={0.25 + n.sim * 0.5}
                    />
                  );
                })}
              {layout.map((p) => {
                const isSel = p.word === selected;
                const isNbr = nbrSet.has(p.word);
                const dim = selected && !isSel && !isNbr;
                return (
                  <g
                    key={p.word}
                    onClick={() => pick(p.word, p.theme)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pick(p.word, p.theme);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`слово «${p.word}» — показать соседей`}
                    aria-pressed={isSel}
                    style={{ cursor: "pointer", outline: "none" }}
                    opacity={dim ? 0.3 : 1}
                  >
                    <circle
                      cx={p.px}
                      cy={p.py}
                      r={isSel ? 8 : 4 + Math.min(3, p.freq / 4)}
                      fill={THEME_COLORS[p.theme]}
                      stroke={isSel ? "#e7edf4" : "none"}
                      strokeWidth={isSel ? 2 : 0}
                    />
                    <text
                      x={p.px}
                      y={p.py - (isSel ? 14 : 9)}
                      textAnchor="middle"
                      fontSize={isSel ? 13 : 10.5}
                      fontWeight={isSel || isNbr ? 700 : 400}
                      fill={dim ? "#5b6878" : isSel ? "#e7edf4" : "#c2cdda"}
                    >
                      {p.word}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className={`mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] ${glow(st === 2)}`}>
              {Object.entries(THEME_COLORS).map(([t, c]) => (
                <span key={t} className="flex items-center gap-1.5 text-muted">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
                  {t}
                </span>
              ))}
            </div>
          </Card>

          {st === null && (
            <Card title="Что здесь происходит">
              <p className="my-2 max-w-[1000px] text-soft">
                Это «дистрибутивная семантика»: смысл слова — это распределение
                его соседей. Мы считаем матрицу совместной встречаемости (окно
                ±3 слова), взвешиваем её PPMI (чтобы случайные совпадения не
                мешали), и вектор каждого слова — строка этой матрицы. Похожесть
                — косинус угла между векторами, карта — проекция на два главных
                направления. Настоящие эмбеддинги (word2vec, эмбеддинги внутри
                GPT) учатся иначе технически, но ловят ту же закономерность —
                просто из триллионов слов.
              </p>
              <p className="my-2 text-sm text-muted">
                📺 К видео: 3Blue1Brown — «But what is a GPT?» (часть про
                эмбеддинги и направления смысла).
              </p>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card title={selected ? `Соседи слова «${selected}»` : "Соседи слова"} className={glow(st === 3)}>
            {selected ? (
              <div className="flex flex-col gap-1.5">
                {nbrs.map((n) => (
                  <div key={n.word} className="flex items-center gap-2">
                    <span className="w-[110px] truncate text-right font-mono text-[13px] text-soft">
                      {n.word}
                    </span>
                    <div className="h-[14px] flex-1 overflow-hidden rounded-md bg-[#202938]">
                      <motion.div
                        className="h-full rounded-md bg-accent/80"
                        animate={{ width: `${Math.max(2, n.sim * 100)}%` }}
                      />
                    </div>
                    <span className="w-[40px] font-mono text-[12px] text-muted">
                      {n.sim.toFixed(2)}
                    </span>
                  </div>
                ))}
                <div className="mt-1 text-[12px] text-faint">
                  сходство 1.00 — близнецы · 0 — ничего общего
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted">
                кликни по любому слову на карте слева
              </div>
            )}
          </Card>

          <Card title="Сравни два слова" className={glow(st === 4)}>
            <div className="flex items-center gap-2">
              {[
                { v: pairA, set: setPairA },
                { v: pairB, set: setPairB },
              ].map(({ v, set }, i) => (
                <select
                  key={i}
                  value={v}
                  onChange={(e) => set(e.target.value)}
                  className="flex-1 cursor-pointer rounded-lg border border-[#344158] bg-[#202938] px-2 py-1.5 font-mono text-[13.5px] text-ink outline-none focus:border-accent"
                >
                  {sortedVocab.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="h-[18px] flex-1 overflow-hidden rounded-md bg-[#202938]">
                <motion.div
                  className={`h-full rounded-md ${pairSim >= 0.5 ? "bg-ok" : pairSim >= 0.2 ? "bg-accent/80" : "bg-hot/70"}`}
                  animate={{ width: `${Math.max(2, Math.min(1, Math.abs(pairSim)) * 100)}%` }}
                />
              </div>
              <span className="w-[48px] font-mono text-[14px] font-semibold text-ink">
                {pairSim.toFixed(2)}
              </span>
            </div>
            <div className="mt-1.5 text-[12.5px] text-muted">
              {pairSim >= 0.6
                ? "очень близкая компания — почти синонимы по употреблению"
                : pairSim >= 0.3
                  ? "заметно похожее окружение"
                  : pairSim >= 0.1
                    ? "слабое родство"
                    : "почти чужие: в корпусе у них разная компания"}
            </div>
          </Card>

          <Card title="Задания 🏆" className={glow(st === 5)}>
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
              Числа честные: встречаемость, PPMI и косинусы посчитаны по
              корпусу при загрузке страницы. Упрощено: показаны только слова,
              встречающиеся 2+ раза; координат всего две (у настоящих моделей —
              тысячи, мы видим «тень»); и корпус крошечный, поэтому у редких
              слов соседи бывают странные — настоящим моделям это лечит
              масштаб.
            </p>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
