import assert from "node:assert/strict";
import test from "node:test";

import {
  CookieJar,
  buildReadinessQuestions,
  createSseParser,
  endSessionForCleanup,
  evaluateReadiness,
  parseConfig,
  requiredReconnectCount,
  settleConcurrentWithCleanup,
  splitSetCookieHeader,
  summarizeLatencies
} from "../../scripts/live-readiness.mjs";

const BASE_ENV = Object.freeze({
  LIVE_READINESS_BASE_URL: "https://example.test/",
  LIVE_READINESS_PRESENTER_EMAIL: "presenter@example.test",
  LIVE_READINESS_PRESENTER_PASSWORD: "environment-secret"
});

const MEDIA = Object.freeze({
  id: "b89f9f5d-3f8f-4f44-9c2a-6f667c8bb255",
  name: "live-readiness.png",
  type: "image/png",
  size: 68,
  url: "/api/media/b89f9f5d-3f8f-4f44-9c2a-6f667c8bb255"
});

test("parseConfig defaults to 75 players and a 60 second soak", () => {
  const config = parseConfig({ argv: [], env: BASE_ENV });

  assert.equal(config.baseUrl, "https://example.test");
  assert.equal(config.players, 75);
  assert.equal(config.soakSeconds, 60);
  assert.equal(config.presenterEmail, BASE_ENV.LIVE_READINESS_PRESENTER_EMAIL);
  assert.equal(config.presenterPassword, BASE_ENV.LIVE_READINESS_PRESENTER_PASSWORD);
});

test("parseConfig accepts non-secret CLI overrides", () => {
  const config = parseConfig({
    argv: [
      "--base-url=https://target.example/",
      "--players",
      "90",
      "--soak-seconds=0",
      "--request-timeout-ms",
      "45000",
      "--convergence-timeout-ms=25000"
    ],
    env: BASE_ENV
  });

  assert.equal(config.baseUrl, "https://target.example");
  assert.equal(config.players, 90);
  assert.equal(config.soakSeconds, 0);
  assert.equal(config.requestTimeoutMs, 45_000);
  assert.equal(config.convergenceTimeoutMs, 25_000);
});

test("parseConfig requires HTTPS whenever presenter credentials leave loopback", () => {
  assert.throws(
    () => parseConfig({ argv: ["--base-url", "http://example.test"], env: BASE_ENV }),
    /HTTPS/i
  );

  const loopback = parseConfig({ argv: ["--base-url", "http://127.0.0.1:4173"], env: BASE_ENV });
  assert.equal(loopback.baseUrl, "http://127.0.0.1:4173");
});

test("parseConfig refuses credential CLI flags and never echoes the environment password", () => {
  assert.throws(
    () => parseConfig({ argv: ["--presenter-password=cli-secret"], env: BASE_ENV }),
    (error) => {
      assert.match(error.message, /unknown option/i);
      assert.doesNotMatch(error.message, /environment-secret|cli-secret/);
      return true;
    }
  );
});

test("splitSetCookieHeader preserves commas inside Expires attributes", () => {
  const cookies = splitSetCookieHeader(
    "presenter=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, player=xyz; Path=/; HttpOnly"
  );

  assert.deepEqual(cookies, [
    "presenter=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
    "player=xyz; Path=/; HttpOnly"
  ]);
});

test("CookieJar stores, replaces, and removes response cookies", () => {
  const jar = new CookieJar();

  jar.capture([
    "presenter=first; Path=/; HttpOnly",
    "player=one; Path=/; HttpOnly"
  ]);
  jar.capture(["presenter=second; Path=/; HttpOnly"]);

  assert.deepEqual(jar.toHeader().split("; ").sort(), ["player=one", "presenter=second"]);

  jar.capture(["presenter=; Max-Age=0; Path=/"]);

  assert.equal(jar.toHeader(), "player=one");
});

test("createSseParser handles split chunks, comments, and multi-line data", () => {
  const events = [];
  const parser = createSseParser((event) => events.push(event));

  parser.push("event: state\r\ndata: {\"version\":");
  parser.push("4,\"phase\":\"lobby\"}\r\n\r\n: keep-alive\n\n");
  parser.push("event: note\ndata: first\ndata: second\n\n");
  parser.finish();

  assert.deepEqual(events, [
    { event: "state", data: "{\"version\":4,\"phase\":\"lobby\"}", id: "" },
    { event: "note", data: "first\nsecond", id: "" }
  ]);
});

