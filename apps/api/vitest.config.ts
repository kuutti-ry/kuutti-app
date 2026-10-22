import { defineConfig } from "vitest/config";

// Vitest owns apps/api and packages/*. React Native components use jest-expo.
// Tests run against a real Postgres: DATABASE_URL, or the local default in the harness.
export default defineConfig({
  test: {
    // The command lines under scripts/ have tests of their own (#73).
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./src/test/global-setup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 15_000,
    // `pnpm test:coverage`; CI's compose job runs it with every service up.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      // The command entries and the server's process shell (src/index.ts) run
      // as processes of their own, which coverage of the test workers cannot
      // see; they are tested by spawning them, the boot itself in boot.test.ts.
      // The libvips gathering's needs the network and is the maintainer's to
      // run; what it does is scripts/notices/libvips.ts, tested on fixtures (#421).
      exclude: [
        "**/*.test.ts",
        "src/test/**",
        "src/index.ts",
        "scripts/demo-*.ts",
        "scripts/notices.ts",
        "scripts/notices-libvips.ts",
        "scripts/openapi.ts",
      ],
      reporter: ["text", "json-summary"],
      // ADR-021's floors, just below what the API reached on 2026-10-11
      // (#235); identity's is the strictest: the hetu, session and erasure
      // code, where a branch nobody ran is a branch nobody checked.
      thresholds: {
        branches: 95,
        lines: 99,
        functions: 99,
        statements: 99,
        "src/identity/**": { branches: 94, lines: 99, functions: 100, statements: 98 },
      },
    },
  },
});
