import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Layout, Card, Btn, Seg } from "../components/ui";
import { StoryPanel, useStory, type StoryStep } from "../components/StoryMode";
import { FlowDots } from "../components/FlowDots";
import { fmt } from "../lib/format";
import {
  PRESETS,
  predict,
  sample,
  fakeEmbedding,
  type Candidate,
  type Prediction,
} from "../lib/tinylm";

/* ---------- история ---------- */

const STEPS: StoryStep[] = [
  {
    emoji: "🗺",
    title: "Весь ИИ играет в одну игру: «угадай следующее слово»",
    text: (
      <>
        Никакой магии: ChatGPT и другие модели делают одно и то же действие
        миллионы раз — смотрят на текст,{" "}
        <b className="text-ink">угадывают следующее слово</b>, приклеивают его и
        повторяют. Внизу — конвейер этого трюка, и он сейчас работает
        по-настоящему: смотри, как рождается слово.
      </>
    ),
  },
  {
    emoji: "✂️",
    title: "Станция 1: текст режут на кусочки — токены",
    text: (
      <>
        Модель не видит «текст» как мы — сначала его нарезают на кусочки,
        токены (tokens). Здесь токен = слово, у настоящих моделей кусочки
        бывают короче («при», «вет»). Это как нарезать овощи, прежде чем
        готовить.
      </>
    ),
  },
  {
    emoji: "🔢",
    title: "Станция 2: каждый токен превращается в столбик чисел",
    text: (
      <>
        Компьютер умеет только считать, поэтому каждому токену выдают столбик
        чисел — эмбеддинг (embedding). Похожие по смыслу слова получают похожие
        числа: «кот» и «кошка» — соседи. На схеме показаны 4 числа,{" "}
        <b className="text-ink">у GPT их тысячи на каждое слово</b>.
      </>
    ),
  },
  {
    emoji: "🧠",
    title: "Станция 3: числа текут через нейросеть",
    text: (
      <>
        А вот и нейроны со страниц 01–04! Числа-эмбеддинги волной проходят
        через слои: каждый нейрон умножает, складывает и передаёт дальше —
        тот самый forward pass. У игрушечной модели тут пара слоёв, у GPT —
        около сотни, и волна пробегает их за доли секунды.
      </>
    ),
  },
  {
    emoji: "🎲",
    title: "Станция 4: на выходе — ставки на каждое слово",
    text: (
      <>
        Сеть выдаёт не одно слово, а <b className="text-ink">вероятности для
        всех слов сразу</b> — как T9 в телефоне, только учитывающий весь смысл
        фразы. Справа — настоящие ставки нашей модели прямо сейчас: длиннее
        полоска — больше шанс быть выбранным.
      </>
    ),
  },
  {
    emoji: "🌡",
    title: "Станция 5: лотерея с ручкой «температура»",
    text: (
      <>
        Слово выбирается случайно, пропорционально ставкам. Температура
        (temperature) крутит смелость лотереи:{" "}
        <b className="text-ink">подвигай оранжевый слайдер</b> и смотри на
        полоски. Холодно (≈0) — всегда самое вероятное слово, скучно и
        предсказуемо. Жарко (2) — шансы выравниваются, начинается креатив и
        бред. Поэтому ИИ отвечает каждый раз по-разному!
      </>
    ),
  },
  {
    emoji: "🔁",
    title: "Выбранное слово приклеивается — и всё сначала",
    text: (
      <>
        Новое слово добавляется к тексту, и конвейер запускается снова: токены
        → числа → сеть → ставки → слово. Смотри, как фраза растёт сама, слово
        за словом. Когда ты ждёшь ответ от ChatGPT — ты ждёшь ровно этот цикл,
        повторяющийся со скоростью десятков слов в секунду.
      </>
    ),
  },
  {
    emoji: "🤏",
    title: "Честно: это модель-игрушка, но трюк — настоящий",
    text: (
      <>
        Наша модель выучила всего ~50 предложений прямо в твоём браузере и
        смотрит только на 2 последних слова. У GPT тот же конвейер, но опыт —
        триллионы слов, а «память» — весь твой разговор. Разница — в масштабе,
        не в принципе. Дальше песочница: выполни задания и поэкспериментируй!
      </>
    ),
  },
];

