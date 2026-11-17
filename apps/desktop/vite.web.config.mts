import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// Runs the renderer in a normal browser against a dev server (`npm run dev:server -w @ffgp/server`).
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [react(), tailwind()],
  server: { port: 5180, strictPort: true },
});
