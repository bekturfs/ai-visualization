import { useEffect, useRef, useState } from "react";
import { bumpRest, stopRest, useFit } from "./store";
import { fmtDuration } from "./ui";

function beep() {
  try {
    const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
    const Ctx = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.55);
    osc.onended = () => void ctx.close();
  } catch {
    /* звук — приятное дополнение, без него всё работает */
  }
}

/**
 * Липкая полоса отдыха. Время считаем от метки окончания, а не тиками:
 * свернул вкладку или заблокировал телефон — вернёшься к правильной цифре.
 */
export function RestBar({ raised = false }: { raised?: boolean }) {
  const timer = useFit((s) => s.timer);
  const sound = useFit((s) => s.settings.sound);
  const vibrate = useFit((s) => s.settings.vibrate);
  const [now, setNow] = useState(() => Date.now());
  const firedFor = useRef<number | null>(null);

  useEffect(() => {
    if (!timer.endsAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [timer.endsAt]);

  const left = timer.endsAt ? (timer.endsAt - now) / 1000 : 0;
  const over = left <= 0;

  useEffect(() => {
    if (!timer.endsAt || !over) return;
    if (firedFor.current === timer.endsAt) return;
    firedFor.current = timer.endsAt;
    if (sound) beep();
    if (vibrate && typeof navigator.vibrate === "function") navigator.vibrate([120, 60, 120]);
    const id = setTimeout(() => stopRest(), 8000);
    return () => clearTimeout(id);
  }, [over, timer.endsAt, sound, vibrate]);

  if (!timer.endsAt) return null;

  const done = timer.total ? Math.min(1, 1 - left / timer.total) : 1;
  const R = 20;
  const C = 2 * Math.PI * R;

  return (
    <div className={`pointer-events-none fixed inset-x-0 z-40 flex justify-center px-3
        ${raised ? "bottom-14 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]" : "bottom-0 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"}`}>
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex w-full max-w-lg items-center gap-3 rounded-2xl border px-3 py-2 shadow-lg backdrop-blur
          ${over ? "border-ok/60 bg-ok/15" : "border-edge bg-panel/95"}`}
      >
        <svg viewBox="0 0 48 48" className="h-11 w-11 shrink-0" aria-hidden="true">
          <circle cx="24" cy="24" r={R} className="fill-none stroke-edge" strokeWidth="4" />
          <circle
            cx="24"
            cy="24"
            r={R}
            className={`fill-none ${over ? "stroke-ok" : "stroke-accent"}`}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - done)}
            transform="rotate(-90 24 24)"
          />
        </svg>
        <div className="min-w-0 flex-1">
          <div className={`font-mono text-lg ${over ? "text-ok" : "text-ink"}`}>
            {over ? "можно работать" : fmtDuration(left)}
          </div>
          <div className="truncate text-xs text-muted">{timer.label}</div>
        </div>
        {!over && (
          <>
            <button
              type="button"
              onClick={() => bumpRest(-15)}
              aria-label="минус 15 секунд"
              className="h-10 rounded-lg border border-edge px-2 text-sm text-soft transition hover:border-accent/60 hover:text-ink"
            >
              −15
            </button>
            <button
              type="button"
              onClick={() => bumpRest(15)}
              aria-label="плюс 15 секунд"
              className="h-10 rounded-lg border border-edge px-2 text-sm text-soft transition hover:border-accent/60 hover:text-ink"
            >
              +15
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => stopRest()}
          aria-label="закрыть таймер"
          className="h-10 w-10 shrink-0 rounded-lg text-muted transition hover:bg-panel2 hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
