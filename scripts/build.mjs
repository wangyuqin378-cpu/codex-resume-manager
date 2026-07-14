import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(path.join(dist, "resources"), { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(root, "src/main/main.ts")],
    outfile: path.join(dist, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: false,
  }),
  build({
    entryPoints: [path.join(root, "src/main/preload.ts")],
    outfile: path.join(dist, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: false,
  }),
  build({
    entryPoints: [path.join(root, "src/renderer/app.ts")],
    outfile: path.join(dist, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    sourcemap: false,
  }),
]);

await Promise.all([
  cp(path.join(root, "src/renderer/index.html"), path.join(dist, "index.html")),
  cp(path.join(root, "src/renderer/styles.css"), path.join(dist, "styles.css")),
  cp(
    path.join(root, "resources/trayTemplate.svg"),
    path.join(dist, "resources/trayTemplate.svg"),
  ),
]);
