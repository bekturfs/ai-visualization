// Долгий прогон симуляции без браузера.
//
// Зачем: в headless всё рисует SwiftShader, игровое время идёт всемеро медленнее
// реального, и доехать до третьей главы неба в браузере — минут двадцать. А
// логика игры (`engine.ts` + `worldGen.ts`) не знает ни про React, ни про
// Three.js: это чистые функции над одним объектом. Значит её можно прогнать в
// node за секунду и проверить то, что скриншотом не проверишь: что главы
// действительно сменяют друг друга по дистанции, что за сотню километров нигде
// не заводится NaN, что пулы не переполняются, что заезд воспроизводим и что
// частота кадров не влияет на результат.
//
// Запуск: npm run soak
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "soak-"));
const bundle = join(tmp, "sim.mjs");

await build({
  stdin: {
    contents: `
      export * from ${JSON.stringify(join(root, "src/game/engine.ts"))};
      export { ensureWorld, resetWorld } from ${JSON.stringify(join(root, "src/game/worldGen.ts"))};
      export { PHYS, SKY, LIMITS, ROAD } from ${JSON.stringify(join(root, "src/game/config.ts"))};
    `,
    resolveDir: root,
    loader: "ts",
  },
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "warning",
});

const sim = await import(bundle);
const {
  createGame,
  startRun,
  step,
  snapshot,
  setWorldHook,
  ensureWorld,
  resetWorld,
  PHYS,
  SKY,
  LIMITS,
  ROAD,
} = sim;

setWorldHook(ensureWorld);

const problems = [];
const fail = (msg) => problems.push(msg);

/** Простейший автопилот: держимся центра ближайшей своей полосы. */
function drive(g) {
  const target = g.x > (ROAD.laneCenters[0] + ROAD.laneCenters[1]) / 2
    ? ROAD.laneCenters[1]
    : ROAD.laneCenters[0];
  g.input.steer = Math.max(-1, Math.min(1, (target - g.x) * 0.8 - g.vx * 0.35));
  g.input.throttle = 1;
  g.input.brake = 0;
  g.input.nitro = g.nitro > 0.6;
}

/**
 * Прогнать заезд на `seconds` игровых секунд с шагом `dt`.
 *
 * `autopilot: false` замораживает ввод. Это нужно, чтобы отделить физику от
 * управления: автопилот опрашивается раз в кадр, поэтому на 240 Гц он подруливает
 * в восемь раз чаще, чем на 30 Гц, и расходятся тогда траектории, а не движок.
 */
function run(seconds, dt, seed, { immortal = true, collect = null, autopilot = true } = {}) {
  const g = createGame({ seed, quality: 1, best: 0, muted: true });
  startRun(g);
  resetWorld(g);
  if (!autopilot) {
    g.input.steer = 0;
    g.input.throttle = 1;
    g.input.brake = 0;
    g.input.nitro = false;
  }
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    if (autopilot) drive(g);
    step(g, dt);
    g.events.length = 0;
    if (immortal && g.lives < 3) g.lives = 3;
    if (immortal && g.phase === "over") {
      // до конца заезда доводить не хотим — нам нужна дистанция
      g.phase = "playing";
      g.lives = 3;
    }
    if (collect) collect(g, i);
  }
  return g;
}

/* ---------- 1. главы неба действительно сменяются ---------- */

const seen = [];
let badT = 0;
const g1 = run(1200, 1 / 60, 12345, {
  collect: (g) => {
    if (g.chapterT < 0 || g.chapterT > 1 || Number.isNaN(g.chapterT)) badT++;
    if (seen[seen.length - 1] !== g.chapter) seen.push(g.chapter);
  },
});
const expectedCycle = SKY.chapters.length;
console.log(
  `главы за ${Math.round(g1.s / 1000)} км: ${seen.slice(0, 12).join(" → ")}${seen.length > 12 ? " …" : ""}`,
);
if (seen.length < 5) fail(`за ${Math.round(g1.s)} м сменилось всего ${seen.length} глав — небо стоит на месте`);
for (let i = 1; i < seen.length; i++) {
  if (seen[i] !== seen[i - 1] + 1) fail(`главы идут не подряд: ${seen[i - 1]} → ${seen[i]}`);
}
if (badT) fail(`chapterT выходил за [0,1] ${badT} раз`);
console.log(`  цикл неба — ${expectedCycle} главы, дальше повтор со сдвигом`);

/* ---------- 2. ничего не разъезжается на длинной дистанции ---------- */

