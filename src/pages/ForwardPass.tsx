import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Layout, Card, SliderRow, Btn, AnimatedNumber } from "../components/ui";
import { StoryPanel, useStory, type StoryStep } from "../components/StoryMode";
import { FlowDots } from "../components/FlowDots";
import { fmt, par } from "../lib/format";

const sig = (z: number) => 1 / (1 + Math.exp(-z));
const rnd = () => Math.round((Math.random() * 2 - 1) * 100) / 100;

/* ---------- геометрия сети 2–3–2 ---------- */
const P_IN = [
  { x: 75, y: 135 },
  { x: 75, y: 245 },
];
const P_H = [
  { x: 280, y: 75 },
  { x: 280, y: 190 },
  { x: 280, y: 305 },
];
const P_O = [
  { x: 480, y: 135 },
  { x: 480, y: 245 },
];
const R = 27;

type NodeId = "h1" | "h2" | "h3" | "y1" | "y2";

const STEPS: StoryStep[] = [
  {
    emoji: "🏭",
    title: "Сеть — это конвейер из нейронов",
    text: (
      <>
        Каждый кружок на схеме — тот самый нейрон с прошлой страницы: умножил,
        сложил, пропустил через sigmoid. Нейроны выстроены в слои (layers):
        входной → скрытый → выходной. Данные текут только слева направо —
        поэтому процесс называется forward pass, «прямой проход».
      </>
    ),
  },
  {
    emoji: "📥",
    title: "Входной слой — просто числа",
    text: (
      <>
        Два левых кружка ничего не вычисляют — это входные данные, наши
        «факты» x1 и x2. В настоящих сетях здесь могут быть яркости 784
        пикселей картинки с цифрой (как у 3Blue1Brown) — принцип тот же.
      </>
    ),
  },
  {
    emoji: "⚙️",
    title: "Волна №1: скрытый слой",
    text: (
      <>
        Смотри: сигналы побежали к скрытому слою (hidden layer)! Каждый из трёх
        нейронов смотрит на <b className="text-ink">одни и те же входы</b>, но
        со <b className="text-ink">своими весами</b> — поэтому каждый «замечает»
        в данных что-то своё. Один может реагировать на «x1 большой», другой —
        на «x2 отрицательный». Формулы их вычислений — справа.
      </>
    ),
  },
  {
    emoji: "🎯",
    title: "Волна №2: выходной слой — ответ сети",
    text: (
      <>
        Вторая волна: выходные нейроны складывают мнения скрытого слоя — снова
        со своими весами — и выдают ответ сети, y1 и y2. Если бы сеть угадывала
        «кошка или собака», y1 и y2 были бы уверенностью в каждом варианте.
        Вот и весь forward pass: две волны умножений и сложений.
      </>
    ),
  },
  {
    emoji: "🔍",
    title: "Загляни внутрь любого нейрона",
    text: (
      <>
        <b className="text-ink">Кликни на любой кружок</b> скрытого или
        выходного слоя — справа появится его личная формула с настоящими
        числами, а на схеме подсветятся только его провода. Убедись: внутри нет
        никакой магии, только знакомое «умножь и сложи».
      </>
    ),
  },
  {
    emoji: "🌊",
    title: "Сеть теперь живая",
    text: (
      <>
        Когда обе волны прошли, сеть пересчитывается мгновенно:{" "}
        <b className="text-ink">подвигай слайдеры x1 и x2</b> — значения волной
        прокатываются по всем слоям. Нажми «🎲 случайные веса» — и та же сеть
        начнёт давать совсем другие ответы. Вся «личность» сети — в её весах.
      </>
    ),
  },
  {
    emoji: "🏆",
    title: "Проверь себя!",
    text: (
      <>
        В песочнице выполни задания: разгони выход y1 почти до единицы, загляни
        внутрь нейронов, сравняй выходы. Помни: в ChatGPT происходит ровно это
        же — только слоёв около сотни, а чисел — миллиарды.
      </>
    ),
  },
];

