import { useEffect, useRef } from "react";

type Pt = { x: number; y: number };

/**
 * Частицы-сигналы, бегущие по прямой from→to внутри SVG.
 * Анимация на rAF мимо React-рендера — дёшево даже для десятков связей.
 */
export function FlowDots({
  from,
  to,
  count = 3,
  r = 3,
  color = "#58a6ff",
  speed = 0.45,
  active = true,
  opacity = 0.95,
}: {
  from: Pt;
  to: Pt;
  count?: number;
  r?: number;
  color?: string;
  speed?: number; // длин-связей в секунду
  active?: boolean;
  opacity?: number;
}) {
  const g = useRef<SVGGElement>(null);

  useEffect(() => {
    if (!active || !g.current) return;
    const dots = Array.from(g.current.children) as SVGCircleElement[];
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const base = ((now - t0) / 1000) * speed;
      dots.forEach((d, i) => {
        const t = (base + i / dots.length) % 1;
        d.setAttribute("cx", String(from.x + (to.x - from.x) * t));
        d.setAttribute("cy", String(from.y + (to.y - from.y) * t));
        const fade = Math.min(1, t * 5, (1 - t) * 5);
        d.setAttribute("opacity", String(fade * opacity));
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, from.x, from.y, to.x, to.y, speed, opacity]);

  if (!active) return null;
  return (
    <g ref={g} pointerEvents="none">
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} r={r} fill={color} opacity={0} />
      ))}
    </g>
  );
}

/** То же самое, но вдоль произвольного SVG-пути d (для кривых Безье). */
export function FlowDotsPath({
  d,
  count = 3,
  r = 3,
  color = "#58a6ff",
  speed = 0.45,
  active = true,
  reverse = false,
  opacity = 0.95,
}: {
  d: string;
  count?: number;
  r?: number;
  color?: string;
  speed?: number;
  active?: boolean;
  reverse?: boolean;
  opacity?: number;
}) {
  const g = useRef<SVGGElement>(null);
  const path = useRef<SVGPathElement>(null);

  useEffect(() => {
    if (!active || !g.current || !path.current) return;
    const p = path.current;
    const len = p.getTotalLength();
    const dots = Array.from(g.current.children) as SVGCircleElement[];
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const base = ((now - t0) / 1000) * speed;
      dots.forEach((dot, i) => {
        let t = (base + i / dots.length) % 1;
        if (reverse) t = 1 - t;
        const pt = p.getPointAtLength(t * len);
        dot.setAttribute("cx", String(pt.x));
        dot.setAttribute("cy", String(pt.y));
        const tt = reverse ? 1 - t : t;
        const fade = Math.min(1, tt * 5, (1 - tt) * 5);
        dot.setAttribute("opacity", String(fade * opacity));
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, d, speed, reverse, opacity]);

  if (!active) return null;
  return (
    <g pointerEvents="none">
      <path ref={path} d={d} fill="none" stroke="none" />
      <g ref={g}>
        {Array.from({ length: count }, (_, i) => (
          <circle key={i} r={r} fill={color} opacity={0} />
        ))}
      </g>
    </g>
  );
}
