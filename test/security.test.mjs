import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

process.env.AUTH_SECRET = "test-auth-secret-that-is-not-the-default";
process.env.PRESENTER_EMAIL = "presenter@example.com";
process.env.PRESENTER_PASSWORD = "strong-test-password";
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_ALLOWED_EMAILS = "teacher@example.com";

const { __test } = await import("../server.mjs");

beforeEach(() => {
  __test.rateLimitBuckets.clear();
  __test.googleUnknownKidCache.clear();
  __test.googleJwksCache.expiresAt = 0;
  __test.googleJwksCache.keys = new Map();
});

test("startup rejects implicit local defaults", () => {
  const script = "import('./server.mjs').then(({__test})=>__test.validateStartupConfig())";
  assert.throws(
    () =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, AUTH_SECRET: "", PRESENTER_EMAIL: "", PRESENTER_PASSWORD: "", PINBOARD_ALLOW_LOCAL_DEFAULTS: "" },
        stdio: "pipe"
      }),
    /AUTH_SECRET is required/
  );
});

test("option IDs reject attribute metacharacters", () => {
  assert.throws(
    () =>
      __test.normalizeOptions([
        { id: 'good-id', text: "Safe" },
        { id: 'x" autofocus onfocus=alert(1)', text: "Unsafe" }
      ]),
    /Option IDs must use only/
  );
});

test("media data URLs reject attribute breakout and unsupported MIME types", () => {
  assert.throws(
    () =>
      __test.normalizeMedia({
        name: "bad.png",
        type: 'image/png" onerror=alert(1)',
        size: 3,
        dataUrl: 'data:image/png" onerror=alert(1);base64,QUJD'
      }),
    /base64 data URL/
  );

  assert.throws(
    () =>
      __test.normalizeMedia({
        name: "bad.svg",
        type: "image/svg+xml",
        size: 3,
        dataUrl: "data:image/svg+xml;base64,QUJD"
      }),
    /not allowed/
  );

  assert.equal(
    __test.normalizeMedia({
      name: "ok.png",
      type: "image/png",
      size: 3,
      dataUrl: "data:image/png;base64,QUJD"
    }).type,
    "image/png"
  );
});

test("player token is scoped to the issuing PIN and player", () => {
  const token = __test.signPlayerToken("123456", "player-1");
  assert.deepEqual(__test.verifyPlayerToken(token), { pin: "123456", playerId: "player-1" });
});

test("Google presenters require an allowlisted email", () => {
  assert.doesNotThrow(() => __test.assertGooglePresenterAllowed("teacher@example.com"));
  assert.throws(() => __test.assertGooglePresenterAllowed("student@example.com"), /not authorized/);
});

test("unknown Google key IDs are negative cached after a fresh miss", async () => {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      headers: new Headers({ "cache-control": "max-age=3600" }),
      async json() {
        return { keys: [{ kid: "known", kty: "RSA", n: "x", e: "AQAB" }] };
      }
    };
  };

  try {
    await assert.rejects(() => __test.getGoogleJwk("missing-1"), /not recognized/);
    await assert.rejects(() => __test.getGoogleJwk("missing-1"), /not recognized/);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser no longer sends presenter bearer tokens in request URLs or headers", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.equal(appSource.includes('params.set("token"'), false);
  assert.equal(appSource.includes('headers["X-Host-Token"]'), false);
  assert.equal(appSource.includes("pinboard.hostToken"), true, "legacy key should only be removed, not used as storage");
});
