import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Btn } from "./ui";

export type StoryStep = {
  emoji: string;
  title: string;
  text: ReactNode;
};

/** step === null означает «песочница» (свободный режим). */
export function useStory(stepCount: number, startInStory = true) {
  const [step, setStep] = useState<number | null>(startInStory ? 0 : null);
  const next = useCallback(
    () => setStep((s) => (s === null || s >= stepCount - 1 ? null : s + 1)),
    [stepCount],
  );
  const prev = useCallback(
    () => setStep((s) => (s === null ? stepCount - 1 : Math.max(0, s - 1))),
    [stepCount],
  );
  return { step, setStep, next, prev };
}

export function StoryPanel({
  steps,
  step,
  setStep,
  next,
  prev,
  sandboxTitle = "Песочница",
  sandboxText = "Свободный режим: крути все ручки и смотри, что меняется.",
}: {
  steps: StoryStep[];
  step: number | null;
  setStep: (s: number | null) => void;
  next: () => void;
  prev: () => void;
  sandboxTitle?: string;
  sandboxText?: ReactNode;
}) {
  // стрелки клавиатуры листают шаги
  useEffect(() => {
    if (step === null) return;
    const h = (e: KeyboardEvent) => {
      // не перехватываем стрелки, когда фокус в слайдере или другом поле ввода
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [step, next, prev]);

  if (step === null) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-edge bg-panel px-[18px] py-3">
        <span className="text-[15px]">
          🎮 <b>{sandboxTitle}.</b>{" "}
          <span className="text-soft">{sandboxText}</span>
        </span>
        <button
          onClick={() => setStep(0)}
          className="cursor-pointer text-sm text-muted underline decoration-dotted underline-offset-4 hover:text-accent"
        >
          📖 пройти объяснение заново
        </button>
      </div>
    );
  }

  const s = steps[step];
  const last = step === steps.length - 1;
  return (
    <div className="mb-4 rounded-xl border border-[#2d68b8]/60 bg-gradient-to-br from-[#16233a] to-panel px-[18px] py-4">
      <div className="mb-2 flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {steps.map((_, i) => (
            <button
              key={i}
              aria-label={`шаг ${i + 1}`}
              onClick={() => setStep(i)}
              className={`h-2 cursor-pointer rounded-full transition-all ${
                i === step
                  ? "w-6 bg-accent"
                  : i < step
                    ? "w-2 bg-accent/50 hover:bg-accent/80"
                    : "w-2 bg-[#33405a] hover:bg-[#4a5b7d]"
              }`}
            />
          ))}
        </div>
        <span className="text-xs text-muted">
          шаг {step + 1} из {steps.length}
        </span>
        <button
          onClick={() => setStep(null)}
          className="ml-auto cursor-pointer whitespace-nowrap text-[13px] text-muted underline decoration-dotted underline-offset-4 hover:text-accent"
        >
          пропустить → песочница 🎮
        </button>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
        >
          <div className="mb-1 text-[17px] font-semibold">
            <span className="mr-2">{s.emoji}</span>
            {s.title}
          </div>
          <div className="max-w-[920px] text-[15.5px] leading-relaxed text-soft">
            {s.text}
          </div>
        </motion.div>
      </AnimatePresence>

      <div className="mt-3.5 flex items-center gap-2">
        <Btn onClick={prev} disabled={step === 0}>
          ← Назад
        </Btn>
        <Btn onClick={next} variant="primary">
          {last ? "В песочницу 🎮" : "Дальше →"}
        </Btn>
        <span className="ml-2 hidden text-xs text-faint sm:inline">
          можно листать стрелками ← →
        </span>
      </div>
    </div>
  );
}
