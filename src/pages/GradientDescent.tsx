import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Line } from "@react-three/drei";
import { motion } from "motion/react";
import { Layout, Card, SliderRow, Seg, Btn } from "../components/ui";
import { StoryPanel, useStory, type StoryStep } from "../components/StoryMode";
import { fmt, clamp } from "../lib/format";

/* ---------- ландшафты потерь L(w1, w2) ---------- */

type PresetName = "bowl" | "bumpy";
const PRESETS: Record<
  PresetName,
  {
    label: string;
    f: (a: number, b: number) => number;
    g: (a: number, b: number) => [number, number];
    w0: [number, number];
    minHint: string;
  }
> = {
  bowl: {
    label: "L = 0.3·(w1−0.8)² + 0.08·(w2+0.6)²",
    f: (a, b) => 0.3 * (a - 0.8) ** 2 + 0.08 * (b + 0.6) ** 2,
    g: (a, b) => [0.6 * (a - 0.8), 0.16 * (b + 0.6)],
    w0: [-2.4, 2.2],
    minHint: "дно — в точке (0.8, −0.6)",
  },
  bumpy: {
    label: "L = 0.12·(w1²+w2²) + 0.55·sin(1.4·w1)·cos(1.4·w2) + 0.8",
    f: (a, b) =>
      0.12 * (a * a + b * b) + 0.55 * Math.sin(1.4 * a) * Math.cos(1.4 * b) + 0.8,
    g: (a, b) => [
      0.24 * a + 0.77 * Math.cos(1.4 * a) * Math.cos(1.4 * b),
      0.24 * b - 0.77 * Math.sin(1.4 * a) * Math.sin(1.4 * b),
    ],
    w0: [2.5, 2.3],
    minHint: "самая глубокая яма — около (−1.1, 0)",
  },
};

const BOUND = 3; // ландшафт рисуем на [−3, 3]²
const Y_SCALE = 0.55; // вертикаль сплющена для красоты; числа L — честные

/* ---------- цвет по высоте ---------- */
const STOPS = ["#102a52", "#1f5288", "#3a7ab8", "#ffa657", "#f0564f"].map(
  (c) => new THREE.Color(c),
);
function heightColor(t: number): THREE.Color {
  const x = clamp(t, 0, 1) * (STOPS.length - 1);
  const i = Math.min(Math.floor(x), STOPS.length - 2);
  return STOPS[i].clone().lerp(STOPS[i + 1], x - i);
}

/* ---------- 3D: поверхность ---------- */

function Surface({
  preset,
  onPlace,
}: {
  preset: PresetName;
  onPlace: (w: [number, number]) => void;
}) {
  const { geometry, wireGeometry } = useMemo(() => {
    const P = PRESETS[preset];
    const seg = 96;
    const geo = new THREE.PlaneGeometry(BOUND * 2, BOUND * 2, seg, seg);
    geo.rotateX(-Math.PI / 2); // в плоскость XZ, Y — высота
    const pos = geo.attributes.position;
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = P.f(pos.getX(i), pos.getZ(i)) * Y_SCALE;
      pos.setY(i, y);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const c = heightColor((pos.getY(i) - lo) / (hi - lo + 1e-9));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    // редкая сетка поверх — для читаемости рельефа
    const wseg = 24;
    const wgeo = new THREE.PlaneGeometry(BOUND * 2, BOUND * 2, wseg, wseg);
    wgeo.rotateX(-Math.PI / 2);
    const wpos = wgeo.attributes.position;
    for (let i = 0; i < wpos.count; i++) {
      wpos.setY(i, P.f(wpos.getX(i), wpos.getZ(i)) * Y_SCALE + 0.012);
    }
    return { geometry: geo, wireGeometry: wgeo };
  }, [preset]);

  useEffect(
    () => () => {
      geometry.dispose();
      wireGeometry.dispose();
    },
    [geometry, wireGeometry],
  );

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onPlace([
      clamp(e.point.x, -BOUND, BOUND),
      clamp(e.point.z, -BOUND, BOUND),
    ]);
  };

  return (
    <group>
      <mesh geometry={geometry} onClick={click}>
        <meshStandardMaterial vertexColors roughness={0.82} metalness={0.05} />
      </mesh>
      <mesh geometry={wireGeometry}>
        <meshBasicMaterial
          wireframe
          color="#9fc4ff"
          transparent
          opacity={0.10}
        />
      </mesh>
    </group>
  );
}

