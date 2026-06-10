import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { FlowDots } from "../components/FlowDots";

const VIZ = [
  {
    to: "/neuron",
    num: "01",
    title: "Нейрон и функции активации",
    en: "neuron & activation functions",
    badge: "⚡ живые сигналы",
    text: "Нейрон — это взвешивание мнений: каждый вход умножается на «доверие» и складывается. Пошаговая история с бегущими по проводам сигналами.",
  },
  {
    to: "/forward-pass",
    num: "02",
    title: "Forward pass",
    en: "прямой проход через слои",
    badge: "⚡ анимация волны",
    text: "Сеть 2–3–2 как конвейер: волна вычислений прокатывается слой за слоем. Кликни на любой нейрон — увидишь его личную формулу с числами.",
  },
  {
    to: "/gradient-descent",
    num: "03",
    title: "Градиентный спуск",
    en: "gradient descent",
    badge: "🧊 3D-ландшафт",
    text: "Настоящая 3D-долина функции потерь: шарик в тумане ищет дно, видя только наклон под ногами. Покрути сцену, поиграй с learning rate.",
  },
  {
    to: "/backpropagation",
    num: "04",
    title: "Backpropagation",
    en: "обратное распространение ошибки",
    badge: "⚡ поток «вины»",
    text: "Кто виноват в ошибке и насколько? Оранжевый поток вины течёт по графу назад, а потом сеть учится — и ошибка тает на глазах.",
  },
];

const SOON = [
  {
    title: "2 · Как работают LLM",
    en: "how LLMs work",
    items: [
      "Токенизация (tokenization) — BPE в действии",
      "Эмбеддинги (embeddings) — слова как векторы",
      "Механизм внимания (attention)",
      "Архитектура трансформера (transformer)",
      "Предсказание следующего токена",
      "Сэмплирование — temperature, top-p, top-k",
      "Контекстное окно и KV-кэш",
    ],
  },
  {
    title: "3 · Обучение LLM",
    en: "training LLMs",
    items: [
      "Предобучение (pretraining)",
      "Дообучение (fine-tuning)",
      "RLHF — обучение на человеческой обратной связи",
    ],
  },
  {
    title: "4 · Поиск и агенты",
    en: "deep search & agents",
    items: [
      "RAG — retrieval-augmented generation",
      "Пайплайн deep research",
      "Вызов инструментов (tool use)",
      "Цикл агента (agent loop)",
      "Мультиагентные системы",
    ],
  },
  {
    title: "5 · За пределами текста",
    en: "beyond text",
    items: ["Диффузионные модели (diffusion models)", "Мультимодальность"],
  },
];