test("summarizeLatencies reports nearest-rank p50, p95, and max", () => {
  assert.deepEqual(summarizeLatencies([100, 10, 40, 20, 30]), {
    count: 5,
    p50: 30,
    p95: 100,
    max: 100
  });
  assert.deepEqual(summarizeLatencies([]), { count: 0, p50: 0, p95: 0, max: 0 });
});

test("requiredReconnectCount rounds up to reconnect at least 20 percent", () => {
  assert.equal(requiredReconnectCount(75), 15);
  assert.equal(requiredReconnectCount(76), 16);
  assert.equal(requiredReconnectCount(1), 1);
});

test("settleConcurrentWithCleanup closes successful resources when a sibling fails", async () => {
  const cleaned = [];

  await assert.rejects(
    settleConcurrentWithCleanup(
      ["first", "second"],
      async (value) => {
        if (value === "second") {
          throw new Error("expected worker failure");
        }
        return `${value}-resource`;
      },
      async (resource) => cleaned.push(resource)
    ),
    AggregateError
  );

  assert.deepEqual(cleaned, ["first-resource"]);
});

test("endSessionForCleanup retries with active-round discard after a graceful end is rejected", async () => {
  const attempts = [];
  const ended = await endSessionForCleanup(async (body) => {
    attempts.push(body);
    if (body.discardActiveRound === false) {
      throw new Error("active round requires confirmation");
    }
    return { phase: "ended" };
  });

  assert.deepEqual(attempts, [
    { discardActiveRound: false },
    { discardActiveRound: true }
  ]);
  assert.deepEqual(ended, { phase: "ended" });
});

test("buildReadinessQuestions creates media-backed quiz, slide, and true/false phases", () => {
  const questions = buildReadinessQuestions(MEDIA);

  assert.deepEqual(questions.map((question) => question.kind), ["quiz", "slide", "true_false"]);
  assert.equal(new Set(questions.map((question) => question.id)).size, questions.length);
  assert.ok(questions.every((question) => question.media.id === MEDIA.id));
  assert.ok(questions[0].options.some((option) => questions[0].correctOptionIds.includes(option.id)));
  assert.deepEqual(questions[1].options, []);
  assert.equal(questions[2].correctOptionIds.length, 1);
});

test("evaluateReadiness returns no failures when every gate passes", () => {
  const failures = evaluateReadiness({
    metrics: {
      statusCounts: { 200: 200, 201: 76 },
      errorCounts: { http: 0, network: 0, protocol: 0, stream: 0, cleanup: 0 }
    },
    answerRounds: [{ label: "quiz", expected: 75, observed: 75 }],
    convergenceChecks: [{ label: "results", converged: true }],
    reconnects: { required: 15, completed: 15 },
    workflowErrors: []
  });

  assert.deepEqual(failures, []);
});

test("evaluateReadiness reports lost answers, throttling, server errors, drift, and reconnect shortfalls", () => {
  const failures = evaluateReadiness({
    metrics: {
      statusCounts: { 200: 100, 429: 2, 503: 1 },
      errorCounts: { http: 3, network: 1, protocol: 0, stream: 1, cleanup: 0 }
    },
    answerRounds: [{ label: "true-false", expected: 75, observed: 74 }],
    convergenceChecks: [{ label: "ended", converged: false }],
    reconnects: { required: 15, completed: 14 },
    workflowErrors: ["question phase stopped early"]
  });

  assert.ok(failures.some((failure) => /429/.test(failure)));
  assert.ok(failures.some((failure) => /5xx/.test(failure)));
  assert.ok(failures.some((failure) => /lost 1 answer/i.test(failure)));
  assert.ok(failures.some((failure) => /converge/i.test(failure)));
  assert.ok(failures.some((failure) => /reconnect/i.test(failure)));
  assert.ok(failures.some((failure) => /recorded errors/i.test(failure)));
  assert.ok(failures.some((failure) => /stopped early/i.test(failure)));
});
