import type { Session } from "./types";
import { exById, useFit } from "./store";
import { doneSets, duration, tonnage } from "./stats";
import { ExerciseArt } from "./art/ExerciseArt";
import { fmtDuration, fmtTonnage, fmtWeight, Pill } from "./ui";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-edge bg-panel2/50 px-3 py-2 text-center">
      <div className="font-mono text-lg text-ink">{value}</div>
      <div className="text-xs text-muted">{label}</div>
      {hint && <div className="text-xs text-ok">{hint}</div>}
    </div>
  );
}

/** Итог тренировки: одинаково выглядит и на финише, и в журнале. */
export function SessionSummary({
  session,
  compareTo,
}: {
  session: Session;
  compareTo?: Session | null;
}) {
  const state = useFit((s) => s);
  const vol = tonnage(session);
  const prevVol = compareTo ? tonnage(compareTo) : null;
  const delta = prevVol !== null && prevVol > 0 ? vol - prevVol : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label={session.finishedAt ? "время" : "идёт"}
          value={fmtDuration(duration(session))}
        />
        <Stat
          label="тоннаж"
          value={vol > 0 ? fmtTonnage(vol) : "—"}
          hint={
            delta !== null && delta !== 0
              ? `${delta > 0 ? "+" : "−"}${fmtTonnage(Math.abs(delta))} к прошлому`
              : undefined
          }
        />
        <Stat label="подходов" value={String(doneSets(session))} />
      </div>

      <ul className="space-y-2">
        {session.entries.map((e, i) => {
          const ex = exById(e.exId, state);
          const done = e.sets.filter((s) => s.done);
          const top = done.length
            ? done.reduce((a, b) => (b.weight > a.weight ? b : a))
            : null;
          return (
            <li
              key={`${e.exId}-${i}`}
              className="flex items-start gap-3 rounded-xl border border-edge bg-panel px-3 py-2"
            >
              {ex && (
                <ExerciseArt ex={ex} className="w-10 shrink-0 opacity-70" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] text-ink">
                  {ex?.name ?? e.exId}
                </div>
                <div className="text-sm text-muted">
                  {done.length
                    ? done
                        .map((s) => (s.weight ? `${s.weight}×${s.reps}` : `${s.reps}`))
                        .join(" · ")
                    : "без отмеченных подходов"}
                </div>
                {e.note && (
                  <div className="mt-1 text-sm text-soft italic">{e.note}</div>
                )}
              </div>
              {top && top.weight > 0 && (
                <Pill tone="accent">{fmtWeight(top.weight)}</Pill>
              )}
            </li>
          );
        })}
      </ul>

      {session.note && (
        <div className="rounded-xl border border-edge bg-panel px-3 py-2 text-sm text-soft">
          {session.note}
        </div>
      )}
    </div>
  );
}
