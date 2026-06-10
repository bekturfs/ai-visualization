import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Layout, Card } from "../components/ui";
import { StoryPanel, useStory, type StoryStep } from "../components/StoryMode";
import { trainBPE, encodeText, encodeWordSteps } from "../lib/bpe";
import { CORPUS, tokenize } from "../lib/tinylm";

const PALETTE = ["#58a6ff", "#56d364", "#ffa657", "#d2a8ff", "#f0564f", "#79c0ff"];

/** Русская плюрализация: plural(3, "токен", "токена", "токенов") → «токена». */
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

const STEPS: StoryStep[] = [
  {
    emoji: "✂️",
    title: "Модель не видит ни букв, ни слов — только «кусочки»",
    text: (
      <>
        Прежде чем текст попадёт в нейросеть, его нарезают на токены (tokens) —
        кусочки из заранее составленного словаря. Сейчас разберёмся,{" "}
        <b className="text-ink">почему кусочки, а не слова и не буквы</b> — и
        соберём такой словарь по-настоящему, прямо у тебя в браузере.
      </>
    ),
  },
  {
    emoji: "🤯",
    title: "Почему не целыми словами?",
    text: (
      <>
        Слов бесконечно много: «кот», «котик», «котище», «котоламповый»,
        опечатки, имена, новые мемы… Словарь из целых слов распух бы до
        миллионов и всё равно встречал бы незнакомое. А незнакомое слово для
        модели — слепое пятно: она не смогла бы его даже прочитать.
      </>
    ),
  },
  {
    emoji: "🐌",
    title: "Почему не буквами?",
    text: (
      <>
        Буквами можно — их всего ~33, и любое слово читается. Но тогда текст
        становится в 4–5 раз длиннее, а каждый токен — это вычисления, память и
        деньги. Та же фраза будет «съедать» в пять раз больше ресурсов, и
        модели придётся учиться собирать смысл из песчинок.
      </>
    ),
  },
  {
    emoji: "🧱",
    title: "BPE: начинаем с букв…",
    text: (
      <>
        Алгоритм BPE (byte-pair encoding) — золотая середина. Шаг первый:
        режем все слова обучающего текста на отдельные буквы. Смотри на
        карточку «Разделка слова» — слово «предсказывает» сейчас разобрано на
        буквы.
      </>
    ),
  },
  {
    emoji: "🔗",
    title: "…и клеим самые частые пары",
    text: (
      <>
        Дальше алгоритм миллион раз повторяет одно действие:{" "}
        <b className="text-ink">найди два кусочка, которые чаще всего стоят
        рядом, и склей их в один</b>. Смотри: слово склеивается на глазах, а
        справа — настоящий словарь слияний, выученный на нашем корпусе из ~50
        предложений. Частые куски («пред», «ает») становятся токенами.
      </>
    ),
  },
  {
    emoji: "📖",
    title: "Словарь готов: частое — целиком, редкое — кусочками",
    text: (
      <>
        В итоге частые слова кодируются одним-двумя токенами, а редкие и
        выдуманные — несколькими, но <b className="text-ink">прочитать можно
        любое слово</b>, даже которого алгоритм никогда не видел. У GPT словарь
        ≈ 100 000 токенов, выученный на интернете, — принцип ровно тот же.
      </>
    ),
  },
  {
    emoji: "⌨️",
    title: "Попробуй сам!",
    text: (
      <>
        Введи любой текст в поле «Попробуй сам» — хоть выдуманные слова, хоть
        опечатки. Наш словарь маленький, поэтому редкое режется мелко, но
        ничего не теряется. Обрати внимание на счётчик: насколько токенов
        меньше, чем букв.
      </>
    ),
  },
  {
    emoji: "💰",
    title: "Токены — это деньги и память",
    text: (
      <>
        Доступ к моделям продают «за токены», и контекстное окно (сколько
        модель «помнит») тоже меряется в токенах. Чем умнее токенизация, тем
        больше смысла влезает в то же окно. Дальше — задания, а потом
        посмотрим, как токены превращаются в числа (страница 06).
      </>
    ),
  },
];

