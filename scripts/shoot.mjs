// Скриншоты всех страниц + сбор ошибок консоли (для ручной проверки вёрстки).
import { chromium } from "playwright-core";

const BASE = "http://localhost:4173";
const exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const shots = [
  { name: "home", url: "/#/", wait: 1200 },
  { name: "neuron-story", url: "/#/neuron", wait: 1200 },
  { name: "forward-story", url: "/#/forward-pass", wait: 1200 },
  { name: "gd-story", url: "/#/gradient-descent", wait: 2500 },
  { name: "backprop-story", url: "/#/backpropagation", wait: 1200 },
];

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({
  viewport: { width: 1380, height: 940 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 300)));

for (const s of shots) {
  await page.goto(BASE + s.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(s.wait);
  await page.screenshot({ path: `/tmp/shots/${s.name}.png`, fullPage: true });
  console.log("shot:", s.name);
}

// прокликаем историю нейрона до песочницы
await page.goto(BASE + "/#/neuron", { waitUntil: "networkidle" });
for (let i = 0; i < 7; i++) {
  await page.getByRole("button", { name: /Дальше|В песочницу/ }).click();
  await page.waitForTimeout(250);
}
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/shots/neuron-sandbox.png", fullPage: true });
console.log("shot: neuron-sandbox");

// forward: песочница + волна + клик по нейрону
await page.goto(BASE + "/#/forward-pass", { waitUntil: "networkidle" });
await page.getByText("пропустить → песочница").click();
await page.getByRole("button", { name: "▶ Прогнать волну" }).click();
await page.waitForTimeout(2300);
await page.locator("svg circle").nth(3).click({ force: true });
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/shots/forward-sandbox.png", fullPage: true });
console.log("shot: forward-sandbox");

// gd: песочница, несколько шагов
await page.goto(BASE + "/#/gradient-descent", { waitUntil: "networkidle" });
await page.getByText("пропустить → песочница").click();
await page.waitForTimeout(1500);
for (let i = 0; i < 6; i++) {
  await page.getByRole("button", { name: "Шаг", exact: true }).click();
  await page.waitForTimeout(280);
}
await page.waitForTimeout(900);
await page.screenshot({ path: "/tmp/shots/gd-sandbox.png", fullPage: true });
console.log("shot: gd-sandbox");

// backprop: песочница, forward + backward + обучение
await page.goto(BASE + "/#/backpropagation", { waitUntil: "networkidle" });
await page.getByText("пропустить → песочница").click();
await page.getByRole("button", { name: "Forward →" }).click();
await page.waitForTimeout(3300);
await page.getByRole("button", { name: "← Backward" }).click();
await page.waitForTimeout(6200);
for (let i = 0; i < 4; i++) {
  await page.getByRole("button", { name: "⟳ Шаг обучения" }).click();
  await page.waitForTimeout(200);
}
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/shots/backprop-sandbox.png", fullPage: true });
console.log("shot: backprop-sandbox");

console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
await browser.close();
