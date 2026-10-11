import { defineConfig } from "vitest/config";

// No network and no database: the Telia dialect runs against the in-process
// double; the one test that talks to the mock IdP of docker compose skips
// itself when the mock is not up.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    // `pnpm test:coverage`; CI's compose job runs it with the mock IdP up.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      // ADR-021's floor, just below what the kit reached on 2026-10-11 (#235):
      // identity's level, since the kit is the bank login.
      thresholds: { branches: 94, lines: 99, functions: 100, statements: 98 },
    },
  },
});
