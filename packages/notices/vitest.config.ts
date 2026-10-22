import { defineConfig } from "vitest/config";

// No network: every test reads package directories it writes under the
// system's temporary directory.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // `pnpm test:coverage`.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      // ADR-021's floor, at what the package reached when it was written (#416).
      thresholds: { branches: 100, lines: 100, functions: 100, statements: 100 },
    },
  },
});
