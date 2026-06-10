import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Layout,
  Card,
  SliderRow,
  Seg,
  AnimatedNumber,
} from "../components/ui";
import { StoryPanel, useStory, type StoryStep } from "../components/StoryMode";
import { FlowDots } from "../components/FlowDots";
import { fmt, par, clamp } from "../lib/format";

/* ---------- функции активации ---------- */

type ActName = "sigmoid" | "tanh" | "relu" | "step";
const ACT: Record<
  ActName,
  {
    sym: string;
    f: (z: number) => number;
    yr: [number, number];
    ticks: number;
    info: string;
  }
> = {
  sigmoid: {
    sym: "σ",
    f: (z) => 1 / (1 + Math.exp(-z)),
    yr: [-0.25, 1.25],
    ticks: 0.5,
    info: "σ(z) = 1/(1+e⁻ᶻ) — сжимает любой z в (0, 1); на краях насыщается.",
  },
  tanh: {
    sym: "tanh",
    f: Math.tanh,
    yr: [-1.3, 1.3],
    ticks: 0.5,
    info: "tanh(z) — как sigmoid, но выход в (−1, 1) и центрирован вокруг нуля.",
  },
  relu: {
    sym: "ReLU",
    f: (z) => Math.max(0, z),
    yr: [-1.2, 8.4],
    ticks: 2,
    info: "ReLU(z) = max(0, z) — отрицательные обнуляет, положительные пропускает как есть.",
  },
  step: {
    sym: "step",
    f: (z) => (z >= 0 ? 1 : 0),
    yr: [-0.25, 1.25],
    ticks: 0.5,
    info: "step(z) = 1 при z ≥ 0, иначе 0 — исторический перцептрон: только «да» или «нет».",
  },
};

/* ---------- график активации на canvas ---------- */

function ActPlot({ act, z, a }: { act: ActName; z: number; a: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width,
      H = rect.height,
      pad = { l: 38, r: 12, t: 10, b: 24 };
    const A = ACT[act],
      yr = A.yr,
      ZR = [-8, 8] as const;
    const X = (zz: number) =>
      pad.l + ((zz - ZR[0]) / (ZR[1] - ZR[0])) * (W - pad.l - pad.r);
    const Y = (aa: number) =>
      H - pad.b - ((aa - yr[0]) / (yr[1] - yr[0])) * (H - pad.t - pad.b);
    ctx.clearRect(0, 0, W, H);
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.strokeStyle = "#222b3a";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#8b98ab";
    for (let zz = ZR[0]; zz <= ZR[1]; zz += 2) {
      ctx.beginPath();
      ctx.moveTo(X(zz), pad.t);
      ctx.lineTo(X(zz), H - pad.b);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(String(zz), X(zz), H - 8);
    }
    const t0 = Math.ceil(yr[0] / A.ticks) * A.ticks;
    for (let aa = t0; aa <= yr[1] + 1e-9; aa += A.ticks) {
      const v = Math.round(aa * 100) / 100;
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(v));
      ctx.lineTo(W - pad.r, Y(v));
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(String(v), pad.l - 5, Y(v) + 3.5);
    }
    ctx.strokeStyle = "#3a465c";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(0));
    ctx.lineTo(W - pad.r, Y(0));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(X(0), pad.t);
    ctx.lineTo(X(0), H - pad.b);
    ctx.stroke();
    ctx.fillStyle = "#8b98ab";
    ctx.textAlign = "left";
    ctx.fillText("z", W - pad.r - 8, Y(0) - 6);
    ctx.fillText("a", X(0) + 6, pad.t + 9);
    // кривая
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    const N = 280;
    for (let i = 0; i <= N; i++) {
      const zz = ZR[0] + ((ZR[1] - ZR[0]) * i) / N;
      const aa = clamp(A.f(zz), yr[0], yr[1]);
      i === 0 ? ctx.moveTo(X(zz), Y(aa)) : ctx.lineTo(X(zz), Y(aa));
    }
    ctx.stroke();
    // точка (z, a)
    const zc = clamp(z, ZR[0], ZR[1]);
    const ac = clamp(a, yr[0], yr[1]);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#8b98ab";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(X(zc), Y(ac));
    ctx.lineTo(X(zc), Y(0));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(X(zc), Y(ac));
    ctx.lineTo(X(0), Y(ac));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffa657";
    ctx.beginPath();
    ctx.arc(X(zc), Y(ac), 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0d1117";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(X(zc), Y(ac), 5.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#e7edf4";
    ctx.textAlign = X(zc) > W - 110 ? "right" : "left";
    ctx.fillText(
      `(${fmt(z)}, ${fmt(a)})`,
      X(zc) + (X(zc) > W - 110 ? -10 : 10),
      Y(ac) - 9,
    );
  });
  return <canvas ref={ref} className="block h-[260px] w-full" />;
}

