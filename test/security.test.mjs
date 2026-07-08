import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";

process.env.AUTH_SECRET = "test-auth-secret-that-is-not-the-default";
process.env.PRESENTER_EMAIL = "presenter@example.com";
process.env.PRESENTER_PASSWORD = "strong-test-password";
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_ALLOWED_EMAILS = "teacher@example.com";
process.env.TRUST_PROXY = "true";

const { __test } = await import("../server.mjs");

beforeEach(() => {
  __test.rateLimitBuckets.clear();
  __test.googleUnknownKidCache.clear();
  __test.googleJwksCache.expiresAt = 0;
  __test.googleJwksCache.keys = new Map();
  __test.setGoogleJwksLastRefreshAt(0);
  __test.setRateLimitLastPrunedAt(0);
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

test("unknown Google key IDs refresh after the negative-cache throttle window", async () => {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return {
      ok: true,
      headers: new Headers({ "cache-control": "max-age=3600" }),
      async json() {
        return { keys: [{ kid: "rotated", kty: "RSA", n: "x", e: "AQAB" }] };
      }
    };
  };

  try {
    __test.googleJwksCache.expiresAt = Date.now() + 60_000;
    __test.googleUnknownKidCache.set("rotated", Date.now() + 60_000);
    __test.setGoogleJwksLastRefreshAt(Date.now() - 10 * 60_000);
    const jwk = await __test.getGoogleJwk("rotated");
    assert.equal(jwk.kid, "rotated");
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxy client address and rate limit buckets avoid shared proxy lockout and leaks", () => {
  assert.equal(
    __test.getClientAddress({
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      socket: { remoteAddress: "10.0.0.2" }
    }),
    "203.0.113.7"
  );
  assert.equal(
    __test.getClientAddress({
      headers: { forwarded: 'for="198.51.100.8";proto=https' },
      socket: { remoteAddress: "10.0.0.2" }
    }),
    "198.51.100.8"
  );

  const now = Date.now();
  __test.rateLimitBuckets.set("expired", { count: 1, resetAt: now - 1 });
  __test.rateLimitBuckets.set("active", { count: 1, resetAt: now + 60_000 });
  __test.setRateLimitLastPrunedAt(now - 120_000);
  __test.enforceRateLimit("fresh-before-cap", 2, 1000);
  assert.equal(__test.rateLimitBuckets.has("expired"), false);
  assert.equal(__test.rateLimitBuckets.has("active"), true);

  __test.rateLimitBuckets.clear();
  __test.setRateLimitLastPrunedAt(0);
  for (let index = 0; index < __test.MAX_RATE_LIMIT_BUCKETS; index += 1) {
    __test.rateLimitBuckets.set(`expired:${index}`, { count: 1, resetAt: now - 1 });
  }
  __test.enforceRateLimit("fresh", 2, 1000);
  const freshBucket = __test.rateLimitBuckets.get("fresh");
  assert.equal(__test.rateLimitBuckets.size, 1);
  assert.equal(freshBucket.count, 1);
  assert.ok(freshBucket.resetAt > now);

  __test.rateLimitBuckets.clear();
  for (let index = 0; index < __test.MAX_RATE_LIMIT_BUCKETS; index += 1) {
    __test.rateLimitBuckets.set(`active:${index}`, { count: 1, resetAt: now + 60_000 });
  }
  assert.throws(() => __test.enforceRateLimit("overflow", 2, 1000), /Too many requests/);
});

test("live session snapshots keep static deck media outside hot-path state", () => {
  const questions = [
    {
      id: "q1",
      kind: "quiz",
      text: "Pick one",
      points: 100,
      options: [
        { id: "a", text: "A" },
        { id: "b", text: "B" }
      ],
      correctOptionId: "a",
      media: {
        name: "image.png",
        type: "image/png",
        size: 3,
        dataUrl: `data:image/png;base64,${"QUJD".repeat(1024)}`
      }
    }
  ];
  const session = {
    pin: "123456",
    title: "Deck",
    presenterId: "presenter-1",
    questions,
    phase: "answering",
    currentQuestionIndex: 0,
    players: new Map([["player-1", { id: "player-1", nickname: "Player", score: 0, joinedAt: 1 }]]),
    answers: new Map([["player-1", { optionId: "a", answeredAt: 2 }]]),
    scoredQuestionIndexes: new Set(),
    openedAt: 2,
    clients: new Map(),
    endedReason: null,
    createdAt: 1
  };

  const snapshot = __test.serializeSessionSnapshot(session);
  assert.equal(Object.hasOwn(snapshot, "questions"), false);
  assert.equal(snapshot.deckId, "123456");
  assert.equal(JSON.stringify(snapshot).includes("data:image/png"), false);

  const hydrated = __test.hydrateSessionSnapshot(snapshot, new Map(), questions);
  assert.equal(hydrated.questions[0].media.dataUrl, questions[0].media.dataUrl);
});

test("browser no longer sends presenter bearer tokens in request URLs or headers", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.equal(appSource.includes('params.set("token"'), false);
  assert.equal(appSource.includes('headers["X-Host-Token"]'), false);
  assert.equal(appSource.includes('localStorage.removeItem("pinboard.hostToken")'), true);
  assert.equal(appSource.includes('localStorage.setItem("pinboard.hostToken"'), false);
  assert.equal(appSource.includes("function clearPresenterSession()"), true);
  assert.equal(appSource.includes("isPresenterRequest(url)"), true);
});
