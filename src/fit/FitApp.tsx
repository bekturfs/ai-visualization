import { lazy, Suspense, useEffect } from "react";
import { NavLink, Route, Routes, useLocation, Link } from "react-router-dom";
import { RestBar } from "./RestBar";
import { useFit } from "./store";

const Today = lazy(() => import("./pages/Today"));
const Session = lazy(() => import("./pages/Session"));
const Plan = lazy(() => import("./pages/Plan"));
const Library = lazy(() => import("./pages/Library"));
const History = lazy(() => import("./pages/History"));
const Progress = lazy(() => import("./pages/Progress"));
const Settings = lazy(() => import("./pages/Settings"));

const TABS: { to: string; label: string; icon: string }[] = [
  { to: "/fit", label: "сегодня", icon: "▦" },
  { to: "/fit/plan", label: "план", icon: "☰" },
  { to: "/fit/library", label: "база", icon: "⌗" },
  { to: "/fit/history", label: "журнал", icon: "◷" },
  { to: "/fit/progress", label: "прогресс", icon: "◪" },
];

function Nav() {
  return (
    <nav
      aria-label="Разделы"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-panel/95 backdrop-blur"
    >
      <ul className="mx-auto flex max-w-lg">
        {TABS.map((t) => (
          <li key={t.to} className="flex-1">
            <NavLink
              to={t.to}
              end={t.to === "/fit"}
              className={({ isActive }) =>
                `flex min-h-14 flex-col items-center justify-center gap-0.5 pb-[env(safe-area-inset-bottom)] text-[11px] transition ${
                  isActive ? "text-accent" : "text-muted hover:text-soft"
                }`
              }
            >
              <span aria-hidden="true" className="text-lg leading-none">
                {t.icon}
              </span>
              {t.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Loading() {
  return <div className="py-20 text-center text-muted">загрузка…</div>;
}

export default function FitApp() {
  const { pathname } = useLocation();
  const running = pathname === "/fit/run";
  const active = useFit((s) => s.active);

  // при смене вкладки начинаем сверху, иначе новая страница открывается
  // прокрученной на середину предыдущей
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-30 border-b border-edge bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-2 px-4 py-3">
          <Link to="/fit" className="text-base font-semibold text-ink">
            Тренировки
          </Link>
          {active && !running && (
            <Link
              to="/fit/run"
              className="rounded-full border border-ok/40 bg-ok/10 px-2 py-0.5 text-xs text-ok"
            >
              идёт тренировка
            </Link>
          )}
          <span className="flex-1" />
          <Link
            to="/fit/settings"
            aria-label="Настройки"
            className="rounded-lg px-2 py-1 text-xl text-muted transition hover:text-ink"
          >
            ⚙
          </Link>
        </div>
      </header>

      <main className={`mx-auto max-w-lg px-4 pt-4 ${running ? "pb-40" : "pb-32"}`}>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route index element={<Today />} />
            <Route path="run" element={<Session />} />
            <Route path="plan" element={<Plan />} />
            <Route path="library" element={<Library />} />
            <Route path="history" element={<History />} />
            <Route path="progress" element={<Progress />} />
            <Route path="settings" element={<Settings />} />
          </Routes>
        </Suspense>
      </main>

      <RestBar raised={!running} />
      {!running && <Nav />}
    </div>
  );
}
