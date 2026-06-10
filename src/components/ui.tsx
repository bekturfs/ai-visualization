import type { ReactNode } from "react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion, useSpring, useTransform } from "motion/react";
import { fmt } from "../lib/format";

/* ---------- каркас страницы ---------- */

/** Рекомендуемый маршрут по сайту — по нему строится навигация «дальше →». */
export const ROUTE_ORDER = [
  { to: "/big-picture", num: "00", label: "Общая картина" },
  { to: "/roles", num: "🧩", label: "Кто за что отвечает" },
  { to: "/neuron", num: "01", label: "Нейрон и активации" },
  { to: "/forward-pass", num: "02", label: "Forward pass" },
  { to: "/gradient-descent", num: "03", label: "Градиентный спуск" },
  { to: "/backpropagation", num: "04", label: "Backpropagation" },
  { to: "/tokenization", num: "05", label: "Токенизация (BPE)" },
  { to: "/embeddings", num: "06", label: "Эмбеддинги" },
];

function PrevNext({ pathname }: { pathname: string }) {
  const idx = ROUTE_ORDER.findIndex((r) => r.to === pathname);
  if (idx === -1) return null;
  const prev = ROUTE_ORDER[idx - 1];
  const next = ROUTE_ORDER[idx + 1];
  return (
    <nav className="mt-10 flex flex-wrap items-stretch justify-between gap-3 border-t border-edge pt-5">
      {prev ? (
        <Link
          to={prev.to}
          className="rounded-xl border border-edge bg-panel px-4 py-3 no-underline transition-colors hover:border-accent"
        >
          <div className="text-[11.5px] uppercase tracking-wider text-muted">
            ← назад
          </div>
          <div className="text-[14.5px] font-semibold text-ink">
            {prev.num} · {prev.label}
          </div>
        </Link>
      ) : (
        <Link
          to="/"
          className="rounded-xl border border-edge bg-panel px-4 py-3 no-underline transition-colors hover:border-accent"
        >
          <div className="text-[11.5px] uppercase tracking-wider text-muted">
            ← назад
          </div>
          <div className="text-[14.5px] font-semibold text-ink">Главная</div>
        </Link>
      )}
      {next ? (
        <Link
          to={next.to}
          className="rounded-xl border border-[#2d68b8] bg-[#1f3a5f]/40 px-4 py-3 text-right no-underline transition-colors hover:border-accent"
        >
          <div className="text-[11.5px] uppercase tracking-wider text-muted">
            дальше →
          </div>
          <div className="text-[14.5px] font-semibold text-ink">
            {next.num} · {next.label}
          </div>
        </Link>
      ) : (
        <Link
          to="/"
          className="rounded-xl border border-[#2d68b8] bg-[#1f3a5f]/40 px-4 py-3 text-right no-underline transition-colors hover:border-accent"
        >
          <div className="text-[11.5px] uppercase tracking-wider text-muted">
            🏁 маршрут пройден
          </div>
          <div className="text-[14.5px] font-semibold text-ink">
            На главную — дальше attention (скоро)
          </div>
        </Link>
      )}
    </nav>
  );
}

export function Layout({
  crumb,
  crumbEn,
  children,
}: {
  crumb?: string;
  crumbEn?: string;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return (
    <>
      <header className="sticky top-0 z-20 flex items-baseline gap-4 border-b border-edge bg-bg/93 px-5 py-3 backdrop-blur-sm">
        <Link
          to="/"
          className="whitespace-nowrap text-sm text-muted no-underline hover:text-accent"
        >
          ← все визуализации
        </Link>
        {crumb && (
          <span className="truncate text-[15px] font-semibold">
            {crumb}{" "}
            {crumbEn && (
              <span className="text-[13px] font-normal text-muted">
                ({crumbEn})
              </span>
            )}
          </span>
        )}
        {pathname !== "/roles" && (
          <Link
            to="/roles"
            title="Шпаргалка: кто за что отвечает"
            className="ml-auto whitespace-nowrap text-sm text-muted no-underline hover:text-accent"
          >
            🧩 шпаргалка
          </Link>
        )}
      </header>
      <main className="mx-auto max-w-[1180px] px-5 pb-14 pt-5">
        {children}
        <PrevNext pathname={pathname} />
      </main>
    </>
  );
}

/* ---------- карточка ---------- */

export function Card({
  title,
  children,
  className = "",
  right,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border border-edge bg-panel px-[18px] py-4 ${className}`}
    >
      {title && (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.07em] text-muted">
            {title}
          </h2>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

/* ---------- слайдер с подписью и значением ---------- */

export function SliderRow({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.05,
  amber = false,
  labelWidth = 44,
  signColor = false,
  hint,
}: {
  label: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  amber?: boolean;
  labelWidth?: number;
  signColor?: boolean;
  hint?: string;
}) {
  const cls = signColor ? (value < 0 ? "text-hot" : "text-accent") : "";
  return (
    <div
      className="my-1.5 grid items-center gap-2.5"
      style={{ gridTemplateColumns: `${labelWidth}px 1fr 62px` }}
      title={hint}
    >
      <label className="font-mono text-[13.5px] text-muted">{label}</label>
      <input
        type="range"
        className={amber ? "amber" : ""}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <output className={`text-right font-mono text-[13.5px] ${cls}`}>
        {fmt(value)}
      </output>
    </div>
  );
}

/* ---------- сегментные кнопки ---------- */

export function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`cursor-pointer rounded-lg border px-3 py-1.5 text-[13.5px] transition-colors ${
            o.value === value
              ? "border-[#2d68b8] bg-[#1f3a5f] text-[#cfe5ff]"
              : "border-[#344158] bg-[#202938] text-ink hover:border-accent"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- кнопка ---------- */

export function Btn({
  children,
  onClick,
  variant = "normal",
  disabled = false,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "normal" | "primary" | "warm";
  disabled?: boolean;
  className?: string;
}) {
  const styles = {
    normal: "bg-[#202938] border-[#344158] hover:border-accent",
    primary: "bg-[#1f3a5f] border-[#2d68b8] hover:border-accent",
    warm: "bg-[#3d2a16] border-[#7a5226] hover:border-amber",
  } as const;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`cursor-pointer rounded-lg border px-3.5 py-2 text-sm text-ink transition-colors disabled:cursor-default disabled:opacity-45 ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/* ---------- плавно анимированное число ---------- */

export function AnimatedNumber({
  value,
  digits = 2,
  className = "",
}: {
  value: number;
  digits?: number;
  className?: string;
}) {
  const spring = useSpring(value, { stiffness: 220, damping: 30 });
  useEffect(() => {
    spring.set(value);
  }, [value, spring]);
  const text = useTransform(spring, (v) => fmt(v, digits));
  return <motion.span className={className}>{text}</motion.span>;
}
