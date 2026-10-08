import { defineConfig } from "vitest/config";

// No network and no database: the Telia dialect runs against the in-process
// double; the one test that talks to the mock IdP of docker compose skips
// itself when the mock is not up.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
