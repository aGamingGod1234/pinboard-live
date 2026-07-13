import { defineConfig, devices } from "@playwright/test";

const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
const DEFAULT_HTTP_PORT = "80";
const MAX_PORT = 65_535;
const MIN_PORT = 1;
const REUSE_SERVER_VALUE = "true";

function environmentValue(name) {
  return process.env[name]?.trim() ?? "";
}

function resolveE2eUrl() {
  const configuredBaseUrl = environmentValue("E2E_BASE_URL") || DEFAULT_BASE_URL;
  let url;

  try {
    url = new URL(configuredBaseUrl);
  } catch (error) {
    throw new Error(`E2E_BASE_URL must be a valid absolute URL: ${configuredBaseUrl}`, { cause: error });
  }

  if (url.protocol !== "http:") {
    throw new Error(`E2E_BASE_URL must use http for the local test server: ${configuredBaseUrl}`);
  }

  const configuredPort = environmentValue("E2E_PORT");
  if (configuredPort) {
    const port = Number(configuredPort);
    if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw new Error(`E2E_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}: ${configuredPort}`);
    }
    url.port = configuredPort;
  }

  return url;
}

const e2eUrl = resolveE2eUrl();
const BASE_URL = e2eUrl.origin;
const SERVER_PORT = e2eUrl.port || DEFAULT_HTTP_PORT;
const REUSE_EXISTING_SERVER = environmentValue("E2E_REUSE_EXISTING_SERVER") === REUSE_SERVER_VALUE;

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
    reuseExistingServer: REUSE_EXISTING_SERVER,
    timeout: 30_000,
    env: {
      PORT: SERVER_PORT,
      HOST: e2eUrl.hostname,
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
