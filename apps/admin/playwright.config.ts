import { defineConfig, devices } from "@playwright/test";

// The panel's end-to-end flows (#106, ADR-051). `pnpm e2e:admin` (e2e/run.ts) starts the stack
// they run against and hands over its addresses; `playwright test` alone has none and says so
// (e2e/fixtures.ts). One worker: the flows share one database and one moderator, and each
// leaves what it decided behind.

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.out/results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "e2e/.out/report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: process.env.E2E_PANEL_URL,
    // The panel is English only (TD-17) and says times in Finland's zone.
    locale: "en-GB",
    timezoneId: "Europe/Helsinki",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
