import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `pnpm test:coverage`; api.generated.ts is `pnpm openapi`'s output, types only.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/api.generated.ts"],
      reporter: ["text", "json-summary"],
      // ADR-021's floor, just below what the package reached on 2026-10-11 (#235).
      thresholds: { branches: 99, lines: 99, functions: 99, statements: 99 },
    },
  },
});
