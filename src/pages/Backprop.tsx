import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Layout, Card, SliderRow, Btn } from "../components/ui";
import { StoryPanel, useStory, type StoryStep } from "../components/StoryMode";
import { FlowDotsPath } from "../components/FlowDots";
import { fmt, par, clamp } from "../lib/format";

/* ---------- граф: L = (tanh(x1·w1 + x2·w2 + b) − y)² ---------- */

const NW = 128;
const NH = 68;
type NodeKey =
  | "x1" | "w1" | "x2" | "w2" | "b"
  | "m1" | "m2" | "z" | "a" | "y" | "L";

const NODES: Record<
  NodeKey,
  { x: number; y: number; label: string; kind: "leaf" | "param" | "op" }
> = {
  x1: { x: 12, y: 14, label: "x1 — вход", kind: "leaf" },
  w1: { x: 12, y: 96, label: "w1 — параметр", kind: "param" },
  x2: { x: 12, y: 192, label: "x2 — вход", kind: "leaf" },
  w2: { x: 12, y: 274, label: "w2 — параметр", kind: "param" },
  b: { x: 12, y: 366, label: "b — параметр", kind: "param" },
  m1: { x: 240, y: 55, label: "m1 = x1·w1", kind: "op" },
  m2: { x: 240, y: 233, label: "m2 = x2·w2", kind: "op" },
  z: { x: 455, y: 170, label: "z = m1+m2+b", kind: "op" },
  a: { x: 645, y: 170, label: "a = tanh(z)", kind: "op" },
  y: { x: 645, y: 320, label: "y — цель (target)", kind: "leaf" },
  L: { x: 810, y: 170, label: "L = (a−y)²", kind: "op" },
};
const EDGES: [NodeKey, NodeKey][] = [
  ["x1", "m1"], ["w1", "m1"], ["x2", "m2"], ["w2", "m2"],
  ["m1", "z"], ["m2", "z"], ["b", "z"], ["z", "a"], ["a", "L"], ["y", "L"],
];

