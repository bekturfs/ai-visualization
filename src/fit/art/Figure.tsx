import { useEffect, useState } from "react";
import type { EnvKey, Motion, Pose } from "./motions";

const RAD = Math.PI / 180;
type Pt = { x: number; y: number };

/** Точка на расстоянии len под углом ang от «строго вниз»; m = -1 зеркалит по X. */
function pt(o: Pt, len: number, ang: number, m = 1): Pt {
  return {
    x: o.x + m * len * Math.sin(ang * RAD),
    y: o.y + len * Math.cos(ang * RAD),
  };
}

const TORSO = 52;
const NECK = 7;
const HEAD_R = 12;
const UARM = 29;
const FARM = 26;
const THIGH = 39;
const SHIN = 39;
const SH_W = 17;
const HIP_W = 10;
const ORIGIN: Pt = { x: 100, y: 114 };
const FLOOR = 196;

// ───────────────── общий таймер анимации на все карточки ─────────────────

const subs = new Set<(now: number) => void>();
let rafId = 0;
function tick(now: number) {
  subs.forEach((f) => f(now));
  rafId = requestAnimationFrame(tick);
}
function join(f: (now: number) => void) {
  subs.add(f);
  if (!rafId) rafId = requestAnimationFrame(tick);
  return () => {
    subs.delete(f);
    if (!subs.size && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

function reducedMotion() {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Плавный цикл 0→1→0; при active=false замирает на конечной позе. */
export function useCycle(period = 2.6, active = true): number {
  const [t, setT] = useState(1);
  useEffect(() => {
    if (!active || reducedMotion()) {
      setT(1);
      return;
    }
    return join((now) => {
      const p = ((now / 1000) % period) / period;
      setT((1 - Math.cos(p * 2 * Math.PI)) / 2);
    });
  }, [period, active]);
  return t;
}

// ───────────────── геометрия ─────────────────

const POSE_KEYS = [
  "lean",
  "hip",
  "knee",
  "hipL",
  "kneeL",
  "arm",
  "fore",
  "armL",
  "foreL",
  "lift",
  "x",
  "y",
] as const;

function mix(a: Pose, b: Pose, t: number): Required<Pose> {
  const out = {} as Record<string, number>;
  for (const k of POSE_KEYS) {
    const av = (a as Record<string, number | undefined>)[k];
    const bv = (b as Record<string, number | undefined>)[k];
    const from = av ?? bv ?? 0;
    const to = bv ?? av ?? 0;
    out[k] = from + (to - from) * t;
  }
  // руки по умолчанию симметричны
  if (a.armL === undefined && b.armL === undefined) out.armL = out.arm;
  if (a.foreL === undefined && b.foreL === undefined) out.foreL = out.fore;
  if (a.hipL === undefined && b.hipL === undefined) out.hipL = out.hip;
  if (a.kneeL === undefined && b.kneeL === undefined) out.kneeL = out.knee;
  return out as Required<Pose>;
}

type Skeleton = {
  pelvis: Pt;
  chest: Pt;
  head: Pt;
  shR: Pt;
  shL: Pt;
  elbowR: Pt;
  handR: Pt;
  elbowL: Pt;
  handL: Pt;
  hipR: Pt;
  kneeR: Pt;
  ankleR: Pt;
  hipL: Pt;
  kneeL: Pt;
  ankleL: Pt;
  foreAngR: number;
  foreAngL: number;
};

function build(m: Motion, p: Required<Pose>): Skeleton {
  const front = m.view === "front";
  const o = m.origin ?? ORIGIN;
  const pelvis = { x: o.x + p.x, y: o.y + p.y };

  // вид спереди: наклон корпуса читается как укорочение туловища
  const lean = p.lean;
  const torsoLen = front
    ? TORSO * Math.cos(Math.min(Math.abs(lean), 78) * RAD) + 10
    : TORSO;
  const torsoAng = front ? 180 : 180 - lean;

  const chestRaw = pt(pelvis, torsoLen, torsoAng);
  const chest = { x: chestRaw.x, y: chestRaw.y - p.lift };
  const neckLen = front ? NECK + HEAD_R - Math.min(Math.abs(lean), 70) * 0.16 : NECK + HEAD_R;
  const head = pt(chest, neckLen, torsoAng);

  const shR = front ? { x: chest.x + SH_W, y: chest.y } : { x: chest.x, y: chest.y };
  const shL = front ? { x: chest.x - SH_W, y: chest.y } : { x: chest.x - 5, y: chest.y + 3 };

  const elbowR = pt(shR, UARM, p.arm, 1);
  const handR = pt(elbowR, FARM, p.fore, 1);
  const elbowL = pt(shL, UARM, p.armL, front ? -1 : 1);
  const handL = pt(elbowL, FARM, p.foreL, front ? -1 : 1);

  const hipR = front ? { x: pelvis.x + HIP_W, y: pelvis.y } : pelvis;
  const hipL = front ? { x: pelvis.x - HIP_W, y: pelvis.y } : { x: pelvis.x - 4, y: pelvis.y + 2 };
  const legHipR = front ? Math.max(p.hip, 5) : p.hip;
  const legHipL = front ? Math.max(p.hipL, 5) : p.hipL;
  const kneeR = pt(hipR, THIGH, legHipR, 1);
  const ankleR = pt(kneeR, SHIN, p.knee, 1);
  const kneeL = pt(hipL, THIGH, legHipL, front ? -1 : 1);
  const ankleL = pt(kneeL, SHIN, p.kneeL, front ? -1 : 1);

  return {
    pelvis,
    chest,
    head,
    shR,
    shL,
    elbowR,
    handR,
    elbowL,
    handL,
    hipR,
    kneeR,
    ankleR,
    hipL,
    kneeL,
    ankleL,
    foreAngR: p.fore,
    foreAngL: p.foreL,
  };
}

// ───────────────── детали снаряда ─────────────────

function Dumbbell({ at, ang }: { at: Pt; ang: number }) {
  return (
    <g transform={`translate(${at.x} ${at.y}) rotate(${-ang})`}>
      <rect x={-8} y={-3} width={16} height={6} rx={3} className="fill-amber" />
      <rect x={-11} y={-6} width={5} height={12} rx={2} className="fill-amber" />
      <rect x={6} y={-6} width={5} height={12} rx={2} className="fill-amber" />
    </g>
  );
}

function Barbell({ a, b, front }: { a: Pt; b: Pt; front: boolean }) {
  if (!front) {
    return (
      <g>
        <circle cx={a.x} cy={a.y} r={11} className="fill-none stroke-amber" strokeWidth={3} />
        <circle cx={a.x} cy={a.y} r={3.5} className="fill-amber" />
      </g>
    );
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const ext = 26;
  const p1 = { x: a.x - ux * ext, y: a.y - uy * ext };
  const p2 = { x: b.x + ux * ext, y: b.y + uy * ext };
  return (
    <g>
      <line
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
        className="stroke-amber"
        strokeWidth={4}
        strokeLinecap="round"
      />
      {[p1, p2].map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={9} className="fill-amber/70" />
          <circle cx={p.x} cy={p.y} r={4} className="fill-bg" />
        </g>
      ))}
    </g>
  );
}

function Cable({ from, to }: { from: Pt; to: Pt }) {
  return (
    <g>
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        className="stroke-amber"
        strokeWidth={2}
        strokeDasharray="5 3"
      />
      <circle cx={to.x} cy={to.y} r={5} className="fill-amber" />
    </g>
  );
}

function Band({ a, b }: { a: Pt; b: Pt }) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 + 16;
  return (
    <path
      d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
      className="fill-none stroke-amber"
      strokeWidth={3.5}
      strokeLinecap="round"
    />
  );
}

// ───────────────── окружение ─────────────────

function Env({ m }: { m: Motion }) {
  const keys = m.env ?? [];
  const has = (k: EnvKey) => keys.includes(k);
  const anc = m.anchor;
  const ancL = m.anchorL;
  const line = "stroke-edge";
  const fill = "fill-edge";
  return (
    <g>
      {has("floor") && (
        <line
          x1={6}
          y1={FLOOR}
          x2={194}
          y2={FLOOR}
          className={line}
          strokeWidth={3}
          strokeLinecap="round"
        />
      )}
      {has("seatFront") && (
        <g>
          <rect x={72} y={FLOOR - 74} width={12} height={70} rx={4} className={fill} />
          <rect x={72} y={FLOOR - 78} width={56} height={12} rx={5} className={fill} />
          <rect x={94} y={FLOOR - 68} width={10} height={64} rx={4} className={fill} />
        </g>
      )}
      {has("seatSide") && (
        <g>
          <rect x={66} y={FLOOR - 68} width={72} height={11} rx={5} className={fill} />
          <rect x={96} y={FLOOR - 58} width={10} height={56} rx={4} className={fill} />
        </g>
      )}
      {has("benchFlat") && (
        <g>
          <rect x={38} y={FLOOR - 76} width={110} height={13} rx={6} className={fill} />
          <rect x={54} y={FLOOR - 64} width={9} height={62} rx={4} className={fill} />
          <rect x={124} y={FLOOR - 64} width={9} height={62} rx={4} className={fill} />
        </g>
      )}
      {has("benchIncline") && (
        <g>
          <rect
            x={34}
            y={FLOOR - 80}
            width={112}
            height={13}
            rx={6}
            className={fill}
            transform="rotate(-32 90 120)"
          />
          <rect x={100} y={FLOOR - 52} width={9} height={50} rx={4} className={fill} />
        </g>
      )}
      {has("benchLow") && (
        <rect x={22} y={FLOOR - 52} width={58} height={11} rx={5} className={fill} />
      )}
      {has("pullupBar") && (
        <g>
          <line x1={40} y1={26} x2={160} y2={26} className="stroke-amber" strokeWidth={5} strokeLinecap="round" />
          <line x1={44} y1={26} x2={44} y2={8} className={line} strokeWidth={4} />
          <line x1={156} y1={26} x2={156} y2={8} className={line} strokeWidth={4} />
        </g>
      )}
      {has("cableTop") && anc && (
        <g>
          <rect x={anc.x - 7} y={6} width={14} height={anc.y - 6} rx={4} className={fill} />
          <circle cx={anc.x} cy={anc.y} r={6} className="fill-none stroke-amber" strokeWidth={2.5} />
        </g>
      )}
      {has("cableBottom") && anc && (
        <g>
          <rect x={anc.x - 12} y={anc.y - 34} width={24} height={34} rx={5} className={fill} />
          <circle cx={anc.x} cy={anc.y - 30} r={5} className="fill-none stroke-amber" strokeWidth={2.5} />
        </g>
      )}
      {has("cableMid") && anc && (
        <g>
          <rect x={anc.x - 10} y={anc.y - 40} width={20} height={90} rx={5} className={fill} />
          <circle cx={anc.x} cy={anc.y} r={5} className="fill-none stroke-amber" strokeWidth={2.5} />
        </g>
      )}
      {has("cableSides") && anc && ancL && (
        <g>
          <rect x={anc.x - 8} y={anc.y - 16} width={16} height={150} rx={5} className={fill} />
          <rect x={ancL.x - 8} y={ancL.y - 16} width={16} height={150} rx={5} className={fill} />
        </g>
      )}
      {has("dipBars") && (
        <g>
          <line x1={44} y1={128} x2={156} y2={128} className="stroke-amber" strokeWidth={5} strokeLinecap="round" />
          <line x1={52} y1={128} x2={52} y2={FLOOR} className={line} strokeWidth={4} />
          <line x1={148} y1={128} x2={148} y2={FLOOR} className={line} strokeWidth={4} />
          <line x1={6} y1={FLOOR} x2={194} y2={FLOOR} className={line} strokeWidth={3} />
        </g>
      )}
      {has("sled") && (
        <g>
          <rect x={132} y={22} width={54} height={13} rx={5} className="fill-amber/60" transform="rotate(26 158 30)" />
          <rect x={30} y={150} width={110} height={12} rx={5} className={fill} />
          <line x1={6} y1={FLOOR} x2={194} y2={FLOOR} className={line} strokeWidth={3} />
        </g>
      )}
      {has("hyperPad") && (
        <g>
          <rect x={96} y={96} width={44} height={13} rx={6} className={fill} transform="rotate(20 118 102)" />
          <rect x={112} y={104} width={10} height={80} rx={4} className={fill} />
          <rect x={40} y={128} width={16} height={10} rx={4} className={fill} />
          <line x1={6} y1={FLOOR} x2={194} y2={FLOOR} className={line} strokeWidth={3} />
        </g>
      )}
      {has("machine") && (
        <g>
          <rect x={24} y={48} width={10} height={140} rx={4} className={fill} />
          <rect x={166} y={48} width={10} height={140} rx={4} className={fill} />
        </g>
      )}
    </g>
  );
}

// ───────────────── фигура ─────────────────

export function Figure({
  motion,
  t,
  className,
}: {
  motion: Motion;
  t: number;
  className?: string;
}) {
  const p = mix(motion.a, motion.b, t);
  const s = build(motion, p);
  const front = motion.view === "front";
  const limb = {
    className: "stroke-accent",
    strokeWidth: 7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  const far = { ...limb, className: "stroke-accent/40", strokeWidth: 6 };

  const poly = (...pts: Pt[]) => pts.map((q) => `${q.x},${q.y}`).join(" ");

  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true">
      <Env m={motion} />

      {/* дальние конечности — приглушённо, для объёма */}
      <polyline points={poly(s.hipL, s.kneeL, s.ankleL)} {...far} />
      <polyline points={poly(s.shL, s.elbowL, s.handL)} {...far} />

      {/* корпус */}
      <line
        x1={s.pelvis.x}
        y1={s.pelvis.y}
        x2={s.chest.x}
        y2={s.chest.y}
        {...limb}
        strokeWidth={11}
      />
      {front && (
        <line x1={s.shL.x} y1={s.shL.y} x2={s.shR.x} y2={s.shR.y} {...limb} strokeWidth={9} />
      )}
      {front && (
        <line x1={s.hipL.x} y1={s.hipL.y} x2={s.hipR.x} y2={s.hipR.y} {...limb} strokeWidth={9} />
      )}
      <circle cx={s.head.x} cy={s.head.y} r={HEAD_R} className="fill-accent" />

      {/* ближние конечности */}
      <polyline points={poly(s.hipR, s.kneeR, s.ankleR)} {...limb} />
      <polyline points={poly(s.shR, s.elbowR, s.handR)} {...limb} />

      {/* снаряд */}
      {motion.equip === "dumbbell" && (
        <>
          <Dumbbell at={s.handR} ang={s.foreAngR} />
          <Dumbbell at={s.handL} ang={s.foreAngL} />
        </>
      )}
      {motion.equip === "barbell" && <Barbell a={s.handL} b={s.handR} front={front} />}
      {motion.equip === "band" && <Band a={s.handL} b={s.handR} />}
      {motion.equip === "cable" && motion.anchor && (
        <>
          <Cable from={motion.anchor} to={s.handR} />
          {motion.anchorL && <Cable from={motion.anchorL} to={s.handL} />}
        </>
      )}
      {motion.equip === "bar" && (
        <>
          <circle cx={s.handR.x} cy={s.handR.y} r={5} className="fill-amber" />
          <circle cx={s.handL.x} cy={s.handL.y} r={5} className="fill-amber/60" />
        </>
      )}
    </svg>
  );
}
