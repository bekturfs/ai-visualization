import { useEffect, useMemo, useRef, useState } from "react";
import type { Exercise, PlanDay, PlanItem } from "../types";
import { ExerciseArt } from "../art/ExerciseArt";
import { EQUIP_RU, GROUP_RU } from "../data/exercises";
import {
  addDay,
  addItem,
  allExercises,
  moveItem,
  removeDay,
  removeItem,
  resetPlan,
  updateDay,
  updateItem,
  useFit,
} from "../store";
import {
  Btn,
  Card,
  Empty,
  NoteField,
  NumField,
  Pill,
  SectionTitle,
  Sheet,
  TextField,
  plural,
} from "../ui";

const GROUP_KEYS = Object.keys(GROUP_RU);
const EX_FORMS: [string, string, string] = [
  "упражнение",
  "упражнения",
  "упражнений",
];
const DAY_FORMS: [string, string, string] = ["день", "дня", "дней"];

/**
 * Однострочное поле, пишущее в стор на blur, а не на каждую букву: любая
 * мутация стора клонирует состояние целиком, посимвольная запись тормозит.
 * onBlur в React — это focusout, он всплывает, поэтому обёртка ловит уход
 * фокуса из инпута внутри TextField.
 */
function CommitText({
  value,
  onCommit,
  label,
  placeholder,
  id,
  className = "",
}: {
  value: string;
  onCommit: (v: string) => void;
  label?: string;
  placeholder?: string;
  id?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  // внешние изменения (сброс плана, замена упражнения) подхватываем,
  // свои собственные — нет, иначе поле дёргается под пальцем
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setDraft(value);
    }
  }, [value]);
  return (
    <div
      className={className}
      onBlur={() => {
        if (draft === last.current) return;
        last.current = draft;
        onCommit(draft);
      }}
    >
      <TextField
        id={id}
        label={label}
        value={draft}
        onChange={setDraft}
        placeholder={placeholder}
      />
    </div>
  );
}

