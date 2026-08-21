// Сквозной прогон трекера: начать тренировку → отметить подходы → завершить →
// проверить, что запись появилась в журнале и в графиках.
// BASE_URL=http://localhost:5199 node scripts/fit-e2e.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const exe =
  process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT_DIR ?? "/tmp/fit-e2e";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 300)));

const steps = [];
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
};
const step = async (name, fn) => {
  try {
    await fn();
    steps.push(`  ok   ${name}`);
  } catch (e) {
    steps.push(`  FAIL ${name}: ${String(e).split("\n")[0].slice(0, 200)}`);
    await shot(`fail-${name.replace(/\W+/g, "-")}`);
  }
};

await page.goto(`${BASE}/#/fit`, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);

await step("экран «сегодня» открылся", async () => {
  await page.getByRole("button", { name: /Начать тренировку/i }).waitFor({ timeout: 5000 });
});
await shot("01-today");

await step("тренировка началась", async () => {
  await page.getByRole("button", { name: /Начать тренировку/i }).click();
  await page.waitForURL(/#\/fit\/run/, { timeout: 5000 });
  await page.waitForTimeout(400);
});
await shot("02-session");

await step("отметил три подхода", async () => {
  for (let i = 0; i < 3; i++) {
    const marks = page.getByRole("button", { name: /отметить подход|подход выполнен/i });
    const n = await marks.count();
    if (!n) throw new Error("кнопок отметки подхода не найдено");
    await marks.nth(Math.min(i, n - 1)).click();
    await page.waitForTimeout(250);
  }
});
await shot("03-sets-logged");

await step("таймер отдыха появился", async () => {
  await page.getByRole("status").waitFor({ timeout: 3000 });
});

await step("прошёл по всем упражнениям", async () => {
  for (let i = 0; i < 6; i++) {
    const next = page.getByRole("button", { name: /дальше/i });
    if (!(await next.count())) break;
    if (await next.first().isDisabled().catch(() => false)) break;
    await next.first().click();
    await page.waitForTimeout(200);
  }
});
await shot("04-last-exercise");

await step("экран завершения", async () => {
  await page.getByRole("button", { name: /Завершить тренировку/i }).click();
  await page.waitForTimeout(500);
});
await shot("05-finish");

await step("тренировка сохранена", async () => {
  await page.getByRole("button", { name: /^Сохранить/i }).click();
  await page.waitForTimeout(600);
});

await step("запись видна в журнале", async () => {
  await page.goto(`${BASE}/#/fit/history`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const txt = await page.textContent("body");
  if (/пока пусто|ещё нет|нет тренировок/i.test(txt ?? "")) {
    throw new Error("журнал пуст после сохранения");
  }
});
await shot("06-history");

await step("прогресс рисуется", async () => {
  await page.goto(`${BASE}/#/fit/progress`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  if (!(await page.locator("svg").count())) throw new Error("нет ни одного графика");
});
await shot("07-progress");

await step("правка плана переживает перезагрузку", async () => {
  await page.goto(`${BASE}/#/fit/plan`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const name = page.locator('input[type="text"]').first();
  await name.fill("День проверки");
  await name.blur();
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const v = await page.locator('input[type="text"]').first().inputValue();
  if (v !== "День проверки") throw new Error(`после перезагрузки: "${v}"`);
});
await shot("08-plan");

// горизонтальный скролл на телефоне недопустим ни на одном экране
for (const r of ["", "plan", "library", "history", "progress", "settings"]) {
  await step(`нет горизонтального скролла: /${r || "today"}`, async () => {
    await page.goto(`${BASE}/#/fit${r ? "/" + r : ""}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (over > 1) throw new Error(`шире окна на ${over}px`);
  });
}

console.log(steps.join("\n"));
console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
const failed = steps.filter((s) => s.includes("FAIL")).length;
console.log(failed ? `\nПРОВАЛЕНО ШАГОВ: ${failed}` : "\nвсе шаги прошли");
await browser.close();
process.exit(failed ? 1 : 0);
