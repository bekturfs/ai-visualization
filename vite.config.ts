import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base: "./" — собранный сайт работает из любого подкаталога (GitHub Pages и т.п.)
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
