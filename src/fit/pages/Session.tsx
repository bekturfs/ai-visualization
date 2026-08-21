import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { SetLog } from "../types";
import {
  addSet,
  exById,
  finishEntry,
  finishSession,
  lastEntry,
  patchSet,
  removeSet,
  setCursor,
  setEntryNote,
  setSessionMeta,
  toggleSet,
  useFit,
} from "../store";
import { previousSameDay } from "../stats";
import { EQUIP_RU, GROUP_RU, HEAD_RU } from "../data/exercises";
import { ExerciseArt } from "../art/ExerciseArt";
import { SessionSummary } from "../SessionSummary";
import {
  Bar,
  Btn,
  Card,
  Empty,
  NoteField,
  NumField,
  Pill,
  SectionTitle,
  fmtDate,
  fmtDuration,
  plural,
} from "../ui";

const RPE_VALUES = [6, 7, 8, 9, 10];

/**
 * Строка подхода. Тыкать в неё будут потными пальцами, поэтому ✓ — 44 px,
 * а вес и повторы меняются кнопками −/+, а не только клавиатурой.
 */
function SetRow({
  entryIdx,
  setIdx,
  set,
}: {
  entryIdx: number;
  setIdx: number;
  set: SetLog;
}) {
  const num = setIdx + 1;
  return (
    <li
      className={`rounded-xl border p-2 transition-colors ${
        set.done ? "border-ok/70 bg-ok/5" : "border-edge bg-panel"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-4 shrink-0 text-center font-mono text-xs text-faint">
          {num}
        </span>
        <div className="min-w-0 flex-[1.3]">
          <NumField
            compact
            ariaLabel={`вес, подход ${num}`}
            value={set.weight}
            step={2.5}
            suffix="кг"
            onChange={(v) => patchSet(entryIdx, setIdx, { weight: v })}
          />
        </div>
        <div className="min-w-0 flex-1">
          <NumField
            compact
            integer
            ariaLabel={`повторы, подход ${num}`}
            value={set.reps}
            step={1}
            onChange={(v) => patchSet(entryIdx, setIdx, { reps: v })}
          />
        </div>
        <button
          type="button"
          aria-label={
            set.done ? `снять отметку с подхода ${num}` : `отметить подход ${num}`
          }
          aria-pressed={set.done}
          onClick={() => toggleSet(entryIdx, setIdx)}
          className={`h-11 w-11 shrink-0 rounded-lg border text-xl leading-none transition ${
            set.done
              ? "border-ok bg-ok text-bg"
              : "border-edge text-faint hover:border-ok/60 hover:text-ok active:bg-panel2"
          }`}
        >
          ✓
        </button>
      </div>

      {set.done && (
        <div className="mt-1.5 flex items-center gap-1">
          <span
            className="shrink-0 text-xs text-muted"
            title="как тяжело дался подход"
          >
            RPE
          </span>
          {RPE_VALUES.map((v) => {
            const on = set.rpe === v;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                aria-label={`RPE ${v}`}
                onClick={() =>
                  patchSet(entryIdx, setIdx, { rpe: on ? null : v })
                }
                className={`min-h-11 flex-1 rounded-lg border font-mono text-sm transition ${
                  on
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-edge text-muted hover:text-soft"
                }`}
              >
                {v}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

export default function Session() {
  const state = useFit((s) => s);
  const active = useFit((s) => s.active);
  const cursor = useFit((s) => s.cursor);
  const navigate = useNavigate();
  const [showSummary, setShowSummary] = useState(false);
  const [openCues, setOpenCues] = useState(false);

  // ───────── тренировки нет ─────────
  if (!active) {
    return (
      <div className="space-y-4">
        <Empty
          title="Тренировка не начата"
          hint="Выбери день на главной и нажми «Начать тренировку»."
        />
        <div className="flex justify-center">
          <Link
            to="/fit"
            className="inline-flex min-h-14 items-center justify-center rounded-xl bg-accent px-5 text-base font-semibold text-bg transition hover:brightness-110"
          >
            На главную
          </Link>
        </div>
      </div>
    );
  }

  const entries = active.entries;
  const total = entries.length;
  const doneCount = entries.filter((e) => e.done).length;
  const allDone = total > 0 && doneCount === total;

  // ───────── день без упражнений ─────────
  if (!total) {
    return (
      <div className="space-y-4">
        <Empty
          title="В этом дне нет упражнений"
          hint="Добавь их в плане — или заверши пустую тренировку."
        />
        <Btn
          variant="ghost"
          className="w-full"
          onClick={() => {
            finishSession();
            navigate("/fit");
          }}
        >
          завершить
        </Btn>
      </div>
    );
  }

  // ───────── экран завершения ─────────
  if (showSummary) {
    const skipped = entries.filter((e) => !e.sets.some((s) => s.done));
    const nothingLogged = entries.every(
      (e) => !e.sets.some((s) => s.done) && !e.note.trim(),
    );
    const elapsed = (Date.now() - active.startedAt) / 1000;
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-xl font-semibold text-ink">
            Тренировка завершена
          </h1>
          <p className="text-sm text-muted">
            {active.dayName} · в работе {fmtDuration(elapsed)}
          </p>
        </header>

        {skipped.length > 0 && (
          <div className="rounded-xl border border-amber/40 bg-amber/10 px-3 py-2">
            <div className="text-sm font-semibold text-amber">
              {skipped.length}{" "}
              {plural(skipped.length, [
                "упражнение",
                "упражнения",
                "упражнений",
              ])}{" "}
              без единого отмеченного подхода
            </div>
            <div className="mt-1 text-sm text-soft">
              {skipped
                .map((e) => exById(e.exId, state)?.name ?? e.exId)
                .join(", ")}
            </div>
            <div className="mt-1 text-sm text-muted">
              В историю они не попадут — останется только заметка, если ты её
              написал. Забыл отметить подходы — вернись к упражнениям.
            </div>
          </div>
        )}

        <SessionSummary
          hideNote
          session={active}
          compareTo={previousSameDay(state.sessions, active)}
        />

        <section>
          <SectionTitle>самочувствие</SectionTitle>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((n) => {
              const on = active.feel === n;
              return (
                <button
                  key={n}
                  type="button"
                  aria-pressed={on}
                  aria-label={`самочувствие ${n} из 5`}
                  onClick={() => setSessionMeta({ feel: on ? null : n })}
                  className={`min-h-11 flex-1 rounded-xl border font-mono text-base transition ${
                    on
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-edge text-muted hover:text-soft"
                  }`}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-faint">
            1 — еле дожил до конца, 5 — сил ещё вагон
          </p>
        </section>

        <NoteField
          value={active.note}
          onCommit={(v) => setSessionMeta({ note: v })}
          label="заметка к тренировке"
          placeholder="самочувствие, сон, что поменять в следующий раз…"
          rows={3}
        />

        <div className="flex flex-col gap-2">
          <Btn
            variant={nothingLogged ? "ghost" : "primary"}
            size="lg"
            className="w-full"
            onClick={() => {
              finishSession();
              navigate("/fit");
            }}
          >
            {nothingLogged ? "Закрыть без записи" : "Сохранить в журнал"}
          </Btn>
          {nothingLogged && (
            <p className="text-center text-xs text-muted">
              Ни одного отмеченного подхода и ни одной заметки — в журнал
              записывать нечего.
            </p>
          )}
          <Btn
            variant="ghost"
            className="w-full"
            onClick={() => setShowSummary(false)}
          >
            Вернуться к упражнениям
          </Btn>
        </div>
      </div>
    );
  }

  // ───────── текущее упражнение ─────────
  const idx = Math.max(0, Math.min(cursor, total - 1));
  const entry = entries[idx];
  const ex = exById(entry.exId, state);
  const prev = lastEntry(entry.exId, state);
  const prevSets = prev ? prev.entry.sets.filter((s) => s.done) : [];

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="truncate text-base font-semibold text-ink">
            {active.dayName}
          </h1>
          <span className="shrink-0 font-mono text-xs text-muted">
            {idx + 1} из {total}
          </span>
        </div>
        <Bar value={doneCount / total} tone={allDone ? "ok" : "accent"} />
        <div className="flex gap-1">
          {entries.map((e, i) => {
            const name = exById(e.exId, state)?.name ?? e.exId;
            const cls =
              i === idx
                ? e.done
                  ? "border-accent bg-ok/15 text-ok"
                  : "border-accent bg-accent/15 text-accent"
                : e.done
                  ? "border-ok/40 bg-ok/10 text-ok"
                  : "border-edge text-muted hover:text-soft";
            return (
              <button
                key={`${e.exId}-${i}`}
                type="button"
                aria-label={`упражнение ${i + 1}: ${name}`}
                aria-current={i === idx ? "true" : undefined}
                onClick={() => setCursor(i)}
                className={`min-h-11 flex-1 rounded-lg border font-mono text-sm transition ${cls}`}
              >
                {e.done ? "✓" : i + 1}
              </button>
            );
          })}
        </div>
        <div className="text-xs text-muted">
          готово {doneCount} из {total}{" "}
          {plural(total, ["упражнения", "упражнений", "упражнений"])}
        </div>
      </header>

      <Card className="p-4">
        {ex ? (
          <ExerciseArt ex={ex} animate showPhase className="mx-auto max-w-56" />
        ) : null}
        <h2 className="mt-2 text-center text-lg font-semibold text-ink">
          {ex?.name ?? entry.exId}
        </h2>
        {ex && (
          <div className="mt-2 flex flex-wrap justify-center gap-1">
            <Pill>{GROUP_RU[ex.group] ?? ex.group}</Pill>
            <Pill>{EQUIP_RU[ex.equipment] ?? ex.equipment}</Pill>
            {ex.heads?.map((h) => (
              <Pill key={h} tone="accent">
                {HEAD_RU[h] ?? h} дельта
              </Pill>
            ))}
          </div>
        )}

        <div className="mt-3 rounded-xl border border-edge bg-panel2/50 px-3 py-2 text-sm">
          <span className="text-muted">в прошлый раз: </span>
          {prevSets.length ? (
            <span className="text-soft">
              {prevSets
                .map((s) => (s.weight ? `${s.weight}×${s.reps}` : `${s.reps}`))
                .join(" · ")}
              {prev ? ` · ${fmtDate(prev.session.startedAt)}` : ""}
            </span>
          ) : (
            <span className="text-soft">первый раз</span>
          )}
        </div>

        {ex && ex.cues.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={openCues}
              onClick={() => setOpenCues((o) => !o)}
              className="mt-3 flex min-h-11 w-full items-center justify-between rounded-xl border border-edge px-3 text-sm text-soft transition hover:border-accent/60 hover:text-ink"
            >
              <span>техника</span>
              <span aria-hidden="true" className="text-muted">
                {openCues ? "▲" : "▼"}
              </span>
            </button>
            {openCues && (
              <div className="mt-2 space-y-2">
                <ul className="space-y-1">
                  {ex.cues.map((c) => (
                    <li key={c} className="flex gap-2 text-sm text-soft">
                      <span aria-hidden="true" className="text-accent">
                        ·
                      </span>
                      <span className="min-w-0 flex-1">{c}</span>
                    </li>
                  ))}
                </ul>
                {ex.mistakes && ex.mistakes.length > 0 && (
                  <div className="rounded-xl border border-amber/40 bg-amber/10 px-3 py-2">
                    <div className="text-xs tracking-wide text-amber uppercase">
                      частые ошибки
                    </div>
                    <ul className="mt-1 space-y-1">
                      {ex.mistakes.map((m) => (
                        <li key={m} className="flex gap-2 text-sm text-soft">
                          <span aria-hidden="true" className="text-amber">
                            ×
                          </span>
                          <span className="min-w-0 flex-1">{m}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      {entry.planNote && (
        <p className="rounded-xl border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">
          из плана: {entry.planNote}
        </p>
      )}

      <section>
        <SectionTitle>
          подходы · цель {entry.targetSets}×{entry.targetReps}, отдых{" "}
          {fmtDuration(entry.targetRest)}
        </SectionTitle>
        <ul className="space-y-2">
          {entry.sets.map((s, i) => (
            <SetRow key={s.id} entryIdx={idx} setIdx={i} set={s} />
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <Btn className="flex-1" onClick={() => addSet(idx)}>
            + подход
          </Btn>
          <Btn
            className="flex-1"
            disabled={entry.sets.length <= 1}
            title="удалить последний подход"
            onClick={() => removeSet(idx, entry.sets.length - 1)}
          >
            − подход
          </Btn>
        </div>
      </section>

      <NoteField
        value={entry.note}
        onCommit={(v) => setEntryNote(idx, v)}
        label="заметка к упражнению"
        placeholder="вес пошёл тяжело, болело плечо…"
      />

      <Btn
        variant="ok"
        size="lg"
        className="w-full"
        onClick={() => finishEntry(idx)}
      >
        {entry.done && idx < total - 1
          ? "Дальше: следующее упражнение →"
          : entry.done
            ? "Упражнение готово ✓"
            : "Упражнение готово"}
      </Btn>

      <div className="flex gap-2">
        <Btn
          className="flex-1"
          disabled={idx === 0}
          onClick={() => setCursor(idx - 1)}
        >
          ← назад
        </Btn>
        <Btn
          className="flex-1"
          disabled={idx >= total - 1}
          onClick={() => setCursor(idx + 1)}
        >
          дальше →
        </Btn>
      </div>

      <div>
        <Btn
          variant={allDone ? "primary" : "ghost"}
          size="lg"
          className="w-full"
          onClick={() => setShowSummary(true)}
        >
          Завершить тренировку
        </Btn>
        {!allDone && (
          <p className="mt-1 text-center text-xs text-faint">
            не все упражнения отмечены готовыми — но закончить можно в любой
            момент
          </p>
        )}
      </div>
    </div>
  );
}
