import { useState } from "react";
import { Link } from "react-router-dom";
import { exById, useFit } from "../store";
import {
  deltBalance,
  exerciseHistory,
  recentCount,
  trackedExercises,
  weeklyTonnage,
} from "../stats";
import type { ExPoint, WeekBucket } from "../stats";
import { HEAD_RU } from "../data/exercises";
import {
  Bar,
  Card,
  Empty,
  Pill,
  SectionTitle,
  fmtTonnage,
  fmtWeight,
  plural,
} from "../ui";

/** Короткая дата для осей: в подписи графика «5 августа» не помещается. */
function shortDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function Hint({ children }: { children: string }) {
  return <p className="px-1 py-3 text-sm text-muted">{children}</p>;
}

// ───────────────────────── тоннаж по неделям ─────────────────────────

const W_VIEW_W = 320;
const W_TOP = 16;
const W_BASE = 108;
const W_LABEL_Y = 124;

function WeeklyChart({ weeks }: { weeks: WeekBucket[] }) {
  const max = Math.max(...weeks.map((w) => w.tonnage));
  const slot = W_VIEW_W / weeks.length;
  const barW = Math.min(24, slot - 12);
  const span = W_BASE - W_TOP;

  return (
    <svg
      viewBox={`0 0 ${W_VIEW_W} 132`}
      className="w-full"
      role="img"
      aria-label="Столбиковая диаграмма тоннажа по неделям"
    >
      {weeks.map((w, i) => {
        const cx = i * slot + slot / 2;
        const x = cx - barW / 2;
        const h = max > 0 && w.tonnage > 0 ? Math.max(3, (w.tonnage / max) * span) : 0;
        const y = W_BASE - h;
        return (
          <g key={w.start}>
            {/* колодец: пустая неделя тоже должна быть заметна */}
            <rect
              x={x}
              y={W_TOP}
              width={barW}
              height={span}
              rx="3"
              className="fill-panel2"
            />
            {h > 0 && (
              <rect x={x} y={y} width={barW} height={h} rx="3" className="fill-accent" />
            )}
            {w.tonnage > 0 && (
              <text
                x={cx}
                y={y - 4}
                textAnchor="middle"
                fontSize="9"
                className="fill-soft"
              >
                {fmtTonnage(w.tonnage)}
              </text>
            )}
            <text
              x={cx}
              y={W_LABEL_Y}
              textAnchor="middle"
              fontSize="9"
              className={w.tonnage > 0 ? "fill-muted" : "fill-faint"}
            >
              {w.label}
            </text>
          </g>
        );
      })}
      <line
        x1="0"
        y1={W_BASE}
        x2={W_VIEW_W}
        y2={W_BASE}
        className="stroke-edge"
        strokeWidth="1"
      />
    </svg>
  );
}

