import { defineConfig, devices } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./output/playwright/test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: {
    timeout: 8_000
  },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: "npm start",
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: "4173",
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      AUTH_SECRET: "e2e-auth-secret-9f6bd467f2c4412fa4097c32285fb3f5",
      PRESENTER_EMAIL: "e2e@example.test",
      PRESENTER_PASSWORD: "e2e-strong-password-4f2c8d1a",
      DATABASE_URL: "",
      PUBLIC_ORIGIN: BASE_URL,
      ALLOW_INSECURE_LOCAL_AUTH: "true"
    }
  },
  projects: [
    {
      name: "desktop-presenter",
      testMatch: "**/*.desktop.spec.mjs",
      use: {
        ...devices["Desktop Chrome"]
      }
    },
    {
      name: "mobile-player",
      testMatch: "**/*.mobile.spec.mjs",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium"
      }
    }
  ]
});
