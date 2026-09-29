import { lazy, Suspense } from "react";
import { Routes, Route, Link } from "react-router-dom";
import Home from "./pages/Home";

const BigPicture = lazy(() => import("./pages/BigPicture"));
const Roles = lazy(() => import("./pages/Roles"));
const Neuron = lazy(() => import("./pages/Neuron"));
const ForwardPass = lazy(() => import("./pages/ForwardPass"));
const GradientDescent = lazy(() => import("./pages/GradientDescent"));
const Backprop = lazy(() => import("./pages/Backprop"));
const Tokenization = lazy(() => import("./pages/Tokenization"));
const Embeddings = lazy(() => import("./pages/Embeddings"));
const FitApp = lazy(() => import("./fit/FitApp"));

/**
 * Без этого любой неизвестный адрес отрисовывал пустоту: ни один маршрут не
 * совпадал, и человек видел просто фон страницы, не понимая, что произошло.
 */
function NotFound() {
  let shown = location.hash || "/";
  try {
    // без этого кириллический адрес показывается процентными кодами
    shown = decodeURIComponent(shown);
  } catch {
    /* битая последовательность — покажем как есть */
  }
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col justify-center gap-4 px-4">
      <h1 className="text-xl font-semibold text-ink">Такой страницы нет</h1>
      <p className="text-soft">
        Адрес <code className="text-amber">{shown}</code> ничему
        не соответствует. Возможно, эта часть сайта ещё не выложена.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/"
          className="inline-flex min-h-11 items-center rounded-xl border border-edge px-4 text-soft transition hover:border-accent/60 hover:text-ink"
        >
          На главную
        </Link>
        <Link
          to="/fit"
          className="inline-flex min-h-11 items-center rounded-xl border border-edge px-4 text-soft transition hover:border-accent/60 hover:text-ink"
        >
          Тренировки
        </Link>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="flex h-[60vh] items-center justify-center text-muted">
      загрузка…
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/big-picture" element={<BigPicture />} />
        <Route path="/roles" element={<Roles />} />
        <Route path="/neuron" element={<Neuron />} />
        <Route path="/forward-pass" element={<ForwardPass />} />
        <Route path="/gradient-descent" element={<GradientDescent />} />
        <Route path="/backpropagation" element={<Backprop />} />
        <Route path="/tokenization" element={<Tokenization />} />
        <Route path="/embeddings" element={<Embeddings />} />
        {/* личный трекер тренировок — отдельное поддерево, к сайту про ИИ отношения не имеет */}
        <Route path="/fit/*" element={<FitApp />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
