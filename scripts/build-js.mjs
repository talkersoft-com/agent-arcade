// Bundles the renderer entrypoints with esbuild.
//   studio/src/main.jsx -> studio/dist/studio.js  (React, JSX, IIFE)
//   arcade/src/main.js  -> arcade/dist/arcade.js  (vanilla, IIFE)
// Run via `npm run build:js`.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prod = process.env.NODE_ENV === "production";

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(root, "studio/src/main.jsx")],
    outfile: resolve(root, "studio/dist/studio.js"),
    loader: { ".js": "jsx", ".jsx": "jsx" },
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": JSON.stringify(prod ? "production" : "development"),
    },
  }),
  build({
    ...common,
    entryPoints: [resolve(root, "arcade/src/main.js")],
    outfile: resolve(root, "arcade/dist/arcade.js"),
  }),
]);