/* ---------- 3D: шарик, плавно катящийся к цели ---------- */

function Ball({
  target,
  preset,
}: {
  target: [number, number];
  preset: PresetName;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const pos = useRef(new THREE.Vector2(target[0], target[1]));
  useFrame((_, dt) => {
    if (!ref.current) return;
    const k = 1 - Math.exp(-dt * 7);
    pos.current.x += (target[0] - pos.current.x) * k;
    pos.current.y += (target[1] - pos.current.y) * k;
    const P = PRESETS[preset];
    const x = pos.current.x,
      z = pos.current.y;
    const inside = Math.abs(x) <= BOUND + 0.5 && Math.abs(z) <= BOUND + 0.5;
    ref.current.position.set(x, P.f(x, z) * Y_SCALE + 0.14, z);
    ref.current.visible = inside;
  });
  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.14, 24, 24]} />
      <meshStandardMaterial
        color="#ffffff"
        emissive="#58a6ff"
        emissiveIntensity={0.55}
        roughness={0.25}
      />
    </mesh>
  );
}

/* ---------- 3D: стрелка анти-градиента ---------- */

function GradArrow({
  w,
  preset,
  visible,
}: {
  w: [number, number];
  preset: PresetName;
  visible: boolean;
}) {
  const P = PRESETS[preset];
  const [g1, g2] = P.g(w[0], w[1]);
  const mag = Math.hypot(g1, g2);
  if (!visible || mag < 1e-4 || Math.abs(w[0]) > BOUND || Math.abs(w[1]) > BOUND)
    return null;
  const len = clamp(mag * 0.9, 0.25, 1.4);
  const dir = new THREE.Vector3(-g1 / mag, 0, -g2 / mag);
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    dir,
  );
  const y = P.f(w[0], w[1]) * Y_SCALE + 0.16;
  return (
    <group position={[w[0], y, w[1]]} quaternion={quat}>
      <mesh position={[len / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[0.035, 0.035, len, 10]} />
        <meshStandardMaterial
          color="#ffa657"
          emissive="#ffa657"
          emissiveIntensity={0.6}
        />
      </mesh>
      <mesh position={[len + 0.09, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[0.09, 0.2, 12]} />
        <meshStandardMaterial
          color="#ffa657"
          emissive="#ffa657"
          emissiveIntensity={0.6}
        />
      </mesh>
    </group>
  );
}

/* ---------- история ---------- */

const STEPS: StoryStep[] = [
  {
    emoji: "🏔",
    title: "Обучение — это поиск самой низкой точки долины",
    text: (
      <>
        Перед тобой ландшафт ошибки (loss landscape) —{" "}
        <b className="text-ink">покрути его мышкой!</b> Каждая точка долины —
        один вариант весов сети, а высота — насколько сеть с такими весами
        ошибается. Красные вершины — ужасные веса, тёмно-синее дно — отличные.
        Обучить сеть = найти самое глубокое место.
      </>
    ),
  },
  {
    emoji: "🌫",
    title: "Шарик в тумане: карты не существует",
    text: (
      <>
        Загвоздка: у настоящей сети миллиарды весов, и «увидеть» весь ландшафт
        невозможно — его никто никогда не вычислял целиком. Сеть — как шарик в
        густом тумане: видит только{" "}
        <b className="text-ink">наклон под ногами</b>. Этот наклон называется{" "}
        <span className="text-amber">градиент (gradient, ∇L)</span> — оранжевая
        стрелка показывает, куда склон ведёт вниз.
      </>
    ),
  },
  {
    emoji: "👣",
    title: "Шаг против наклона — и повторить",
    text: (
      <>
        Весь алгоритм — одна строчка:{" "}
        <code className="font-mono text-ink">w ← w − η·∇L</code>. «Сделай шаг
        туда, куда ведёт склон, и снова осмотрись». Смотри, шарик пошёл!
        Каждый прыжок — один шаг обучения. Миллион таких шагов — и GPT обучен.
        Нажми <b className="text-ink">«Шаг»</b> несколько раз сам.
      </>
    ),
  },
  {
    emoji: "🎚",
    title: "Learning rate — длина шага, главная ручка обучения",
    text: (
      <>
        η (learning rate) задаёт длину шага. Маленький — ползём вечность.
        Нормальный — быстро и точно. Большой — перепрыгиваем дно и скачем по
        склонам туда-сюда. Огромный — каждый прыжок выше предыдущего, и шарик{" "}
        <b className="text-ink">улетает в космос</b> (расходимость).{" "}
        <b className="text-ink">Разгони слайдер η до упора и нажми ▶ Старт</b> —
        устрой взрыв!
      </>
    ),
  },
  {
    emoji: "⛰",
    title: "Ловушка: локальные минимумы",
    text: (
      <>
        Я переключил ландшафт на «холмы». Теперь ям много, а самая глубокая —
        одна. Шарик скатывается в <b className="text-ink">ближайшую</b> яму и
        останавливается: под ногами ровно, градиент нулевой — а до настоящего
        дна он так и не дошёл. Это локальный минимум (local minimum).{" "}
        <b className="text-ink">Кликни в разные места ландшафта</b> — финиш
        зависит от старта!
      </>
    ),
  },
  {
    emoji: "📉",
    title: "Кривая loss — пульс обучения",
    text: (
      <>
        График справа — ошибка по шагам. Именно на такие кривые инженеры
        смотрят, когда обучают настоящие модели: loss падает — сеть учится,
        дрожит — η великоват, растёт — всё сломалось. Ты только что прочитал
        свой первый «график обучения».
      </>
    ),
  },
  {
    emoji: "🏆",
    title: "Проверь себя!",
    text: (
      <>
        В песочнице: докати шарик до дна чаши, устрой расходимость и поймай
        шарик в локальной яме на холмах. Помни: всё это происходит в
        миллиардо-мерном пространстве каждый раз, когда кто-то обучает нейросеть.
      </>
    ),
  },
];

/* ---------- страница ---------- */

export default function GradientDescent() {
  const [preset, setPreset] = useState<PresetName>("bowl");
  const [w, setW] = useState<[number, number]>(PRESETS.bowl.w0);
  const [eta, setEta] = useState(0.3);
  const [trail, setTrail] = useState<[number, number][]>([PRESETS.bowl.w0]);
  const [losses, setLosses] = useState<number[]>([
    PRESETS.bowl.f(...PRESETS.bowl.w0),
  ]);
  const [running, setRunning] = useState(false);
  const [diverged, setDiverged] = useState(false);
  const [divergedOnce, setDivergedOnce] = useState(false);
  const [stuckOnce, setStuckOnce] = useState(false);
  const [bottomOnce, setBottomOnce] = useState(false);
  const [deepOnce, setDeepOnce] = useState(false);

  const story = useStory(STEPS.length);
  const st = story.step;

  const P = PRESETS[preset];
  const L = P.f(w[0], w[1]);
  const [g1, g2] = P.g(w[0], w[1]);
  const gMag = Math.hypot(g1, g2);

  const place = useCallback(
    (nw: [number, number], np?: PresetName) => {
      const pp = np ?? preset;
      setW(nw);
      setTrail([nw]);
      setLosses([PRESETS[pp].f(nw[0], nw[1])]);
      setDiverged(false);
      setRunning(false);
    },
    [preset],
  );

  const switchPreset = (p: PresetName) => {
    setPreset(p);
    place(PRESETS[p].w0, p);
  };

  const step = useCallback(() => {
    setW(([a, b]) => {
      const [ga, gb] = PRESETS[preset].g(a, b);
      const na = a - eta * ga;
      const nb = b - eta * gb;
      const nl = PRESETS[preset].f(na, nb);
      setTrail((t) => [...t.slice(-60), [na, nb]]);
      setLosses((l) => [...l.slice(-120), nl]);
      if (Math.abs(na) > 8 || Math.abs(nb) > 8 || !isFinite(nl)) {
        setDiverged(true);
        setDivergedOnce(true);
        setRunning(false);
      } else {
        // достижения для заданий
        if (preset === "bowl" && nl < 0.01) setBottomOnce(true);
        if (preset === "bumpy") {
          const [nga, ngb] = PRESETS[preset].g(na, nb);
          if (Math.hypot(nga, ngb) < 0.04 && nl > 0.6) setStuckOnce(true);
          if (nl < 0.45) setDeepOnce(true);
        }
      }
      return [na, nb];
    });
  }, [preset, eta]);

  // авто-режим
  useEffect(() => {
    if (!running || diverged) return;
    const id = setInterval(step, 350);
    return () => clearInterval(id);
  }, [running, diverged, step]);

  // действия шагов истории
  const autoRef = useRef<number[]>([]);
  useEffect(() => {
    autoRef.current.forEach(clearTimeout);
    autoRef.current = [];
    if (st === null) return;
    setRunning(false);
    if (st <= 1 && preset !== "bowl") switchPreset("bowl");
    if (st <= 1) place(PRESETS.bowl.w0, "bowl");
    if (st === 2) {
      // несколько медленных шагов, чтобы показать движение
      if (preset !== "bowl") switchPreset("bowl");
      place(PRESETS.bowl.w0, "bowl");
      for (let i = 0; i < 6; i++) {
        autoRef.current.push(window.setTimeout(step, 700 + i * 600));
      }
    }
    if (st === 4 && preset !== "bumpy") switchPreset("bumpy");
    if (st === 5) {
      // прогон для красивой кривой loss
      place(PRESETS[preset].w0);
      for (let i = 0; i < 14; i++) {
        autoRef.current.push(window.setTimeout(step, 400 + i * 260));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  const glow = (on: boolean) => (on ? "ring-2 ring-accent/70" : "");

  const tasks = [
    { label: "Чаша: докати шарик до дна (L < 0.01)", done: bottomOnce },
    { label: "Устрой взрыв: разгони η, чтобы шарик улетел", done: divergedOnce },
    { label: "Холмы: застрянь в мелкой яме (∇L ≈ 0, но L > 0.6)", done: stuckOnce },
    { label: "Холмы: найди яму поглубже (L < 0.45)", done: deepOnce },
  ];

  const trail3D = useMemo(
    () =>
      trail
        .filter(([a, b]) => Math.abs(a) <= BOUND && Math.abs(b) <= BOUND)
        .map(
          ([a, b]) =>
            [a, P.f(a, b) * Y_SCALE + 0.07, b] as [number, number, number],
        ),
    [trail, P],
  );

  /* sparkline кривой loss */
  const spark = useMemo(() => {
    if (losses.length < 2) return "";
    const max = Math.max(...losses.map((l) => (isFinite(l) ? l : 0)), 0.001);
    const W2 = 260,
      H2 = 64;
    return losses
      .map((l, i) => {
        const xx = (i / (losses.length - 1)) * W2;
        const yy = H2 - 4 - (clamp(l, 0, max) / max) * (H2 - 10);
        return `${i === 0 ? "M" : "L"}${xx.toFixed(1)},${yy.toFixed(1)}`;
      })
      .join(" ");
  }, [losses]);

  return (
    <Layout crumb="03 · Градиентный спуск" crumbEn="gradient descent">
      <h1 className="mb-1.5 mt-2 text-[23px] font-bold">
        Как сеть спускается к минимуму потерь — в 3D
      </h1>
      <p className="mb-4 max-w-[920px] text-muted">
        <b className="text-ink">Градиент отвечает за направление</b> («куда
        крутить веса, чтобы ошибка падала»),{" "}
        <b className="text-ink">learning rate — за размер шага</b>. Высота
        ландшафта — ошибка сети, и обучение — повтор одного правила:{" "}
        <code className="font-mono">w ← w − η·∇L</code>. Сцену можно вращать
        (зажми мышь), приближать (колесо) и кликать, чтобы поставить шарик.
      </p>

      <StoryPanel
        steps={STEPS}
        step={story.step}
        setStep={story.setStep}
        next={story.next}
        prev={story.prev}
        sandboxText="Вращай сцену, кликай по ландшафту, играй с η. Оранжевая стрелка — направление −∇L («куда вниз»)."
      />

      <Card title={`Ландшафт потерь · ${P.label}`} className="mb-4">
        <div className="relative">
          <div className="h-[440px] w-full overflow-hidden rounded-lg">
            <Canvas camera={{ position: [5.6, 4.6, 6.8], fov: 42 }} dpr={[1, 2]}>
              <color attach="background" args={["#0d1117"]} />
              <fog attach="fog" args={["#0d1117", 15, 30]} />
              <ambientLight intensity={0.85} />
              <directionalLight position={[6, 10, 4]} intensity={1.5} />
              <directionalLight position={[-6, 6, -6]} intensity={0.45} color="#58a6ff" />
              <Surface preset={preset} onPlace={place} />
              <Ball target={w} preset={preset} />
              <GradArrow w={w} preset={preset} visible={st === null || st >= 1} />
              {trail3D.length > 1 && (
                <Line points={trail3D} color="#e7edf4" lineWidth={1.5} transparent opacity={0.55} />
              )}
              <OrbitControls
                target={[0, 0.55, 0]}
                enablePan={false}
                minDistance={4}
                maxDistance={18}
                maxPolarAngle={Math.PI / 2.05}
              />
            </Canvas>
          </div>
          {diverged && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="absolute left-1/2 top-4 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[#8a3633] bg-[#3c1212]/95 px-4 py-2 text-sm text-[#ffb3ae]"
            >
              💥 Расходимся! η слишком большой — шарик улетел. Кликни по
              ландшафту, чтобы начать заново.
            </motion.div>
          )}
          <div className="pointer-events-none absolute bottom-3 right-4 text-xs text-faint">
            🖱 вращать · колесо — зум · клик — поставить шарик
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-3 items-start gap-4 max-lg:grid-cols-1">
        <Card title="Управление" className={glow(st === 3)}>
          <Seg
            options={[
              { value: "bowl", label: "Чаша (выпуклая)" },
              { value: "bumpy", label: "Холмы (локальные минимумы)" },
            ]}
            value={preset}
            onChange={switchPreset}
          />
          <div className="mt-3">
            <SliderRow
              label="η (learning rate)"
              labelWidth={110}
              value={eta}
              onChange={setEta}
              min={0.05}
              max={3.5}
              step={0.01}
              amber
            />
          </div>
          <div className="text-[12.5px] leading-normal text-muted">
            η ≈ 0.1 — медленно · η ≈ 0.5 — хорошо · η ≈ 3 — осцилляции ·
            η &gt; 3.3 — взрыв 💥 (для чаши)
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn onClick={() => { setRunning(false); step(); }} disabled={diverged}>
              Шаг
            </Btn>
            <Btn
              variant="primary"
              onClick={() => setRunning((r) => !r)}
              disabled={diverged}
            >
              {running ? "⏸ Пауза" : "▶ Старт"}
            </Btn>
            <Btn onClick={() => place(P.w0)}>Сброс</Btn>
            <Btn
              onClick={() =>
                place([
                  Math.round((Math.random() * 5.6 - 2.8) * 10) / 10,
                  Math.round((Math.random() * 5.6 - 2.8) * 10) / 10,
                ])
              }
            >
              🎲 Случайный старт
            </Btn>
          </div>
          <div className="mt-2.5 text-[12.5px] text-muted">💡 {P.minHint}</div>
        </Card>

        <Card title="Числа на этом шаге">
          <div className="font-mono text-[13.5px] leading-[2.05]">
            <div>
              <span className="text-muted">w = </span>({fmt(w[0])}, {fmt(w[1])})
            </div>
            <div>
              <span className="text-muted">L(w) = </span>
              <span className="font-semibold text-ok">{fmt(L)}</span>
            </div>
            <div>
              <span className="text-muted">∇L = </span>
              <span className="text-amber">({fmt(g1)}, {fmt(g2)})</span>
              <span className="text-muted"> |∇L| = {fmt(gMag)}</span>
            </div>
            <div className="break-words border-t border-edge pt-1">
              <span className="text-muted">шаг: </span>w − {fmt(eta)}·
              <span className="text-amber">∇L</span> = ({fmt(w[0] - eta * g1)},{" "}
              {fmt(w[1] - eta * g2)})
            </div>
            <div className="text-[12px] text-faint">
              шагов сделано: {losses.length - 1}
            </div>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Кривая loss (как у настоящего обучения)" className={glow(st === 5)}>
            <svg viewBox="0 0 260 64" className="h-[64px] w-full">
              <line x1="0" y1="60" x2="260" y2="60" stroke="#2b3444" />
              {spark && (
                <path d={spark} fill="none" stroke="#56d364" strokeWidth="2" />
              )}
            </svg>
            <div className="mt-1 text-[12px] text-muted">
              {losses.length < 3
                ? "сделай несколько шагов — увидишь, как падает ошибка"
                : diverged
                  ? "кривая взлетела — это и есть расходимость"
                  : `L: ${fmt(losses[0])} → ${fmt(losses[losses.length - 1])}`}
            </div>
          </Card>

          <Card title="Задания 🏆" className={glow(st === 6)}>
            <ul className="m-0 list-none p-0 text-[13.5px]">
              {tasks.map((t, i) => (
                <li key={i} className="my-1.5 flex items-start gap-2.5">
                  <motion.span
                    animate={t.done ? { scale: [1, 1.4, 1] } : { scale: 1 }}
                    className={t.done ? "text-ok" : "text-faint"}
                  >
                    {t.done ? "✅" : "⬜"}
                  </motion.span>
                  <span className={t.done ? "text-ok" : "text-soft"}>{t.label}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      {st === null && (
        <Card title="Что здесь происходит" className="mt-4">
          <p className="my-2 max-w-[1000px] text-soft">
            Обучение сети — это поиск минимума функции потерь. Мы стоим в точке
            w, считаем градиент ∇L — направление самого крутого подъёма — и
            делаем шаг в противоположную сторону. Learning rate η задаёт длину
            шага, и это главная ручка обучения: маленький η — ползём медленно;
            большой — перепрыгиваем минимум и осциллируем; слишком большой —
            улетаем в бесконечность. Заметь: чаша вытянута, и шарик скачет
            поперёк «оврага», медленно дрейфуя вдоль — это классическая беда
            градиентного спуска, ради которой придумали momentum и Adam. В
            настоящих сетях всё то же самое, только координат у w — миллиарды.
          </p>
          <p className="my-2 text-sm text-muted">
            📺 К видео: 3Blue1Brown — «Gradient descent, how neural networks
            learn» (глава 2) и Karpathy — «Zero to Hero», часть 1: цикл
            «forward → grad → w −= lr·grad».
          </p>
        </Card>
      )}
    </Layout>
  );
}
