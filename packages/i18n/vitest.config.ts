import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `pnpm test:coverage`.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts", "src/generated/**"],
      reporter: ["text", "json-summary"],
      // ADR-021's floor, just below what the package reached on 2026-10-11 (#235).
      thresholds: { branches: 96, lines: 99, functions: 99, statements: 99 },
    },
  },
});
