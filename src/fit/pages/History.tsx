import { useState } from "react";
import { Link } from "react-router-dom";
import type { Session } from "../types";
import { removeSession, useFit } from "../store";
import { doneSets, duration, previousSameDay, tonnage } from "../stats";
import { SessionSummary } from "../SessionSummary";
import {
  Btn,
  Card,
  Empty,
  Pill,
  SectionTitle,
  Sheet,
  fmtDate,
  fmtDuration,
  fmtTime,
  fmtTonnage,
  plural,
} from "../ui";

/** Самочувствие 1–5 словами: голая цифра в журнале ничего не говорит. */
const FEEL_RU: Record<number, string> = {
  1: "тяжело",
  2: "так себе",
  3: "норм",
  4: "хорошо",
  5: "отлично",
};

function feelTone(feel: number): "ok" | "amber" | "muted" {
  if (feel >= 4) return "ok";
  if (feel <= 2) return "amber";
  return "muted";
}

function setsWord(n: number): string {
  return `${n} ${plural(n, ["подход", "подхода", "подходов"])}`;
}

function Row({
  session,
  prev,
  open,
  onToggle,
  onAskDelete,
}: {
  session: Session;
  prev: Session | null;
  open: boolean;
  onToggle: () => void;
  onAskDelete: () => void;
}) {
  const vol = tonnage(session);
  const sec = duration(session);
  const feel = session.feel;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-h-14 min-w-0 flex-1 items-start gap-2 px-3 py-3 text-left"
        >
          <span
            aria-hidden="true"
            className={`mt-0.5 shrink-0 text-xs ${open ? "text-accent" : "text-faint"}`}
          >
            {open ? "▾" : "▸"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] text-ink">
              {session.dayName}
            </span>
            <span className="block text-xs text-muted">
              {fmtDate(session.startedAt)}, {fmtTime(session.startedAt)}
            </span>
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Pill tone={vol > 0 ? "accent" : "muted"}>
                {vol > 0 ? fmtTonnage(vol) : "без веса"}
              </Pill>
              <Pill>{setsWord(doneSets(session))}</Pill>
              {sec > 0 && <Pill>{fmtDuration(sec)}</Pill>}
              {feel !== null && (
                <Pill tone={feelTone(feel)}>{FEEL_RU[feel] ?? `${feel}/5`}</Pill>
              )}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={onAskDelete}
          aria-label={`Удалить тренировку ${session.dayName} от ${fmtDate(session.startedAt)}`}
          className="mt-1 me-1 h-11 w-11 shrink-0 rounded-lg text-muted transition hover:bg-panel2 hover:text-hot"
        >
          ✕
        </button>
      </div>

      {open && (
        <div className="border-t border-edge px-3 py-3">
          <SessionSummary session={session} compareTo={prev} />
        </div>
      )}
    </Card>
  );
}

export default function History() {
  const sessions = useFit((s) => s.sessions);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<Session | null>(null);

  // в сторе порядок от старых к новым — журнал читают наоборот; копия, не reverse() по месту
  const list = [...sessions].reverse();

  if (!list.length) {
    return (
      <div className="space-y-4">
        <SectionTitle>журнал</SectionTitle>
        <Empty
          title="тренировок пока нет"
          hint="закончи первую — она появится здесь с тоннажем и сравнением с прошлым разом"
        />
        <Link
          to="/fit"
          className="flex min-h-12 items-center justify-center rounded-xl bg-accent px-4 font-semibold text-bg transition hover:brightness-110"
        >
          к сегодняшней тренировке
        </Link>
      </div>
    );
  }

  const totalVol = sessions.reduce((n, s) => n + tonnage(s), 0);

  return (
    <div className="space-y-4">
      <div>
        <SectionTitle>журнал</SectionTitle>
        <p className="text-sm text-muted">
          {list.length}{" "}
          {plural(list.length, ["тренировка", "тренировки", "тренировок"])}, суммарно{" "}
          {fmtTonnage(totalVol)}. нажми на строку — раскроется разбор.
        </p>
      </div>

      <ul className="space-y-2">
        {list.map((s) => (
          <li key={s.id}>
            <Row
              session={s}
              prev={previousSameDay(sessions, s)}
              open={openId === s.id}
              onToggle={() => setOpenId(openId === s.id ? null : s.id)}
              onAskDelete={() => setPending(s)}
            />
          </li>
        ))}
      </ul>

      <Sheet
        open={pending !== null}
        onClose={() => setPending(null)}
        title="удалить тренировку?"
      >
        {pending && (
          <div className="space-y-4">
            <p className="text-sm text-soft">
              {pending.dayName}, {fmtDate(pending.startedAt)}:{" "}
              {setsWord(doneSets(pending))}, {fmtTonnage(tonnage(pending))}.
              запись пропадёт насовсем, вернуть будет нечем.
            </p>
            <div className="flex gap-2">
              <Btn className="flex-1" onClick={() => setPending(null)}>
                оставить
              </Btn>
              <Btn
                variant="danger"
                className="flex-1"
                onClick={() => {
                  removeSession(pending.id);
                  setPending(null);
                }}
              >
                удалить
              </Btn>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