/** Пути-кривые между узлами (статичны). */
const EDGE_PATHS: Record<string, string> = (() => {
  const incoming: Partial<Record<NodeKey, NodeKey[]>> = {};
  for (const [s, d] of EDGES) (incoming[d] = incoming[d] ?? []).push(s);
  const entryY = (d: NodeKey, s: NodeKey) => {
    const list = incoming[d]!;
    const i = list.indexOf(s);
    const cy = NODES[d].y + NH / 2;
    if (list.length === 1) return cy;
    const span = Math.min(34, 14 * (list.length - 1));
    return cy - span / 2 + i * (span / (list.length - 1));
  };
  const out: Record<string, string> = {};
  for (const [s, d] of EDGES) {
    const sx = NODES[s].x + NW;
    const sy = NODES[s].y + NH / 2;
    const tx = NODES[d].x;
    const ty = entryY(d, s);
    const dx = Math.max(30, (tx - sx) * 0.45);
    out[`${s}>${d}`] = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  }
  return out;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- история ---------- */

const STEPS: StoryStep[] = [
  {
    emoji: "🍰",
    title: "Кто виноват, что торт невкусный?",
    text: (
      <>
        Команда пекла торт: один отвечал за тесто, другой за крем, третий за
        духовку. Торт вышел так себе. Чтобы в следующий раз получилось лучше,
        нужно понять: <b className="text-ink">кто и насколько виноват?</b>{" "}
        Backpropagation — это честный алгоритм раздачи вины: он считает, как
        сильно каждый участник повлиял на итоговую ошибку.
      </>
    ),
  },
  {
    emoji: "🗺",
    title: "Вычислительный граф: рецепт по шагам",
    text: (
      <>
        Мы разложили вычисление одного нейрона на простейшие шаги — получился
        граф, как у Карпатого в micrograd:{" "}
        <code className="font-mono text-ink">L = (tanh(x1·w1 + x2·w2 + b) − y)²</code>.
        Каждая коробочка — одна операция.{" "}
        <span className="text-accent">Синие пунктирные</span> — параметры,
        которые можно менять (это «повара»). L в конце — ошибка: насколько
        ответ сети a не совпал с целью y.
      </>
    ),
  },
  {
    emoji: "▶️",
    title: "Forward: считаем и всё запоминаем",
    text: (
      <>
        Смотри: вычисление бежит слева направо, у коробочек появляются значения
        (val). Важно, что граф <b className="text-ink">запоминает каждое
        промежуточное число</b> — они понадобятся, когда пойдём назад. В логе
        справа — каждая операция с настоящими числами.
      </>
    ),
  },
  {
    emoji: "⬅️",
    title: "Backward: вина течёт назад по цепочке",
    text: (
      <>
        А теперь главное: <span className="text-amber">оранжевая волна вины</span>{" "}
        бежит справа налево! У каждой коробочки появляется grad = «если этот
        узел чуть увеличить, насколько вырастет ошибка». Вина передаётся по
        цепочке (chain rule): вина узла = вина того, кому он передал результат,
        умноженная на его локальное влияние. Дёшево и для миллиардов параметров.
      </>
    ),
  },
  {
    emoji: "🔧",
    title: "Шаг обучения: сдвигаем виноватых",
    text: (
      <>
        Зная вину каждого параметра, применяем градиентный спуск с прошлой
        страницы: <code className="font-mono text-ink">w ← w − η·∇w</code>.
        Каждый параметр сдвигается чуть-чуть против своей вины. Смотри на
        график loss: я делаю несколько шагов обучения — и ошибка тает. Это и
        есть обучение нейросети: forward → backward → сдвиг. Повторять до
        победы.
      </>
    ),
  },
  {
    emoji: "🏆",
    title: "Проверь себя!",
    text: (
      <>
        В песочнице: прогони forward и backward сам, дообучи нейрон почти до
        нуля ошибки, потом сдвинь цель y — и переобучи заново. PyTorch делает
        ровно это же при вызове{" "}
        <code className="font-mono text-ink">loss.backward()</code>, только
        узлов — миллиарды.
      </>
    ),
  },
];

/* ---------- страница ---------- */

type Vals = Partial<Record<NodeKey, number>>;

export default function Backprop() {
  const [V, setV] = useState({ x1: 0.8, w1: 0.7, x2: 0.2, w2: -0.4, b: 0.1, y: -0.5 });
  const [eta, setEta] = useState(0.2);
  const [val, setVal] = useState<Vals>({});
  const [grad, setGrad] = useState<Vals>({});
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lit, setLit] = useState<{ node: NodeKey; back: boolean } | null>(null);
  const [log, setLog] = useState<{ text: string; cls: string }[]>([
    { text: "Нажми «Forward →» — увидишь вычисление слева направо, затем «← Backward» — волну вины.", cls: "li" },
  ]);
  const [losses, setLosses] = useState<number[]>([]);
  const [fwdOnce, setFwdOnce] = useState(false);
  const [bwdOnce, setBwdOnce] = useState(false);
  const [trainedLow, setTrainedLow] = useState(false);
  const [targetMoved, setTargetMoved] = useState(false);
  const [retrained, setRetrained] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const story = useStory(STEPS.length);
  const st = story.step;

  const pushLog = (text: string, cls = "lf") =>
    setLog((l) => [...l.slice(-200), { text, cls }]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  /* ---------- честные вычисления ---------- */

  const forwardCalc = (vv: typeof V): Required<Pick<Vals, "m1" | "m2" | "z" | "a" | "L">> => {
    const m1 = vv.x1 * vv.w1;
    const m2 = vv.x2 * vv.w2;
    const z = m1 + m2 + vv.b;
    const a = Math.tanh(z);
    const L = (a - vv.y) ** 2;
    return { m1, m2, z, a, L };
  };
  const backwardCalc = (vv: typeof V, f: ReturnType<typeof forwardCalc>) => {
    const gL = 1;
    const ga = 2 * (f.a - vv.y);
    const gz = ga * (1 - f.a * f.a);
    const gm1 = gz, gm2 = gz, gb = gz;
    return {
      L: gL, a: ga, z: gz, m1: gm1, m2: gm2, b: gb,
      w1: gm1 * vv.x1, x1: gm1 * vv.w1,
      w2: gm2 * vv.x2, x2: gm2 * vv.w2,
    };
  };

  const FSTEPS: { k: NodeKey; line: (vv: typeof V, f: ReturnType<typeof forwardCalc>) => string }[] = [
    { k: "m1", line: (vv, f) => `m1 = x1·w1 = ${par(vv.x1)}·${par(vv.w1)} = ${fmt(f.m1)}` },
    { k: "m2", line: (vv, f) => `m2 = x2·w2 = ${par(vv.x2)}·${par(vv.w2)} = ${fmt(f.m2)}` },
    { k: "z", line: (vv, f) => `z = m1 + m2 + b = ${fmt(f.m1)} + ${par(f.m2)} + ${par(vv.b)} = ${fmt(f.z)}` },
    { k: "a", line: (_vv, f) => `a = tanh(z) = tanh(${fmt(f.z)}) = ${fmt(f.a)}` },
    { k: "L", line: (vv, f) => `L = (a − y)² = (${fmt(f.a)} − ${par(vv.y)})² = ${fmt(f.L)}` },
  ];
  const BSTEPS: { k: NodeKey; line: (vv: typeof V, f: ReturnType<typeof forwardCalc>, g: ReturnType<typeof backwardCalc>) => string }[] = [
    { k: "L", line: () => `∇L = ∂L/∂L = 1.00 — стартуем с конца` },
    { k: "a", line: (vv, f, g) => `∇a = 2·(a − y) = 2·(${fmt(f.a)} − ${par(vv.y)}) = ${fmt(g.a)}` },
    { k: "z", line: (_vv, f, g) => `∇z = ∇a·(1 − a²) = ${par(g.a)}·${par(1 - f.a * f.a)} = ${fmt(g.z)}` },
    { k: "m1", line: (_vv, _f, g) => `∇m1 = ∇z·1 = ${fmt(g.m1)}` },
    { k: "m2", line: (_vv, _f, g) => `∇m2 = ∇z·1 = ${fmt(g.m2)}` },
    { k: "b", line: (_vv, _f, g) => `∇b = ∇z·1 = ${fmt(g.b)} ← вина параметра b` },
    { k: "w1", line: (vv, _f, g) => `∇w1 = ∇m1·x1 = ${par(g.m1)}·${par(vv.x1)} = ${fmt(g.w1)} ← вина w1` },
    { k: "x1", line: (vv, _f, g) => `∇x1 = ∇m1·w1 = ${par(g.m1)}·${par(vv.w1)} = ${fmt(g.x1)}` },
    { k: "w2", line: (vv, _f, g) => `∇w2 = ∇m2·x2 = ${par(g.m2)}·${par(vv.x2)} = ${fmt(g.w2)} ← вина w2` },
    { k: "x2", line: (vv, _f, g) => `∇x2 = ∇m2·w2 = ${par(g.m2)}·${par(vv.w2)} = ${fmt(g.x2)}` },
  ];

  /* ---------- анимированные прогоны ---------- */

  const runForward = async (animate = true) => {
    if (busy) return;
    setBusy(true);
    setVal({});
    setGrad({});
    const f = forwardCalc(V);
    if (animate) pushLog("— forward: считаем значения слева направо —", "li");
    const acc: Vals = {};
    for (const s of FSTEPS) {
      acc[s.k] = f[s.k as keyof typeof f];
      if (animate) {
        setLit({ node: s.k, back: false });
        setVal({ ...acc });
        pushLog(s.line(V, f), "lf");
        await sleep(560);
        if (!aliveRef.current) return;
      }
    }
    setVal(f);
    setLit(null);
    setBusy(false);
    setFwdOnce(true);
  };

  const runBackward = async () => {
    if (busy || val.L === undefined) return;
    setBusy(true);
    const f = forwardCalc(V);
    const g = backwardCalc(V, f);
    setGrad({});
    pushLog("— backward: разносим вину справа налево (chain rule) —", "li");
    const acc: Vals = {};
    for (const s of BSTEPS) {
      acc[s.k] = g[s.k as keyof typeof g];
      setLit({ node: s.k, back: true });
      setGrad({ ...acc });
      pushLog(s.line(V, f, g), "lb");
      await sleep(560);
      if (!aliveRef.current) return;
    }
    setLit(null);
    setBusy(false);
    setBwdOnce(true);
  };

  const trainStep = (vv: typeof V) => {
    const f = forwardCalc(vv);
    const g = backwardCalc(vv, f);
    const nv = {
      ...vv,
      w1: vv.w1 - eta * g.w1,
      w2: vv.w2 - eta * g.w2,
      b: vv.b - eta * g.b,
    };
    const nf = forwardCalc(nv);
    return { nv, oldL: f.L, newL: nf.L, nf };
  };

  const doTrain = () => {
    if (busy) return;
    setV((vv) => {
      const { nv, oldL, newL, nf } = trainStep(vv);
      setEpoch((e) => e + 1);
      setVal(nf);
      setGrad({});
      setLosses((l) => [...l.slice(-80), newL]);
      pushLog(`Эпоха ${epoch + 1}: L = ${fmt(oldL)} → ${fmt(newL)}   (w ← w − ${fmt(eta)}·∇w)`, "le");
      if (newL < 0.01) {
        setTrainedLow(true);
        if (targetMoved) setRetrained(true);
      }
      return nv;
    });
  };

  /* действия шагов истории */
  const storyTimers = useRef<number[]>([]);
  useEffect(() => {
    storyTimers.current.forEach(clearTimeout);
    storyTimers.current = [];
    if (st === null) return;
    if (st === 2) {
      storyTimers.current.push(window.setTimeout(() => runForward(true), 400));
    }
    if (st === 3) {
      // forward мгновенно (если не посчитан), затем анимированный backward
      storyTimers.current.push(
        window.setTimeout(async () => {
          if (val.L === undefined) {
            setVal(forwardCalc(V));
            await sleep(200);
          }
          runBackward();
        }, 400),
      );
    }
    if (st === 4) {
      for (let i = 0; i < 4; i++) {
        storyTimers.current.push(window.setTimeout(doTrain, 600 + i * 900));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  /* ---------- отрисовка ---------- */

  const nodeValue = (k: NodeKey): number | null => {
    if (k in V) return V[k as keyof typeof V];
    return val[k] ?? null;
  };

  const glow = (on: boolean) => (on ? "ring-2 ring-accent/70" : "");

  const tasks = [
    { label: "Прогони Forward → и ← Backward по разу", done: fwdOnce && bwdOnce },
    { label: "Сделай 5 шагов обучения подряд", done: epoch >= 5 },
    { label: "Дообучи почти до нуля: L < 0.01", done: trainedLow },
    { label: "Сдвинь цель y и переобучи заново до L < 0.01", done: retrained },
  ];

  const setLeaf = (key: "x1" | "x2" | "y", v: number) => {
    setV((vv) => ({ ...vv, [key]: v }));
    if (key === "y" && trainedLow) setTargetMoved(true);
    setVal({});
    setGrad({});
    setLit(null);
  };

  const spark = useMemo(() => {
    if (losses.length < 2) return "";
    const max = Math.max(...losses, 0.001);
    return losses
      .map((l, i) => {
        const xx = (i / (losses.length - 1)) * 260;
        const yy = 60 - (clamp(l, 0, max) / max) * 52;
        return `${i === 0 ? "M" : "L"}${xx.toFixed(1)},${yy.toFixed(1)}`;
      })
      .join(" ");
  }, [losses]);

  return (
    <Layout crumb="04 · Backpropagation" crumbEn="обратное распространение ошибки">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Как ошибка течёт назад по графу
      </h1>
      <p className="mb-4 max-w-[940px] text-muted">
        Вычислительный граф одного нейрона с tanh — как в micrograd у Карпатого:{" "}
        <code className="font-mono">L = (tanh(x1·w1 + x2·w2 + b) − y)²</code>.{" "}
        <span className="text-amber">Оранжевый grad</span> у узла — это ∂L/∂узел,
        «вина» узла в ошибке.
      </p>

      <StoryPanel
        steps={STEPS}
        step={story.step}
        setStep={story.setStep}
        next={story.next}
        prev={story.prev}
        sandboxText="Запускай forward/backward, делай шаги обучения и смотри, как тает loss."
      />

      <Card title="Вычислительный граф (computational graph)" className="mb-4">
        <svg viewBox="0 0 950 470" aria-label="Вычислительный граф нейрона">
          <defs>
            <marker
              id="garr"
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="6.5"
              markerHeight="6.5"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="#45526b" />
            </marker>
          </defs>

          {EDGES.map(([s, d]) => {
            const key = `${s}>${d}`;
            const isLitF = lit && !lit.back && d === lit.node;
            const isLitB = lit && lit.back && s === lit.node;
            return (
              <g key={key}>
                <path
                  d={EDGE_PATHS[key]}
                  fill="none"
                  stroke={isLitF ? "#9fc4ff" : isLitB ? "#ffa657" : "#45526b"}
                  strokeWidth={isLitF || isLitB ? 2.4 : 1.6}
                  markerEnd="url(#garr)"
                />
                <FlowDotsPath
                  d={EDGE_PATHS[key]}
                  count={2}
                  r={3}
                  color={isLitB ? "#ffa657" : "#9fc4ff"}
                  speed={1.2}
                  active={Boolean(isLitF || isLitB)}
                  reverse={Boolean(isLitB)}
                />
              </g>
            );
          })}

          {(Object.entries(NODES) as [NodeKey, (typeof NODES)[NodeKey]][]).map(
            ([k, nd]) => {
              const v = nodeValue(k);
              const g = grad[k];
              const isLit = lit?.node === k;
              return (
                <g key={k}>
                  <motion.rect
                    x={nd.x}
                    y={nd.y}
                    width={NW}
                    height={NH}
                    rx={10}
                    fill="#1b2330"
                    stroke={
                      isLit
                        ? lit!.back
                          ? "#ffa657"
                          : "#79b8ff"
                        : nd.kind === "param"
                          ? "#2d68b8"
                          : "#3a465c"
                    }
                    strokeWidth={isLit ? 2.6 : nd.kind === "param" ? 1.8 : 1.4}
                    strokeDasharray={nd.kind === "param" && !isLit ? "5 3" : undefined}
                    animate={{
                      filter: isLit
                        ? lit!.back
                          ? "drop-shadow(0 0 8px rgba(255,166,87,.8))"
                          : "drop-shadow(0 0 8px rgba(88,166,255,.8))"
                        : "drop-shadow(0 0 0px rgba(0,0,0,0))",
                    }}
                  />
                  <text
                    x={nd.x + 10}
                    y={nd.y + 17}
                    fontSize="11.5"
                    fill={nd.kind === "param" ? "#79b8ff" : "#8b98ab"}
                  >
                    {nd.label}
                  </text>
                  <text x={nd.x + 10} y={nd.y + 38} fontSize="13.5">
                    <tspan fill="#5b6878" fontSize="11">val </tspan>
                    <tspan
                      fill={
                        v === null
                          ? "#5b6878"
                          : nd.kind === "param"
                            ? v < 0
                              ? "#f0564f"
                              : "#58a6ff"
                            : "#e7edf4"
                      }
                      fontWeight={700}
                    >
                      {v === null ? "?" : fmt(v)}
                    </tspan>
                  </text>
                  <text x={nd.x + 10} y={nd.y + 57} fontSize="13">
                    <tspan fill="#5b6878" fontSize="11">grad </tspan>
                    <tspan fill="#ffa657">{g === undefined ? "—" : fmt(g)}</tspan>
                  </text>
                </g>
              );
            },
          )}
        </svg>
        <div className="mt-2 text-[12.5px] text-muted">
          <span className="text-accent">Синяя пунктирная рамка</span> — обучаемые
          параметры (trainable parameters): w1, w2, b.{" "}
          <span className="text-amber">grad</span> — «вина» узла, появляется
          после Backward.
        </div>
      </Card>

      <div className="grid grid-cols-[.9fr_1.1fr] items-start gap-4 max-lg:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Card title="Управление" className={glow(st === 5)}>
            <SliderRow label="x1 (вход)" labelWidth={110} value={V.x1} onChange={(v) => setLeaf("x1", v)} min={-2} max={2} />
            <SliderRow label="x2 (вход)" labelWidth={110} value={V.x2} onChange={(v) => setLeaf("x2", v)} min={-2} max={2} />
            <SliderRow label="y (цель)" labelWidth={110} value={V.y} onChange={(v) => setLeaf("y", v)} min={-1} max={1} />
            <SliderRow label="η (learning rate)" labelWidth={110} value={eta} onChange={setEta} min={0.01} max={1.5} step={0.01} amber />
            <div className="mt-3 flex flex-wrap gap-2">
              <Btn variant="primary" onClick={() => runForward(true)} disabled={busy}>
                Forward →
              </Btn>
              <Btn variant="warm" onClick={runBackward} disabled={busy || val.L === undefined}>
                ← Backward
              </Btn>
              <Btn onClick={doTrain} disabled={busy}>
                ⟳ Шаг обучения
              </Btn>
              <Btn
                onClick={() => {
                  if (busy) return;
                  const r = (lim: number) =>
                    Math.round((Math.random() * 2 - 1) * lim * 100) / 100;
                  setV((vv) => ({ ...vv, w1: r(1), w2: r(1), b: r(0.5) }));
                  setVal({});
                  setGrad({});
                  setEpoch(0);
                  setLosses([]);
                  pushLog("— случайные веса; эпохи обнулены —", "li");
                }}
                disabled={busy}
              >
                🎲 Случайные веса
              </Btn>
            </div>
            <div className="mt-3 text-[13.5px] text-muted">
              эпоха (epoch): <b className="text-ink">{epoch}</b>
              {val.L !== undefined && (
                <>
                  {" "}· текущая ошибка L ={" "}
                  <b className={val.L < 0.01 ? "text-ok" : "text-ink"}>{fmt(val.L)}</b>
                </>
              )}
            </div>
          </Card>

          <Card title="Кривая loss по эпохам" className={glow(st === 4)}>
            <svg viewBox="0 0 260 64" className="h-[64px] w-full">
              <line x1="0" y1="60" x2="260" y2="60" stroke="#2b3444" />
              {spark && <path d={spark} fill="none" stroke="#56d364" strokeWidth="2" />}
            </svg>
            <div className="mt-1 text-[12px] text-muted">
              {losses.length < 2
                ? "нажми «⟳ Шаг обучения» несколько раз — увидишь, как тает ошибка"
                : `L: ${fmt(losses[0])} → ${fmt(losses[losses.length - 1])} за ${losses.length} шагов`}
            </div>
          </Card>

          <Card title="Задания 🏆" className={glow(st === 5)}>
            <ul className="m-0 list-none p-0 text-[13.5px]">
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
          <Card
            title="Лог вычислений"
            right={
              <button
                onClick={() => setLog([])}
                className="cursor-pointer text-xs text-muted hover:text-accent"
              >
                очистить
              </button>
            }
          >
            <div
              ref={logRef}
              className="h-[330px] overflow-y-auto rounded-lg border border-edge bg-[#0e131b] px-3 py-2.5 font-mono text-[12.8px] leading-[1.8]"
            >
              {log.map((l, i) => (
                <div
                  key={i}
                  className={`break-words ${
                    l.cls === "lb"
                      ? "text-amber"
                      : l.cls === "le"
                        ? "font-semibold text-ok"
                        : l.cls === "li"
                          ? "text-faint"
                          : "text-[#c8d2de]"
                  }`}
                >
                  {l.text}
                </div>
              ))}
            </div>
          </Card>

          {st === null && (
            <Card title="Что здесь происходит">
              <p className="my-2 max-w-[1000px] text-soft">
                Backpropagation отвечает на вопрос: насколько каждый параметр
                виноват в ошибке? Forward строит граф и запоминает все
                промежуточные значения, а backward идёт справа налево и
                перемножает локальные производные по chain rule — градиент
                каждого узла говорит, на сколько вырастет loss, если этот узел
                чуть увеличить. Дальше шаг градиентного спуска: каждый параметр
                сдвигается против своего градиента, w ← w − η·∇w. Это в точности
                то, что делает micrograd — и то, что PyTorch делает с миллиардами
                узлов при вызове loss.backward().
              </p>
              <p className="my-2 text-sm text-muted">
                📺 К видео: Karpathy — «The spelled-out intro to neural networks
                and backpropagation: building micrograd» (этот граф — оттуда) и
                3Blue1Brown — главы 3–4 про backpropagation.
              </p>
            </Card>
          )}
        </div>
      </div>
    </Layout>
  );
}