/* ---------- история ---------- */

const STEPS: StoryStep[] = [
  {
    emoji: "🤔",
    title: "Нейрон — это крошечная «решалка»",
    text: (
      <>
        На входе — несколько чисел, на выходе — одно: насколько нейрон
        «загорелся». Вся гигантская нейросеть (и ChatGPT тоже) — это миллиарды
        таких простейших решалок, соединённых проводами. Поймёшь один нейрон —
        поймёшь главное. Смотри на схему слева: три входа, один нейрон, один
        выход.
      </>
    ),
  },
  {
    emoji: "📥",
    title: "Входы x — это факты",
    text: (
      <>
        Представь, что нейрон решает, идти ли гулять. Каждый вход — факт:
        «на улице тепло», «идёт дождь», «друзья зовут». Числом мы говорим,
        насколько факт выражен: +2 — очень да, 0 — ничего, −2 — совсем наоборот.
        По проводам уже бегут сигналы — это входы «текут» в нейрон.{" "}
        <b className="text-ink">Подвигай слайдеры x1–x3 справа</b> и посмотри на
        кружки слева.
      </>
    ),
  },
  {
    emoji: "🎚",
    title: "Веса w — это доверие к каждому факту",
    text: (
      <>
        Каждый провод имеет «громкость» — вес (weight).{" "}
        <span className="text-accent">Синий провод</span> — факт голосует «за»,{" "}
        <span className="text-hot">красный</span> — «против», толщина — сила
        влияния. Совет лучшего друга весит больше совета незнакомца — вот это и
        есть вес. <b className="text-ink">Подвигай w1 справа</b>: провод на
        схеме потолстеет или сменит цвет. Именно веса сеть подбирает, когда
        «учится».
      </>
    ),
  },
  {
    emoji: "➕",
    title: "Складываем всё в одно число z",
    text: (
      <>
        Нейрон умножает каждый факт на доверие к нему и всё складывает:{" "}
        <code className="font-mono text-ink">z = w1·x1 + w2·x2 + w3·x3 + b</code>.
        Это «сумма голосов с учётом веса каждого голоса». Внизу слева — живая
        формула с настоящими числами: подвигай любой слайдер и увидишь, как
        пересчитывается результат.
      </>
    ),
  },
  {
    emoji: "🎭",
    title: "Bias b — стартовое настроение",
    text: (
      <>
        Смещение (bias) прибавляется к сумме всегда, независимо от входов.
        Это «характер» нейрона: оптимисту (b &gt; 0) хватит слабых поводов,
        чтобы сказать «да», пессимисту (b &lt; 0) нужны очень веские аргументы.
        Технически bias сдвигает порог срабатывания.{" "}
        <b className="text-ink">Покрути слайдер b</b> — пунктирная коробочка
        сверху на схеме.
      </>
    ),
  },
  {
    emoji: "📈",
    title: "Активация: превращаем z в решение",
    text: (
      <>
        Сумма z может быть любой — хоть +50. Функция активации (activation
        function) переводит её в аккуратный ответ: sigmoid сжимает всё в
        диапазон от 0 («молчу») до 1 («горю!»). Оранжевая точка на графике
        справа — твой нейрон прямо сейчас. Сдвинь любой слайдер — точка
        поедет по кривой. Это нелинейность, и без неё сеть умела бы рисовать
        только прямые линии.
      </>
    ),
  },
  {
    emoji: "🏆",
    title: "Проверь себя!",
    text: (
      <>
        Дальше — песочница. Попробуй выполнить задания из карточки{" "}
        <b className="text-ink">«Задания»</b>: зажечь нейрон на полную, погасить
        его и поймать «мёртвый ReLU». Если справился — ты понял, что вычисляет
        нейрон, лучше большинства людей на планете 😎
      </>
    ),
  },
];

/* ---------- геометрия схемы ---------- */

const IN = [
  { x: 74, y: 88 },
  { x: 74, y: 178 },
  { x: 74, y: 268 },
];
const NEURON = { x: 350, y: 178, r: 50 };

