// Builds the deployable Fleetfix Cloud: deploy/cloud/{server.mjs, web/, package.json} and a zip of it.
// Usage: npm run package -w @ffgp/cloud
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "deploy", "cloud");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

execFileSync("npm", ["run", "web:cloud", "-w", "@ffgp/desktop"], { cwd: root, stdio: "inherit" });
cpSync(join(root, "apps/desktop/dist-web"), join(out, "web"), { recursive: true });

await build({
  entryPoints: [join(root, "apps/cloud/src/start.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Everything (Fastify, Zod, the garage server) goes into one file, so the host needs no npm install.
  external: ["node:*"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: "none",
  logLevel: "info",
});

const version = JSON.parse(execFileSync("node", ["-p", "JSON.stringify(require('./package.json').version)"], { cwd: root }).toString());
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "fleetfix-cloud",
      version,
      private: true,
      type: "module",
      main: "server.mjs",
      engines: { node: ">=24" },
      scripts: { build: "node -e \"console.log('Fleetfix Cloud is prebuilt')\"", start: "node server.mjs" },
    },
    null,
    2,
  ),
);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
const zip = join(root, "deploy", `fleetfix-cloud_${stamp}.zip`);
execFileSync("zip", ["-qr", zip, "."], { cwd: out });
console.log(`Packaged ${out}\n        → ${zip}`);
