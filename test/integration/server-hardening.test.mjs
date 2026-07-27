import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { get as httpGet } from "node:http";
import { createServer as createNetServer } from "node:net";
import { after, before, test } from "node:test";

const TEST_EMAIL = "hardening@example.test";
const TEST_PASSWORD = "hardening-password-123";
const GOOGLE_TEST_CLIENT_ID = "hardening-google-client";
const GOOGLE_TEST_EMAIL = "google-hardening@example.test";
const PUBLIC_GOOGLE_TEST_EMAIL = "new-presenter@gmail.com";
const GOOGLE_TEST_KID = "hardening-google-key";
const MEDIA_BURST_REQUEST_COUNT = 9;
const MEDIA_BURST_HELD_REQUEST_COUNT = MEDIA_BURST_REQUEST_COUNT - 1;
const MEDIA_BURST_BYTES = 16 * 1024 * 1024;
const MEDIA_QUEUE_OBSERVATION_MS = 200;
const JSON_HEADERS = { "Content-Type": "application/json" };
const { publicKey: googlePublicKey, privateKey: googlePrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleTestJwk = googlePublicKey.export({ format: "jwk" });
Object.assign(googleTestJwk, { kid: GOOGLE_TEST_KID, alg: "RS256", use: "sig" });
const googleFetchPreloadSource = `
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === "https://www.googleapis.com/oauth2/v3/certs") {
    return new Response(JSON.stringify({ keys: [JSON.parse(process.env.MOCK_GOOGLE_JWK)] }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "max-age=3600" }
    });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    return new Response(JSON.stringify({
      access_token: "mock-google-access-token",
      expires_in: 3600,
      id_token: "mock-google-id-token",
      token_type: "Bearer"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return new Response(JSON.stringify({
      email: "${GOOGLE_TEST_EMAIL}",
      email_verified: true,
      name: "Google Hardening Callback",
      sub: "callback-google-presenter-sub"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return originalFetch(input, init);
};`;
const googleFetchPreload = `data:text/javascript,${encodeURIComponent(googleFetchPreloadSource)}`;

let baseUrl;
let serverProcess;
let serverOutput = "";

before(async () => {
  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["--import", googleFetchPreload, "server.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      AUTH_SECRET: "hardening-test-secret-with-more-than-thirty-two-characters",
      PRESENTER_EMAIL: TEST_EMAIL,
      PRESENTER_PASSWORD: TEST_PASSWORD,
      GOOGLE_CLIENT_ID: GOOGLE_TEST_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: "hardening-google-secret",
      GOOGLE_ALLOWED_EMAILS: GOOGLE_TEST_EMAIL,
      MOCK_GOOGLE_JWK: JSON.stringify(googleTestJwk),
      DATABASE_URL: "",
      PUBLIC_ORIGIN: baseUrl,
      TRUST_PROXY: "true",
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

test("startup logs do not expose presenter credentials", () => {
  assert.doesNotMatch(serverOutput, new RegExp(TEST_EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  assert.doesNotMatch(serverOutput, new RegExp(TEST_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("events dashboard is namespaced without replacing the existing SSE route", async () => {
  const redirectResponse = await fetch(`${baseUrl}/events`, { redirect: "manual" });
  assert.equal(redirectResponse.status, 308);
  assert.equal(redirectResponse.headers.get("location"), "/events/");

  const dashboardResponse = await fetch(`${baseUrl}/events/`);
  assert.equal(dashboardResponse.status, 200);
  assert.match(await dashboardResponse.text(), /AI Events SG/);

  const dataResponse = await fetch(`${baseUrl}/events/api/data`);
  assert.equal(dataResponse.status, 200);
  const data = await dataResponse.json();
  assert.ok(data.dataset.events.length >= 30);

  const streamResponse = await fetch(`${baseUrl}/events?pin=invalid&role=player`);
  assert.equal(streamResponse.status, 400);
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

test("Google credential login honors the requested cookie persistence", async () => {
  const sessionOnly = await postJson("/api/auth/google", {
    credential: createGoogleTestCredential({
      email: PUBLIC_GOOGLE_TEST_EMAIL,
      sub: "public-google-presenter-sub"
    }),
    keepSignedIn: false
  }, { Origin: baseUrl });
  assert.equal(sessionOnly.status, 200);
  const sessionCookie = sessionOnly.headers.get("set-cookie") ?? "";
  assert.match(sessionCookie, /pinboard_presenter=/);
  assert.doesNotMatch(sessionCookie, /(?:^|;\s*)Max-Age=/i);
  assert.doesNotMatch(sessionCookie, /(?:^|;\s*)Expires=/i);

  const persistent = await postJson("/api/auth/google", {
    credential: createGoogleTestCredential(),
    keepSignedIn: true
  }, { Origin: baseUrl });
  assert.equal(persistent.status, 200);
  assert.match(persistent.headers.get("set-cookie") ?? "", /(?:^|;\s*)Max-Age=\d+(?:;|$)/i);
});

test("Google OAuth callback honors the requested cookie persistence", async () => {
  const start = await fetch(`${baseUrl}/auth/google?keepSignedIn=1`, {
    redirect: "manual"
  });
  assert.equal(start.status, 302);
  const startCookies = start.headers.get("set-cookie") ?? "";
  const stateDigest = extractCookieValue(startCookies, "pinboard_oauth_state");
  const callbackState = new URL(start.headers.get("location") ?? "", baseUrl).searchParams.get("state");
  const keepSignedIn = extractCookieValue(startCookies, "pinboard_oauth_keep_signed_in");
  assert.ok(stateDigest);
  assert.ok(callbackState);
  assert.notEqual(stateDigest, callbackState);
  assert.equal(keepSignedIn, "1");

  const callback = await fetch(`${baseUrl}/auth/google/callback?state=${encodeURIComponent(callbackState)}&code=mock-code`, {
    headers: {
      Cookie: [
        `pinboard_oauth_state=${encodeURIComponent(stateDigest)}`,
        `pinboard_oauth_keep_signed_in=1`
      ].join("; ")
    },
    redirect: "manual"
  });
  assert.equal(callback.status, 302);
  assert.match(callback.headers.get("set-cookie") ?? "", /pinboard_presenter=/);
  assert.match(callback.headers.get("set-cookie") ?? "", /(?:^|;\s*)Max-Age=\d+(?:;|$)/i);
});

test("game audio manifest and assets are served with the expected media types", async () => {
  const manifestResponse = await fetch(`${baseUrl}/audio/game-audio.json`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get("content-type") ?? "", /application\/json/i);
  const manifest = await manifestResponse.json();
  assert.equal(typeof manifest.loops?.lobby?.src, "string");
  assert.equal(typeof manifest.loops?.question?.src, "string");
  assert.equal(typeof manifest.effects?.answerSubmit?.src, "string");

  const loopResponse = await fetch(`${baseUrl}${manifest.loops.lobby.src}`);
  assert.equal(loopResponse.status, 200);
  assert.match(loopResponse.headers.get("content-type") ?? "", /audio\/mpeg/i);
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

  const videoContent = await fetch(`${baseUrl}/api/media`, {
    method: "POST",
    headers: {
      "Content-Type": "video/mp4",
      "X-File-Name": encodeURIComponent("clip.mp4"),
      Cookie: login.cookie,
      "X-CSRF-Token": login.csrfToken,
      Origin: baseUrl
    },
    body: Buffer.from("000000186674797069736f6d00000200", "hex")
  });
  assert.equal(videoContent.status, 415);
  assert.match((await videoContent.json()).error, /image/i);
});

test("concurrent participant media downloads wait for capacity instead of being rejected", async () => {
  const login = await loginPresenter();
  const pngBytes = Buffer.alloc(MEDIA_BURST_BYTES);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBytes);
  const upload = await fetch(`${baseUrl}/api/media`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "X-File-Name": encodeURIComponent("burst.png"),
      Cookie: login.cookie,
      "X-CSRF-Token": login.csrfToken,
      Origin: baseUrl
    },
    body: pngBytes
  });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json();
  const firstOptionId = randomUUID();
  const createResponse = await postJson(
    "/api/sessions",
    {
      title: "Media burst integration",
      questions: [{
        id: randomUUID(),
        kind: "quiz",
        text: "Can every participant load this image?",
        points: 1_000,
        timerSeconds: 60,
        options: [
          { id: firstOptionId, text: "Yes" },
          { id: randomUUID(), text: "No" }
        ],
        correctOptionId: firstOptionId,
        media: uploaded.media
      }]
    },
    {
      Cookie: login.cookie,
      "X-CSRF-Token": login.csrfToken,
      Origin: baseUrl
    }
  );
  assert.equal(createResponse.status, 201);
  const { pin } = await createResponse.json();

  const playerCookies = [];
  for (let index = 0; index < MEDIA_BURST_REQUEST_COUNT; index += 1) {
    const joinResponse = await postJson(`/api/sessions/${pin}/join`, { nickname: `Burst Player ${index + 1}` }, {
      Origin: baseUrl
    });
    assert.equal(joinResponse.status, 201);
    playerCookies.push((joinResponse.headers.get("set-cookie") ?? "").split(";")[0]);
  }

  const mediaUrl = `${baseUrl}${uploaded.media.url}?pin=${pin}`;
  const heldResponses = [];
  const queuedController = new AbortController();
  try {
    for (let index = 0; index < MEDIA_BURST_HELD_REQUEST_COUNT; index += 1) {
      const held = await openPausedMedia(mediaUrl, playerCookies[index]);
      assert.equal(held.response.statusCode, 200);
      heldResponses.push(held.response);
    }

    const queuedResponsePromise = fetch(mediaUrl, {
      headers: { Cookie: playerCookies[MEDIA_BURST_HELD_REQUEST_COUNT] },
      signal: queuedController.signal
    });
    const earlyResult = await Promise.race([
      queuedResponsePromise.then((response) => ({ kind: "response", response })),
      delay(MEDIA_QUEUE_OBSERVATION_MS).then(() => ({ kind: "pending" }))
    ]);
    assert.equal(earlyResult.kind, "pending");

    heldResponses[0].resume();
    const queuedResponse = await queuedResponsePromise;
    assert.equal(queuedResponse.status, 200);
    assert.equal((await queuedResponse.arrayBuffer()).byteLength, MEDIA_BURST_BYTES);
  } finally {
    queuedController.abort();
    for (const response of heldResponses) {
      response.destroy();
    }
  }
});

test("trusted real-IP headers rate-limit distinct originating clients independently", async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${baseUrl}/auth/google`, {
      headers: {
        "X-Real-IP": "198.51.100.10",
        "X-Forwarded-For": "spoofed-client, 10.0.0.20"
      },
      redirect: "manual"
    });
    assert.equal(response.status, 302);
  }

  const rateLimited = await fetch(`${baseUrl}/auth/google`, {
    headers: {
      "X-Real-IP": "198.51.100.10",
      "X-Forwarded-For": "spoofed-client, 10.0.0.20"
    },
    redirect: "manual"
  });
  assert.equal(rateLimited.status, 429);

  const differentClient = await fetch(`${baseUrl}/auth/google`, {
    headers: {
      "X-Real-IP": "198.51.100.11",
      "X-Forwarded-For": "spoofed-client, 10.0.0.20"
    },
    redirect: "manual"
  });
  assert.equal(differentClient.status, 302);
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

function createGoogleTestCredential({ email = GOOGLE_TEST_EMAIL, sub = "hardening-google-sub" } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: GOOGLE_TEST_KID, typ: "JWT" });
  const payload = encode({
    iss: "accounts.google.com",
    aud: GOOGLE_TEST_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    sub,
    email,
    email_verified: true,
    name: "Google Hardening"
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), googlePrivateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function extractCookieValue(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
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

function openPausedMedia(url, cookie) {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers: { Cookie: cookie } }, (response) => {
      response.pause();
      resolve({ request, response });
    });
    request.once("error", reject);
  });
}
