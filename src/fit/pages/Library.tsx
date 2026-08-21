import { useMemo, useState } from "react";
import type { Exercise } from "../types";
import { ExerciseArt, ExerciseMedia } from "../art/ExerciseArt";
import { EQUIP_RU, GROUP_RU, HEAD_RU } from "../data/exercises";
import {
  addCustomExercise,
  addItem,
  allExercises,
  removeCustomExercise,
  useFit,
} from "../store";
import {
  Btn,
  Card,
  Empty,
  Pill,
  SectionTitle,
  Sheet,
  TextField,
  plural,
} from "../ui";

const GROUP_KEYS = Object.keys(GROUP_RU);
const HEAD_KEYS = Object.keys(HEAD_RU);
const EX_FORMS: [string, string, string] = [
  "упражнение",
  "упражнения",
  "упражнений",
];

function match(ex: Exercise, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return (
    ex.name.toLowerCase().includes(s) || ex.en.toLowerCase().includes(s)
  );
}

function FilterRow({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      {options.map(([k, text]) => (
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
          {text}
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

/** Карточка упражнения в сетке. Схема без animate: 40 rAF-подписок ни к чему. */
function GridCard({ ex, onOpen }: { ex: Exercise; onOpen: () => void }) {
  return (
    <Card className="p-2" onClick={onOpen}>
      <ExerciseArt ex={ex} className="mx-auto w-20" />
      <div className="mt-1 text-sm leading-tight text-ink">{ex.name}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Pill>{GROUP_RU[ex.group]}</Pill>
        <Pill>{EQUIP_RU[ex.equipment]}</Pill>
        {ex.custom && <Pill tone="ok">своё</Pill>}
      </div>
    </Card>
  );
}

function Bullets({ items, tone }: { items: string[]; tone: "soft" | "amber" }) {
  return (
    <ul className="space-y-1">
      {items.map((t) => (
        <li key={t} className="flex gap-2 text-sm">
          <span
            aria-hidden="true"
            className={tone === "amber" ? "text-amber" : "text-accent"}
          >
            •
          </span>
          <span className={tone === "amber" ? "text-amber" : "text-soft"}>
            {t}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DetailSheet({
  ex,
  onClose,
  onDelete,
}: {
  ex: Exercise;
  onClose: () => void;
  onDelete: () => void;
}) {
  const plan = useFit((s) => s.plan);
  const used = plan
    .filter((d) => d.items.some((it) => it.exId === ex.id))
    .map((d) => d.name);

  return (
    <Sheet open onClose={onClose} title={ex.name}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1">
          <Pill>{GROUP_RU[ex.group]}</Pill>
          <Pill>{EQUIP_RU[ex.equipment]}</Pill>
          {ex.heads?.map((h) => (
            <Pill key={h} tone="accent">
              {HEAD_RU[h]} дельта
            </Pill>
          ))}
          {ex.custom && <Pill tone="ok">своё</Pill>}
        </div>

        <ExerciseMedia ex={ex} />

        {ex.cues.length > 0 && (
          <div>
            <SectionTitle>техника</SectionTitle>
            <Bullets items={ex.cues} tone="soft" />
          </div>
        )}

        {ex.mistakes && ex.mistakes.length > 0 && (
          <div>
            <SectionTitle>частые ошибки</SectionTitle>
            <Bullets items={ex.mistakes} tone="amber" />
          </div>
        )}

        <p className="text-sm text-muted">
          используется в:{" "}
          {used.length ? (
            <span className="text-soft">{used.join(", ")}</span>
          ) : (
            "пока ни в одном дне"
          )}
        </p>

        <div>
          <SectionTitle>добавить в день</SectionTitle>
          {plan.length === 0 ? (
            <p className="text-sm text-muted">
              дней ещё нет — заведи их на вкладке «план»
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {plan.map((d) => (
                <Btn key={d.id} onClick={() => addItem(d.id, ex.id)}>
                  + {d.name}
                </Btn>
              ))}
            </div>
          )}
        </div>

        {ex.custom && (
          <Btn className="w-full" variant="danger" onClick={onDelete}>
            удалить своё упражнение
          </Btn>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Своё упражнение собирается на основе похожего: от него берём схему движения,
 * группу и снаряд — отдельный пикер анимаций пользователю не нужен.
 */
function CreateSheet({ onClose }: { onClose: () => void }) {
  const list = useFit(allExercises);
  const [name, setName] = useState("");
  const [cue, setCue] = useState("");
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");
  const [baseId, setBaseId] = useState<string | null>(null);

  const base = baseId ? (list.find((e) => e.id === baseId) ?? null) : null;
  const found = useMemo(
    () =>
      list.filter((e) => (group === "all" || e.group === group) && match(e, q)),
    [list, group, q],
  );

  const ready = name.trim().length > 0 && base !== null;

  return (
    <Sheet open onClose={onClose} title="своё упражнение">
      <div className="space-y-4">
        <TextField
          id="new-ex-name"
          label="название"
          value={name}
          onChange={setName}
          placeholder="напр. «Махи в наклоне на скамье»"
        />

        <div className="space-y-2">
          <SectionTitle>похожее упражнение</SectionTitle>
          <p className="-mt-1 text-xs text-muted">
            от него возьмём схему движения, группу мышц и снаряд
          </p>
          <TextField value={q} onChange={setQ} placeholder="поиск по базе" />
          <FilterRow
            label="группа мышц"
            value={group}
            onChange={setGroup}
            options={[
              ["all", "все"],
              ...GROUP_KEYS.map((k) => [k, GROUP_RU[k]] as [string, string]),
            ]}
          />
          {found.length === 0 ? (
            <Empty title="ничего не нашлось" />
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {found.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    aria-pressed={baseId === e.id}
                    onClick={() => setBaseId(e.id)}
                    className={`flex w-full items-center gap-3 rounded-xl border bg-panel2/40 p-2 text-left transition ${
                      baseId === e.id
                        ? "border-accent"
                        : "border-edge hover:border-accent/60"
                    }`}
                  >
                    <ExerciseArt ex={e} className="w-10 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-ink">
                        {e.name}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {GROUP_RU[e.group]} · {EQUIP_RU[e.equipment]}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <TextField
          id="new-ex-cue"
          label="подсказка по технике (необязательно)"
          value={cue}
          onChange={setCue}
          placeholder="напр. «локти чуть впереди корпуса»"
        />

        <div className="flex gap-2">
          <Btn className="flex-1" onClick={onClose}>
            отмена
          </Btn>
          <Btn
            className="flex-1"
            variant="primary"
            disabled={!ready}
            onClick={() => {
              if (!base || !name.trim()) return;
              addCustomExercise({
                name: name.trim(),
                en: base.en,
                group: base.group,
                heads: base.heads,
                equipment: base.equipment,
                motion: base.motion,
                cues: cue.trim() ? [cue.trim()] : [],
                def: { ...base.def },
              });
              onClose();
            }}
          >
            добавить
          </Btn>
        </div>
        {!ready && (
          <p className="text-xs text-faint">
            нужно название и выбранное похожее упражнение
          </p>
        )}
      </div>
    </Sheet>
  );
}

export default function Library() {
  const list = useFit(allExercises);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");
  const [head, setHead] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);

  const found = useMemo(
    () =>
      list.filter((e) => {
        if (group !== "all" && e.group !== group) return false;
        if (group === "shoulders" && head !== "all") {
          if (!e.heads?.includes(head as "front" | "side" | "rear")) return false;
        }
        return match(e, q);
      }),
    [list, group, head, q],
  );

  const open = openId ? (list.find((e) => e.id === openId) ?? null) : null;
  const toDelete = delId ? (list.find((e) => e.id === delId) ?? null) : null;

  return (
    <div className="space-y-4">
      <div>
        <SectionTitle>база упражнений</SectionTitle>
        <p className="text-sm text-muted">
          {found.length} {plural(found.length, EX_FORMS)} из {list.length}.
          Нажми на карточку — схема, техника и добавление в день.
        </p>
      </div>

      <div className="space-y-2">
        <TextField
          value={q}
          onChange={setQ}
          placeholder="поиск: махи, press, тяга…"
        />
        <FilterRow
          label="группа мышц"
          value={group}
          onChange={(g) => {
            setGroup(g);
            if (g !== "shoulders") setHead("all");
          }}
          options={[
            ["all", "все"],
            ...GROUP_KEYS.map((k) => [k, GROUP_RU[k]] as [string, string]),
          ]}
        />
        {group === "shoulders" && (
          <FilterRow
            label="пучок дельты"
            value={head}
            onChange={setHead}
            options={[
              ["all", "все пучки"],
              ...HEAD_KEYS.map((k) => [k, HEAD_RU[k]] as [string, string]),
            ]}
          />
        )}
      </div>

      {found.length === 0 ? (
        <Empty
          title="ничего не нашлось"
          hint="сними фильтр или добавь своё упражнение"
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {found.map((ex) => (
            <GridCard key={ex.id} ex={ex} onOpen={() => setOpenId(ex.id)} />
          ))}
        </div>
      )}

      <Btn className="w-full" variant="ghost" onClick={() => setCreating(true)}>
        + своё упражнение
      </Btn>

      {open && (
        <DetailSheet
          ex={open}
          onClose={() => setOpenId(null)}
          onDelete={() => {
            setDelId(open.id);
            setOpenId(null);
          }}
        />
      )}

      {creating && <CreateSheet onClose={() => setCreating(false)} />}

      {toDelete && (
        <ConfirmSheet
          title="удалить упражнение?"
          text={`«${toDelete.name}» исчезнет из базы и из всех дней плана. Записи в журнале останутся.`}
          action="удалить"
          onConfirm={() => removeCustomExercise(toDelete.id)}
          onClose={() => setDelId(null)}
        />
      )}
    </div>
  );
}
