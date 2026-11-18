import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// The renderer as a website: `npm run web` (dev, against `npm run dev:server -w @ffgp/server`), and
// `npm run web:cloud` (the Fleetfix Cloud browser app, built to dist-web and served by @ffgp/cloud).
export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer"),
  envDir: import.meta.dirname,
  plugins: [react(), tailwind()],
  server: { port: 5180, strictPort: true },
  build: {
    outDir: resolve(import.meta.dirname, "dist-web"),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(import.meta.dirname, "src/renderer/index.html") } },
  },
});
