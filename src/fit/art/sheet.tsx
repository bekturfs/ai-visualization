import { createRoot } from "react-dom/client";
import { MOTIONS } from "./motions";
import { Figure, useCycle } from "./Figure";
import "../../index.css";

function Cell({ name, phase }: { name: string; phase: 0 | 1 }) {
  const t = useCycle(2.6, false);
  return (
    <div className="rounded-lg border border-edge bg-panel p-1">
      <Figure motion={MOTIONS[name]} t={phase ? 1 : 0} className="w-full" />
      <div className="text-center text-[10px] text-muted">
        {name} · {MOTIONS[name].phases[phase]} {t < 0 ? "" : ""}
      </div>
    </div>
  );
}

function Sheet() {
  const keys = Object.keys(MOTIONS);
  return (
    <div className="grid grid-cols-8 gap-2 p-3">
      {keys.map((k) => (
        <Cell key={k + "0"} name={k} phase={0} />
      ))}
      {keys.map((k) => (
        <Cell key={k + "1"} name={k} phase={1} />
      ))}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Sheet />);
