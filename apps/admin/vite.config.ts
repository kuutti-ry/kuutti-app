/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
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
