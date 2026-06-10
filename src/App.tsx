import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";

const BigPicture = lazy(() => import("./pages/BigPicture"));
const Neuron = lazy(() => import("./pages/Neuron"));
const ForwardPass = lazy(() => import("./pages/ForwardPass"));
const GradientDescent = lazy(() => import("./pages/GradientDescent"));
const Backprop = lazy(() => import("./pages/Backprop"));

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
        <Route path="/neuron" element={<Neuron />} />
        <Route path="/forward-pass" element={<ForwardPass />} />
        <Route path="/gradient-descent" element={<GradientDescent />} />
        <Route path="/backpropagation" element={<Backprop />} />
      </Routes>
    </Suspense>
  );
}