function FilterRow({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={`min-h-11 rounded-full border px-3 text-sm transition ${
            value === k
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-edge text-muted hover:border-accent/40 hover:text-ink"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ConfirmSheet({
  title,
  text,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open onClose={onClose} title={title}>
      <p className="text-[15px] text-soft">{text}</p>
      <div className="mt-4 flex gap-2">
        <Btn className="flex-1" onClick={onClose}>
          отмена
        </Btn>
        <Btn
          className="flex-1"
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {action}
        </Btn>
      </div>
    </Sheet>
  );
}

/** Выбор упражнения из базы: поиск + фильтр по группе. */
function PickerSheet({
  title,
  currentId,
  onPick,
  onClose,
}: {
  title: string;
  currentId?: string;
  onPick: (ex: Exercise) => void;
  onClose: () => void;
}) {
  const list = useFit(allExercises);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");

  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    return list.filter(
      (e) =>
        (group === "all" || e.group === group) &&
        (!s ||
          e.name.toLowerCase().includes(s) ||
          e.en.toLowerCase().includes(s)),
    );
  }, [list, q, group]);

  return (
    <Sheet open onClose={onClose} title={title}>
      <div className="space-y-3">
        <TextField
          value={q}
          onChange={setQ}
          placeholder="поиск: жим, lateral, тяга…"
        />
        <FilterRow
          value={group}
          onChange={setGroup}
          options={[
            ["all", "все"],
            ...GROUP_KEYS.map((k) => [k, GROUP_RU[k]] as [string, string]),
          ]}
        />
        {found.length === 0 ? (
          <Empty
            title="ничего не нашлось"
            hint="попробуй другое слово или сними фильтр"
          />
        ) : (
          <ul className="space-y-1">
            {found.map((ex) => (
              <li key={ex.id}>
                <button
                  type="button"
                  onClick={() => onPick(ex)}
                  className="flex w-full items-center gap-3 rounded-xl border border-edge bg-panel2/40 p-2 text-left transition hover:border-accent/60"
                >
                  <ExerciseArt ex={ex} className="w-10 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-ink">
                      {ex.name}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {GROUP_RU[ex.group]} · {EQUIP_RU[ex.equipment]} ·{" "}
                      {ex.def.sets}×{ex.def.reps}
                    </span>
                  </span>
                  {ex.id === currentId && <Pill tone="accent">сейчас</Pill>}
                  {ex.custom && <Pill tone="ok">своё</Pill>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

function ItemRow({
  dayId,
  idx,
  total,
  item,
  ex,
  onReplace,
}: {
  dayId: string;
  idx: number;
  total: number;
  item: PlanItem;
  ex: Exercise | undefined;
  onReplace: () => void;
}) {
  const [showNote, setShowNote] = useState(Boolean(item.note));

  if (!ex) {
    return (
      <li className="flex items-center gap-2 rounded-xl border border-edge bg-panel2/40 p-2">
        <span className="min-w-0 flex-1 text-sm text-amber">
          упражнения больше нет в базе
        </span>
        <Btn variant="danger" onClick={() => removeItem(dayId, idx)}>
          убрать
        </Btn>
      </li>
    );
  }

  return (
    <li className="rounded-xl border border-edge bg-panel2/40 p-2">
      <div className="flex items-center gap-2">
        <ExerciseArt ex={ex} className="w-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] leading-tight text-ink">{ex.name}</div>
          <div className="mt-0.5 text-xs text-muted">
            {GROUP_RU[ex.group]} · {EQUIP_RU[ex.equipment]}
          </div>
        </div>
        <span className="shrink-0 font-mono text-xs text-faint">
          {idx + 1}/{total}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <NumField
          label="подходы"
          compact
          value={item.sets}
          min={1}
          max={10}
          step={1}
          onChange={(v) => updateItem(dayId, idx, { sets: Math.round(v) })}
        />
        <NumField
          label="отдых"
          compact
          suffix="с"
          value={item.rest}
          min={0}
          max={600}
          step={15}
          onChange={(v) => updateItem(dayId, idx, { rest: Math.round(v) })}
        />
      </div>

      <CommitText
        className="mt-2"
        id={`reps-${dayId}-${idx}`}
        label="повторы"
        value={item.reps}
        placeholder="8–10, макс, 45–60 сек"
        onCommit={(v) => updateItem(dayId, idx, { reps: v })}
      />

      {showNote ? (
        <div className="mt-2">
          <NoteField
            id={`note-${dayId}-${idx}`}
            label="заметка"
            rows={2}
            value={item.note ?? ""}
            placeholder="напр. «последний подход до отказа»"
            onCommit={(v) => updateItem(dayId, idx, { note: v })}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowNote(true)}
          className="mt-1 min-h-11 text-sm text-muted transition hover:text-ink"
        >
          + заметка
        </button>
      )}

      <div className="mt-2 flex gap-2">
        <Btn
          className="w-11 px-0"
          ariaLabel="переместить выше"
          title="выше"
          disabled={idx === 0}
          onClick={() => moveItem(dayId, idx, -1)}
        >
          ↑
        </Btn>
        <Btn
          className="w-11 px-0"
          ariaLabel="переместить ниже"
          title="ниже"
          disabled={idx === total - 1}
          onClick={() => moveItem(dayId, idx, 1)}
        >
          ↓
        </Btn>
        <Btn className="flex-1" onClick={onReplace}>
          заменить
        </Btn>
        <Btn
          className="w-11 px-0"
          variant="danger"
          ariaLabel={`убрать ${ex.name} из дня`}
          title="убрать из дня"
          onClick={() => removeItem(dayId, idx)}
        >
          ✕
        </Btn>
      </div>
    </li>
  );
}

function DayCard({ day }: { day: PlanDay }) {
  const list = useFit(allExercises);
  const byId = useMemo(
    () => new Map(list.map((e) => [e.id, e])),
    [list],
  );
  // null — добавляем новое, число — заменяем упражнение на этой позиции
  const [picker, setPicker] = useState<{ idx: number | null } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const n = day.items.length;
  const shoulders = day.items.filter(
    (it) => byId.get(it.exId)?.group === "shoulders",
  ).length;

  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <CommitText
            id={`day-name-${day.id}`}
            label="название"
            value={day.name}
            placeholder="День A"
            onCommit={(v) => updateDay(day.id, { name: v })}
          />
          <CommitText
            id={`day-sub-${day.id}`}
            label="подзаголовок"
            value={day.subtitle}
            placeholder="что качаем"
            onCommit={(v) => updateDay(day.id, { subtitle: v })}
          />
        </div>
        <Btn
          className="mt-5 w-11 shrink-0 px-0"
          variant="danger"
          ariaLabel={`удалить день «${day.name}»`}
          title="удалить день"
          onClick={() => setConfirmDel(true)}
        >
          ✕
        </Btn>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Pill>
          {n} {plural(n, EX_FORMS)}
        </Pill>
        <Pill tone={shoulders > 0 ? "accent" : "muted"}>
          {shoulders} на плечи
        </Pill>
        {n > 0 && shoulders === 0 && (
          <span className="text-xs text-amber">акцент на плечи потерян</span>
        )}
      </div>

      {n === 0 ? (
        <p className="text-sm text-muted">
          в этом дне пока пусто — добавь упражнение
        </p>
      ) : (
        <ul className="space-y-2">
          {day.items.map((it, i) => (
            <ItemRow
              key={`${it.exId}-${i}`}
              dayId={day.id}
              idx={i}
              total={n}
              item={it}
              ex={byId.get(it.exId)}
              onReplace={() => setPicker({ idx: i })}
            />
          ))}
        </ul>
      )}

      <Btn
        className="w-full"
        variant="ghost"
        onClick={() => setPicker({ idx: null })}
      >
        + упражнение
      </Btn>

      {picker && (
        <PickerSheet
          title={picker.idx === null ? "добавить упражнение" : "заменить упражнение"}
          currentId={
            picker.idx === null ? undefined : day.items[picker.idx]?.exId
          }
          onClose={() => setPicker(null)}
          onPick={(ex) => {
            if (picker.idx === null) {
              addItem(day.id, ex.id);
            } else {
              // подходы/повторы/отдых берём у нового упражнения, иначе от
              // старого останутся чужие «45–60 сек» на жиме
              updateItem(day.id, picker.idx, {
                exId: ex.id,
                sets: ex.def.sets,
                reps: ex.def.reps,
                rest: ex.def.rest,
              });
            }
            setPicker(null);
          }}
        />
      )}

      {confirmDel && (
        <ConfirmSheet
          title="удалить день?"
          text={`«${day.name}» и ${n} ${plural(n, EX_FORMS)} внутри исчезнут. История прошлых тренировок останется на месте.`}
          action="удалить"
          onConfirm={() => removeDay(day.id)}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </Card>
  );
}

export default function Plan() {
  const plan = useFit((s) => s.plan);
  const list = useFit(allExercises);
  const [confirmReset, setConfirmReset] = useState(false);

  const byId = useMemo(() => new Map(list.map((e) => [e.id, e])), [list]);
  const total = plan.reduce((n, d) => n + d.items.length, 0);
  const shoulders = plan.reduce(
    (n, d) =>
      n +
      d.items.filter((it) => byId.get(it.exId)?.group === "shoulders").length,
    0,
  );

  return (
    <div className="space-y-4">
      <div>
        <SectionTitle>программа</SectionTitle>
        <p className="text-sm text-muted">
          {plan.length} {plural(plan.length, DAY_FORMS)} · {total}{" "}
          {plural(total, EX_FORMS)} · {shoulders} на плечи. Меняй что угодно:
          порядок, подходы, повторы, отдых.
        </p>
      </div>

      {plan.length === 0 ? (
        <div className="space-y-3">
          <Empty
            title="дней нет"
            hint="добавь первый день и набери в него упражнения"
          />
          <Btn className="w-full" variant="primary" onClick={addDay}>
            + день
          </Btn>
        </div>
      ) : (
        <>
          {plan.map((d) => (
            <DayCard key={d.id} day={d} />
          ))}
          <div className="space-y-2 pt-2">
            <Btn className="w-full" variant="primary" onClick={addDay}>
              + день
            </Btn>
            <Btn
              className="w-full"
              variant="plain"
              onClick={() => setConfirmReset(true)}
            >
              сбросить к исходной программе
            </Btn>
          </div>
        </>
      )}

      {confirmReset && (
        <ConfirmSheet
          title="сбросить программу?"
          text="План вернётся к стартовым трём дням с акцентом на плечи. Все свои правки — названия, порядок, подходы и заметки — пропадут. Журнал тренировок не тронется."
          action="сбросить"
          onConfirm={resetPlan}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
