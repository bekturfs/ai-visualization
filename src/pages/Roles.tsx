import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { Layout, Card, SliderRow } from "../components/ui";
import { FlowDots } from "../components/FlowDots";
import { fmt } from "../lib/format";

const sig = (z: number) => 1 / (1 + Math.exp(-z));

/* ---------- живой пример: нейрон решает, брать ли зонт ---------- */

const FACTS = [
  { emoji: "☁️", name: "тучи на небе", short: "тучи" },
  { emoji: "📻", name: "прогноз обещает дождь", short: "прогноз" },
  { emoji: "💧", name: "уже капает", short: "капает" },
];

export default function Roles() {
  const [x, setX] = useState([0.7, 0.3, 0.0]);
  const [w, setW] = useState([1.2, 0.8, 2.5]);
  const [b, setB] = useState(-1.5);
  const [rained, setRained] = useState(true); // что случилось «на самом деле»

  const z = w[0] * x[0] + w[1] * x[1] + w[2] * x[2] + b;
  const a = sig(z);
  const take = a > 0.5;
  const target = rained ? 1 : 0;
  const loss = (a - target) ** 2;
  // самый влиятельный факт (по модулю вклада) и самый «громкий» вес прямо сейчас
  const contribs = w.map((wi, i) => wi * x[i]);
  const maxIdx = contribs.reduce(
    (best, c, i) => (Math.abs(c) > Math.abs(contribs[best]) ? i : best),
    0,
  );
  const topW = w.reduce(
    (best, wi, i) => (Math.abs(wi) > Math.abs(w[best]) ? i : best),
    0,
  );

  const setXi = (i: number, v: number) =>
    setX((xs) => xs.map((o, j) => (j === i ? v : o)));
  const setWi = (i: number, v: number) =>
    setW((ws) => ws.map((o, j) => (j === i ? v : o)));

  const goto = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  /* ---------- карточки «кто за что отвечает» ---------- */

  type Block = {
    id: string;
    emoji: string;
    title: string;
    en: string;
    role: string; // «отвечает за …» — одной фразой
    text: ReactNode;
    example: ReactNode; // живая строка про зонт
    link?: { to: string; label: string };
  };

  const blocks: Block[] = [
    {
      id: "input",
      emoji: "📥",
      title: "Вход",
      en: "input, x",
      role: "за информацию из внешнего мира",
      text: (
        <>
          Входы — это факты, записанные числами. Сами по себе они ничего не
          решают — это просто «что мы видим». В больших сетях входами бывают
          пиксели фото, слова текста, звук.
        </>
      ),
      example: (
        <>
          сейчас: тучи = {fmt(x[0])}, прогноз = {fmt(x[1])}, капает ={" "}
          {fmt(x[2])} (0 — совсем нет, 1 — максимально)
        </>
      ),
      link: { to: "/neuron", label: "01 · Нейрон" },
    },
    {
      id: "weight",
      emoji: "🎚",
      title: "Вес",
      en: "weight, w",
      role: "за важность каждого факта",
      text: (
        <>
          Вес — это «громкость» факта: насколько сильно он влияет на решение и
          в какую сторону (плюс — «за», минус — «против»).{" "}
          <b className="text-ink">Именно веса сеть подбирает, когда учится</b> —
          всё обучение нейросетей сводится к подкручиванию весов.
        </>
      ),
      example: (
        <>
          самый «громкий» факт сейчас — {FACTS[topW].emoji} «{FACTS[topW].short}»
          (вес {fmt(w[topW])}), а с учётом самих фактов сильнее всего на решение
          давит {FACTS[maxIdx].emoji} «{FACTS[maxIdx].short}» (вклад{" "}
          {fmt(contribs[maxIdx])}). Подвигай ползунки важности — лидер сменится
        </>
      ),
      link: { to: "/neuron", label: "01 · Нейрон" },
    },
    {
      id: "bias",
      emoji: "🎭",
      title: "Смещение",
      en: "bias, b",
      role: "за характер: насколько легко сказать «да» без поводов",
      text: (
        <>
          Bias прибавляется всегда, независимо от фактов. Это стартовая
          предрасположенность: перестраховщик (b &gt; 0) берёт зонт почти
          всегда, оптимист (b &lt; 0) — только при веских причинах. Технически —
          сдвигает порог срабатывания.
        </>
      ),
      example: (
        <>
          сейчас b = {fmt(b)}: наш нейрон —{" "}
          {b < -0.5 ? "оптимист, без серьёзных поводов зонт не возьмёт" : b > 0.5 ? "перестраховщик, зонт почти всегда с собой" : "что-то посередине"}
        </>
      ),
      link: { to: "/neuron", label: "01 · Нейрон" },
    },
    {
      id: "sum",
      emoji: "➕",
      title: "Взвешенная сумма",
      en: "weighted sum, z",
      role: "за подсчёт голосов",
      text: (
        <>
          Каждый факт умножается на свою важность, всё складывается, плюс
          характер. Получается один «счёт голосов» z: сильно положительный —
          доводов «за» много, отрицательный — мало.
        </>
      ),
      example: (
        <>
          z = {fmt(w[0])}·{fmt(x[0])} + {fmt(w[1])}·{fmt(x[1])} + {fmt(w[2])}·
          {fmt(x[2])} + ({fmt(b)}) = <b className="text-ok">{fmt(z)}</b>
        </>
      ),
      link: { to: "/neuron", label: "01 · Нейрон" },
    },
    {
      id: "activation",
      emoji: "📈",
      title: "Функция активации",
      en: "activation, f",
      role: "за перевод счёта в понятный ответ",
      text: (
        <>
          Счёт z может быть любым — хоть +50. Активация сжимает его в удобную
          шкалу: sigmoid даёт число от 0 («точно нет») до 1 («точно да») —
          получается <b className="text-ink">уверенность</b>. Заодно добавляет
          нелинейность, без которой сеть умела бы рисовать только прямые линии.
        </>
      ),
      example: (
        <>
          σ({fmt(z)}) = <b className="text-ok">{fmt(a)}</b> — уверенность{" "}
          {(a * 100).toFixed(0)}%, что зонт нужен
        </>
      ),
      link: { to: "/neuron", label: "01 · Нейрон" },
    },
    {
      id: "neuron",
      emoji: "⚪️",
      title: "Нейрон целиком",
      en: "neuron",
      role: "за одно микро-решение",
      text: (
        <>
          Нейрон = взвесить факты + перевести в уверенность. Одно крошечное
          решение из чисел. По отдельности он примитивен — сила появляется,
          когда таких решалок миллиарды и они слушают друг друга.
        </>
      ),
      example: (
        <>
          вердикт сейчас: {take ? "☂️ зонт берём" : "☀️ идём так"} (уверенность{" "}
          {(a * 100).toFixed(0)}%)
        </>
      ),
      link: { to: "/neuron", label: "01 · Нейрон" },
    },
    {
      id: "layer",
      emoji: "📚",
      title: "Слой",
      en: "layer",
      role: "за несколько разных «взглядов» на одни данные",
      text: (
        <>
          Слой — это несколько нейронов, смотрящих на одни и те же входы, но с{" "}
          <b className="text-ink">разными весами</b>: один следит за «капает +
          тучи», другой — за «прогноз + ветер», третий — за чем-то своим.
          Каждый замечает свою закономерность.
        </>
      ),
      example: (
        <>
          в примере с зонтом второй нейрон слоя мог бы отвечать на вопрос
          «надолго ли выхожу?», третий — «есть ли куртка с капюшоном?»
        </>
      ),
      link: { to: "/forward-pass", label: "02 · Forward pass" },
    },
    {
      id: "network",
      emoji: "🕸",
      title: "Сеть из слоёв",
      en: "network, forward pass",
      role: "за сборку микро-решений в сложное решение",
      text: (
        <>
          Выходы одного слоя становятся входами следующего: микро-решения
          складываются в решения покрупнее. Прогон данных через все слои слева
          направо — это forward pass. В GPT таких слоёв ~сотня.
        </>
      ),
      example: (
        <>
          слой 1: «дождь вероятен?», «выхожу надолго?» → слой 2 собирает:
          «брать ли зонт, куртку или остаться дома»
        </>
      ),
      link: { to: "/forward-pass", label: "02 · Forward pass" },
    },
    {
      id: "loss",
      emoji: "📏",
      title: "Функция потерь",
      en: "loss, L",
      role: "за измерение «насколько ошиблись»",
      text: (
        <>
          Чтобы учиться, нужно мерить ошибку числом. Loss сравнивает ответ сети
          с тем, что было на самом деле: угадали — почти ноль, промахнулись —
          большое число. Переключи «что случилось» в живом примере сверху и
          смотри сюда.
        </>
      ),
      example: (
        <>
          сеть сказала {fmt(a)}, на самом деле дождь{" "}
          {rained ? "БЫЛ (правильный ответ 1)" : "НЕ БЫЛ (правильный ответ 0)"}:
          L = ({fmt(a)} − {target})² = <b className="text-ok">{fmt(loss)}</b>
          {loss > 0.25 ? " — ощутимый промах" : " — почти угадали"}
        </>
      ),
      link: { to: "/gradient-descent", label: "03 · Градиентный спуск" },
    },
    {
      id: "gradient",
      emoji: "🧭",
      title: "Градиент",
      en: "gradient, ∇L",
      role: "за направление «куда крутить веса»",
      text: (
        <>
          Градиент — компас обучения: для каждого веса он говорит, в какую
          сторону его сдвинуть, чтобы ошибка уменьшилась. Не «на сколько
          красиво», а строго математически — наклон ошибки по этому весу.
        </>
      ),
      example: (
        <>
          {loss < 0.1
            ? "сеть почти угадала — градиенты крошечные, веса почти не изменятся (не сломано — не чини)"
            : rained
              ? "промокли → градиент скажет: веса «дождевых» фактов увеличить, чтобы в следующий раз зонт взять"
              : "зря таскали зонт → градиент скажет: веса чуть уменьшить, паниковать меньше"}
        </>
      ),
      link: { to: "/gradient-descent", label: "03 · Градиентный спуск" },
    },
    {
      id: "lr",
      emoji: "👣",
      title: "Learning rate",
      en: "η, скорость обучения",
      role: "за размер шага при подкрутке",
      text: (
        <>
          Насколько сильно менять веса за один раз. Слишком мало — учимся
          вечность; слишком много — перепрыгиваем хорошие настройки и идём
          вразнос. Главная «ручка», которую крутят инженеры.
        </>
      ),
      example: (
        <>
          один промах под дождём не должен превращать оптимиста в параноика —
          η держит шаг изменения весов разумным
        </>
      ),
      link: { to: "/gradient-descent", label: "03 · Градиентный спуск" },
    },
    {
      id: "backprop",
      emoji: "🍰",
      title: "Backpropagation",
      en: "обратное распространение",
      role: "за поиск виноватых в ошибке",
      text: (
        <>
          В сети миллиарды весов — кого именно подкручивать? Backprop проходит
          по вычислению задом наперёд и каждому весу выдаёт его персональную
          долю вины (его градиент). Дёшево и точно — поэтому им учат все сети.
        </>
      ),
      example: (
        <>
          промокли: главный виноватый — маленький вес у «уже капает»? или
          слишком пессимистичный bias? backprop посчитает вину каждого
        </>
      ),
      link: { to: "/backpropagation", label: "04 · Backpropagation" },
    },
    {
      id: "training",
      emoji: "🔁",
      title: "Цикл обучения",
      en: "training loop",
      role: "за повторение «ошиблись → нашли виноватых → подкрутили»",
      text: (
        <>
          Всё вместе: прогнали пример (forward) → померили ошибку (loss) →
          нашли виноватых (backprop) → сдвинули веса на шаг (gradient descent ×
          η). Повторить миллиарды раз на миллиардах примеров — получится GPT.
        </>
      ),
      example: (
        <>
          1000 дней с зонтом и без — и веса сами настроятся лучше любых правил,
          написанных вручную
        </>
      ),
      link: { to: "/big-picture", label: "00 · Общая картина" },
    },
  ];

  /* ---------- схема живого примера ---------- */
  const IN_POS = [
    { x: 80, y: 50 },
    { x: 80, y: 125 },
    { x: 80, y: 200 },
  ];
  const N = { x: 330, y: 125 };

  return (
    <Layout crumb="🧩 Кто за что отвечает" crumbEn="what each part does">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Кто за что отвечает — разбор на одном примере
      </h1>
      <p className="mb-4 max-w-[940px] text-muted">
        Один житейский вопрос — <b className="text-ink">«брать ли зонт?»</b> —
        и все детали нейросети по очереди: какую роль играет каждая. Пример
        сверху живой: крути ползунки, а карточки ниже будут ссылаться на твои
        текущие числа.
      </p>

      {/* навигация по блокам */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {blocks.map((bl) => (
          <button
            key={bl.id}
            onClick={() => goto(bl.id)}
            className="cursor-pointer rounded-full border border-edge bg-panel px-3 py-1 text-[12.5px] text-muted transition-colors hover:border-accent hover:text-accent"
          >
            {bl.emoji} {bl.title}
          </button>
        ))}
      </div>

      {/* живой пример */}
      <Card title="Живой пример: нейрон-решала «брать ли зонт?»" className="mb-5">
        <div className="grid grid-cols-[1.1fr_.9fr] items-center gap-4 max-lg:grid-cols-1">
          <svg viewBox="0 0 560 250" aria-label="Нейрон решает, брать ли зонт">
            {w.map((wi, i) => {
              const col = wi >= 0 ? "#58a6ff" : "#f0564f";
              return (
                <g key={i}>
                  <line
                    x1={IN_POS[i].x + 30}
                    y1={IN_POS[i].y}
                    x2={N.x}
                    y2={N.y}
                    stroke={col}
                    strokeWidth={1.2 + Math.abs(wi) * 2.2}
                    strokeOpacity={0.9}
                  />
                  <text
                    x={(IN_POS[i].x + 30 + N.x) / 2 - 20}
                    y={(IN_POS[i].y + N.y) / 2 - 8}
                    fontSize="11.5"
                    fill={col}
                  >
                    важность {fmt(wi)}
                  </text>
                  <FlowDots
                    from={{ x: IN_POS[i].x + 30, y: IN_POS[i].y }}
                    to={N}
                    count={2}
                    r={2.6}
                    color={col}
                    speed={0.45}
                    opacity={0.15 + Math.min(0.8, Math.abs(w[i] * x[i]) * 0.6)}
                  />
                </g>
              );
            })}
            {FACTS.map((f, i) => (
              <g key={i}>
                <circle cx={IN_POS[i].x} cy={IN_POS[i].y} r={28} fill="#1b2330" stroke="#3a465c" strokeWidth={1.5} />
                <text x={IN_POS[i].x} y={IN_POS[i].y - 6} textAnchor="middle" fontSize="15">
                  {f.emoji}
                </text>
                <text x={IN_POS[i].x} y={IN_POS[i].y + 12} textAnchor="middle" fontSize="11" fill="#e7edf4">
                  {fmt(x[i])}
                </text>
                <text x={IN_POS[i].x} y={IN_POS[i].y - 38} textAnchor="middle" fontSize="11" fill="#8b98ab">
                  {f.short}
                </text>
              </g>
            ))}
            <motion.circle
              cx={N.x}
              cy={N.y}
              r={46}
              fill={`hsl(213, ${Math.round(55 + a * 20)}%, ${(14 + a * 50).toFixed(0)}%)`}
              stroke="#3a567e"
              strokeWidth={2}
              animate={{
                filter:
                  a > 0.75
                    ? "drop-shadow(0 0 12px rgba(88,166,255,.7))"
                    : "drop-shadow(0 0 0px rgba(88,166,255,0))",
              }}
            />
            <text x={N.x} y={N.y - 8} textAnchor="middle" fontSize="11" fill={a > 0.6 ? "#22344e" : "#8b98ab"}>
              счёт {fmt(z)}
            </text>
            <text x={N.x} y={N.y + 12} textAnchor="middle" fontSize="14" fontWeight={700} fill={a > 0.6 ? "#0d1117" : "#e7edf4"}>
              {(a * 100).toFixed(0)}%
            </text>
            <text x={N.x} y={N.y + 70} textAnchor="middle" fontSize="11.5" fill="#8b98ab">
              характер (bias): {fmt(b)}
            </text>
            <line x1={N.x + 50} y1={N.y} x2={470} y2={N.y} stroke="#8b98ab" strokeWidth={2} />
            <text x={505} y={N.y - 14} textAnchor="middle" fontSize="26">
              {take ? "☂️" : "☀️"}
            </text>
            <text x={505} y={N.y + 10} textAnchor="middle" fontSize="12" fill="#e7edf4">
              {take ? "берём" : "не берём"}
            </text>
            <text x={505} y={N.y + 28} textAnchor="middle" fontSize="11" fill="#8b98ab">
              уверенность {(a * 100).toFixed(0)}%
            </text>
          </svg>

          <div>
            <div className="mb-1 text-xs tracking-wide text-muted">Факты (входы)</div>
            {FACTS.map((f, i) => (
              <SliderRow
                key={i}
                label={`${f.emoji} ${f.short}`}
                labelWidth={96}
                value={x[i]}
                onChange={(v) => setXi(i, v)}
                min={0}
                max={1}
              />
            ))}
            <div className="mb-1 mt-3 text-xs tracking-wide text-muted">
              Важность фактов (веса) и характер (bias)
            </div>
            {FACTS.map((f, i) => (
              <SliderRow
                key={i}
                label={`w ${f.short}`}
                labelWidth={96}
                value={w[i]}
                onChange={(v) => setWi(i, v)}
                min={-3}
                max={3}
                signColor
              />
            ))}
            <SliderRow label="b характер" labelWidth={96} value={b} onChange={setB} min={-3} max={3} signColor />
            <div className="mt-3 flex items-center gap-2 text-[13.5px]">
              <span className="text-muted">что случилось на самом деле:</span>
              <button
                onClick={() => setRained((r) => !r)}
                className="cursor-pointer rounded-lg border border-[#344158] bg-[#202938] px-3 py-1 text-ink transition-colors hover:border-accent"
              >
                {rained ? "🌧 дождь был" : "🌤 дождя не было"}
              </button>
            </div>
          </div>
        </div>
      </Card>

      {/* карточки блоков */}
      <div className="grid grid-cols-2 items-start gap-4 max-md:grid-cols-1">
        {blocks.map((bl) => (
          <div key={bl.id} id={bl.id} className="scroll-mt-16">
            <Card className="h-full">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[20px]">{bl.emoji}</span>
                <span className="text-[16px] font-semibold">{bl.title}</span>
                <span className="text-[12.5px] text-muted">({bl.en})</span>
              </div>
              <div className="mb-2 text-[14px] font-semibold text-accent">
                Отвечает {bl.role}
              </div>
              <p className="my-0 text-[14px] leading-relaxed text-soft">{bl.text}</p>
              <div className="mt-2.5 rounded-lg border border-edge bg-panel2 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-[#cfe5ff]">
                ☂️ {bl.example}
              </div>
              {bl.link && (
                <div className="mt-2.5 text-[13px]">
                  <Link to={bl.link.to} className="text-muted underline decoration-dotted underline-offset-4 hover:text-accent">
                    покрутить руками → {bl.link.label}
                  </Link>
                </div>
              )}
            </Card>
          </div>
        ))}
      </div>
    </Layout>
  );
}
