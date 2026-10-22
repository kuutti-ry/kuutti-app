/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
