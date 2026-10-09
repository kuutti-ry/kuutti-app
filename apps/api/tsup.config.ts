import { defineConfig } from "tsup";

// One runnable file per command. Everything except Node built-ins is bundled,
// so the runtime image carries dist/index.js, the demo commands of ADR-018
// beside it (each a file of its own: nothing of the demo is on the API's own
// import graph, ADR-014 §10), the migrations folder and sharp's native binary,
// nothing else. pg-native is an optional native binding pg probes for;
// pino-pretty is dev only; @img/* are sharp's prebuilt libvips and addon for
// the platform (#48), which a bundler cannot inline and the Dockerfile copies.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "demo-stories": "scripts/demo-stories.ts",
    "demo-population": "scripts/demo-population.ts",
    "demo-reset": "scripts/demo-reset.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: false,
  noExternal: [/.*/],
  external: ["pg-native", "pino-pretty", /^@img\//],
  sourcemap: true,
  clean: true,
  minify: false,
  // CommonJS dependencies (pg, pino) call require() at runtime; an ESM bundle has
  // none unless one is created from the bundle's own location.
  // Aliased: sharp's own ESM imports createRequire too, and two top-level
  // bindings of the same name would not compile.
  banner: {
    js: 'import { createRequire as __kuuttiCreateRequire } from "node:module"; const require = __kuuttiCreateRequire(import.meta.url);',
  },
});
