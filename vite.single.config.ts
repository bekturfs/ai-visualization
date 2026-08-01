import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

/**
 * Сборка для `npm run single` — всё одним куском.
 *
 * Обычная сборка уводит физику в отдельный чанк по динамическому импорту: она
 * весит больше всей остальной игры и в первую секунду не нужна. Но файл,
 * который открывают с диска или из вложения, догрузить чанк не может — там
 * некуда сходить. Поэтому здесь `inlineDynamicImports`: один вход, один выход,
 * ничего не подгружается.
 */
export default defineConfig({
  base: "./",
  plugins: [tailwindcss()],
  build: {
    outDir: "dist-single",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