const finite = (g) => {
  for (const k of ["s", "speed", "x", "vx", "steer", "yaw", "roll", "bob", "nitro", "score", "multiplier", "chapterT"]) {
    if (!Number.isFinite(g[k])) return k;
  }
  for (const c of g.cars) if (!Number.isFinite(c.s) || !Number.isFinite(c.lane)) return "car";
  for (const p of g.pickups) if (!Number.isFinite(p.s) || !Number.isFinite(p.lane)) return "pickup";
  return null;
};

let worstCars = 0;
let worstPickups = 0;
let nan = null;
const g2 = run(3600, 1 / 60, 777, {
  collect: (g, i) => {
    if (i % 120 !== 0) return;
    if (!nan) nan = finite(g);
    worstCars = Math.max(worstCars, g.cars.filter((c) => c.active).length);
    worstPickups = Math.max(worstPickups, g.pickups.filter((p) => p.active).length);
  },
});
console.log(
  `час езды: ${(g2.s / 1000).toFixed(1)} км, ${Math.round(g2.score).toLocaleString("ru")} очков, ` +
    `пик машин ${worstCars}/${LIMITS.cars}, бонусов ${worstPickups}/${LIMITS.pickups}`,
);
if (nan) fail(`через час пути поле «${nan}» перестало быть числом`);
if (worstCars > LIMITS.cars) fail(`активных машин больше пула: ${worstCars} > ${LIMITS.cars}`);
if (worstPickups > LIMITS.pickups) fail(`активных бонусов больше пула: ${worstPickups} > ${LIMITS.pickups}`);
if (g2.speed > PHYS.speedMax + PHYS.nitroBoost + 1) fail(`скорость ушла за потолок: ${g2.speed.toFixed(1)} м/с`);

/* ---------- 3. заезд воспроизводим ---------- */

const a = run(300, 1 / 60, 4242);
const b = run(300, 1 / 60, 4242);
const sameRun =
  Math.abs(a.s - b.s) < 1e-6 && Math.abs(a.score - b.score) < 1e-6 && a.chapter === b.chapter;
console.log(`воспроизводимость: ${sameRun ? "да" : "НЕТ"} (${a.s.toFixed(3)} м против ${b.s.toFixed(3)} м)`);
if (!sameRun) fail("один и тот же сид дал разные заезды");

/* ---------- 4. частота кадров не меняет игру ---------- */

// Сначала честная проверка движка: ввод заморожен, отличается только длина кадра.
const pSlow = run(300, 1 / 30, 999, { autopilot: false });
const pFast = run(300, 1 / 240, 999, { autopilot: false });
const pDrift = Math.abs(pSlow.s - pFast.s);
const pPct = (pDrift / pSlow.s) * 100;
console.log(
  `физика, ввод заморожен, 30 Гц против 240 Гц за 5 минут: ` +
    `${pSlow.s.toFixed(1)} м против ${pFast.s.toFixed(1)} м — ${pDrift.toFixed(2)} м (${pPct.toFixed(3)} %)`,
);
if (pPct > 0.1) fail(`физика зависит от частоты кадров: расхождение ${pPct.toFixed(2)} %`);

// А теперь с автопилотом — здесь расхождение ожидаемо и живёт в управлении:
// частота опроса ввода равна частоте кадров, как и в настоящей игре.
const slow = run(300, 1 / 30, 999);
const fast = run(300, 1 / 240, 999);
const driftPct = (Math.abs(slow.s - fast.s) / slow.s) * 100;
console.log(
  `с автопилотом (ввод опрашивается раз в кадр): ${slow.s.toFixed(0)} м против ` +
    `${fast.s.toFixed(0)} м — ${driftPct.toFixed(2)} %, это управление, не движок`,
);
if (driftPct > 4) fail(`даже с поправкой на управление расхождение великовато: ${driftPct.toFixed(1)} %`);

/* ---------- 5. сложность действительно растёт ---------- */

const early = snapshot(run(30, 1 / 60, 31337)).speedKmh;
const late = snapshot(run(600, 1 / 60, 31337)).speedKmh;
console.log(`разгон: ${early} км/ч на тридцатой секунде → ${late} км/ч на десятой минуте`);
if (late <= early) fail("скорость со временем не растёт — рампы сложности нет");

/* ---------- итог ---------- */

rmSync(tmp, { recursive: true, force: true });
console.log("\nПРОБЛЕМЫ:", problems.length ? problems : "нет");
process.exit(problems.length ? 1 : 0);
