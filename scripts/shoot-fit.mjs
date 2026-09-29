// Скриншоты разделов трекера тренировок на мобильном вьюпорте + ошибки консоли.
// Использование: BASE_URL=http://localhost:5199 node scripts/shoot-fit.mjs [маршрут ...]
// Без аргументов снимает все разделы.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const exe =
  process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.OUT_DIR ?? "/tmp/fit-shots";
mkdirSync(OUT, { recursive: true });

const DEFAULT = ["", "plan", "library", "history", "progress", "settings"];
const routes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;

const browser = await chromium.launch({ executablePath: exe });
// по умолчанию — телефон; VIEWPORT=1500x1000 для широкой раскладки
const [vw, vh] = (process.env.VIEWPORT ?? "390x844").split("x").map(Number);
const mobile = vw <= 640;
const page = await browser.newPage({
  viewport: { width: vw, height: vh },
  deviceScaleFactor: mobile ? 2 : 1,
  isMobile: mobile,
  hasTouch: mobile,
});
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 300)));

for (const r of routes) {
  const url = `${BASE}/#/fit${r ? "/" + r : ""}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const name = r || "today";
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  console.log(`shot: ${name}${wide ? "  ⚠ горизонтальный скролл" : ""}`);
}

console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
await browser.close();
