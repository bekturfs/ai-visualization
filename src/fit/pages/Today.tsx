import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { PlanDay } from "../types";
import { cancelSession, exById, nextDay, startSession, useFit } from "../store";
import { doneSets, recentCount } from "../stats";
import { ExerciseArt } from "../art/ExerciseArt";
import {
  Btn,
  Card,
  Empty,
  SectionTitle,
  Sheet,
  daysAgo,
  fmtDate,
  fmtDuration,
  plural,
} from "../ui";

/** Тикающие часы: нужны только пока идёт тренировка. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

function agoLabel(ts: number): string {
  const d = daysAgo(ts);
  if (d <= 1) return fmtDate(ts);
  return `${fmtDate(ts)} · ${d} ${plural(d, ["день", "дня", "дней"])} назад`;
}

const LINK_BTN =
  "inline-flex min-h-14 items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold transition";

function DayItems({ day }: { day: PlanDay }) {
  const state = useFit((s) => s);
  if (!day.items.length) {
    return (
      <p className="text-sm text-muted">
        В этом дне пока нет упражнений — добавь их в плане.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {day.items.map((it, i) => {
        const ex = exById(it.exId, state);
        return (
          <li
            key={`${it.exId}-${i}`}
            className="flex items-center gap-3 rounded-xl border border-edge bg-panel2/40 px-2 py-2"
          >
            {ex ? (
              <ExerciseArt ex={ex} className="w-9 shrink-0 opacity-70" />
            ) : (
              <span className="w-9 shrink-0 text-center text-faint">?</span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] text-ink">
                {ex?.name ?? it.exId}
              </div>
              <div className="text-xs text-muted">
                {it.sets}×{it.reps} · отдых {fmtDuration(it.rest)}
              </div>
              {it.note && (
                <div className="truncate text-xs text-amber">{it.note}</div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function Today() {
  const state = useFit((s) => s);
  const active = useFit((s) => s.active);
  const plan = state.plan;
  const sessions = state.sessions;

  const navigate = useNavigate();
  const [picked, setPicked] = useState<string | null>(null);
  const [askCancel, setAskCancel] = useState(false);
  const now = useNow(active !== null);

  const suggested = nextDay(state);
  const day = plan.find((d) => d.id === picked) ?? suggested;

  const last = sessions.length ? sessions[sessions.length - 1] : null;
  const week = recentCount(sessions, 7);

  // ───────── идёт тренировка ─────────
  if (active) {
    const secs = Math.max(0, (now - active.startedAt) / 1000);
    const sets = doneSets(active);
    const total = active.entries.reduce((n, e) => n + e.sets.length, 0);
    return (
      <div className="space-y-4">
        <Card className="p-4">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl text-ok">
              {fmtDuration(secs)}
            </span>
            <span className="text-sm text-muted">тренировка идёт</span>
          </div>
          <h1 className="mt-2 text-xl font-semibold text-ink">
            {active.dayName}
          </h1>
          <p className="mt-1 text-sm text-muted">
            начата в{" "}
            {new Date(active.startedAt).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })}
            {" · "}
            {sets} из {total} {plural(total, ["подхода", "подходов", "подходов"])}{" "}
            отмечено
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <Link
              to="/fit/run"
              className={`${LINK_BTN} bg-accent text-bg hover:brightness-110`}
            >
              Продолжить
            </Link>
            <Btn variant="danger" onClick={() => setAskCancel(true)}>
              Отменить тренировку
            </Btn>
          </div>
        </Card>

        <p className="px-1 text-xs text-faint">
          Незавершённая тренировка хранится в браузере — можно закрыть вкладку и
          вернуться позже.
        </p>

        <Sheet
          open={askCancel}
          onClose={() => setAskCancel(false)}
          title="Отменить тренировку?"
        >
          <p className="text-[15px] text-soft">
            {sets > 0
              ? `Отмеченные подходы (${sets}) будут удалены и в журнал не попадут.`
              : "Пока не отмечено ни одного подхода — терять нечего."}{" "}
            Отменить это действие нельзя.
          </p>
          <div className="mt-4 flex flex-col gap-2">
            <Btn
              variant="danger"
              size="lg"
              onClick={() => {
                cancelSession();
                setAskCancel(false);
              }}
            >
              Да, удалить тренировку
            </Btn>
            <Btn variant="ghost" onClick={() => setAskCancel(false)}>
              Нет, вернуться
            </Btn>
          </div>
        </Sheet>
      </div>
    );
  }

  // ───────── плана нет ─────────
  if (!plan.length || !day) {
    return (
      <div className="space-y-4">
        <Empty
          title="В плане нет ни одного дня"
          hint="Тренировку начинать не с чего — сначала собери план."
        />
        <div className="flex justify-center">
          <Link
            to="/fit/plan"
            className={`${LINK_BTN} bg-accent text-bg hover:brightness-110`}
          >
            Открыть план
          </Link>
        </div>
      </div>
    );
  }

  // ───────── следующий день ─────────
  return (
    <div className="space-y-5">
      <section>
        <SectionTitle>что дальше</SectionTitle>
        <div className="-mx-4 overflow-x-auto px-4">
          <div className="flex w-max gap-2">
            {plan.map((d) => {
              const on = d.id === day.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setPicked(d.id)}
                  className={`min-h-11 shrink-0 rounded-xl border px-3 text-sm transition ${
                    on
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-edge text-soft hover:border-accent/60 hover:text-ink"
                  }`}
                >
                  {d.name}
                  {suggested && d.id === suggested.id && (
                    <span aria-hidden="true" className="ms-1 text-accent">
                      •
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {suggested && (
          <p className="mt-1 text-xs text-faint">
            • — следующий по кругу после прошлой тренировки. Можно выбрать
            любой.
          </p>
        )}
      </section>

      <Card className="p-4">
        <h1 className="text-xl font-semibold text-ink">{day.name}</h1>
        <p className="mt-0.5 text-sm text-muted">{day.subtitle}</p>

        <div className="mt-3">
          <DayItems day={day} />
        </div>

        <div className="mt-4">
          <Btn
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!day.items.length}
            onClick={() => {
              if (startSession(day.id)) navigate("/fit/run");
            }}
          >
            Начать тренировку
          </Btn>
        </div>
      </Card>

      <section>
        <SectionTitle>как идут дела</SectionTitle>
        {last ? (
          <Card className="px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl text-ink">{week}</span>
              <span className="text-sm text-muted">
                {plural(week, ["тренировка", "тренировки", "тренировок"])} за
                последние 7 дней
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">
              последняя: {agoLabel(last.startedAt)} · {last.dayName}
            </p>
            <Link
              to="/fit/history"
              className="mt-2 inline-block text-sm text-accent"
            >
              весь журнал →
            </Link>
          </Card>
        ) : (
          <Card className="px-4 py-3">
            <p className="text-[15px] text-soft">
              Здесь пока пусто. Начни первую тренировку — дальше появится
              статистика: тоннаж, подходы и баланс пучков дельт.
            </p>
            <p className="mt-1 text-sm text-muted">
              Всё хранится только в этом браузере, регистрация не нужна.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
