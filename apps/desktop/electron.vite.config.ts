import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const version = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version as string;

// Everything (server, Fastify, shared logic) is bundled into main, so the packaged app needs no node_modules.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: { external: ["electron", /^node:/] },
    },
  },
  preload: {
    build: { externalizeDeps: false, rollupOptions: { external: ["electron"], output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
    plugins: [react(), tailwind()],
    define: { __APP_VERSION__: JSON.stringify(version) },
  },
});
