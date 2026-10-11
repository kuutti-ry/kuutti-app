import { defineConfig } from "vitest/config";

// Tests run against a real Postgres: DATABASE_URL, or the local default in src/test.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // `pnpm test:coverage`; CI's compose job runs it.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      // ADR-021's floor, just below what the package reached on 2026-10-11 (#235).
      thresholds: { branches: 95, lines: 99, functions: 98, statements: 98 },
    },
  },
});
