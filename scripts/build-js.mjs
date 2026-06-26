// Bundles the renderer entrypoints with esbuild.
//   studio/src/main.jsx -> studio/dist/studio.js  (React, JSX, IIFE)
//   arcade/src/main.js  -> arcade/dist/arcade.js  (vanilla, IIFE)
// Run via `npm run build:js`  (one-shot)
//      or `npm run build:js -- --watch`  (rebuild on save — dev hot-reload).
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prod = process.env.NODE_ENV === "production";
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
};

const configs = [
  {
    ...common,
    entryPoints: [resolve(root, "studio/src/main.jsx")],
    outfile: resolve(root, "studio/dist/studio.js"),
    // `.css` → text: the stylesheet is imported as a string and injected as a
    // <style> tag at runtime (renderer/index.html only loads studio.js). Keeps the
    // single-bundle contract while reusing the reference's CSS verbatim.
    loader: { ".js": "jsx", ".jsx": "jsx", ".css": "text" },
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development"),
    },
  },
  {
    ...common,
    entryPoints: [resolve(root, "arcade/src/main.js")],
    outfile: resolve(root, "arcade/dist/arcade.js"),
  },
];

if (watch) {
  // Watch mode: rebuild dist/* on every source save. Paired with electron-reloader
  // (active when running from source), the renderer reloads automatically.
  const ctxs = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("[build-js] watching studio/ + arcade/ for changes — edit and save to rebuild.");
} else {
  await Promise.all(configs.map((c) => build(c)));
}
