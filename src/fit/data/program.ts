import type { PlanDay } from "../types";
import { EX_BY_ID } from "./exercises";

/** Собирает пункт плана из дефолтов упражнения, с возможностью переопределить. */
function item(
  exId: string,
  over?: Partial<{ sets: number; reps: string; rest: number }>,
) {
  const d = EX_BY_ID[exId].def;
  return {
    exId,
    sets: over?.sets ?? d.sets,
    reps: over?.reps ?? d.reps,
    rest: over?.rest ?? d.rest,
  };
}

/**
 * Стартовая программа: 3 дня в неделю, по 5 упражнений, акцент на плечи.
 * В каждом дне 3–4 упражнения на дельты плюс что-то на баланс,
 * чтобы не перекосить фигуру и не забыть про ноги и спину.
 */
export const DEFAULT_PLAN: PlanDay[] = [
  {
    id: "a",
    name: "День A",
    subtitle: "Плечи: жим",
    items: [
      item("ohp"),
      item("lat-raise"),
      item("incline-db"),
      item("pulldown"),
      item("rear-fly", { sets: 3 }),
    ],
  },
  {
    id: "b",
    name: "День B",
    subtitle: "Плечи: тяга",
    items: [
      item("bb-row"),
      item("upright-row"),
      item("cable-rear-fly", { sets: 4 }),
      item("db-press", { sets: 3 }),
      item("face-pull"),
    ],
  },
  {
    id: "c",
    name: "День C",
    subtitle: "Плечи: объём + ноги",
    items: [
      item("squat"),
      item("arnold", { sets: 4 }),
      item("cable-lat-raise", { sets: 4 }),
      item("front-raise"),
      item("plank"),
    ],
  },
];
