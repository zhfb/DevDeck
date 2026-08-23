import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "on-first-retry",
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH || process.platform === "darwin"
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
      : undefined,
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
