import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { after, before, test } from "node:test";

const TEST_EMAIL = "hardening@example.test";
const TEST_PASSWORD = "hardening-password-123";
const JSON_HEADERS = { "Content-Type": "application/json" };

let baseUrl;
let serverProcess;
let serverOutput = "";

before(async () => {
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      AUTH_SECRET: "hardening-test-secret-with-more-than-thirty-two-characters",
      PRESENTER_EMAIL: TEST_EMAIL,
      PRESENTER_PASSWORD: TEST_PASSWORD,
      DATABASE_URL: "",
      PUBLIC_ORIGIN: baseUrl,
      ALLOW_INSECURE_LOCAL_AUTH: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcess.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  serverProcess.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  await waitForHealth();
});

after(async () => {
  if (!serverProcess) {
    return;
  }
  serverProcess.kill();
  await Promise.race([
    new Promise((resolve) => serverProcess.once("exit", resolve)),
    delay(1_000)
  ]);
  if (serverProcess.exitCode === null) {
    serverProcess.kill("SIGKILL");
  }
});

test("all HTML responses include the security header baseline", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("permissions-policy") ?? "", /camera=\(\)/);
});

test("presenter login establishes a revocable HttpOnly cookie without returning a bearer token", async () => {
  const response = await postJson("/api/auth", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    keepSignedIn: false
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /pinboard_presenter=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.equal(Object.hasOwn(body, "hostToken"), false);
  assert.equal(typeof body.csrfToken, "string");
  assert.ok(body.csrfToken.length >= 32);

  const me = await fetch(`${baseUrl}/api/me`, {
    headers: { Cookie: cookie.split(";")[0] }
  });
  assert.equal(me.status, 200);
  assert.match(me.headers.get("cache-control") ?? "", /no-store/);
  assert.match(me.headers.get("vary") ?? "", /Cookie/i);
});

test("anonymous presenter restoration is a quiet cache-safe response", async () => {
  const response = await fetch(`${baseUrl}/api/me`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), { presenter: null, csrfToken: null });
});

test("ordinary auth JSON is rejected before buffering media-sized bodies", async () => {
  const oversizedPassword = "x".repeat(20 * 1024);
  const response = await postJson("/api/auth", {
    email: TEST_EMAIL,
    password: oversizedPassword
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.code, "REQUEST_TOO_LARGE");
});

test("unexpected routes never expose internal exception details", async () => {
  const response = await fetch(`${baseUrl}/api/not-a-real-endpoint`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{}"
  });
  assert.equal(response.status, 405);
  const body = await response.json();
  assert.equal(typeof body.requestId, "string");
  assert.equal(JSON.stringify(body).includes("stack"), false);
});

test("presenter content rejects attribute-breaking stable IDs", async () => {
  const login = await loginPresenter();
  const response = await postJson(
    "/api/sessions",
    {
      title: "XSS regression",
      questions: [{
        id: "question-1",
        kind: "quiz",
        text: "Pick one",
        points: 100,
        timerSeconds: 30,
        options: [
          { id: "safe-option", text: "Safe" },
          { id: 'x\" autofocus onfocus=alert(1)', text: "Unsafe" }
        ],
        correctOptionId: "safe-option",
        media: null
      }]
    },
    {
      Cookie: login.cookie,
      "X-CSRF-Token": login.csrfToken,
      Origin: baseUrl
    }
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "INVALID_STABLE_ID");
});

test("media is signature-validated, stored separately, and supports byte ranges", async () => {
  const login = await loginPresenter();
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const upload = await fetch(`${baseUrl}/api/media`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "X-File-Name": encodeURIComponent("pixel.png"),
      Cookie: login.cookie,
      "X-CSRF-Token": login.csrfToken,
      Origin: baseUrl
    },
    body: pngBytes
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  assert.equal(uploaded.media.type, "image/png");
  assert.equal(uploaded.media.size, pngBytes.length);
  assert.match(uploaded.media.url, /^\/api\/media\/[0-9a-f-]{36}$/);
  assert.equal(Object.hasOwn(uploaded.media, "dataUrl"), false);

  const unauthenticated = await fetch(`${baseUrl}${uploaded.media.url}`);
  assert.equal(unauthenticated.status, 401);

  const range = await fetch(`${baseUrl}${uploaded.media.url}`, {
    headers: { Range: "bytes=0-3", Cookie: login.cookie }
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-type"), "image/png");
  assert.equal(range.headers.get("content-range"), `bytes 0-3/${pngBytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), pngBytes.subarray(0, 4));

  const activeContent = await fetch(`${baseUrl}/api/media`, {
    method: "POST",
    headers: {
      "Content-Type": "image/svg+xml",
      "X-File-Name": encodeURIComponent("unsafe.svg"),
      Cookie: login.cookie,
      "X-CSRF-Token": login.csrfToken,
      Origin: baseUrl
    },
    body: Buffer.from("<svg><script>alert(1)</script></svg>")
  });
  assert.equal(activeContent.status, 415);
});

async function loginPresenter() {
  const response = await postJson("/api/auth", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    keepSignedIn: false
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0],
    csrfToken: body.csrfToken
  };
}

function postJson(pathname, body, extraHeaders = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body)
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Server exited before health check:\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }
    await delay(100);
  }
  throw new Error(`Server did not become healthy:\n${serverOutput}`);
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
