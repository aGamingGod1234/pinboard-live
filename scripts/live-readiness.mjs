import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const ENV_KEYS = Object.freeze({
  baseUrl: "LIVE_READINESS_BASE_URL",
  presenterEmail: "LIVE_READINESS_PRESENTER_EMAIL",
  presenterPassword: "LIVE_READINESS_PRESENTER_PASSWORD",
  players: "LIVE_READINESS_PLAYERS",
  soakSeconds: "LIVE_READINESS_SOAK_SECONDS",
  requestTimeoutMs: "LIVE_READINESS_REQUEST_TIMEOUT_MS",
  convergenceTimeoutMs: "LIVE_READINESS_CONVERGENCE_TIMEOUT_MS"
});

const CLI_OPTIONS = Object.freeze({
  "--base-url": "baseUrl",
  "--players": "players",
  "--soak-seconds": "soakSeconds",
  "--request-timeout-ms": "requestTimeoutMs",
  "--convergence-timeout-ms": "convergenceTimeoutMs"
});

const DEFAULT_PLAYER_COUNT = 75;
const DEFAULT_SOAK_SECONDS = 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONVERGENCE_TIMEOUT_MS = 20_000;
const MAX_PLAYER_COUNT = 5_000;
const MAX_SOAK_SECONDS = 86_400;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const PROGRESS_INTERVAL_MS = 30_000;
const CONVERGENCE_POLL_MS = 25;
const SSE_CLOSE_WAIT_MS = 2_000;
const RECONNECT_RATIO = 0.2;
const READINESS_TIMER_SECONDS = 300;
const READINESS_QUESTION_POINTS = 1_000;
const MAX_ERROR_MESSAGE_LENGTH = 240;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_TOO_MANY_REQUESTS = 429;
const SERVER_ERROR_STATUS_MIN = 500;
const SERVER_ERROR_STATUS_MAX = 599;
const CONTENT_TYPE_JSON = "application/json";
const CONTENT_TYPE_PNG = "image/png";
const SSE_CONTENT_TYPE = "text/event-stream";
const CSRF_HEADER = "x-csrf-token";
const FILE_NAME_HEADER = "x-file-name";
const REQUEST_ORIGIN_HEADER = "origin";
const EVENT_STATE = "state";
const ROLE_PLAYER = "player";
const PHASE_LOBBY = "lobby";
const PHASE_ANSWERING = "answering";
const PHASE_RESULTS = "results";
const PHASE_LEADERBOARD = "leaderboard";
const PHASE_QUESTION = "question";
const PHASE_ENDED = "ended";
const ACTION_START = "start";
const ACTION_REVEAL = "reveal";
const ACTION_NEXT = "next";
const ACTION_END = "end";
const READINESS_MEDIA_NAME = "live-readiness.png";
const READINESS_TITLE_PREFIX = "Live readiness";
const PLAYER_NAME_PREFIX = "Ready";
const LOOPBACK_HOSTNAMES = Object.freeze(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SMALL_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const ERROR_CATEGORIES = Object.freeze(["http", "network", "protocol", "stream", "cleanup"]);

const HELP_TEXT = `Usage: node scripts/live-readiness.mjs [options]

Options:
  --base-url URL                  Target origin (or ${ENV_KEYS.baseUrl})
  --players COUNT                 Concurrent players (default: ${DEFAULT_PLAYER_COUNT})
  --soak-seconds SECONDS          SSE soak duration (default: ${DEFAULT_SOAK_SECONDS})
  --request-timeout-ms MS         HTTP request timeout (default: ${DEFAULT_REQUEST_TIMEOUT_MS})
  --convergence-timeout-ms MS     State convergence timeout (default: ${DEFAULT_CONVERGENCE_TIMEOUT_MS})
  --help                          Show this help

Credentials are accepted only through ${ENV_KEYS.presenterEmail} and ${ENV_KEYS.presenterPassword}.`;

class HttpStatusError extends Error {
  constructor(label, status, detail) {
    super(`${label} returned HTTP ${status}${detail ? ` (${detail})` : ""}.`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  capture(values) {
    const headers = Array.isArray(values) ? values : [values];
    for (const header of headers) {
      for (const value of splitSetCookieHeader(header)) {
        this.#captureOne(value);
      }
    }
  }

  captureResponseHeaders(headers) {
    this.capture(readSetCookieHeaders(headers));
  }

  toHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  #captureOne(header) {
    if (typeof header !== "string" || !header.trim()) {
      return;
    }
    const parts = header.split(";");
    const pair = parts.shift()?.trim() ?? "";
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }
    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    const removesCookie = parts.some((part) => /^\s*max-age\s*=\s*0\s*$/i.test(part));
    if (removesCookie) {
      this.cookies.delete(name);
      return;
    }
    this.cookies.set(name, value);
  }
}

export function splitSetCookieHeader(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  return value
    .split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseConfig({ argv = [], env = {} } = {}) {
  const cli = parseCliArguments(argv);
  if (cli.help) {
    return Object.freeze({ help: true });
  }

  const baseUrl = normalizeBaseUrl(cli.baseUrl ?? env[ENV_KEYS.baseUrl]);
  const presenterEmail = readRequiredEnvironmentValue(env, ENV_KEYS.presenterEmail, { trim: true });
  const presenterPassword = readRequiredEnvironmentValue(env, ENV_KEYS.presenterPassword, { trim: false });
  const players = readBoundedInteger(
    cli.players ?? env[ENV_KEYS.players],
    "Player count",
    1,
    MAX_PLAYER_COUNT,
    DEFAULT_PLAYER_COUNT
  );
  const soakSeconds = readBoundedInteger(
    cli.soakSeconds ?? env[ENV_KEYS.soakSeconds],
    "Soak seconds",
    0,
    MAX_SOAK_SECONDS,
    DEFAULT_SOAK_SECONDS
  );
  const requestTimeoutMs = readBoundedInteger(
    cli.requestTimeoutMs ?? env[ENV_KEYS.requestTimeoutMs],
    "Request timeout",
    MIN_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS
  );
  const convergenceTimeoutMs = readBoundedInteger(
    cli.convergenceTimeoutMs ?? env[ENV_KEYS.convergenceTimeoutMs],
    "Convergence timeout",
    MIN_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    DEFAULT_CONVERGENCE_TIMEOUT_MS
  );

  return Object.freeze({
    help: false,
    baseUrl,
    presenterEmail,
    presenterPassword,
    players,
    soakSeconds,
    requestTimeoutMs,
    convergenceTimeoutMs
  });
}

function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument === "--help") {
      values.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error("Positional arguments are not supported.");
    }
    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
    const key = CLI_OPTIONS[option];
    if (!key) {
      throw new Error(`Unknown option ${option}.`);
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(`Option ${option} was provided more than once.`);
    }
    const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null;
    const nextValue = inlineValue ?? argv[index + 1];
    if (nextValue === undefined || (inlineValue === null && String(nextValue).startsWith("--"))) {
      throw new Error(`Option ${option} requires a value.`);
    }
    values[key] = String(nextValue);
    if (inlineValue === null) {
      index += 1;
    }
  }
  return values;
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${ENV_KEYS.baseUrl} or --base-url is required.`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("The readiness base URL is not valid.");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("The readiness base URL must use HTTP or HTTPS.");
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTNAMES.includes(parsed.hostname.toLowerCase())) {
    throw new Error("The readiness base URL must use HTTPS unless it targets loopback.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The readiness base URL must not contain credentials.");
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error("The readiness base URL must be an origin without a path, query, or fragment.");
  }
  return parsed.origin;
}

function readRequiredEnvironmentValue(env, key, { trim }) {
  const raw = env[key];
  if (typeof raw !== "string" || raw.length === 0 || (trim && !raw.trim())) {
    throw new Error(`${key} is required.`);
  }
  return trim ? raw.trim() : raw;
}

function readBoundedInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

export function createSseParser(onEvent) {
  if (typeof onEvent !== "function") {
    throw new TypeError("An SSE event callback is required.");
  }
  let buffer = "";
  let lastEventId = "";

  const dispatch = (block) => {
    const lines = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    let event = "message";
    const data = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) {
        continue;
      }
      const separatorIndex = line.indexOf(":");
      const field = separatorIndex < 0 ? line : line.slice(0, separatorIndex);
      let value = separatorIndex < 0 ? "" : line.slice(separatorIndex + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "event") {
        event = value || "message";
      } else if (field === "data") {
        data.push(value);
      } else if (field === "id" && !value.includes("\0")) {
        lastEventId = value;
      }
    }
    if (data.length > 0) {
      onEvent({ event, data: data.join("\n"), id: lastEventId });
    }
  };

  return {
    push(chunk) {
      buffer += String(chunk ?? "");
      while (true) {
        const boundary = findSseBoundary(buffer);
        if (!boundary) {
          break;
        }
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        dispatch(block);
      }
    },
    finish() {
      if (buffer) {
        dispatch(buffer);
        buffer = "";
      }
    }
  };
}

function findSseBoundary(value) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

export function summarizeLatencies(values) {
  const sorted = values.filter(Number.isFinite).map(Number).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return { count: 0, p50: 0, p95: 0, max: 0 };
  }
  return {
    count: sorted.length,
    p50: roundMilliseconds(nearestRank(sorted, 50)),
    p95: roundMilliseconds(nearestRank(sorted, 95)),
    max: roundMilliseconds(sorted.at(-1))
  };
}

function nearestRank(sortedValues, percentile) {
  const rank = Math.max(1, Math.ceil((percentile / 100) * sortedValues.length));
  return sortedValues[rank - 1];
}

function roundMilliseconds(value) {
  return Math.round(value * 100) / 100;
}

export function requiredReconnectCount(playerCount) {
  if (!Number.isSafeInteger(playerCount) || playerCount < 0) {
    throw new TypeError("Player count must be a non-negative integer.");
  }
  return playerCount === 0 ? 0 : Math.max(1, Math.ceil(playerCount * RECONNECT_RATIO));
}

export function buildReadinessQuestions(media) {
  const normalizedMedia = validateMediaDescriptor(media);
  const quizCorrectId = randomUUID();
  const quizIncorrectId = randomUUID();
  const trueId = randomUUID();
  const falseId = randomUUID();
  return [
    {
      id: randomUUID(),
      kind: "quiz",
      text: "Readiness burst question",
      points: READINESS_QUESTION_POINTS,
      timerSeconds: READINESS_TIMER_SECONDS,
      options: [
        { id: quizCorrectId, text: "Ready" },
        { id: quizIncorrectId, text: "Not ready" }
      ],
      correctOptionIds: [quizCorrectId],
      media: { ...normalizedMedia }
    },
    {
      id: randomUUID(),
      kind: "slide",
      text: "Readiness phase transition",
      points: 0,
      timerSeconds: 0,
      options: [],
      correctOptionIds: [],
      media: { ...normalizedMedia }
    },
    {
      id: randomUUID(),
      kind: "true_false",
      text: "All readiness players remain connected",
      points: READINESS_QUESTION_POINTS,
      timerSeconds: READINESS_TIMER_SECONDS,
      options: [
        { id: trueId, text: "True" },
        { id: falseId, text: "False" }
      ],
      correctOptionIds: [trueId],
      media: { ...normalizedMedia }
    }
  ];
}

function validateMediaDescriptor(media) {
  if (!media || typeof media !== "object") {
    throw new TypeError("A media descriptor is required.");
  }
  const requiredKeys = ["id", "name", "type", "url"];
  if (requiredKeys.some((key) => typeof media[key] !== "string" || !media[key])) {
    throw new TypeError("The media descriptor is incomplete.");
  }
  if (!Number.isSafeInteger(media.size) || media.size < 0) {
    throw new TypeError("The media size is not valid.");
  }
  return media;
}

export function evaluateReadiness({ metrics, answerRounds, convergenceChecks, reconnects, workflowErrors }) {
  const failures = [];
  const statusCounts = metrics?.statusCounts ?? {};
  const throttledCount = Number(statusCounts[HTTP_TOO_MANY_REQUESTS] ?? 0);
  const serverErrorCount = Object.entries(statusCounts).reduce((total, [status, count]) => {
    const numericStatus = Number(status);
    return numericStatus >= SERVER_ERROR_STATUS_MIN && numericStatus <= SERVER_ERROR_STATUS_MAX
      ? total + Number(count)
      : total;
  }, 0);
  if (throttledCount > 0) {
    failures.push(`Observed ${throttledCount} HTTP 429 response(s).`);
  }
  if (serverErrorCount > 0) {
    failures.push(`Observed ${serverErrorCount} HTTP 5xx response(s).`);
  }

  for (const round of answerRounds ?? []) {
    const lost = Number(round.expected) - Number(round.observed);
    if (lost !== 0) {
      failures.push(`${round.label} lost ${lost} answer(s): expected ${round.expected}, observed ${round.observed}.`);
    }
    if (round.accepted !== undefined && Number(round.accepted) !== Number(round.expected)) {
      failures.push(`${round.label} accepted ${round.accepted} of ${round.expected} answer submissions.`);
    }
  }

  for (const check of convergenceChecks ?? []) {
    if (!check.converged) {
      failures.push(`${check.label} state/version did not converge.`);
    }
  }

  if (Number(reconnects?.completed ?? 0) < Number(reconnects?.required ?? 0)) {
    failures.push(`Completed ${reconnects?.completed ?? 0} of ${reconnects?.required ?? 0} required SSE reconnects.`);
  }

  const errorCounts = metrics?.errorCounts ?? {};
  const recordedErrorCount = ERROR_CATEGORIES.reduce((total, category) => total + Number(errorCounts[category] ?? 0), 0);
  if (recordedErrorCount > 0) {
    const detail = ERROR_CATEGORIES.map((category) => `${category}=${Number(errorCounts[category] ?? 0)}`).join(", ");
    failures.push(`Recorded errors: ${detail}.`);
  }

  for (const error of workflowErrors ?? []) {
    failures.push(`Workflow: ${error}`);
  }
  return failures;
}

function createMetrics() {
  return {
    requestAttempts: 0,
    latencies: [],
    latenciesByLabel: new Map(),
    statusCounts: new Map(),
    errorCounts: Object.fromEntries(ERROR_CATEGORIES.map((category) => [category, 0])),
    errors: []
  };
}

function recordStatus(metrics, status) {
  metrics.statusCounts.set(status, (metrics.statusCounts.get(status) ?? 0) + 1);
}

function recordLatency(metrics, label, milliseconds) {
  const value = Math.max(0, Number(milliseconds));
  metrics.latencies.push(value);
  const samples = metrics.latenciesByLabel.get(label) ?? [];
  samples.push(value);
  metrics.latenciesByLabel.set(label, samples);
}

function recordMetricError(runtime, category, label, error) {
  runtime.metrics.errorCounts[category] += 1;
  const message = redactSecrets(safeErrorMessage(error), runtime.secrets);
  runtime.metrics.errors.push({ category, label, message });
  return message;
}

function snapshotMetrics(metrics) {
  const statusCounts = Object.fromEntries([...metrics.statusCounts.entries()].sort(([left], [right]) => left - right));
  const operations = Object.fromEntries(
    [...metrics.latenciesByLabel.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, values]) => [label, summarizeLatencies(values)])
  );
  return {
    totalRequests: metrics.requestAttempts,
    statusCounts,
    errorCounts: { ...metrics.errorCounts },
    latency: summarizeLatencies(metrics.latencies),
    operations,
    errors: metrics.errors.map((entry) => ({ ...entry }))
  };
}

function readSetCookieHeaders(headers) {
  if (!headers) {
    return [];
  }
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const combined = typeof headers.get === "function" ? headers.get("set-cookie") : null;
  return splitSetCookieHeader(combined);
}

async function executeHttp(runtime, descriptor) {
  const startedAt = performance.now();
  runtime.metrics.requestAttempts += 1;
  let responseReceived = false;
  let timeout = null;
  const controller = descriptor.signal ? null : new AbortController();
  const signal = descriptor.signal ?? controller.signal;
  const timeoutMs = descriptor.timeoutMs === null
    ? null
    : descriptor.timeoutMs ?? runtime.config.requestTimeoutMs;
  if (controller && timeoutMs !== null) {
    timeout = setTimeout(() => controller.abort(new Error(`${descriptor.label} timed out.`)), timeoutMs);
  }

  try {
    const headers = createRequestHeaders(runtime, descriptor);
    const response = await runtime.fetchImpl(new URL(descriptor.path, runtime.config.baseUrl), {
      method: descriptor.method ?? "GET",
      headers,
      body: descriptor.body,
      signal,
      redirect: "manual"
    });
    responseReceived = true;
    recordStatus(runtime.metrics, response.status);
    descriptor.jar?.captureResponseHeaders(response.headers);
    const expectedStatuses = descriptor.expectedStatuses ?? [HTTP_OK];
    if (!expectedStatuses.includes(response.status)) {
      const detail = await readResponseError(response);
      throw new HttpStatusError(descriptor.label, response.status, detail);
    }
    return await descriptor.consume(response);
  } catch (error) {
    const category = error instanceof HttpStatusError ? "http" : responseReceived ? "protocol" : "network";
    recordMetricError(runtime, category, descriptor.label, error);
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    recordLatency(runtime.metrics, descriptor.label, performance.now() - startedAt);
  }
}

function createRequestHeaders(runtime, descriptor) {
  const headers = new Headers(descriptor.headers ?? {});
  const cookie = descriptor.jar?.toHeader();
  if (cookie) {
    headers.set("cookie", cookie);
  }
  if (descriptor.csrfToken) {
    headers.set(CSRF_HEADER, descriptor.csrfToken);
  }
  if (descriptor.mutation) {
    headers.set(REQUEST_ORIGIN_HEADER, runtime.config.baseUrl);
  }
  return headers;
}

async function readResponseError(response) {
  try {
    const text = await response.text();
    if (!text) {
      return "";
    }
    try {
      const payload = JSON.parse(text);
      const detail = payload?.code || payload?.error;
      return typeof detail === "string" ? sanitizeMessage(detail) : "";
    } catch {
      return sanitizeMessage(text);
    }
  } catch {
    return "";
  }
}

function sanitizeMessage(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function safeErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return sanitizeMessage(error.message);
  }
  return sanitizeMessage(error ?? "Unknown error");
}

function redactSecrets(message, secrets) {
  let redacted = String(message);
  for (const secret of secrets ?? []) {
    if (typeof secret === "string" && secret) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
  }
  return redacted;
}

async function jsonRequest(runtime, descriptor) {
  const hasBody = descriptor.body !== undefined;
  const headers = {
    Accept: CONTENT_TYPE_JSON,
    ...(hasBody ? { "Content-Type": `${CONTENT_TYPE_JSON}; charset=utf-8` } : {}),
    ...descriptor.headers
  };
  return executeHttp(runtime, {
    ...descriptor,
    headers,
    body: hasBody ? JSON.stringify(descriptor.body) : undefined,
    consume: async (response) => {
      const text = await response.text();
      if (!text) {
        return {};
      }
      const payload = JSON.parse(text);
      if (!payload || typeof payload !== "object") {
        throw new Error(`${descriptor.label} did not return a JSON object.`);
      }
      return payload;
    }
  });
}

function createRuntime(config, dependencies) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Node.js fetch support is required.");
  }
  return {
    config,
    fetchImpl,
    log: dependencies.log ?? ((message) => console.log(message)),
    errorLog: dependencies.errorLog ?? ((message) => console.error(message)),
    secrets: [config.presenterEmail, config.presenterPassword],
    metrics: createMetrics(),
    hostJar: new CookieJar(),
    csrfToken: "",
    authenticated: false,
    media: null,
    pin: "",
    latestSession: null,
    players: [],
    streams: [],
    answerRounds: [],
    convergenceChecks: [],
    reconnects: { required: requiredReconnectCount(config.players), completed: 0 },
    workflowErrors: [],
    ended: false
  };
}

function progress(runtime, message) {
  runtime.log(`[readiness] ${redactSecrets(message, runtime.secrets)}`);
}

async function authenticatePresenter(runtime) {
  const payload = await jsonRequest(runtime, {
    label: "authenticate",
    path: "/api/auth",
    method: "POST",
    mutation: true,
    jar: runtime.hostJar,
    expectedStatuses: [HTTP_OK],
    body: {
      email: runtime.config.presenterEmail,
      password: runtime.config.presenterPassword,
      keepSignedIn: false
    }
  });
  if (typeof payload.csrfToken !== "string" || !payload.csrfToken || !payload.presenter) {
    throw new Error("Authentication response did not include presenter state and a CSRF token.");
  }
  runtime.csrfToken = payload.csrfToken;
  runtime.authenticated = true;
}

async function uploadReadinessMedia(runtime) {
  const media = await executeHttp(runtime, {
    label: "media-upload",
    path: "/api/media",
    method: "POST",
    mutation: true,
    jar: runtime.hostJar,
    csrfToken: runtime.csrfToken,
    expectedStatuses: [HTTP_CREATED],
    headers: {
      "Content-Type": CONTENT_TYPE_PNG,
      [FILE_NAME_HEADER]: encodeURIComponent(READINESS_MEDIA_NAME)
    },
    body: SMALL_PNG_BYTES,
    consume: async (response) => {
      const payload = await response.json();
      return validateMediaDescriptor(payload?.media);
    }
  });
  runtime.media = media;
  return media;
}

async function createDirectSession(runtime, questions, runId) {
  const payload = await jsonRequest(runtime, {
    label: "session-create",
    path: "/api/sessions",
    method: "POST",
    mutation: true,
    jar: runtime.hostJar,
    csrfToken: runtime.csrfToken,
    expectedStatuses: [HTTP_CREATED],
    body: {
      title: `${READINESS_TITLE_PREFIX} ${runId.slice(0, 8)}`,
      questions
    }
  });
  const pin = typeof payload.pin === "string" ? payload.pin : "";
  if (!/^\d{6}$/.test(pin) || !payload.session) {
    throw new Error("Session creation did not return a six-digit PIN and host state.");
  }
  runtime.pin = pin;
  runtime.latestSession = payload.session;
  return payload.session;
}

async function joinPlayers(runtime, runId) {
  const specs = Array.from({ length: runtime.config.players }, (_, index) => ({
    index,
    nickname: `${PLAYER_NAME_PREFIX}-${runId.slice(0, 6)}-${index + 1}`
  }));
  const players = await settleConcurrent(runtime, "player joins", specs, async (spec) => {
    const jar = new CookieJar();
    const payload = await jsonRequest(runtime, {
      label: "player-join",
      path: `/api/sessions/${runtime.pin}/join`,
      method: "POST",
      mutation: true,
      jar,
      expectedStatuses: [HTTP_CREATED],
      body: { nickname: spec.nickname }
    });
    if (typeof payload.playerId !== "string" || !payload.playerId) {
      throw new Error("A player join response did not include a player ID.");
    }
    return { ...spec, id: payload.playerId, jar };
  });
  runtime.players = players;
  return players;
}

export async function settleConcurrentWithCleanup(items, worker, cleanup = async () => {}) {
  if (!Array.isArray(items) || typeof worker !== "function" || typeof cleanup !== "function") {
    throw new TypeError("Concurrent items, worker, and cleanup callback are required.");
  }
  const settled = await Promise.allSettled(items.map((item, index) => worker(item, index)));
  const failures = settled.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    const successfulValues = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    await Promise.allSettled(successfulValues.map((value) => cleanup(value)));
    throw new AggregateError(
      failures.map((result) => result.reason),
      `${failures.length} concurrent operation(s) failed.`
    );
  }
  return settled.map((result) => result.value);
}

async function settleConcurrent(runtime, label, items, worker, cleanup) {
  try {
    return await settleConcurrentWithCleanup(items, worker, cleanup);
  } catch (error) {
    const reasons = error instanceof AggregateError ? error.errors : [error];
    const first = redactSecrets(safeErrorMessage(reasons[0]), runtime.secrets);
    throw new Error(`${label} failed for ${reasons.length} of ${items.length} operations: ${first}`);
  }
}

async function openPlayerStreams(runtime, players) {
  let streams = [];
  try {
    streams = await settleConcurrent(
      runtime,
      "SSE opens",
      players,
      (player) => openPlayerStream(runtime, player),
      closeStream
    );
    await waitForInitialStates(runtime, streams);
    return streams;
  } catch (error) {
    await Promise.all(streams.map((stream) => closeStream(stream)));
    throw error;
  }
}

async function openPlayerStream(runtime, player) {
  const controller = new AbortController();
  const handshakeTimeout = setTimeout(
    () => controller.abort(new Error("SSE handshake timed out.")),
    runtime.config.requestTimeoutMs
  );
  let response;
  try {
    response = await executeHttp(runtime, {
      label: "sse-open",
      path: `/events?pin=${encodeURIComponent(runtime.pin)}&role=${ROLE_PLAYER}`,
      method: "GET",
      jar: player.jar,
      signal: controller.signal,
      timeoutMs: null,
      headers: { Accept: SSE_CONTENT_TYPE },
      expectedStatuses: [HTTP_OK],
      consume: async (candidate) => {
        const contentType = candidate.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith(SSE_CONTENT_TYPE)) {
          throw new Error("SSE response did not use text/event-stream.");
        }
        return candidate;
      }
    });
  } finally {
    clearTimeout(handshakeTimeout);
  }
  if (!response.body) {
    const error = new Error("SSE response did not include a readable body.");
    recordMetricError(runtime, "protocol", "sse-open", error);
    throw error;
  }

  const stream = {
    player,
    controller,
    latestState: null,
    eventCount: 0,
    plannedAbort: false,
    closed: false,
    error: "",
    loop: null
  };
  const parser = createSseParser((event) => handleStreamEvent(runtime, stream, event));
  stream.loop = consumeSseBody(response.body, parser)
    .then(() => {
      if (!stream.plannedAbort) {
        const error = new Error("SSE stream ended unexpectedly.");
        stream.error = recordMetricError(runtime, "stream", "sse-read", error);
      }
    })
    .catch((error) => {
      if (!stream.plannedAbort && !isAbortError(error)) {
        stream.error = recordMetricError(runtime, "stream", "sse-read", error);
      }
    })
    .finally(() => {
      stream.closed = true;
    });
  return stream;
}

function handleStreamEvent(runtime, stream, event) {
  stream.eventCount += 1;
  if (event.event !== EVENT_STATE) {
    return;
  }
  try {
    const state = JSON.parse(event.data);
    if (!state || typeof state !== "object" || !Number.isSafeInteger(state.version)) {
      throw new Error("SSE state event did not include an integer version.");
    }
    stream.latestState = state;
  } catch (error) {
    stream.error = recordMetricError(runtime, "protocol", "sse-state", error);
  }
}

async function consumeSseBody(body, parser) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        parser.push(decoder.decode());
        parser.finish();
        return;
      }
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError";
}

async function waitForInitialStates(runtime, streams) {
  const ready = await waitForCondition(
    () => streams.every((stream) => stream.latestState || stream.error),
    runtime.config.convergenceTimeoutMs
  );
  const failed = streams.filter((stream) => !stream.latestState || stream.error);
  if (!ready || failed.length > 0) {
    throw new Error(`${failed.length || streams.length} SSE stream(s) did not provide valid initial state.`);
  }
}

async function reconnectPlayerStreams(runtime) {
  const targets = runtime.streams.slice(0, runtime.reconnects.required);
  await Promise.all(targets.map((stream) => closeStream(stream)));
  const replacements = await openPlayerStreams(runtime, targets.map((stream) => stream.player));
  const replacementByPlayerId = new Map(replacements.map((stream) => [stream.player.id, stream]));
  runtime.streams = runtime.streams.map((stream) => replacementByPlayerId.get(stream.player.id) ?? stream);
  runtime.reconnects.completed = replacements.length;
}

async function closeStream(stream) {
  stream.plannedAbort = true;
  if (!stream.controller.signal.aborted) {
    stream.controller.abort();
  }
  if (stream.loop) {
    await Promise.race([stream.loop, sleep(SSE_CLOSE_WAIT_MS)]);
  }
}

async function closeAllStreams(runtime) {
  await Promise.all(runtime.streams.map((stream) => closeStream(stream)));
}

async function hostAction(runtime, action, body = {}) {
  const payload = await jsonRequest(runtime, {
    label: `host-${action}`,
    path: `/api/sessions/${runtime.pin}/${action}`,
    method: "POST",
    mutation: true,
    jar: runtime.hostJar,
    csrfToken: runtime.csrfToken,
    expectedStatuses: [HTTP_OK],
    body
  });
  if (!payload.session || typeof payload.session !== "object") {
    throw new Error(`Host ${action} response did not include session state.`);
  }
  runtime.latestSession = payload.session;
  runtime.ended = payload.session.phase === PHASE_ENDED;
  return payload.session;
}

async function fetchMediaBurst(runtime, phaseLabel) {
  const path = `/api/media/${encodeURIComponent(runtime.media.id)}?pin=${encodeURIComponent(runtime.pin)}`;
  await settleConcurrent(runtime, `${phaseLabel} media fetches`, runtime.players, async (player) => {
    await executeHttp(runtime, {
      label: `media-${phaseLabel}`,
      path,
      method: "GET",
      jar: player.jar,
      expectedStatuses: [HTTP_OK],
      consume: async (response) => {
        const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== CONTENT_TYPE_PNG) {
          throw new Error(`${phaseLabel} media response was not image/png.`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.equals(SMALL_PNG_BYTES)) {
          throw new Error(`${phaseLabel} media response did not match the uploaded PNG.`);
        }
      }
    });
  });
}

async function submitAnswerBurst(runtime, phaseLabel, selectedOptionIds) {
  const results = await settleConcurrent(runtime, `${phaseLabel} answers`, runtime.players, (player) => jsonRequest(runtime, {
    label: `answer-${phaseLabel}`,
    path: `/api/sessions/${runtime.pin}/answer`,
    method: "POST",
    mutation: true,
    jar: player.jar,
    expectedStatuses: [HTTP_OK],
    body: { selectedOptionIds }
  }));
  return results.filter((payload) => payload.accepted === true && payload.duplicate !== true).length;
}

async function assertConvergence(runtime, expected, label) {
  let observation = inspectConvergence(runtime.streams, expected, runtime.config.players);
  const converged = await waitForCondition(() => {
    observation = inspectConvergence(runtime.streams, expected, runtime.config.players);
    return observation.converged;
  }, runtime.config.convergenceTimeoutMs);
  runtime.convergenceChecks.push({
    label,
    converged,
    version: observation.version,
    phases: observation.phases
  });
  if (!converged) {
    throw new Error(`${label} did not converge across ${runtime.config.players} SSE streams.`);
  }
  return observation;
}

function inspectConvergence(streams, expected, playerCount) {
  if (streams.length !== playerCount || streams.some((stream) => stream.closed || stream.error || !stream.latestState)) {
    return { converged: false, version: null, phases: [] };
  }
  const states = streams.map((stream) => stream.latestState);
  const versions = states.map((state) => Number(state.version));
  const phases = [...new Set(states.map((state) => state.phase))];
  const versionSet = new Set(versions);
  const sharedVersion = versionSet.size === 1 ? versions[0] : null;
  const minimumVersion = Number(expected.version ?? 0);
  const commonStateMatches = states.every((state) =>
    state.phase === expected.phase
    && state.playerCount === playerCount
    && Number(state.version) >= minimumVersion
    && (expected.currentQuestionIndex === undefined || state.currentQuestionIndex === expected.currentQuestionIndex)
    && (expected.answerCount === undefined || state.answerCount === expected.answerCount)
  );
  return {
    converged: commonStateMatches && sharedVersion !== null,
    version: sharedVersion,
    phases
  };
}

async function waitForCondition(predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() <= deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(CONVERGENCE_POLL_MS);
  }
  return Boolean(predicate());
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function runSoak(runtime) {
  const totalMs = runtime.config.soakSeconds * 1_000;
  const startedAt = performance.now();
  progress(runtime, `soak started seconds=${runtime.config.soakSeconds}`);
  while (performance.now() - startedAt < totalMs) {
    const remainingMs = totalMs - (performance.now() - startedAt);
    await sleep(Math.min(PROGRESS_INTERVAL_MS, Math.max(0, remainingMs)));
    assertStreamsHealthy(runtime);
    const elapsedSeconds = Math.min(runtime.config.soakSeconds, Math.round((performance.now() - startedAt) / 1_000));
    const eventCount = runtime.streams.reduce((total, stream) => total + stream.eventCount, 0);
    progress(runtime, `soak progress ${elapsedSeconds}/${runtime.config.soakSeconds}s active_streams=${activeStreamCount(runtime.streams)} sse_events=${eventCount}`);
  }
  assertStreamsHealthy(runtime);
}

function assertStreamsHealthy(runtime) {
  const active = activeStreamCount(runtime.streams);
  const errors = runtime.streams.filter((stream) => stream.error).length;
  if (active !== runtime.config.players || errors > 0) {
    throw new Error(`SSE soak health failed: active=${active}, expected=${runtime.config.players}, errors=${errors}.`);
  }
}

function activeStreamCount(streams) {
  return streams.filter((stream) => !stream.closed && !stream.error).length;
}

async function executeBattleSequence(runtime, questions) {
  const lobbyState = runtime.latestSession;
  await assertConvergence(runtime, { phase: PHASE_LOBBY, version: lobbyState.version }, "lobby");

  await reconnectPlayerStreams(runtime);
  await assertConvergence(runtime, { phase: PHASE_LOBBY, version: lobbyState.version }, "reconnected lobby");
  progress(runtime, `SSE ready streams=${runtime.streams.length} reconnected=${runtime.reconnects.completed}`);

  const started = await hostAction(runtime, ACTION_START);
  assertHostPhase(started, PHASE_ANSWERING, 0, ACTION_START);
  await assertConvergence(runtime, { phase: PHASE_ANSWERING, version: started.version, currentQuestionIndex: 0 }, "quiz answering");
  await fetchMediaBurst(runtime, "quiz");
  const quizAccepted = await submitAnswerBurst(runtime, "quiz", questions[0].correctOptionIds);
  const quizResults = await hostAction(runtime, ACTION_REVEAL);
  assertHostPhase(quizResults, PHASE_RESULTS, 0, ACTION_REVEAL);
  runtime.answerRounds.push({
    label: "quiz",
    expected: runtime.config.players,
    observed: Number(quizResults.answerCount),
    accepted: quizAccepted
  });
  await assertConvergence(runtime, {
    phase: PHASE_RESULTS,
    version: quizResults.version,
    currentQuestionIndex: 0,
    answerCount: runtime.config.players
  }, "quiz results");

  const leaderboard = await hostAction(runtime, ACTION_NEXT);
  assertHostPhase(leaderboard, PHASE_LEADERBOARD, 0, ACTION_NEXT);
  await assertConvergence(runtime, { phase: PHASE_LEADERBOARD, version: leaderboard.version, currentQuestionIndex: 0 }, "leaderboard");

  const slide = await hostAction(runtime, ACTION_NEXT);
  assertHostPhase(slide, PHASE_QUESTION, 1, ACTION_NEXT);
  await assertConvergence(runtime, { phase: PHASE_QUESTION, version: slide.version, currentQuestionIndex: 1 }, "slide");
  await fetchMediaBurst(runtime, "slide");

  const trueFalse = await hostAction(runtime, ACTION_NEXT);
  assertHostPhase(trueFalse, PHASE_ANSWERING, 2, ACTION_NEXT);
  await assertConvergence(runtime, { phase: PHASE_ANSWERING, version: trueFalse.version, currentQuestionIndex: 2 }, "true-false answering");
  await fetchMediaBurst(runtime, "true-false");
  const trueFalseAccepted = await submitAnswerBurst(runtime, "true-false", questions[2].correctOptionIds);
  const trueFalseResults = await hostAction(runtime, ACTION_REVEAL);
  assertHostPhase(trueFalseResults, PHASE_RESULTS, 2, ACTION_REVEAL);
  runtime.answerRounds.push({
    label: "true-false",
    expected: runtime.config.players,
    observed: Number(trueFalseResults.answerCount),
    accepted: trueFalseAccepted
  });
  await assertConvergence(runtime, {
    phase: PHASE_RESULTS,
    version: trueFalseResults.version,
    currentQuestionIndex: 2,
    answerCount: runtime.config.players
  }, "true-false results");
  progress(runtime, `bursts complete answers=${quizAccepted + trueFalseAccepted} media_fetches=${runtime.config.players * questions.length}`);

  await runSoak(runtime);
}

function assertHostPhase(session, phase, questionIndex, action) {
  if (session.phase !== phase || session.currentQuestionIndex !== questionIndex) {
    throw new Error(`Host ${action} produced phase=${session.phase}, question=${session.currentQuestionIndex}; expected phase=${phase}, question=${questionIndex}.`);
  }
}

export async function endSessionForCleanup(endAction) {
  try {
    return await endAction({ discardActiveRound: false });
  } catch (gracefulError) {
    try {
      return await endAction({ discardActiveRound: true });
    } catch (forcedError) {
      throw new AggregateError([gracefulError, forcedError], "The readiness session could not be ended during cleanup.");
    }
  }
}

async function cleanupReadinessRun(runtime) {
  progress(runtime, "cleanup started");
  if (runtime.pin && runtime.authenticated && !runtime.ended) {
    try {
      const ended = await endSessionForCleanup((body) => hostAction(runtime, ACTION_END, body));
      if (ended.phase !== PHASE_ENDED) {
        throw new Error("End action did not move the session to ended state.");
      }
      if (runtime.streams.length === runtime.config.players && activeStreamCount(runtime.streams) === runtime.config.players) {
        await assertConvergence(runtime, { phase: PHASE_ENDED, version: ended.version }, "ended");
      }
    } catch (error) {
      recordMetricError(runtime, "cleanup", "session-end", error);
    }
  }

  await closeAllStreams(runtime);

  if (runtime.media && runtime.authenticated) {
    try {
      await jsonRequest(runtime, {
        label: "media-delete",
        path: `/api/media/${encodeURIComponent(runtime.media.id)}`,
        method: "DELETE",
        mutation: true,
        jar: runtime.hostJar,
        csrfToken: runtime.csrfToken,
        expectedStatuses: [HTTP_OK]
      });
    } catch (error) {
      recordMetricError(runtime, "cleanup", "media-delete", error);
    }
  }

  if (runtime.authenticated) {
    try {
      await jsonRequest(runtime, {
        label: "logout",
        path: "/api/logout",
        method: "POST",
        mutation: true,
        jar: runtime.hostJar,
        csrfToken: runtime.csrfToken,
        expectedStatuses: [HTTP_OK]
      });
    } catch (error) {
      recordMetricError(runtime, "cleanup", "logout", error);
    }
  }
}

export async function runReadiness(config, dependencies = {}) {
  const runtime = createRuntime(config, dependencies);
  const runId = randomUUID();
  try {
    progress(runtime, `starting players=${config.players} soak_seconds=${config.soakSeconds}`);
    await authenticatePresenter(runtime);
    progress(runtime, "presenter authenticated");
    const media = await uploadReadinessMedia(runtime);
    const questions = buildReadinessQuestions(media);
    await createDirectSession(runtime, questions, runId);
    progress(runtime, "disposable live session created");
    await joinPlayers(runtime, runId);
    progress(runtime, `players joined count=${runtime.players.length}`);
    runtime.streams = await openPlayerStreams(runtime, runtime.players);
    await executeBattleSequence(runtime, questions);
  } catch (error) {
    const message = redactSecrets(safeErrorMessage(error), runtime.secrets);
    runtime.workflowErrors.push(message);
    progress(runtime, `workflow stopped: ${message}`);
  } finally {
    await cleanupReadinessRun(runtime);
  }

  const metrics = snapshotMetrics(runtime.metrics);
  const report = {
    players: config.players,
    soakSeconds: config.soakSeconds,
    answerRounds: runtime.answerRounds.map((round) => ({ ...round })),
    convergenceChecks: runtime.convergenceChecks.map((check) => ({ ...check })),
    reconnects: { ...runtime.reconnects },
    workflowErrors: [...runtime.workflowErrors],
    metrics
  };
  report.failures = evaluateReadiness(report);
  report.passed = report.failures.length === 0;
  return report;
}

function formatStatusCounts(statusCounts) {
  const entries = Object.entries(statusCounts);
  return entries.length === 0 ? "none" : entries.map(([status, count]) => `${status}:${count}`).join(",");
}

function formatErrorCounts(errorCounts) {
  return ERROR_CATEGORIES.map((category) => `${category}:${Number(errorCounts[category] ?? 0)}`).join(",");
}

function printReport(report, output = console) {
  const latency = report.metrics.latency;
  const answered = report.answerRounds.reduce((total, round) => total + Number(round.observed), 0);
  const expectedAnswers = report.answerRounds.reduce((total, round) => total + Number(round.expected), 0);
  output.log(
    `[readiness] ${report.passed ? "PASS" : "FAIL"} players=${report.players} reconnects=${report.reconnects.completed}/${report.reconnects.required} answers=${answered}/${expectedAnswers}`
  );
  output.log(
    `[readiness] requests=${report.metrics.totalRequests} statuses=${formatStatusCounts(report.metrics.statusCounts)} errors=${formatErrorCounts(report.metrics.errorCounts)} latency_ms=p50:${latency.p50},p95:${latency.p95},max:${latency.max}`
  );
  for (const failure of report.failures) {
    output.error(`[readiness] gate: ${failure}`);
  }
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, output = console } = {}) {
  let config;
  try {
    config = parseConfig({ argv, env });
  } catch (error) {
    output.error(`[readiness] configuration error: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
    return null;
  }
  if (config.help) {
    output.log(HELP_TEXT);
    return null;
  }
  const report = await runReadiness(config, {
    fetchImpl,
    log: (message) => output.log(message),
    errorLog: (message) => output.error(message)
  });
  printReport(report, output);
  process.exitCode = report.passed ? 0 : 1;
  return report;
}

export function isDirectExecution(metaUrl = import.meta.url, scriptPath = process.argv[1]) {
  if (!scriptPath) {
    return false;
  }
  try {
    return pathToFileURL(resolve(scriptPath)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main().catch((error) => {
    console.error(`[readiness] fatal: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
