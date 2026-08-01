// Склеить прод-сборку в один самодостаточный HTML-файл.
//
// Возможно это только потому, что в игре нет ни одного ассета: ни картинок, ни
// звуков, ни шрифтов, ни моделей. Всё, что есть, — разметка, стили и скрипт,
// значит их можно втянуть внутрь и получить файл, который играется откуда
// угодно: с флешки, из вложения, из статического хостинга без настройки.
//
// Запуск: npm run build && npm run single   →   dist/starry-ride.html
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const ASSETS = join(DIST, "assets");

const files = readdirSync(ASSETS);
const jsName = files.find((f) => f.endsWith(".js"));
const cssName = files.find((f) => f.endsWith(".css"));
if (!jsName) throw new Error("в dist/assets нет .js — сначала `npm run build`");

const js = readFileSync(join(ASSETS, jsName), "utf8");
const css = cssName ? readFileSync(join(ASSETS, cssName), "utf8") : "";

/**
 * Внутри инлайнового скрипта парсер HTML ищет литеральную последовательность
 * `</script`, где бы она ни встретилась — хоть в строке, хоть в регулярке. И
 * `<!--` тоже открывает комментарий. Экранируем оба случая: для JS это
 * равнозначный текст, для парсера — безобидный.
 */
const safe = (code) => code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no"
    />
    <meta name="theme-color" content="#04081a" />
    <meta name="color-scheme" content="dark" />
    <link
      rel="icon"
      href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌌</text></svg>"
    />
    <title>Starry Ride — ночной заезд</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${safe(js)}</script>
  </body>
</html>
`;

const out = join(DIST, "starry-ride.html");
writeFileSync(out, html);
const kb = (n) => (n / 1024).toFixed(0) + " КБ";
console.log(`${out}\n  скрипт ${kb(js.length)} + стили ${kb(css.length)} → ${kb(html.length)}`);