/** Декоративная анимированная мини-сеть в шапке. */
function HeroNet() {
  const L1 = [
    { x: 30, y: 40 },
    { x: 30, y: 110 },
  ];
  const L2 = [
    { x: 150, y: 20 },
    { x: 150, y: 75 },
    { x: 150, y: 130 },
  ];
  const L3 = [{ x: 270, y: 75 }];
  const edges: { a: { x: number; y: number }; b: { x: number; y: number } }[] =
    [];
  for (const a of L1) for (const b of L2) edges.push({ a, b });
  for (const a of L2) for (const b of L3) edges.push({ a, b });
  return (
    <svg
      viewBox="0 0 300 150"
      className="h-[120px] w-[240px] shrink-0 opacity-90 max-md:hidden"
      aria-hidden
    >
      {edges.map((e, i) => (
        <line
          key={i}
          x1={e.a.x}
          y1={e.a.y}
          x2={e.b.x}
          y2={e.b.y}
          stroke="#2e3950"
          strokeWidth="1.5"
        />
      ))}
      {edges.map((e, i) => (
        <FlowDots
          key={i}
          from={e.a}
          to={e.b}
          count={1}
          r={2.5}
          speed={0.25 + (i % 5) * 0.07}
          color={i % 3 === 2 ? "#ffa657" : "#58a6ff"}
        />
      ))}
      {[...L1, ...L2, ...L3].map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="11"
          fill="#1b2330"
          stroke="#3a567e"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}

export default function Home() {
  return (
    <main className="mx-auto max-w-[1080px] px-6 pb-14 pt-10">
      <div className="flex items-start justify-between gap-6">
        <div>
          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-2 text-3xl font-bold"
          >
            AI-визуализации
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 }}
            className="mb-2 max-w-[760px] text-base text-muted"
          >
            Интерактивные визуализации, чтобы <b className="text-ink">увидеть</b>,
            как работает ИИ — от одного нейрона до LLM. Каждая тема — это{" "}
            <b className="text-ink">пошаговая история простым языком</b> с
            анимациями и 3D, а в конце — песочница, где всё можно покрутить
            руками. Все вычисления на страницах честные — никаких заранее
            записанных чисел.
          </motion.p>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-sm text-faint"
          >
            Хорошо смотрится рядом с видео 3Blue1Brown (Neural networks) и
            Andrej Karpathy (Zero to Hero).
          </motion.p>
        </div>
        <HeroNet />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12 }}
        className="mt-9"
      >
        <Link
          to="/big-picture"
          className="group flex items-center gap-5 rounded-2xl border border-[#2d68b8]/70 bg-gradient-to-br from-[#16233a] to-panel px-6 py-5 no-underline transition-all hover:-translate-y-0.5 hover:border-accent"
        >
          <div className="rounded-xl border border-accent/35 bg-accent/10 px-3 py-2 font-mono text-lg font-bold leading-none text-accent">
            00
          </div>
          <div>
            <div className="text-lg font-semibold text-ink">
              Начни отсюда: как ИИ пишет ответ — общая картина{" "}
              <span className="text-[13px] font-normal text-muted">
                (the big picture)
              </span>
            </div>
            <p className="m-0 mt-1 max-w-[760px] text-[14px] leading-normal text-soft">
              Текст заходит → токены → числа → нейросеть → вероятности → новое
              слово. Весь конвейер на одном экране, с живой мини-моделью прямо
              в браузере — поймёт даже непрограммист. Остальные страницы
              разбирают каждую станцию по отдельности.
            </p>
          </div>
          <span className="ml-auto text-2xl text-faint transition-transform group-hover:translate-x-1 group-hover:text-accent max-md:hidden">
            →
          </span>
        </Link>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18 }}
        className="mt-4"
      >
        <Link
          to="/roles"
          className="group flex items-center gap-5 rounded-2xl border border-edge bg-panel px-6 py-4 no-underline transition-all hover:-translate-y-0.5 hover:border-accent"
        >
          <span className="text-[26px]">🧩</span>
          <div>
            <div className="text-[16px] font-semibold text-ink">
              Шпаргалка: кто за что отвечает{" "}
              <span className="text-[13px] font-normal text-muted">
                (what each part does)
              </span>
            </div>
            <p className="m-0 mt-0.5 max-w-[760px] text-[13.5px] leading-normal text-soft">
              Вход, вес, bias, активация, слой, loss, градиент, backprop — роль
              каждой детали простыми словами на одном житейском примере:
              «брать ли зонт?». С живыми числами.
            </p>
          </div>
          <span className="ml-auto text-2xl text-faint transition-transform group-hover:translate-x-1 group-hover:text-accent max-md:hidden">
            →
          </span>
        </Link>
      </motion.div>

      <h2 className="mb-3.5 mt-9 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">
        Блок 1 · Основы нейросетей (neural network fundamentals)
      </h2>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        {VIZ.map((v, i) => (
          <motion.div
            key={v.to}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.07 }}
          >
            <Link
              to={v.to}
              className="group flex h-full items-start gap-4 rounded-2xl border border-edge bg-panel px-5 py-[18px] no-underline transition-all hover:-translate-y-0.5 hover:border-accent hover:bg-panel2"
            >
              <div className="mt-0.5 rounded-lg border border-accent/35 bg-accent/10 px-2.5 py-1.5 font-mono text-[15px] font-bold leading-none text-accent">
                {v.num}
              </div>
              <div>
                <div className="text-[16.5px] font-semibold text-ink">
                  {v.title}
                </div>
                <div className="mb-1 text-[13px] text-muted">{v.en}</div>
                <span className="mb-2 inline-block rounded-full border border-edge bg-panel2 px-2 py-0.5 text-[11.5px] text-muted group-hover:border-accent/40 group-hover:text-accent">
                  {v.badge}
                </span>
                <p className="m-0 text-[13.5px] leading-normal text-soft">
                  {v.text}
                </p>
              </div>
            </Link>
          </motion.div>
        ))}
      </div>

      <h2 className="mb-3.5 mt-9 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">
        Дальше по роадмапу · coming soon
      </h2>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        {SOON.map((s) => (
          <div
            key={s.title}
            className="rounded-2xl border border-dashed border-edge bg-panel px-5 py-4 opacity-65"
          >
            <span className="float-right mt-0.5 rounded-full border border-edge px-2.5 py-0.5 text-[11px] uppercase tracking-wider text-muted">
              скоро
            </span>
            <h3 className="m-0 mb-1 text-[15px] font-semibold text-[#aeb9c8]">
              {s.title}{" "}
              <span className="text-[13px] font-normal text-muted">
                ({s.en})
              </span>
            </h3>
            <ul className="m-0 mt-2.5 list-disc pl-[18px] text-[13.5px] text-muted">
              {s.items.map((it) => (
                <li key={it} className="my-1">
                  {it}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <footer className="mt-11 border-t border-edge pt-[18px] text-[13.5px] text-muted">
        React + TypeScript + Three.js (react-three-fiber) + Motion + Tailwind.
        Запуск: <code className="font-mono">npm install && npm run dev</code>.
        Полный роадмап — в{" "}
        <a
          href="https://github.com/bekturfs/ai-visualization"
          className="text-muted underline hover:text-accent"
        >
          README репозитория
        </a>
        .
      </footer>
    </main>
  );
}
