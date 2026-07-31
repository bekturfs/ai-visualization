// Прогон игры «Starry Ride» в настоящем браузере: кадры, ошибки консоли, FPS.
//
// Зачем отдельно от shoot.mjs: игре нужен живой WebGL, длинный заезд (главы неба
// меняются по дистанции, а не по времени) и проверка тача на узком экране.
//
// Переменные окружения:
//   BASE_URL   — адрес запущенного `npm run preview` (по умолчанию :4173)
//   CHROME_PATH — бинарь Chromium
//   OUT_DIR    — куда класть кадры
//   QUICK=1    — короткий прогон (без ожидания далёких глав неба)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const EXE =
  process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT_DIR ?? "/tmp/ride-shots";
const QUICK = process.env.QUICK === "1";
mkdirSync(OUT, { recursive: true });

// Программный WebGL: в headless нет настоящей видеокарты, рендерим через SwiftShader.
const browser = await chromium.launch({
  executablePath: EXE,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const problems = [];
/** Открыть страницу и подписаться на всё, что может пойти не так. */
async function openPage(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on("console", (m) => {
    if (m.type() === "error") problems.push("CONSOLE: " + m.text().slice(0, 400));
  });
  page.on("pageerror", (e) => problems.push("PAGEERROR: " + String(e).slice(0, 400)));
  page.on("requestfailed", (r) => {
    const u = r.url();
    // data:-урлы и favicon не интересны
    if (!u.startsWith("data:") && !u.includes("favicon")) {
      problems.push(`REQFAIL: ${u.slice(0, 160)} — ${r.failure()?.errorText}`);
    }
  });
  return page;
}

const shot = (page, name) =>
  page.screenshot({ path: `${OUT}/${name}.png` }).then(() => console.log("shot:", name));

/** Средний FPS за `ms` миллисекунд, замеренный внутри страницы. */
function measureFps(page, ms) {
  return page.evaluate(
    (d) =>
      new Promise((res) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < d) requestAnimationFrame(tick);
          else res(Math.round((frames * 1000) / (performance.now() - t0)));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/** Живое состояние игры, если страница его выставила (см. Ride.tsx). */
const probe = (page) =>
  page.evaluate(() => {
    const g = globalThis.__ride;
    if (!g) return null;
    return {
      phase: g.phase,
      s: Math.round(g.s),
      speed: +g.speed.toFixed(1),
      x: +g.x.toFixed(2),
      score: Math.round(g.score),
      lives: g.lives,
      chapter: g.chapter,
      nitro: +g.nitro.toFixed(2),
      cars: g.cars.filter((c) => c.active).length,
      pickups: g.pickups.filter((p) => p.active).length,
      events: g.events.length,
    };
  });

const press = async (page, code, ms) => {
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
};

/* ---------------- десктоп ---------------- */

const page = await openPage({ width: 1380, height: 860 });
await page.goto(`${BASE}/#/ride`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await shot(page, "01-menu");

// WebGL действительно поднялся?
const gl = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  if (!c) return "НЕТ CANVAS";
  const ctx = c.getContext("webgl2") ?? c.getContext("webgl");
  if (!ctx) return "НЕТ WEBGL-КОНТЕКСТА";
  const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
  return dbg ? String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "webgl ok";
});
console.log("webgl:", gl);
if (gl.startsWith("НЕТ")) problems.push("WEBGL: " + gl);

// старт заезда
const startBtn = page.getByRole("button", { name: /поехали/i });
if (await startBtn.count()) await startBtn.first().click();
else {
  problems.push("UI: кнопки «поехали» нет — стартую с клавиатуры");
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(1800);
await shot(page, "02-drive");
console.log("state:", JSON.stringify(await probe(page)));

// руление вправо, потом влево — видно ли реакцию руля и крена
await press(page, "ArrowRight", 900);
await shot(page, "03-steer-right");
await press(page, "ArrowLeft", 1200);
await shot(page, "04-steer-left");

// нитро
await page.keyboard.down("Space");
await page.waitForTimeout(1100);
await shot(page, "05-nitro");
await page.keyboard.up("Space");

console.log("fps (десктоп, заезд):", await measureFps(page, 3000));

// длинный заезд: ждём смены глав неба (они по дистанции, ~1200 м на главу)
const marks = QUICK ? [6000] : [8000, 14000, 20000, 26000];
let i = 6;
for (const ms of marks) {
  await page.waitForTimeout(ms);
  const st = await probe(page);
  console.log("state:", JSON.stringify(st));
  await shot(page, `${String(i).padStart(2, "0")}-sky-ch${st ? st.chapter : "?"}`);
  i++;
}

// пауза
await page.keyboard.press("Escape");
await page.waitForTimeout(700);
await shot(page, `${String(i++).padStart(2, "0")}-paused`);
console.log("state (пауза):", JSON.stringify(await probe(page)));
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// вываливаемся на встречку, пока не кончатся жизни — проверяем аварию и «конец»
for (let a = 0; a < 40; a++) {
  const st = await probe(page);
  if (!st || st.phase === "over") break;
  await press(page, "ArrowLeft", 1400);
  await page.waitForTimeout(600);
}
await shot(page, `${String(i++).padStart(2, "0")}-crash-or-over`);
console.log("state (после таранов):", JSON.stringify(await probe(page)));

/* ---------------- мобильный портрет ---------------- */

const m = await openPage({ width: 390, height: 844 });
await m.goto(`${BASE}/#/ride`, { waitUntil: "networkidle" });
await m.waitForTimeout(2500);
await shot(m, "20-mobile-menu");
const mStart = m.getByRole("button", { name: /поехали/i });
if (await mStart.count()) await mStart.first().click();
await m.waitForTimeout(2500);
await shot(m, "21-mobile-drive");
console.log("fps (мобильный портрет):", await measureFps(m, 2500));
console.log("state (мобильный):", JSON.stringify(await probe(m)));

// горизонтальная прокрутка на узком экране — верный признак сломанной вёрстки
const overflow = await m.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
if (overflow > 1) problems.push(`ВЁРСТКА: горизонтальная прокрутка ${overflow}px на 390px`);

/* ---------------- остальные страницы не сломались? ---------------- */

const home = await openPage({ width: 1380, height: 860 });
await home.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
await home.waitForTimeout(1200);
await shot(home, "30-home");

console.log("\nПРОБЛЕМЫ:", problems.length ? problems : "нет");
await browser.close();
process.exit(problems.length ? 1 : 0);