/* ---------- мини-сеть для станции 3 ---------- */

const MINI_L1 = [14, 34, 54].map((y) => ({ x: 12, y }));
const MINI_L2 = [8, 24, 40, 56].map((y) => ({ x: 52, y }));
const MINI_L3 = [24, 44].map((y) => ({ x: 92, y }));

function MiniNet({ active }: { active: boolean }) {
  const edges: { a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
  for (const a of MINI_L1) for (const b of MINI_L2) edges.push({ a, b });
  for (const a of MINI_L2) for (const b of MINI_L3) edges.push({ a, b });
  return (
    <svg viewBox="0 0 104 68" className="h-[64px] w-full">
      {edges.map((e, i) => (
        <line key={i} x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y} stroke="#2e3950" strokeWidth="1" />
      ))}
      {active &&
        edges.map((e, i) => (
          <FlowDots key={i} from={e.a} to={e.b} count={1} r={1.8} speed={0.9 + (i % 4) * 0.2} color="#9fc4ff" />
        ))}
      {[...MINI_L1, ...MINI_L2, ...MINI_L3].map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="5" fill={active ? "#28456e" : "#1b2330"} stroke="#3a567e" strokeWidth="1" />
      ))}
    </svg>
  );
}

/* ---------- страница ---------- */

const MS = { tokens: 0, embed: 600, net: 1200, probs: 1900, pick: 2700, done: 3400 };

