import { defineConfig, devices } from "@playwright/test";

const isCI = process.env.CI !== undefined;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4337/",
    trace: "on-first-retry",
  },
  webServer: {
    command: "corepack pnpm build && corepack pnpm preview --host 127.0.0.1 --port 4337",
    url: "http://127.0.0.1:4337/",
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
