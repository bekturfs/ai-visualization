import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// base: "./" — собранный сайт работает из любого подкаталога (GitHub Pages и т.п.)
//
// Плагина React здесь больше нет: игра — обычный Three.js и обычный DOM.
export default defineConfig({
  base: "./",
  plugins: [tailwindcss()],
  build: {
    // Физика на rapier весит больше, чем вся остальная сборка, и в первую
    // секунду не нужна: она уезжает отдельным чанком по динамическому импорту.
    chunkSizeWarningLimit: 2600,
  },
});