export default function BigPicture() {
  const [presetIdx, setPresetIdx] = useState(0);
  const [context, setContext] = useState<string[]>(PRESETS[0].tokens);
  const [genCount, setGenCount] = useState(0); // слов сгенерировано в текущей фразе
  const [temp, setTemp] = useState(0.8);
  const [phase, setPhase] = useState<number | null>(null); // 0..4 — станции конвейера
  const [choice, setChoice] = useState<Candidate | null>(null);
  const [frozen, setFrozen] = useState<Prediction | null>(null); // ставки в момент выбора
  const [deadEnd, setDeadEnd] = useState(false);
  const [running, setRunning] = useState(false);
  // задания
  const [total, setTotal] = useState(0);
  const [usedPresets, setUsedPresets] = useState<Set<number>>(new Set([0]));
  const [coldUsed, setColdUsed] = useState(false);
  const [hotUsed, setHotUsed] = useState(false);

  const timers = useRef<number[]>([]);
  const phaseRef = useRef<number | null>(null);
  const choiceRef = useRef<Candidate | null>(null);
  const tempRef = useRef(temp);
  tempRef.current = temp;
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const story = useStory(STEPS.length);
  const st = story.step;

  const live = predict(context, temp);

  const setPhaseBoth = (p: number | null) => {
    phaseRef.current = p;
    setPhase(p);
  };

  /** Один проход конвейера: токены → числа → сеть → ставки → слово. */
  const genOne = (speed = 1) => {
    if (phaseRef.current !== null) return;
    const ctx = context;
    const probe = predict(ctx, tempRef.current);
    if (probe.candidates.length === 0) {
      setDeadEnd(true);
      setRunning(false);
      return;
    }
    const at = (ms: number, f: () => void) =>
      timers.current.push(window.setTimeout(f, ms * speed));
    setChoice(null);
    setFrozen(null);
    setPhaseBoth(0);
    at(MS.embed, () => setPhaseBoth(1));
    at(MS.net, () => setPhaseBoth(2));
    at(MS.probs, () => {
      setPhaseBoth(3);
      const pred = predict(ctx, tempRef.current);
      const c = sample(pred.candidates);
      choiceRef.current = c;
      setFrozen(pred);
      setChoice(c);
      if (tempRef.current <= 0.15) setColdUsed(true);
      if (tempRef.current >= 1.8) setHotUsed(true);
    });
    at(MS.pick, () => setPhaseBoth(4));
    at(MS.done, () => {
      const c = choiceRef.current;
      if (c) {
        setContext((cc) => [...cc, c.word]);
        setGenCount((g) => g + 1);
        setTotal((t) => t + 1);
      }
      choiceRef.current = null;
      setChoice(null);
      setFrozen(null);
      setPhaseBoth(null);
    });
  };

  // авто-режим: новый цикл, как только предыдущий закончился
  useEffect(() => {
    if (!running || phase !== null) return;
    if (deadEnd || genCount >= 30) {
      setRunning(false);
      return;
    }
    const id = window.setTimeout(() => genOne(0.45), 150);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, phase, deadEnd, genCount]);

  const reset = (idx = presetIdx) => {
    clearTimers();
    setPhaseBoth(null);
    setRunning(false);
    choiceRef.current = null;
    setChoice(null);
    setFrozen(null);
    setDeadEnd(false);
    setContext(PRESETS[idx].tokens);
    setGenCount(0);
  };

  const pickPreset = (idx: number) => {
    setPresetIdx(idx);
    setUsedPresets((s) => new Set(s).add(idx));
    reset(idx);
  };

  // действия шагов истории
  useEffect(() => {
    clearTimers();
    setRunning(false);
    setPhaseBoth(null);
    if (st === null) return;
    if (st === 0) {
      reset(presetIdx);
      timers.current.push(window.setTimeout(() => genOne(1.25), 800));
    }
    if (st === 6) {
      // несколько слов подряд
      timers.current.push(window.setTimeout(() => setRunning(true), 400));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  // на шагах 1–4 принудительно подсвечиваем нужную станцию
  const displayPhase =
    st !== null && st >= 1 && st <= 4 && phase === null ? st - 1 : phase;

  const lastToken = context[context.length - 1];
  const emb = fakeEmbedding(lastToken);
  const shown = (frozen ?? live).candidates.slice(0, 8);
  const promptLen = PRESETS[presetIdx].tokens.length;

  const glow = (on: boolean) => (on ? "ring-2 ring-accent/70" : "");

  const tasks = [
    { label: "Сгенерируй 10 слов (любых)", done: total >= 10 },
    { label: "Попробуй все 4 стартовые фразы", done: usedPresets.size >= 4 },
    { label: "«Заморозь» модель: слово при температуре ≤ 0.15", done: coldUsed },
    { label: "«Разогрей» до бреда: слово при температуре ≥ 1.8", done: hotUsed },
  ];

  /* станция конвейера */
  const Stage = ({
    idx,
    title,
    children,
  }: {
    idx: number;
    title: string;
    children: React.ReactNode;
  }) => (
    <div
      className={`min-w-[150px] flex-1 rounded-xl border bg-panel2 px-3 py-2.5 transition-all ${
        displayPhase === idx
          ? "border-accent shadow-[0_0_14px_rgba(88,166,255,.25)]"
          : "border-edge opacity-80"
      }`}
    >
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {idx + 1} · {title}
      </div>
      {children}
    </div>
  );

  const Arrow = ({ after }: { after: number }) => (
    <motion.span
      className="self-center text-[20px] text-faint max-md:hidden"
      animate={
        displayPhase !== null && displayPhase > after
          ? { color: "#58a6ff", opacity: 1 }
          : displayPhase === after
            ? { opacity: [0.3, 1, 0.3] }
            : { opacity: 0.35 }
      }
      transition={displayPhase === after ? { repeat: Infinity, duration: 0.9 } : {}}
    >
      →
    </motion.span>
  );

  return (
    <Layout crumb="00 · Общая картина" crumbEn="the big picture">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Как ИИ пишет ответ — вся картина целиком
      </h1>
      <p className="mb-4 max-w-[940px] text-muted">
        Текст заходит слева, ответ выходит справа — а внутри один и тот же
        конвейер, повторяющийся для каждого слова. Здесь он работает
        по-настоящему: крошечная модель обучилась на ~50 предложениях прямо в
        твоём браузере, и все вероятности честные.
      </p>

      <StoryPanel
        steps={STEPS}
        step={story.step}
        setStep={story.setStep}
        next={story.next}
        prev={story.prev}
        sandboxText="Меняй стартовую фразу, крути температуру и генерируй — конвейер каждый раз проживает полный цикл."
      />

      {/* конвейер */}
      <Card title="Конвейер предсказания следующего слова" className="mb-4">
        <div className="flex flex-wrap gap-2">
          <Stage idx={0} title="Токены">
            <div className="flex flex-wrap gap-1">
              {context.slice(-4).map((t, i) => (
                <span
                  key={`${t}${i}`}
                  className="rounded-md border border-[#2d68b8]/60 bg-[#1f3a5f]/60 px-1.5 py-0.5 font-mono text-[12px] text-[#cfe5ff]"
                >
                  {t}
                </span>
              ))}
            </div>
            <div className="mt-1.5 text-[11px] text-faint">
              {context.length > 4 && `…ещё ${context.length - 4} · `}текст нарезан
            </div>
          </Stage>
          <Arrow after={0} />
          <Stage idx={1} title="Числа (эмбеддинг)">
            <div className="font-mono text-[12px] leading-snug text-soft">
              <span className="text-[#cfe5ff]">{lastToken}</span> → [
              {emb.map((v, i) => (
                <span key={i}>
                  {fmt(v)}
                  {i < emb.length - 1 ? ", " : ""}
                </span>
              ))}
              ]
            </div>
            <div className="mt-1.5 text-[11px] text-faint">
              упрощённо: 4 числа из тысяч
            </div>
          </Stage>
          <Arrow after={1} />
          <Stage idx={2} title="Нейросеть">
            <MiniNet active={displayPhase === 2} />
          </Stage>
          <Arrow after={2} />
          <Stage idx={3} title="Ставки">
            <div className="flex flex-col gap-1">
              {shown.slice(0, 3).map((c) => (
                <div key={c.word} className="flex items-center gap-1.5">
                  <div className="h-[7px] rounded-sm bg-accent/70" style={{ width: `${Math.max(6, c.p * 70)}px` }} />
                  <span className="font-mono text-[11px] text-soft">{c.word}</span>
                </div>
              ))}
            </div>
            <div className="mt-1.5 text-[11px] text-faint">шанс каждого слова</div>
          </Stage>
          <Arrow after={3} />
          <Stage idx={4} title="Новое слово">
            <div className="flex h-[44px] items-center">
              <AnimatePresence mode="wait">
                {choice && displayPhase !== null && displayPhase >= 4 ? (
                  <motion.span
                    key={choice.word}
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="rounded-lg border border-ok/60 bg-ok/10 px-2.5 py-1 font-mono text-[15px] font-bold text-ok"
                  >
                    {choice.word}
                  </motion.span>
                ) : (
                  <span className="font-mono text-[15px] text-faint">?</span>
                )}
              </AnimatePresence>
            </div>
            <div className="text-[11px] text-faint">приклеится к тексту →</div>
          </Stage>
        </div>
      </Card>

      <div className="grid grid-cols-[1.05fr_.95fr] items-start gap-4 max-lg:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Card title="Текст (растёт на глазах)">
            <div className="mb-3">
              <Seg
                options={PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
                value={String(presetIdx)}
                onChange={(v) => pickPreset(Number(v))}
              />
            </div>
            <div className="min-h-[84px] rounded-lg border border-edge bg-[#0e131b] px-3.5 py-3 text-[16px] leading-[2.1]">
              {context.map((t, i) => (
                <motion.span
                  key={`${i}-${t}`}
                  initial={i >= promptLen ? { opacity: 0, y: 6, scale: 0.85 } : false}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  className={`mr-1.5 inline-block rounded-md px-1.5 ${
                    i < promptLen
                      ? "bg-panel2 text-muted"
                      : "border border-[#2d68b8]/40 bg-[#1f3a5f]/50 text-[#cfe5ff]"
                  }`}
                >
                  {t}
                </motion.span>
              ))}
              {phase !== null && (
                <motion.span
                  className="inline-block h-[18px] w-[9px] translate-y-[3px] bg-accent"
                  animate={{ opacity: [1, 0.2, 1] }}
                  transition={{ repeat: Infinity, duration: 0.8 }}
                />
              )}
            </div>
            {deadEnd && (
              <div className="mt-2.5 rounded-lg border border-[#7a5226] bg-[#3d2a16]/60 px-3 py-2 text-[13.5px] text-amber">
                🛑 Модель «закончила мысль»: такого сочетания слов она в своих
                50 предложениях не видела. Нажми «⟳ Сначала» или смени фразу —
                у настоящих LLM словарь больше в миллионы раз.
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn variant="primary" onClick={() => genOne()} disabled={phase !== null || deadEnd}>
                ▶ Следующее слово
              </Btn>
              <Btn onClick={() => setRunning((r) => !r)} disabled={deadEnd}>
                {running ? "⏸ Стоп" : "▶▶ Авто"}
              </Btn>
              <Btn onClick={() => reset()}>⟳ Сначала</Btn>
            </div>
            <div className={`mt-4 rounded-lg px-2 py-1 ${glow(st === 5)}`}>
              <div
                className="grid items-center gap-2.5"
                style={{ gridTemplateColumns: "150px 1fr 56px" }}
              >
                <label className="text-[13.5px] text-muted">
                  🌡 температура
                </label>
                <input
                  type="range"
                  className="amber"
                  min={0.05}
                  max={2}
                  step={0.05}
                  value={temp}
                  onChange={(e) => setTemp(parseFloat(e.target.value))}
                />
                <output className="text-right font-mono text-[13.5px]">{fmt(temp)}</output>
              </div>
              <div className="mt-0.5 text-[12px] text-faint">
                0.05 — «робот»: всегда самое вероятное · 0.8 — живо · 2 — лотерея почти без правил
              </div>
            </div>
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
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Ставки на следующее слово (честные)" className={glow(st === 4)}>
            {shown.length === 0 ? (
              <div className="text-sm text-muted">модель не знает продолжения 🤷</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {shown.map((c) => {
                  const isChoice = choice?.word === c.word && phase !== null && phase >= 3;
                  return (
                    <motion.div layout key={c.word} className="flex items-center gap-2">
                      <span
                        className={`w-[92px] truncate text-right font-mono text-[13px] ${
                          isChoice ? "font-bold text-ok" : "text-soft"
                        }`}
                      >
                        {c.word}
                      </span>
                      <div className="h-[16px] flex-1 overflow-hidden rounded-md bg-[#202938]">
                        <motion.div
                          className={`h-full rounded-md ${isChoice ? "bg-ok" : "bg-accent/80"}`}
                          animate={{ width: `${Math.max(2, c.p * 100)}%` }}
                          transition={{ type: "spring", stiffness: 160, damping: 26 }}
                        />
                      </div>
                      <span className={`w-[44px] font-mono text-[12px] ${isChoice ? "text-ok" : "text-muted"}`}>
                        {(c.p * 100).toFixed(0)}%
                        {isChoice ? " 🎯" : ""}
                      </span>
                    </motion.div>
                  );
                })}
              </div>
            )}
            <div className="mt-2.5 text-[12px] text-muted">
              {live.source === "trigram" &&
                `модель смотрит на 2 последних слова: «${live.contextUsed.join(" ")}»`}
              {live.source === "bigram" &&
                `модель смотрит на последнее слово: «${live.contextUsed.join(" ")}»`}
              {live.source === "none" && "контекст модели не знаком"}
              {" "}· шансы пересчитаны под текущую температуру
            </div>
          </Card>

          <Card title="🤏 Насколько это честно?">
            <p className="my-1 text-[13.5px] leading-relaxed text-soft">
              Всё, что ты видишь, по-настоящему вычисляется в браузере: модель
              обучена на ~50 встроенных предложениях, ставки — реальная
              статистика «какое слово шло дальше», лотерея и температура —
              честные. Упрощено главное: настоящая LLM смотрит на{" "}
              <b className="text-ink">весь текст сразу</b> (а не на 2 слова) и
              выучила <b className="text-ink">триллионы слов</b> (а не 50
              предложений). Конвейер — тот же.
            </p>
          </Card>

          {st === null && (
            <Card title="Что здесь происходит">
              <p className="my-2 max-w-[1000px] text-soft">
                Это автодополнение на стероидах: токенизация → эмбеддинги →
                forward pass → распределение вероятностей → сэмплирование — и
                так для каждого слова. Каждая станция конвейера разобрана
                отдельной страницей этого сайта (нейрон, forward pass), а
                остальные — токенизация, attention, сэмплирование — на подходе
                в блоке 2 роадмапа.
              </p>
              <p className="my-2 text-sm text-muted">
                📺 К видео: 3Blue1Brown — «But what is a GPT?» и Karpathy —
                «Let's build GPT from scratch» (там этот конвейер собирается в
                коде целиком).
              </p>
            </Card>
          )}
        </div>
      </div>
    </Layout>
  );
}