export default function ForwardPass() {
  const [x, setX] = useState([0.8, 0.2]);
  const [W1, setW1] = useState([
    [0.62, -0.41],
    [0.35, 0.84],
    [-0.72, 0.2],
  ]);
  const [b1, setB1] = useState([0.1, -0.3, 0.25]);
  const [W2, setW2] = useState([
    [1.1, -0.85, 0.4],
    [-0.5, 0.74, 0.61],
  ]);
  const [b2, setB2] = useState([0.05, -0.15]);

  // stage: 0 — ничего, 1 — скрытый слой посчитан, 2 — вся сеть (живой режим)
  const [stage, setStage] = useState(0);
  const [wave, setWave] = useState<null | "ih" | "ho">(null);
  const [selected, setSelected] = useState<NodeId | null>(null);
  const [waveCount, setWaveCount] = useState(0);
  const [peeked, setPeeked] = useState(false);
  const timers = useRef<number[]>([]);

  const story = useStory(STEPS.length);
  const st = story.step;

  const h = b1.map((bb, j) => sig(W1[j][0] * x[0] + W1[j][1] * x[1] + bb));
  const y = b2.map(
    (bb, k) => sig(W2[k][0] * h[0] + W2[k][1] * h[1] + W2[k][2] * h[2] + bb),
  );

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  /** Анимированная волна: 0 → скрытый → выходной. */
  const runWave = useCallback(() => {
    clearTimers();
    setStage(0);
    setWave("ih");
    timers.current.push(
      window.setTimeout(() => setStage(1), 850),
      window.setTimeout(() => setWave("ho"), 950),
      window.setTimeout(() => setStage(2), 1800),
      window.setTimeout(() => {
        setWave(null);
        setWaveCount((c) => c + 1);
      }, 1900),
    );
  }, []);

  // шаги истории сами запускают волны
  useEffect(() => {
    if (st === null) return;
    if (st <= 1) {
      clearTimers();
      setStage(0);
      setWave(null);
      setSelected(null);
    }
    if (st === 2) {
      clearTimers();
      setStage(0);
      setWave("ih");
      timers.current.push(window.setTimeout(() => setStage(1), 850));
      timers.current.push(window.setTimeout(() => setWave(null), 1100));
    }
    if (st === 3) {
      clearTimers();
      setStage(1);
      setWave("ho");
      timers.current.push(window.setTimeout(() => setStage(2), 850));
      timers.current.push(window.setTimeout(() => setWave(null), 1100));
    }
    if (st >= 4) {
      clearTimers();
      setWave(null);
      setStage(2);
    }
  }, [st]);

  const randomize = () => {
    setW1((m) => m.map((r) => r.map(rnd)));
    setB1((v) => v.map(rnd));
    setW2((m) => m.map((r) => r.map(rnd)));
    setB2((v) => v.map(rnd));
  };

  const nodeVal = (id: NodeId): number | null => {
    if (id.startsWith("h")) return stage >= 1 ? h[+id[1] - 1] : null;
    return stage >= 2 ? y[+id[1] - 1] : null;
  };

  /* подсветка рёбер: выбранный нейрон затемняет остальные */
  const edgeDim = (kind: "ih" | "ho", to: number) => {
    if (selected) {
      const sKind = selected.startsWith("h") ? "ih" : "ho";
      const sIdx = +selected[1] - 1;
      return kind === sKind && to === sIdx ? 1 : 0.12;
    }
    if (st === 2 || wave === "ih") return kind === "ih" ? 1 : 0.25;
    if (st === 3 || wave === "ho") return kind === "ho" ? 1 : 0.25;
    return 0.85;
  };

  const glow = (on: boolean) => (on ? "ring-2 ring-accent/70" : "");

  /* карточка-детализация выбранного нейрона */
  const detail = (() => {
    if (!selected) return null;
    const i = +selected[1] - 1;
    if (selected.startsWith("h")) {
      const zz = W1[i][0] * x[0] + W1[i][1] * x[1] + b1[i];
      return {
        name: `h${i + 1} (скрытый слой)`,
        inputs: [
          { label: "x1", w: W1[i][0], v: x[0] },
          { label: "x2", w: W1[i][1], v: x[1] },
        ],
        b: b1[i],
        z: zz,
        a: sig(zz),
        known: stage >= 1,
      };
    }
    const zz = W2[i][0] * h[0] + W2[i][1] * h[1] + W2[i][2] * h[2] + b2[i];
    return {
      name: `y${i + 1} (выходной слой)`,
      inputs: [
        { label: "h1", w: W2[i][0], v: h[0] },
        { label: "h2", w: W2[i][1], v: h[1] },
        { label: "h3", w: W2[i][2], v: h[2] },
      ],
      b: b2[i],
      z: zz,
      a: sig(zz),
      known: stage >= 2,
    };
  })();

  const tasks = [
    { label: "Прогони волну целиком (кнопка «▶ Прогнать волну»)", done: waveCount > 0 },
    { label: "Загляни внутрь нейрона (клик по кружку)", done: peeked },
    { label: "Разгони выход: y1 > 0.85", done: stage === 2 && y[0] > 0.85 },
    {
      label: "Сравняй выходы: |y1 − y2| < 0.03",
      done: stage === 2 && Math.abs(y[0] - y[1]) < 0.03,
    },
  ];

  const Node = ({
    id,
    p,
    label,
    clickable,
  }: {
    id: NodeId | "x1" | "x2";
    p: { x: number; y: number };
    label: string;
    clickable: boolean;
  }) => {
    const isInput = id === "x1" || id === "x2";
    const v = isInput ? x[+id[1] - 1] : nodeVal(id as NodeId);
    const norm = v === null ? 0 : isInput ? (v + 1) / 2 : v;
    const n = Math.min(Math.max(norm, 0), 1);
    const sel = selected === id;
    const toggle = () => {
      setSelected((s) => (s === id ? null : (id as NodeId)));
      setPeeked(true);
    };
    return (
      <g
        onClick={clickable ? toggle : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              }
            : undefined
        }
        tabIndex={clickable ? 0 : undefined}
        role={clickable ? "button" : undefined}
        aria-label={
          clickable ? `нейрон ${label} — показать его формулу` : undefined
        }
        aria-pressed={clickable ? sel : undefined}
        style={{ cursor: clickable ? "pointer" : "default", outline: "none" }}
      >
        <motion.circle
          cx={p.x}
          cy={p.y}
          r={R}
          animate={{
            fill:
              v === null
                ? "#1b2330"
                : `hsl(213, ${Math.round(55 + n * 20)}%, ${(14 + n * 52).toFixed(0)}%)`,
            scale: v === null ? 1 : [1, 1.12, 1],
          }}
          transition={{ duration: 0.45 }}
          stroke={sel ? "#ffa657" : v === null ? "#3a465c" : `hsl(213,70%,${(28 + n * 30).toFixed(0)}%)`}
          strokeWidth={sel ? 3 : 1.6}
          style={
            sel
              ? { filter: "drop-shadow(0 0 8px rgba(255,166,87,.7))" }
              : undefined
          }
        />
        <text x={p.x} y={p.y - R - 9} textAnchor="middle" fontSize="13" fill="#8b98ab">
          {label}
        </text>
        <text
          x={p.x}
          y={p.y + 5}
          textAnchor="middle"
          fontSize="13.5"
          fill={v === null ? "#5b6878" : n > 0.6 ? "#0d1117" : "#e7edf4"}
        >
          {v === null ? "?" : fmt(v)}
        </text>
      </g>
    );
  };

  return (
    <Layout crumb="02 · Forward pass" crumbEn="прямой проход через сеть">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Как данные текут через слои
      </h1>
      <p className="mb-4 max-w-[900px] text-muted">
        Сеть 2–3–2: входной слой (input layer), скрытый слой (hidden layer),
        выходной слой (output layer). Каждый нейрон считает σ(w·x + b) от
        выходов предыдущего слоя.
      </p>

      <StoryPanel
        steps={STEPS}
        step={story.step}
        setStep={story.setStep}
        next={story.next}
        prev={story.prev}
        sandboxText="Двигай входы, запускай волну, кликай по нейронам. Толщина связи — |w|, цвет — знак веса."
      />

      <div className="grid grid-cols-[1.05fr_.95fr] items-start gap-4 max-lg:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Card title="Сеть 2–3–2 (активация — sigmoid)">
            <svg viewBox="0 0 560 380" aria-label="Нейросеть 2-3-2">
              {/* рёбра вход → скрытый */}
              {W1.map((row, j) =>
                row.map((w, i) => (
                  <g key={`ih${j}${i}`} opacity={edgeDim("ih", j)}>
                    <line
                      x1={P_IN[i].x}
                      y1={P_IN[i].y}
                      x2={P_H[j].x}
                      y2={P_H[j].y}
                      stroke={w >= 0 ? "#58a6ff" : "#f0564f"}
                      strokeWidth={1 + Math.abs(w) * 3.2}
                      strokeOpacity={0.85}
                    >
                      <title>{`w = ${fmt(w)}`}</title>
                    </line>
                    <FlowDots
                      from={P_IN[i]}
                      to={P_H[j]}
                      count={2}
                      r={2.8}
                      color={w >= 0 ? "#9fc4ff" : "#ff9b95"}
                      speed={wave === "ih" ? 1.1 : 0.35}
                      active={wave === "ih" || (stage === 2 && st === null)}
                      opacity={wave === "ih" ? 1 : 0.35}
                    />
                  </g>
                )),
              )}
              {/* рёбра скрытый → выход */}
              {W2.map((row, k) =>
                row.map((w, j) => (
                  <g key={`ho${k}${j}`} opacity={edgeDim("ho", k)}>
                    <line
                      x1={P_H[j].x}
                      y1={P_H[j].y}
                      x2={P_O[k].x}
                      y2={P_O[k].y}
                      stroke={w >= 0 ? "#58a6ff" : "#f0564f"}
                      strokeWidth={1 + Math.abs(w) * 3.2}
                      strokeOpacity={0.85}
                    >
                      <title>{`w = ${fmt(w)}`}</title>
                    </line>
                    <FlowDots
                      from={P_H[j]}
                      to={P_O[k]}
                      count={2}
                      r={2.8}
                      color={w >= 0 ? "#9fc4ff" : "#ff9b95"}
                      speed={wave === "ho" ? 1.1 : 0.35}
                      active={wave === "ho" || (stage === 2 && st === null)}
                      opacity={wave === "ho" ? 1 : 0.35}
                    />
                  </g>
                )),
              )}

              <g opacity={st === 1 ? 1 : st !== null && st < 4 && st >= 1 ? 0.9 : 1}>
                <Node id="x1" p={P_IN[0]} label="x1" clickable={false} />
                <Node id="x2" p={P_IN[1]} label="x2" clickable={false} />
              </g>
              <Node id="h1" p={P_H[0]} label="h1" clickable />
              <Node id="h2" p={P_H[1]} label="h2" clickable />
              <Node id="h3" p={P_H[2]} label="h3" clickable />
              <Node id="y1" p={P_O[0]} label="y1" clickable />
              <Node id="y2" p={P_O[1]} label="y2" clickable />

              <text x={75} y={368} textAnchor="middle" fontSize="11.5" fill="#5b6878">
                входы (input)
              </text>
              <text x={280} y={368} textAnchor="middle" fontSize="11.5" fill="#5b6878">
                скрытый (hidden)
              </text>
              <text x={480} y={368} textAnchor="middle" fontSize="11.5" fill="#5b6878">
                выход (output)
              </text>
            </svg>
          </Card>

          <Card title="Управление" className={glow(st === 5)}>
            <SliderRow label="x1" value={x[0]} onChange={(v) => setX([v, x[1]])} min={-1} max={1} />
            <SliderRow label="x2" value={x[1]} onChange={(v) => setX([x[0], v])} min={-1} max={1} />
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn variant="primary" onClick={runWave} disabled={wave !== null}>
                ▶ Прогнать волну
              </Btn>
              <Btn onClick={randomize}>🎲 Случайные веса</Btn>
              <Btn
                onClick={() => {
                  clearTimers();
                  setStage(0);
                  setWave(null);
                }}
              >
                Сброс
              </Btn>
            </div>
            <div
              className={`mt-3 rounded-lg border px-3 py-1.5 text-[13.5px] ${
                stage === 2
                  ? "border-[#2c5238] text-[#7ee29a]"
                  : "border-edge text-muted"
              } bg-panel2`}
            >
              {stage === 0 && "Сеть не вычислена — у нейронов «?». Нажми «▶ Прогнать волну»."}
              {stage === 1 && "Скрытый слой готов. Сейчас волна дойдёт до выхода…"}
              {stage === 2 && "Сеть вычислена ✓ — двигай x1, x2: forward pass пересчитывается вживую."}
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <AnimatePresence>
            {detail && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                <Card
                  title={`🔍 Внутри нейрона ${detail.name}`}
                  right={
                    <button
                      onClick={() => setSelected(null)}
                      className="cursor-pointer text-xs text-muted hover:text-accent"
                    >
                      закрыть ✕
                    </button>
                  }
                  className="border-amber/50"
                >
                  {detail.known ? (
                    <div className="font-mono text-[13.5px] leading-[2]">
                      {detail.inputs.map((inp) => (
                        <div key={inp.label}>
                          <span className="text-muted">{inp.label}:</span>{" "}
                          <span className={inp.w < 0 ? "text-hot" : "text-accent"}>
                            {par(inp.w)}
                          </span>
                          {"·"}
                          {par(inp.v)} = {fmt(inp.w * inp.v)}
                          <span className="ml-2 text-faint">
                            {inp.w * inp.v > 0.05
                              ? "← голос «за»"
                              : inp.w * inp.v < -0.05
                                ? "← голос «против»"
                                : "← почти молчит"}
                          </span>
                        </div>
                      ))}
                      <div>
                        <span className="text-muted">bias:</span> {fmt(detail.b)}
                      </div>
                      <div className="border-t border-edge pt-1">
                        z = {fmt(detail.z)} → σ(z) ={" "}
                        <AnimatedNumber value={detail.a} className="font-semibold text-ok" />
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted">
                      Этот нейрон ещё не вычислен — прогони волну.
                    </div>
                  )}
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          <Card title="Вычисления (что считает каждый нейрон)">
            <div className="mb-1 text-xs tracking-wide text-muted">
              Скрытый слой: h = σ(W·x + b)
            </div>
            <div className="font-mono text-[12.8px] leading-[1.95]">
              {stage >= 1 ? (
                b1.map((bb, j) => {
                  const zz = W1[j][0] * x[0] + W1[j][1] * x[1] + bb;
                  return (
                    <div key={j} className="-indent-3.5 break-words pl-3.5">
                      h{j + 1} = σ(
                      <span className={W1[j][0] < 0 ? "text-hot" : "text-accent"}>
                        {par(W1[j][0])}
                      </span>
                      ·{par(x[0])} +{" "}
                      <span className={W1[j][1] < 0 ? "text-hot" : "text-accent"}>
                        {par(W1[j][1])}
                      </span>
                      ·{par(x[1])} + {fmt(bb)}) = σ({fmt(zz)}) ={" "}
                      <span className="font-semibold text-ok">{fmt(h[j])}</span>
                    </div>
                  );
                })
              ) : (
                <div className="text-faint">— ещё не вычислен —</div>
              )}
            </div>
            <div className="mb-1 mt-3 text-xs tracking-wide text-muted">
              Выходной слой: y = σ(W·h + b)
            </div>
            <div className="font-mono text-[12.8px] leading-[1.95]">
              {stage >= 2 ? (
                b2.map((bb, k) => {
                  const zz =
                    W2[k][0] * h[0] + W2[k][1] * h[1] + W2[k][2] * h[2] + bb;
                  return (
                    <div key={k} className="-indent-3.5 break-words pl-3.5">
                      y{k + 1} = σ(
                      {W2[k].map((w, j) => (
                        <span key={j}>
                          <span className={w < 0 ? "text-hot" : "text-accent"}>
                            {par(w)}
                          </span>
                          ·{par(h[j])}
                          {j < 2 ? " + " : ""}
                        </span>
                      ))}{" "}
                      + {fmt(bb)}) = σ({fmt(zz)}) ={" "}
                      <span className="font-semibold text-ok">{fmt(y[k])}</span>
                    </div>
                  );
                })
              ) : (
                <div className="text-faint">— ещё не вычислен —</div>
              )}
            </div>
          </Card>

          <Card title="Задания 🏆" className={glow(st === 6)}>
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

          {st === null && (
            <Card title="Что здесь происходит">
              <p className="my-2 max-w-[1000px] text-soft">
                Forward pass — это многократное повторение того, что делал один
                нейрон. Каждый нейрон скрытого слоя берёт взвешенную сумму обоих
                входов плюс свой bias и пропускает её через sigmoid; выходной
                слой делает то же с активациями скрытого. Вся «магия» сети — это
                просто числа-веса. Внутри настоящих сетей не происходит ничего
                другого — только таких сумм там миллиарды.
              </p>
              <p className="my-2 text-sm text-muted">
                📺 К видео: 3Blue1Brown — «But what is a neural network?» (сеть
                784–16–16–10 делает ровно это) и Karpathy — «Zero to Hero», часть
                1: forward pass собирается из объектов Value.
              </p>
            </Card>
          )}
        </div>
      </div>
    </Layout>
  );
}