export default function Neuron() {
  const [x, setX] = useState([0.8, 0.2, -0.5]);
  const [w, setW] = useState([0.7, -0.4, 0.3]);
  const [b, setB] = useState(0.1);
  const [act, setAct] = useState<ActName>("sigmoid");
  const story = useStory(STEPS.length);
  const st = story.step;

  const A = ACT[act];
  const z = w[0] * x[0] + w[1] * x[1] + w[2] * x[2] + b;
  const a = A.f(z);

  // нормировка активации в [0,1] для яркости нейрона
  const aNorm = useMemo(() => {
    if (act === "tanh") return (a + 1) / 2;
    if (act === "relu") return Math.min(1, a / 2);
    return a;
  }, [a, act]);
  const n = clamp(aNorm, 0, 1);

  // что подсвечивать на каждом шаге истории
  const hl = {
    inputs: st === 1,
    wires: st === 2,
    formula: st === 3,
    bias: st === 4,
    plot: st === 5,
    tasks: st === 6 || st === null,
  };
  const glow = (on: boolean) =>
    on ? "ring-2 ring-accent/70 transition-shadow" : "transition-shadow";
  // в режиме истории приглушаем нерелевантные части схемы
  const dim = (relevant: boolean) =>
    st !== null && !relevant && st >= 1 ? 0.35 : 1;

  /* задания песочницы */
  const tasks = [
    { label: "Зажги нейрон на полную: a > 0.95", done: act === "sigmoid" && a > 0.95 },
    { label: "Полностью погаси: a < 0.05", done: act === "sigmoid" && a < 0.05 },
    {
      label: "«Мёртвый ReLU»: включи ReLU и получи ровно a = 0",
      done: act === "relu" && a === 0,
    },
    {
      label: "Сделай нейрону «характер»: пусть при всех x = 0 выход a > 0.8",
      done:
        act === "sigmoid" &&
        ACT.sigmoid.f(b) > 0.8 &&
        Math.abs(x[0]) < 0.05 &&
        Math.abs(x[1]) < 0.05 &&
        Math.abs(x[2]) < 0.05,
    },
  ];

  const setXi = (i: number, v: number) =>
    setX((xs) => xs.map((o, j) => (j === i ? v : o)));
  const setWi = (i: number, v: number) =>
    setW((ws) => ws.map((o, j) => (j === i ? v : o)));

  return (
    <Layout crumb="01 · Нейрон и функции активации" crumbEn="neuron & activation functions">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Что вычисляет один нейрон
      </h1>
      <p className="mb-4 max-w-[900px] text-muted">
        Нейрон делает две вещи: считает взвешенную сумму входов{" "}
        <code className="font-mono">z = w1·x1 + w2·x2 + w3·x3 + b</code> и
        пропускает её через функцию активации:{" "}
        <code className="font-mono">a = f(z)</code>.
      </p>

      <StoryPanel
        steps={STEPS}
        step={story.step}
        setStep={story.setStep}
        next={story.next}
        prev={story.prev}
        sandboxText="Крути слайдеры, меняй активацию и выполняй задания. Толщина провода — |w|, цвет — знак веса."
      />

      <div className="grid grid-cols-[1.15fr_.85fr] items-start gap-4 max-lg:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Card title="Схема нейрона" className={glow(st !== null && st <= 2 && st >= 1)}>
            <svg viewBox="0 0 560 330" aria-label="Схема: 3 входа, нейрон, выход">
              <defs>
                <marker
                  id="arr"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="#8b98ab" />
                </marker>
              </defs>

              {/* провода */}
              <g opacity={dim(st === 1 || st === 2 || st === 3)}>
                {w.map((wi, i) => {
                  const from = { x: IN[i].x + 26, y: IN[i].y };
                  const to = { x: NEURON.x, y: NEURON.y };
                  const t = 0.42;
                  const lx = from.x + t * (to.x - from.x);
                  const ly = from.y + t * (to.y - from.y);
                  const col = wi >= 0 ? "#58a6ff" : "#f0564f";
                  return (
                    <g key={i}>
                      <line
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        stroke={col}
                        strokeWidth={1.2 + Math.abs(wi) * 2.6}
                        strokeOpacity={0.9}
                        style={
                          hl.wires
                            ? { filter: "drop-shadow(0 0 4px rgba(255,255,255,.45))" }
                            : undefined
                        }
                      />
                      <text x={lx} y={ly - 9} textAnchor="middle" fontSize="12.5" fill={col}>
                        {`w${i + 1} = ${fmt(wi)}`}
                      </text>
                      <FlowDots
                        from={from}
                        to={to}
                        count={3}
                        r={2.6 + Math.min(1.6, Math.abs(wi))}
                        color={col}
                        speed={hl.wires ? 0.7 : 0.4}
                        active={st === null || st >= 1}
                        opacity={0.20 + Math.min(0.75, Math.abs(x[i] * wi) * 0.5)}
                      />
                    </g>
                  );
                })}
              </g>

              {/* выход */}
              <g opacity={dim(st === 5)}>
                <line
                  x1={400}
                  y1={178}
                  x2={500}
                  y2={178}
                  stroke={a >= 0 ? "#58a6ff" : "#f0564f"}
                  strokeWidth={2.5}
                  markerEnd="url(#arr)"
                />
                <text x={452} y={162} textAnchor="middle" fontSize="14" fill="#e7edf4">
                  a = {fmt(a)}
                </text>
                <FlowDots
                  from={{ x: 402, y: 178 }}
                  to={{ x: 496, y: 178 }}
                  count={2}
                  r={3}
                  color="#ffa657"
                  speed={0.55}
                  active={st === null || st >= 5}
                  opacity={0.25 + n * 0.7}
                />
              </g>

              {/* bias */}
              <g opacity={dim(st === 4 || st === 3)}>
                <line
                  x1={350}
                  y1={80}
                  x2={350}
                  y2={128}
                  stroke="#8b98ab"
                  strokeWidth={1.6}
                  strokeDasharray="4 4"
                />
                <rect
                  x={318}
                  y={40}
                  width={64}
                  height={40}
                  rx={9}
                  fill="#1b2330"
                  stroke={hl.bias ? "#58a6ff" : "#3a465c"}
                  strokeWidth={hl.bias ? 2.2 : 1}
                  style={
                    hl.bias
                      ? { filter: "drop-shadow(0 0 6px rgba(88,166,255,.6))" }
                      : undefined
                  }
                />
                <text x={350} y={57} textAnchor="middle" fontSize="12" fill="#8b98ab">
                  b (bias)
                </text>
                <text x={350} y={73} textAnchor="middle" fontSize="13" fill="#e7edf4">
                  {fmt(b)}
                </text>
              </g>

              {/* входы */}
              <g opacity={dim(st === 1 || st === 2 || st === 3)}>
                {x.map((xi, i) => (
                  <g key={i}>
                    <circle
                      cx={IN[i].x}
                      cy={IN[i].y}
                      r={26}
                      fill="#1b2330"
                      stroke={hl.inputs ? "#58a6ff" : "#3a465c"}
                      strokeWidth={hl.inputs ? 2.2 : 1.5}
                      style={
                        hl.inputs
                          ? { filter: "drop-shadow(0 0 6px rgba(88,166,255,.6))" }
                          : undefined
                      }
                    />
                    <text
                      x={IN[i].x}
                      y={IN[i].y - 36}
                      textAnchor="middle"
                      fontSize="13"
                      fill="#8b98ab"
                    >
                      x{i + 1}
                    </text>
                    <text
                      x={IN[i].x}
                      y={IN[i].y + 5}
                      textAnchor="middle"
                      fontSize="13"
                      fill="#e7edf4"
                    >
                      {fmt(xi)}
                    </text>
                  </g>
                ))}
              </g>

              {/* нейрон */}
              <motion.circle
                cx={NEURON.x}
                cy={NEURON.y}
                r={NEURON.r}
                fill={`hsl(213, ${Math.round(55 + n * 20)}%, ${(14 + n * 52).toFixed(0)}%)`}
                stroke={`hsl(213, 70%, ${(28 + n * 30).toFixed(0)}%)`}
                strokeWidth={2}
                animate={{
                  filter:
                    n > 0.75
                      ? "drop-shadow(0 0 14px rgba(88,166,255,.8))"
                      : "drop-shadow(0 0 0px rgba(88,166,255,0))",
                }}
              />
              <text x={350} y={152} textAnchor="middle" fontSize="11" fill={n > 0.6 ? "#22344e" : "#8b98ab"}>
                Σ → f
              </text>
              <text x={350} y={175} textAnchor="middle" fontSize="13" fill={n > 0.6 ? "#22344e" : "#aeb9c8"}>
                z = {fmt(z)}
              </text>
              <text
                x={350}
                y={197}
                textAnchor="middle"
                fontSize="15"
                fontWeight={700}
                fill={n > 0.6 ? "#0d1117" : "#e7edf4"}
              >
                a = {fmt(a)}
              </text>
              <text x={350} y={248} textAnchor="middle" fontSize="12" fill="#8b98ab">
                нейрон (neuron)
              </text>
            </svg>
          </Card>

          <Card title="Живая формула" className={glow(hl.formula)}>
            <div className="font-mono text-[14.5px] leading-[1.9]">
              <div className="text-muted">z = w1·x1 + w2·x2 + w3·x3 + b</div>
              <div className="break-words">
                {"z = "}
                {w.map((wi, i) => (
                  <span key={i}>
                    <span className={wi < 0 ? "text-hot" : "text-accent"}>{par(wi)}</span>
                    {"·"}
                    {par(x[i])}
                    {i < 2 ? " + " : ""}
                  </span>
                ))}
                {" + "}
                {fmt(b)}
                {" = "}
                <AnimatedNumber value={z} className="font-semibold text-ok" />
              </div>
              <div>
                a = {A.sym}(z) = {A.sym}({fmt(z)}) ={" "}
                <AnimatedNumber value={a} className="font-semibold text-ok" />
              </div>
            </div>
          </Card>

          {st === null && (
            <Card title="Что здесь происходит">
              <p className="my-2 max-w-[1000px] text-soft">
                Нейрон — крошечный калькулятор: каждый вход x умножается на свой
                вес w (weight), всё складывается, добавляется смещение b (bias) —
                получается z. Затем z проходит через нелинейную функцию активации
                — именно нелинейность позволяет сети из тысяч таких нейронов
                приближать сколь угодно сложные зависимости, а не только прямые
                линии. У sigmoid и tanh края «насыщаются» (там градиент почти
                нулевой — сеть перестаёт учиться), ReLU просто обрезает
                отрицательные z, а step — это перцептрон 1958 года, ступенька без
                полутонов.
              </p>
              <p className="my-2 text-sm text-muted">
                📺 К видео: 3Blue1Brown — «But what is a neural network?» (глава
                1) и Andrej Karpathy — «Zero to Hero», часть 1 (micrograd): там
                ровно такой нейрон с tanh строится в коде.
              </p>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card
            title="Параметры"
            className={glow(st === 1 || st === 2 || st === 4)}
          >
            <div className="mb-1 text-xs tracking-wide text-muted">
              Входы (inputs){st === 1 && " ← двигай эти"}
            </div>
            {x.map((xi, i) => (
              <SliderRow
                key={i}
                label={`x${i + 1}`}
                value={xi}
                onChange={(v) => setXi(i, v)}
                min={-2}
                max={2}
              />
            ))}
            <div className="mb-1 mt-3 text-xs tracking-wide text-muted">
              Веса (weights) и смещение (bias)
              {st === 2 && " ← теперь эти"}
            </div>
            {w.map((wi, i) => (
              <SliderRow
                key={i}
                label={`w${i + 1}`}
                value={wi}
                onChange={(v) => setWi(i, v)}
                min={-2}
                max={2}
                signColor
              />
            ))}
            <SliderRow
              label="b"
              value={b}
              onChange={setB}
              min={-2}
              max={2}
              signColor
            />
          </Card>

          <Card title="Функция активации (activation function)" className={glow(hl.plot)}>
            <Seg
              options={[
                { value: "sigmoid", label: "sigmoid (σ)" },
                { value: "tanh", label: "tanh" },
                { value: "relu", label: "ReLU" },
                { value: "step", label: "step" },
              ]}
              value={act}
              onChange={setAct}
            />
            <div className="mt-3">
              <ActPlot act={act} z={z} a={a} />
            </div>
            <div className="mt-2 text-[12.5px] text-muted">{A.info}</div>
          </Card>

          <Card title="Задания 🏆" className={glow(st === 6)}>
            <ul className="m-0 list-none p-0 text-[14px]">
              {tasks.map((t, i) => (
                <li key={i} className="my-1.5 flex items-start gap-2.5">
                  <motion.span
                    animate={
                      t.done
                        ? { scale: [1, 1.4, 1], rotate: [0, 8, 0] }
                        : { scale: 1 }
                    }
                    className={t.done ? "text-ok" : "text-faint"}
                  >
                    {t.done ? "✅" : "⬜"}
                  </motion.span>
                  <span className={t.done ? "text-ok" : "text-soft"}>
                    {t.label}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
