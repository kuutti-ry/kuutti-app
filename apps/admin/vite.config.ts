/// <reference types="vitest/config" />
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import saiga from "../../scripts/saiga.json" with { type: "json" };

/**
 * Saiga in the dev server (ADR-052): styles.css names /fonts/saiga-<version>/,
 * which a deployed panel's bucket holds and the dev server answers from
 * ~/.cache/kuutti-fonts, where `pnpm fonts` put it, to this computer alone.
 * Never in the project, so no build carries the files.
 */
function saigaInDev(): Plugin {
  const dir = join(homedir(), ".cache", "kuutti-fonts", `saiga-${saiga.version}`, "WOFF2");
  const files = new Set(saiga.faces.map(({ name }) => `${name}.woff2`));
  const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  // A tunnel or a port forwarder also arrives on loopback: it names another host or says it forwards.
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const fromThisComputer = (req: import("node:http").IncomingMessage): boolean =>
    loopback.has(req.socket.remoteAddress ?? "") &&
    localHosts.has((req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase()) &&
    ["forwarded", "x-forwarded-for", "x-forwarded-host"].every((name) => !(name in req.headers));
  return {
    name: "kuutti-saiga",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(`/fonts/saiga-${saiga.version}`, (req, res) => {
        const file = (req.url ?? "").split("?")[0]?.slice(1) ?? "";
        const local = join(dir, file);
        if (!files.has(file) || !fromThisComputer(req) || !existsSync(local)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "font/woff2");
        createReadStream(local).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Tailwind compiles src/styles.css into the build's one stylesheet (ADR-050).
  plugins: [react(), tailwindcss(), saigaInDev()],
  build: {
    outDir: "dist",
    sourcemap: true,
    // Every asset a file of its own: Vite would inline one under 4 KB as a
    // data: URL, which the host's CSP refuses (img-src 'self' and the API's
    // origin, ADR-025 §3).
    assetsInlineLimit: 0,
    // The copyright lines and licence texts of the bundled packages (#416), at
    // the build's root: not Vite's default .vite/license.md, since
    // upload-artifact leaves hidden directories behind and the host answers a
    // missing key with the panel's index.html. The deploys upload it uncached,
    // a fixed name being no immutable asset; the footer links it.
    license: { fileName: "licenses.txt" },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // `pnpm test:coverage`. main.tsx only mounts the app into the page.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text", "json-summary"],
      // ADR-021's floor, just below what the panel reached on 2026-10-11 (#235).
      thresholds: { branches: 97, lines: 98, functions: 95, statements: 98 },
    },
  },
});