function WeeklyBlock({ weeks }: { weeks: WeekBucket[] }) {
  const total = weeks.reduce((n, w) => n + w.tonnage, 0);
  const workouts = weeks.reduce((n, w) => n + w.sessions, 0);
  const last = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2];

  if (total === 0) {
    return (
      <Hint>
        за последние восемь недель нет ни одного подхода с весом — как только
        появится, здесь будет видно, растёт объём или стоит
      </Hint>
    );
  }

  const delta = prev && prev.tonnage > 0 ? last.tonnage - prev.tonnage : null;

  return (
    <>
      <WeeklyChart weeks={weeks} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Pill tone="accent">{fmtTonnage(total)} за 8 недель</Pill>
        <Pill>
          {workouts} {plural(workouts, ["тренировка", "тренировки", "тренировок"])}
        </Pill>
        {delta !== null && delta !== 0 && (
          <Pill tone={delta > 0 ? "ok" : "amber"}>
            эта неделя {delta > 0 ? "+" : "−"}
            {fmtTonnage(Math.abs(delta))} к прошлой
          </Pill>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        столбик — сумма «вес × повторы» за неделю. провалы это тоже данные:
        пропущенная неделя видна пустой колонкой.
      </p>
    </>
  );
}

// ───────────────────────── баланс дельт ─────────────────────────

const NOTE_CLASS = {
  amber: "rounded-xl border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber",
  ok: "rounded-xl border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok",
} as const;

function DeltRow({
  name,
  sets,
  pct,
  tone,
}: {
  name: string;
  sets: number;
  pct: number;
  tone: "accent" | "amber" | "ok";
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-sm text-soft">{name}</span>
      <div className="min-w-0 flex-1">
        <Bar value={pct / 100} tone={tone} />
      </div>
      <span className="w-16 shrink-0 text-right font-mono text-xs text-muted">
        {pct}% · {sets}
      </span>
    </div>
  );
}

function DeltBlock() {
  const state = useFit((s) => s);
  const bal = deltBalance(state.sessions, state, 30);
  const total = bal.front + bal.side + bal.rear;

  if (total === 0) {
    return (
      <Hint>
        за 30 дней не отмечено ни одного подхода на плечи — начни тренироваться
        по плану, и баланс пучков посчитается сам
      </Hint>
    );
  }

  const pct = (n: number) => Math.round((n / total) * 100);
  const front = pct(bal.front);
  const side = pct(bal.side);
  const rear = pct(bal.rear);

  const notes: { tone: keyof typeof NOTE_CLASS; text: string }[] = [];
  if (rear < 20) {
    notes.push({
      tone: "amber",
      text: `задняя дельта — ${rear}% подходов, это мало. добавь тяги к лицу и разведения в наклоне: именно задняя даёт плечу объём сбоку-сзади и держит осанку.`,
    });
  }
  if (front > 50) {
    notes.push({
      tone: "amber",
      text: `передняя дельта — ${front}% подходов. её и так грузит каждый жим (лёжа, стоя, отжимания), отдельные подъёмы перед собой можно спокойно убрать.`,
    });
  }
  if (!notes.length) {
    notes.push({
      tone: "ok",
      text: "распределение по пучкам ровное — так и держи, ничего добавлять не нужно.",
    });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <DeltRow name={HEAD_RU.front} sets={bal.front} pct={front} tone="accent" />
        <DeltRow name={HEAD_RU.side} sets={bal.side} pct={side} tone="amber" />
        <DeltRow name={HEAD_RU.rear} sets={bal.rear} pct={rear} tone="ok" />
      </div>
      <p className="text-xs text-muted">
        {total} {plural(total, ["подход", "подхода", "подходов"])} на плечи за 30
        дней. упражнение на два пучка засчитано обоим — так оно и работает.
      </p>
      {notes.map((n) => (
        <p key={n.text} className={NOTE_CLASS[n.tone]}>
          {n.text}
        </p>
      ))}
    </div>
  );
}

// ───────────────────────── рабочий вес ─────────────────────────

const L_VIEW_W = 320;
const L_LEFT = 34;
const L_RIGHT = 310;
const L_TOP = 20;
const L_BOTTOM = 104;

function WeightChart({ pts }: { pts: ExPoint[] }) {
  const ws = pts.map((p) => p.topWeight);
  const maxW = Math.max(...ws);
  const minW = Math.min(...ws);
  const spanW = maxW - minW;
  const pad = spanW > 0 ? spanW * 0.25 : Math.max(1, maxW * 0.1);
  const hi = maxW + pad;
  const lo = Math.max(0, minW - pad);
  const range = hi - lo || 1;

  const x = (i: number) =>
    pts.length === 1
      ? (L_LEFT + L_RIGHT) / 2
      : L_LEFT + (i / (pts.length - 1)) * (L_RIGHT - L_LEFT);
  const y = (w: number) => L_BOTTOM - ((w - lo) / range) * (L_BOTTOM - L_TOP);

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.topWeight)}`).join(" ");
  const area = `${line} L${x(pts.length - 1)},${L_BOTTOM} L${x(0)},${L_BOTTOM} Z`;

  const topIdx = ws.indexOf(maxW);
  const labelX = Math.min(Math.max(x(topIdx), L_LEFT + 16), L_RIGHT - 16);

  return (
    <svg
      viewBox={`0 0 ${L_VIEW_W} 124`}
      className="w-full"
      role="img"
      aria-label="График рабочего веса по тренировкам"
    >
      <line
        x1={L_LEFT}
        y1={L_TOP}
        x2={L_RIGHT}
        y2={L_TOP}
        className="stroke-edge"
        strokeDasharray="3 3"
      />
      <line
        x1={L_LEFT}
        y1={L_BOTTOM}
        x2={L_RIGHT}
        y2={L_BOTTOM}
        className="stroke-edge"
      />
      <text x={L_LEFT - 4} y={L_TOP + 3} textAnchor="end" fontSize="9" className="fill-faint">
        {Math.round(hi)}
      </text>
      <text x={L_LEFT - 4} y={L_BOTTOM + 3} textAnchor="end" fontSize="9" className="fill-faint">
        {Math.round(lo)}
      </text>

      <path d={area} className="fill-accent/10" />
      <path d={line} fill="none" strokeWidth="2" className="stroke-accent" />

      {pts.map((p, i) => (
        <circle
          key={p.ts}
          cx={x(i)}
          cy={y(p.topWeight)}
          r={i === topIdx ? 4 : 3}
          strokeWidth="1.5"
          className={i === topIdx ? "fill-amber stroke-bg" : "fill-accent stroke-bg"}
        />
      ))}

      <text
        x={labelX}
        y={y(maxW) - 8}
        textAnchor="middle"
        fontSize="9"
        className="fill-amber"
      >
        {fmtWeight(maxW)}
      </text>

      <text x={L_LEFT} y="120" textAnchor="start" fontSize="9" className="fill-faint">
        {shortDate(pts[0].ts)}
      </text>
      <text x={L_RIGHT} y="120" textAnchor="end" fontSize="9" className="fill-faint">
        {shortDate(pts[pts.length - 1].ts)}
      </text>
    </svg>
  );
}

function WeightBlock() {
  const state = useFit((s) => s);
  const tracked = trackedExercises(state.sessions);
  const [picked, setPicked] = useState("");

  if (!tracked.length) {
    return (
      <Hint>
        ни в одной тренировке нет отмеченных подходов с весом — как только
        появятся, здесь можно будет выбрать упражнение и смотреть его кривую
      </Hint>
    );
  }

  // выбор держим в состоянии, но не чиним его эффектом: просто откатываемся
  // на первое доступное упражнение, если выбранное исчезло
  const exId = tracked.includes(picked) ? picked : tracked[0];
  const pts = exerciseHistory(state.sessions, exId);
  const name = exById(exId, state)?.name ?? exId;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const delta = first && last ? last.topWeight - first.topWeight : 0;

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="progress-ex" className="mb-1 block text-xs text-muted">
          упражнение
        </label>
        <select
          id="progress-ex"
          value={exId}
          onChange={(e) => setPicked(e.target.value)}
          className="min-h-11 w-full rounded-xl border border-edge bg-panel2 px-3 text-[15px] text-ink outline-none focus-visible:border-accent"
        >
          {tracked.map((id) => (
            <option key={id} value={id}>
              {exById(id, state)?.name ?? id}
            </option>
          ))}
        </select>
      </div>

      {pts.length < 2 ? (
        <p className="text-sm text-muted">
          {name}: пока одна тренировка —{" "}
          <span className="text-soft">
            {fmtWeight(pts[0]?.topWeight ?? 0)} × {pts[0]?.topReps ?? 0}
          </span>{" "}
          {pts[0] ? `(${shortDate(pts[0].ts)})` : ""}. линия появится со второго
          раза, сравнивать пока не с чем.
        </p>
      ) : (
        <>
          <WeightChart pts={pts} />
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone="amber">
              максимум {fmtWeight(Math.max(...pts.map((p) => p.topWeight)))}
            </Pill>
            <Pill>
              {pts.length}{" "}
              {plural(pts.length, ["тренировка", "тренировки", "тренировок"])}
            </Pill>
            <Pill tone={delta > 0 ? "ok" : delta < 0 ? "amber" : "muted"}>
              {delta === 0
                ? "вес не менялся"
                : `${delta > 0 ? "+" : "−"}${fmtWeight(Math.abs(delta))} с начала`}
            </Pill>
          </div>
          <p className="text-xs text-muted">
            точка — лучший подход тренировки. последний раз:{" "}
            {fmtWeight(last.topWeight)} × {last.topReps}.
          </p>
        </>
      )}
    </div>
  );
}

// ───────────────────────── страница ─────────────────────────

export default function Progress() {
  const sessions = useFit((s) => s.sessions);
  const weeks = weeklyTonnage(sessions, 8);

  if (!sessions.length) {
    return (
      <div className="space-y-4">
        <SectionTitle>прогресс</SectionTitle>
        <Empty
          title="считать пока нечего"
          hint="после первой законченной тренировки здесь появятся тоннаж по неделям, баланс дельт и кривая рабочего веса"
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

  return (
    <div className="space-y-5">
      <div>
        <SectionTitle>прогресс</SectionTitle>
        <p className="text-sm text-muted">
          за последние 7 дней: {recentCount(sessions, 7)}{" "}
          {plural(recentCount(sessions, 7), [
            "тренировка",
            "тренировки",
            "тренировок",
          ])}
          .
        </p>
      </div>

      <section>
        <SectionTitle>тоннаж по неделям</SectionTitle>
        <Card className="p-3">
          <WeeklyBlock weeks={weeks} />
        </Card>
      </section>

      <section>
        <SectionTitle>баланс дельт</SectionTitle>
        <Card className="p-3">
          <DeltBlock />
        </Card>
      </section>

      <section>
        <SectionTitle>рабочий вес</SectionTitle>
        <Card className="p-3">
          <WeightBlock />
        </Card>
      </section>
    </div>
  );
}
