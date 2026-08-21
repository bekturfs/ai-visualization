import { useEffect, useId, useRef, useState, type ReactNode } from "react";

// ───────────────────────── форматирование ─────────────────────────

export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function fmtWeight(kg: number): string {
  if (!kg) return "—";
  return Number.isInteger(kg) ? `${kg} кг` : `${kg.toFixed(1)} кг`;
}

export function fmtTonnage(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(1)} т`;
  return `${Math.round(kg)} кг`;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} с`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const yest = new Date(today.getTime() - 86400000);
  if (sameDay(d, today)) return "сегодня";
  if (sameDay(d, yest)) return "вчера";
  const y = d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${y}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDateTime(ts: number): string {
  return `${fmtDate(ts)}, ${fmtTime(ts)}`;
}

/** Сколько дней назад, для «последняя тренировка …». */
export function daysAgo(ts: number): number {
  const a = new Date(ts);
  const b = new Date();
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// ───────────────────────── атомы ─────────────────────────

export function Card({
  children,
  className = "",
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const base = "rounded-2xl border border-edge bg-panel";
  if (!onClick) return <div className={`${base} ${className}`}>{children}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} w-full text-left transition-colors hover:border-accent/50 ${className}`}
    >
      {children}
    </button>
  );
}

type BtnVariant = "primary" | "ghost" | "danger" | "ok" | "plain";
type BtnSize = "sm" | "md" | "lg";

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary: "bg-accent text-bg font-semibold hover:brightness-110",
  ok: "bg-ok text-bg font-semibold hover:brightness-110",
  danger: "border border-hot/60 text-hot hover:bg-hot/10",
  ghost: "border border-edge text-soft hover:border-accent/60 hover:text-ink",
  plain: "text-muted hover:text-ink",
};

const BTN_SIZE: Record<BtnSize, string> = {
  sm: "min-h-9 px-3 text-sm",
  md: "min-h-11 px-4 text-[15px]",
  lg: "min-h-14 px-5 text-base",
};

export function Btn({
  children,
  onClick,
  variant = "ghost",
  size = "md",
  disabled,
  className = "",
  title,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: BtnVariant;
  size?: BtnSize;
  disabled?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`inline-flex items-center justify-center gap-2 rounded-xl transition
        disabled:cursor-not-allowed disabled:opacity-40
        ${BTN_VARIANT[variant]} ${BTN_SIZE[size]} ${className}`}
    >
      {children}
    </button>
  );
}

const TONE = {
  accent: "border-accent/40 bg-accent/10 text-accent",
  amber: "border-amber/40 bg-amber/10 text-amber",
  ok: "border-ok/40 bg-ok/10 text-ok",
  hot: "border-hot/40 bg-hot/10 text-hot",
  muted: "border-edge bg-panel2 text-muted",
} as const;

export type Tone = keyof typeof TONE;

export function Pill({
  children,
  tone = "muted",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap
        ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Числовое поле с крупными −/+ по бокам: в зале попасть по кнопке проще,
 * чем целиться в клавиатуру.
 */
export function NumField({
  value,
  onChange,
  step = 1,
  min = 0,
  max = 9999,
  suffix,
  label,
  compact,
  integer,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  label?: string;
  compact?: boolean;
  /** Повторы и подходы — только целые. */
  integer?: boolean;
  ariaLabel?: string;
}) {
  const id = useId();
  // черновик строкой: иначе нельзя стереть поле, а «2,5» превращается в 25
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const tidy = (v: number) =>
    integer ? Math.round(clamp(v)) : Math.round(clamp(v) * 100) / 100;

  const parse = (raw: string): number | null => {
    const t = raw.replace(",", ".").trim();
    if (!/^-?\d*\.?\d*$/.test(t) || t === "" || t === "-" || t === ".") return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
  };

  const commit = () => {
    const v = parse(shown);
    setDraft(null);
    // пустое, бессмысленное или вне диапазона — оставляем прежнее значение.
    // Прижать «-5» к нулю значит молча стереть набранные до этого 40 кг.
    if (v === null || v < min || v > max) return;
    onChange(tidy(v));
  };

  const bump = (dir: 1 | -1) => {
    const base = parse(shown) ?? value;
    setDraft(null);
    onChange(tidy(base + dir * step));
  };

  const btn = compact ? "h-9 w-9 text-lg" : "h-11 w-11 text-xl";
  const name = ariaLabel ?? label;

  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-1 block text-xs text-muted">
          {label}
        </label>
      )}
      <div className="flex items-stretch gap-1">
        <button
          type="button"
          aria-label={name ? `${name}: меньше` : "меньше"}
          onClick={() => bump(-1)}
          className={`${btn} shrink-0 rounded-lg border border-edge text-soft transition hover:border-accent/60 hover:text-ink active:bg-panel2`}
        >
          −
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            id={id}
            type="text"
            inputMode="decimal"
            aria-label={label ? undefined : name}
            value={shown}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            onFocus={(e) => e.currentTarget.select()}
            className={`w-full rounded-lg border border-edge bg-panel2 text-center font-mono text-ink
              outline-none focus-visible:border-accent
              ${compact ? "h-9 text-sm" : "h-11 text-base"}
              ${suffix ? "pe-8" : ""}`}
          />
          {suffix && (
            <span className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 text-xs text-faint">
              {suffix}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label={name ? `${name}: больше` : "больше"}
          onClick={() => bump(1)}
          className={`${btn} shrink-0 rounded-lg border border-edge text-soft transition hover:border-accent/60 hover:text-ink active:bg-panel2`}
        >
          +
        </button>
      </div>
    </div>
  );
}

/** Модалка снизу: закрывается по Esc и по клику вне панели. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const focusable = () =>
      [
        ...(panel.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => el.offsetParent !== null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // ловушка Tab: без неё фокус уходит на страницу за шторкой
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[88vh] w-full flex-col rounded-t-2xl border border-edge
          bg-panel sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
          <h2 className="truncate text-base font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="закрыть"
            className="-me-1 h-9 w-9 shrink-0 rounded-lg text-muted transition hover:bg-panel2 hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-edge px-4 py-10 text-center">
      <div className="text-soft">{title}</div>
      {hint && <div className="mt-1 text-sm text-muted">{hint}</div>}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-xs tracking-wide text-muted uppercase">{children}</h2>
  );
}

/** Полоса прогресса. */
export function Bar({ value, tone = "accent" }: { value: number; tone?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  const color =
    tone === "ok" ? "bg-ok" : tone === "amber" ? "bg-amber" : "bg-accent";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel2">
      <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ───────────────────────── поля ввода ─────────────────────────

const INPUT =
  "w-full rounded-xl border border-edge bg-panel2 px-3 text-ink placeholder:text-faint outline-none focus-visible:border-accent";

export function TextField({
  value,
  onChange,
  placeholder,
  label,
  id,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  id?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="mb-1 block text-xs text-muted">
          {label}
        </label>
      )}
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} min-h-11 text-[15px]`}
      />
    </div>
  );
}

/**
 * Текст с локальным черновиком: в стор пишем на blur, а не на каждую букву.
 * Каждая мутация стора клонирует состояние целиком — на телефоне посимвольная
 * запись заметно тормозит.
 */
export function NoteField({
  value,
  onCommit,
  placeholder,
  label,
  rows = 2,
  id,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  label?: string;
  rows?: number;
  id?: string;
}) {
  const [draft, setDraft] = useState(value);
  const last = useRef(value);
  // подхватываем внешние изменения, только если сами их не вносили
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setDraft(value);
    }
  }, [value]);
  const commit = () => {
    if (draft === last.current) return;
    last.current = draft;
    onCommit(draft);
  };
  return (
    <div>
      {label && (
        <label htmlFor={id} className="mb-1 block text-xs text-muted">
          {label}
        </label>
      )}
      <textarea
        id={id}
        rows={rows}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className={`${INPUT} resize-y py-2 text-[15px]`}
      />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 rounded-xl px-1 py-2 text-left transition hover:bg-panel2/60"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] text-ink">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          checked ? "bg-accent" : "bg-edge"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-bg transition-all ${
            checked ? "start-5.5" : "start-0.5"
          }`}
        />
      </span>
    </button>
  );
}