export default function Tokenization() {
  const merges = useMemo(() => trainBPE(), []);
  const corpusWords = useMemo(() => {
    const s = new Set<string>();
    for (const sent of CORPUS) for (const w of tokenize(sent)) s.add(w);
    return s;
  }, []);
  const demoStates = useMemo(
    () => encodeWordSteps("предсказывает", merges),
    [merges],
  );

  const [text, setText] = useState("нейросеть предсказывает погоду, а снеговичок тает");
  const [animIdx, setAnimIdx] = useState(0);
  const timer = useRef<number | null>(null);

  const story = useStory(STEPS.length);
  const st = story.step;

  // анимация разделки слова на шагах 3–4 и в песочнице
  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (st === 3) {
      setAnimIdx(0);
      return;
    }
    if (st === 4 || st === null) {
      setAnimIdx(0);
      timer.current = window.setInterval(() => {
        setAnimIdx((i) => (i + 1) % demoStates.length);
      }, 1100);
      return () => {
        if (timer.current) clearInterval(timer.current);
      };
    }
    setAnimIdx(demoStates.length - 1);
  }, [st, demoStates.length]);

  const tokens = useMemo(() => encodeText(text, merges), [text, merges]);
  const letters = (text.match(/[а-яёa-z]/gi) ?? []).length;

  /* статистика по словам ввода — для заданий */
  const wordStats = useMemo(() => {
    const words = text.toLowerCase().match(/[а-яё-]+/g) ?? [];
    return words.map((w) => ({
      w,
      n: encodeText(w, merges).length,
      known: corpusWords.has(w),
    }));
  }, [text, merges, corpusWords]);

  const [oneTokenSeen, setOneTokenSeen] = useState(false);
  const [fiveTokenSeen, setFiveTokenSeen] = useState(false);
  const [novelSeen, setNovelSeen] = useState(false);
  const [longSeen, setLongSeen] = useState(false);
  useEffect(() => {
    if (wordStats.some((s) => s.n === 1 && s.w.length >= 4)) setOneTokenSeen(true);
    if (wordStats.some((s) => s.n >= 5)) setFiveTokenSeen(true);
    if (wordStats.some((s) => !s.known && s.w.length >= 5)) setNovelSeen(true);
    if (letters >= 30) setLongSeen(true);
  }, [wordStats, letters]);

  const tasks = [
    { label: "Найди слово (4+ букв), которое кодируется 1 токеном", done: oneTokenSeen },
    { label: "Найди слово из 5+ токенов", done: fiveTokenSeen },
    { label: "Введи выдуманное слово — оно всё равно прочитается", done: novelSeen },
    { label: "Набери текст от 30 букв и оцени экономию", done: longSeen },
  ];

  const glow = (on: boolean) => (on ? "ring-2 ring-accent/70" : "");
  const curState = demoStates[Math.min(animIdx, demoStates.length - 1)];

  return (
    <Layout crumb="05 · Токенизация" crumbEn="tokenization, BPE">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Как текст нарезают на токены
      </h1>
      <p className="mb-4 max-w-[940px] text-muted">
        <b className="text-ink">Токенизация отвечает за «зрение» модели:</b>{" "}
        какими кусочками она видит текст. Здесь работает настоящий алгоритм
        BPE, обученный в браузере на корпусе с предыдущих страниц — все
        слияния и счётчики честные.
      </p>

      <StoryPanel
        steps={STEPS}
        step={story.step}
        setStep={story.setStep}
        next={story.next}
        prev={story.prev}
        sandboxText="Печатай любой текст и смотри, как он режется. Слева — вечная анимация разделки слова."
      />

      <div className="grid grid-cols-[1.05fr_.95fr] items-start gap-4 max-lg:grid-cols-1">
        <div className="flex flex-col gap-4">
          <Card title="Разделка слова «предсказывает»" className={glow(st === 3 || st === 4)}>
            <div className="flex min-h-[56px] flex-wrap items-center gap-1.5">
              {curState.syms.map((s, i) => (
                <motion.span
                  layout
                  key={`${animIdx}-${i}-${s}`}
                  initial={{ scale: 0.7, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="rounded-lg border px-2.5 py-1.5 font-mono text-[16px]"
                  style={{
                    borderColor: PALETTE[i % PALETTE.length] + "88",
                    background: PALETTE[i % PALETTE.length] + "1f",
                    color: PALETTE[i % PALETTE.length],
                  }}
                >
                  {s}
                </motion.span>
              ))}
              <span className="ml-2 text-[13px] text-muted">
                {curState.syms.length}{" "}
                {plural(curState.syms.length, "токен", "токена", "токенов")}
              </span>
            </div>
            <div className="mt-2 min-h-[20px] text-[13px] text-muted">
              {curState.rule ? (
                <>
                  склеили «{curState.rule.a}» + «{curState.rule.b}» → «
                  <b className="text-ink">{curState.rule.merged}</b>» (пара
                  встречается {curState.rule.count} раз в корпусе)
                </>
              ) : (
                "шаг 0: слово разобрано на отдельные буквы"
              )}
            </div>
          </Card>

          <Card title="Попробуй сам" className={glow(st === 6)}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-edge bg-[#0e131b] px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-accent"
              placeholder="введи любой текст (кириллицей)…"
            />
            <div className="mt-3 flex min-h-[40px] flex-wrap gap-1.5">
              <AnimatePresence>
                {tokens.map((t, i) => (
                  <motion.span
                    key={`${i}-${t.text}`}
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className={`rounded-md border px-2 py-1 font-mono text-[13.5px] ${
                      t.known ? "" : "border-dashed"
                    }`}
                    style={
                      t.known
                        ? {
                            borderColor: PALETTE[i % PALETTE.length] + "77",
                            background: PALETTE[i % PALETTE.length] + "1a",
                            color: PALETTE[i % PALETTE.length],
                          }
                        : { borderColor: "#8a3633", color: "#ffb3ae" }
                    }
                    title={
                      t.known
                        ? undefined
                        : "символ вне словаря: пунктуация, цифра или другой алфавит"
                    }
                  >
                    {t.text}
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
            <div className={`mt-2.5 text-[13px] text-muted ${glow(st === 7)}`}>
              букв: <b className="text-ink">{letters}</b> · токенов:{" "}
              <b className="text-ink">{tokens.length}</b>
              {letters > 0 && tokens.length > 0 && (
                <>
                  {" "}
                  · экономия против побуквенной нарезки:{" "}
                  <b className="text-ok">
                    {Math.round((1 - tokens.length / letters) * 100)}%
                  </b>
                </>
              )}
            </div>
          </Card>

          {st === null && (
            <Card title="Что здесь происходит">
              <p className="my-2 max-w-[1000px] text-soft">
                BPE строит словарь снизу вверх: буквы → частые пары букв →
                частые куски слов. Получается компромисс между «словарь из
                слов» (компактно, но незнакомое не прочитать) и «словарь из
                букв» (читается всё, но дорого). Реальные модели (GPT, Claude,
                Llama) используют варианты этой же идеи со словарями на
                ~50–200 тысяч токенов. Из-за токенизации модели, кстати,
                плохо считают буквы в словах: они буквы попросту не видят.
              </p>
              <p className="my-2 text-sm text-muted">
                📺 К видео: Karpathy — «Let's build the GPT Tokenizer» (BPE
                с нуля в коде).
              </p>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card title={`Выученный словарь слияний (${merges.length} правил)`} className={glow(st === 4 || st === 5)}>
            <div className="grid max-h-[330px] grid-cols-2 gap-x-4 overflow-y-auto rounded-lg border border-edge bg-[#0e131b] px-3 py-2 font-mono text-[12.5px] leading-[1.85]">
              {merges.map((m, i) => {
                const active = curState.rule === m;
                return (
                  <div
                    key={i}
                    className={`flex justify-between ${active ? "rounded bg-[#1f3a5f] px-1 text-[#cfe5ff]" : ""}`}
                  >
                    <span>
                      <span className="text-faint">{i + 1}.</span>{" "}
                      <span className="text-soft">{m.a}</span>
                      <span className="text-faint">+</span>
                      <span className="text-soft">{m.b}</span>
                      <span className="text-faint"> → </span>
                      <span className="font-semibold text-accent">{m.merged}</span>
                    </span>
                    <span className="text-faint">×{Math.round(m.count)}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 text-[12px] text-muted">
              правила в порядке выучивания: чем выше, тем чаще пара встречалась
              в корпусе
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

          <Card title="🤏 Насколько это честно?">
            <p className="my-1 text-[13.5px] leading-relaxed text-soft">
              Алгоритм настоящий — тот самый BPE. Упрощено: наш словарь выучен
              на ~50 предложениях ({merges.length} слияний), у GPT — на
              интернете (~100 000 токенов), поэтому там «предсказывает» — один
              токен, а не несколько. И настоящие токенизаторы работают с
              байтами, так что читают любой язык и эмодзи.
            </p>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
