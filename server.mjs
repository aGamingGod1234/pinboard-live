import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, createHmac, createPublicKey, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual, verify } from "node:crypto";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import QRCode from "qrcode";
import {
  DEFAULT_BODY_LIMITS,
  bodyLimitForRoute,
  createSecurityHeaders,
  createTokenBucketLimiter,
  detectMediaMimeType,
  isStrictStableId,
  isTrustedOrigin,
  resolveClientAddress,
  shouldPersistPresenterSession,
  validateMediaDataUrl,
  validateBodyByteLength,
  validateContentLength
} from "./src/http-security.mjs";
import {
  DomainError,
  endSession as endSessionDomain,
  recordAnswer,
  scoreCurrentQuestion as scoreCurrentQuestionDomain,
  setPlayerPresence
} from "./src/session-domain.mjs";

const BYTE = 1;
const KIB = 1024 * BYTE;
const MIB = 1024 * KIB;
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_LOCAL_AUTH_SECRET = "local-development-secret-change-me";
const DEFAULT_LOCAL_PRESENTER_EMAIL = "presenter@pinboard.local";
const DEFAULT_LOCAL_PRESENTER_PASSWORD = "local-presenter-password";
const DEFAULT_PRESENTER_NAME = "Presenter";
const DUPLICATE_TITLE_SUFFIX = " copy";
const GAME_PIN_LENGTH = 6;
const MIN_OPTION_COUNT = 2;
const MAX_OPTION_COUNT = 6;
const MAX_QUESTION_COUNT = 200;
const MAX_TITLE_LENGTH = 120;
const MAX_PRESENTER_NAME_LENGTH = 120;
const MAX_QUESTION_TEXT_LENGTH = 120;
const MAX_OPTION_TEXT_LENGTH = 64;
const DEFAULT_TIMER_SECONDS = 30;
const MIN_TIMER_SECONDS = 5;
const MAX_TIMER_SECONDS = 300;
const MAX_NICKNAME_LENGTH = 32;
const MAX_POINTS = 1_000_000;
const MAX_MEDIA_BYTES = Number(process.env.MAX_QUESTION_MEDIA_BYTES ?? 100 * MIB);
const MAX_MEDIA_STORAGE_BYTES_PER_PRESENTER = Number(process.env.MAX_MEDIA_STORAGE_BYTES_PER_PRESENTER ?? 1024 * MIB);
const MAX_MEDIA_ASSETS_PER_PRESENTER = Number(process.env.MAX_MEDIA_ASSETS_PER_PRESENTER ?? 500);
const SSE_HEARTBEAT_MS = 25_000;
const MAX_SSE_BUFFERED_BYTES = 64 * KIB;
const SESSION_EVENTS_CHANNEL = "pinboard_session_events";
const SESSION_LISTENER_RETRY_MS = 5_000;
const SERVER_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const SERVER_HEADERS_TIMEOUT_MS = 30_000;
const SERVER_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const SESSION_LOCK_TIMEOUT_MS = 5_000;
const SESSION_STATEMENT_TIMEOUT_MS = 15_000;
const SESSION_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;
const SESSION_TIMER_RETRY_MS = 1_000;
const RECENT_PLAYER_LIMIT = 80;
const LEADERBOARD_LIMIT = 20;
const PASSWORD_KEY_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const PRESENTER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRESENTER_COOKIE = "pinboard_presenter";
const PRESENTER_TOKEN_VERSION = 2;
const PRESENTER_TOKEN_BYTES = 32;
const BASE64URL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PLAYER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const ENDED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
const ACTIVE_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ORPHAN_MEDIA_RETENTION_DAYS = 7;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_JSON_BODY_LIMIT = DEFAULT_BODY_LIMITS.AUTH;
const AUTH_RATE_CAPACITY = 10;
const AUTH_RATE_REFILL_INTERVAL_MS = 60_000;
const PLAYER_JOIN_RATE_CAPACITY = 600;
const PLAYER_JOIN_IP_RATE_CAPACITY = 240;
const PLAYER_ACTION_RATE_CAPACITY = 120;
const EVENT_STREAM_RATE_CAPACITY = 12;
const PRESENTER_REQUEST_RATE_CAPACITY = 300;
const MEDIA_REQUEST_RATE_CAPACITY = 12;
const MEDIA_UPLOAD_RATE_CAPACITY = 6;
const QR_REQUEST_RATE_CAPACITY = 30;
const PLAYER_RATE_REFILL_INTERVAL_MS = 60_000;
const MAX_CONCURRENT_MEDIA_REQUESTS = 8;
const MAX_CONCURRENT_MEDIA_REQUESTS_PER_PRINCIPAL = 2;
const MEDIA_RESPONSE_TIMEOUT_MS = 60_000;
const MEDIA_STREAM_CHUNK_BYTES = 1 * MIB;
const MAX_CONCURRENT_MEDIA_UPLOADS = 2;
const MAX_CONCURRENT_MEDIA_UPLOADS_PER_PRESENTER = 1;
const MAX_PLAYERS_PER_SESSION = Number(process.env.MAX_PLAYERS_PER_SESSION ?? 5_000);
const MAX_SSE_CONNECTIONS_PER_PRINCIPAL = 3;
const MAX_SSE_CLIENTS_PER_SESSION = MAX_PLAYERS_PER_SESSION + 16;
const MAX_MEDIA_NAME_LENGTH = 180;
const SAFE_LEGACY_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_TOKEN_MAX_LENGTH = 4096;
const GOOGLE_JWKS_DEFAULT_TTL_MS = 60 * 60 * 1000;
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const HOST_SESSION_ACTIONS = new Set(["start", "open", "reveal", "next", "end"]);
const PLAYER_COOKIE_REQUIRED_ACTIONS = new Set(["answer", "leave"]);
const SESSION_ACTIONS = new Set(["join", "resume", "answer", "leave", ...HOST_SESSION_ACTIONS]);

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? DEFAULT_HOST;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const AUTH_SECRET = process.env.AUTH_SECRET ?? (IS_PRODUCTION ? "" : DEFAULT_LOCAL_AUTH_SECRET);
const BOOTSTRAP_PRESENTER_EMAIL = normalizeEmail(process.env.PRESENTER_EMAIL ?? (IS_PRODUCTION ? "" : DEFAULT_LOCAL_PRESENTER_EMAIL));
const BOOTSTRAP_PRESENTER_PASSWORD = process.env.PRESENTER_PASSWORD ?? (IS_PRODUCTION ? "" : DEFAULT_LOCAL_PRESENTER_PASSWORD);
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? "";
const GOOGLE_ALLOWED_EMAILS = new Set(
  (process.env.GOOGLE_ALLOWED_EMAILS ?? "").split(",").map(normalizeEmail).filter(Boolean)
);
const GOOGLE_ALLOWED_DOMAINS = new Set(
  (process.env.GOOGLE_ALLOWED_DOMAINS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean)
);
if (BOOTSTRAP_PRESENTER_EMAIL) {
  GOOGLE_ALLOWED_EMAILS.add(BOOTSTRAP_PRESENTER_EMAIL);
}
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? "";
const ALLOW_INSECURE_LOCAL_AUTH = process.env.ALLOW_INSECURE_LOCAL_AUTH === "true";
const TRUST_PROXY = process.env.TRUST_PROXY === "true" || Boolean(process.env.RAILWAY_ENVIRONMENT);
const INSTANCE_ID = randomUUID();
const scryptAsync = promisify(scrypt);
const { Pool } = pg;

/** @typedef {"lobby" | "question" | "answering" | "results" | "ended"} Phase */
/** @typedef {"quiz" | "true_false" | "slide"} QuestionKind */
/** @typedef {{ id: string, text: string }} Option */
/** @typedef {{ id: string, name: string, type: string, size: number, url: string }} MediaAsset */
/** @typedef {{ id: string, kind: QuestionKind, text: string, points: number, timerSeconds: number, options: Option[], correctOptionIds: string[], media: MediaAsset | null }} Question */
/** @typedef {{ id: string, nickname: string, score: number, joinedAt: number, connected: boolean, lastSeenAt: number, resumeTokenHash: string, leftAt: number | null }} Player */
/** @typedef {{ selectedOptionIds: string[], answeredAt: number }} Answer */
/** @typedef {{ id: string, response: import("node:http").ServerResponse, role: "host" | "player", playerId: string | null, playerTokenHash: string | null, presenterTokenHash: string | null, heartbeat: NodeJS.Timeout | null, backpressured: boolean, pendingStatePayload: string | null, pendingAnswerPayload: string | null, drainHandler: (() => void) | null }} Client */
/** @typedef {{ id: string, email: string, name: string, passwordHash: string, googleSub?: string | null }} Presenter */
/** @typedef {{ id: string, presenterId: string, title: string, snapshot: { title: string, questions: Question[] }, createdAt: string, updatedAt: string, version: number }} Presentation */
/** @typedef {{ pin: string, title: string, presenterId: string, questions: Question[], phase: Phase, currentQuestionIndex: number, players: Map<string, Player>, answers: Map<string, Answer>, scoredQuestionIndexes: Set<number>, openedAt: number | null, clients: Map<string, Client>, endedReason: string | null, endedAt: number | null, createdAt: number, version: number }} Session */

const staticRoutes = new Map([
  ["/", { path: new URL("./public/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/index.html", { path: new URL("./public/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/styles.css", { path: new URL("./public/styles.css", import.meta.url), type: "text/css; charset=utf-8" }],
  ["/app.js", { path: new URL("./public/app.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/client-state.js", { path: new URL("./public/client-state.js", import.meta.url), type: "text/javascript; charset=utf-8" }]
]);
const STATIC_CACHE_CONTROL = "no-store";

const database = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
/** @type {Map<string, Presenter>} */
const localPresentersByEmail = new Map();
/** @type {Map<string, Presentation>} */
const localPresentationsById = new Map();
/** @type {Map<string, { id: string, presenterId: string, name: string, mimeType: string, sizeBytes: number, data: Buffer }>} */
const localMediaAssetsById = new Map();
/** @type {Map<string, Session>} */
const sessions = new Map();
const timerHandlesByPin = new Map();
const sessionMutationQueues = new Map();
const sessionMutationStorage = new AsyncLocalStorage();
let sessionEventListener = null;
let sessionEventListenerRetry = null;
let dummyPasswordHash = "";
/** @type {Map<string, { presenterId: string, csrfToken: string, expiresAt: number }>} */
const localPresenterSessions = new Map();
/** @type {{ expiresAt: number, keys: Map<string, JsonWebKey> }} */
const googleJwksCache = { expiresAt: 0, keys: new Map() };
const authRateLimiter = createTokenBucketLimiter({
  capacity: AUTH_RATE_CAPACITY,
  refillTokens: AUTH_RATE_CAPACITY,
  refillIntervalMs: AUTH_RATE_REFILL_INTERVAL_MS
});
const playerJoinRateLimiter = createTokenBucketLimiter({
  capacity: PLAYER_JOIN_RATE_CAPACITY,
  refillTokens: PLAYER_JOIN_RATE_CAPACITY,
  refillIntervalMs: PLAYER_RATE_REFILL_INTERVAL_MS
});
const playerJoinIpRateLimiter = createTokenBucketLimiter({
  capacity: PLAYER_JOIN_IP_RATE_CAPACITY,
  refillTokens: PLAYER_JOIN_IP_RATE_CAPACITY,
  refillIntervalMs: PLAYER_RATE_REFILL_INTERVAL_MS
});
const playerActionRateLimiter = createTokenBucketLimiter({
  capacity: PLAYER_ACTION_RATE_CAPACITY,
  refillTokens: PLAYER_ACTION_RATE_CAPACITY,
  refillIntervalMs: PLAYER_RATE_REFILL_INTERVAL_MS
});
const eventStreamRateLimiter = createTokenBucketLimiter({
  capacity: EVENT_STREAM_RATE_CAPACITY,
  refillTokens: EVENT_STREAM_RATE_CAPACITY,
  refillIntervalMs: PLAYER_RATE_REFILL_INTERVAL_MS
});
const presenterRequestRateLimiter = createTokenBucketLimiter({
  capacity: PRESENTER_REQUEST_RATE_CAPACITY,
  refillTokens: PRESENTER_REQUEST_RATE_CAPACITY,
  refillIntervalMs: PLAYER_RATE_REFILL_INTERVAL_MS
});
const mediaRequestRateLimiter = createTokenBucketLimiter({
  capacity: MEDIA_REQUEST_RATE_CAPACITY,
  refillTokens: MEDIA_REQUEST_RATE_CAPACITY,
  refillIntervalMs: PLAYER_RATE_REFILL_INTERVAL_MS
});
const mediaUploadRateLimiter = createTokenBucketLimiter({
  capacity: MEDIA_UPLOAD_RATE_CAPACITY,
  refillTokens: MEDIA_UPLOAD_RATE_CAPACITY,
  refillIntervalMs: PLAYER_RATE_REFILL_INTERVAL_MS
});
const qrRequestRateLimiter = createTokenBucketLimiter({
  capacity: QR_REQUEST_RATE_CAPACITY,
  refillTokens: QR_REQUEST_RATE_CAPACITY,
  refillIntervalMs: PLAYER_RATE_REFILL_INTERVAL_MS
});
const activeMediaRequestsByPrincipal = new Map();
let activeMediaRequestCount = 0;
const activeMediaUploadsByPresenter = new Map();
let activeMediaUploadCount = 0;

class HttpError extends Error {
  constructor(statusCode, message, code = "REQUEST_FAILED") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  request.requestId = requestId;
  applyResponseSecurityHeaders(response, requestId);
  try {
    enforceMutationOrigin(request);
    enforceRequestRateLimit(request);
    await routeRequest(request, response);
  } catch (error) {
    handleRouteError(response, error, requestId);
  }
});
server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;

startServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function startServer() {
  validateStartupConfig();
  dummyPasswordHash = await createPasswordHash(randomBytes(32).toString("base64url"));
  await initializeDatabase();
  await startSessionEventListener();
  await bootstrapPresenter();
  await cleanupExpiredState();
  setInterval(() => {
    void cleanupExpiredState().catch((error) => logBackgroundError("session cleanup", error));
  }, SESSION_CLEANUP_INTERVAL_MS).unref();

  server.listen(PORT, HOST, () => {
    console.log(`Pinboard Live running at http://localhost:${PORT}`);
    console.log(`Presenter email: ${BOOTSTRAP_PRESENTER_EMAIL}`);
  });
}

async function startSessionEventListener() {
  if (!database || sessionEventListener) {
    return;
  }
  const client = await database.connect();
  try {
    await client.query(`LISTEN ${SESSION_EVENTS_CHANNEL}`);
  } catch (error) {
    client.release(true);
    throw error;
  }
  sessionEventListener = client;
  client.on("notification", (notification) => {
    void handleSessionEventNotification(notification)
      .catch((error) => logBackgroundError("session event notification", error));
  });
  client.on("error", (error) => {
    logBackgroundError("session event listener", error);
    if (sessionEventListener === client) {
      sessionEventListener = null;
      client.release(true);
      scheduleSessionEventListenerRetry();
    }
  });
  await refreshCachedSessionsAfterListenerStart();
}

function scheduleSessionEventListenerRetry() {
  if (sessionEventListenerRetry || !database) {
    return;
  }
  sessionEventListenerRetry = setTimeout(() => {
    sessionEventListenerRetry = null;
    void startSessionEventListener().catch((error) => {
      logBackgroundError("session event listener reconnect", error);
      scheduleSessionEventListenerRetry();
    });
  }, SESSION_LISTENER_RETRY_MS);
  sessionEventListenerRetry.unref();
}

async function handleSessionEventNotification(notification) {
  if (notification.channel !== SESSION_EVENTS_CHANNEL || !notification.payload) {
    return;
  }
  let event;
  try {
    event = JSON.parse(notification.payload);
  } catch {
    return;
  }
  if (event.origin === INSTANCE_ID || typeof event.pin !== "string" || !/^\d{6}$/.test(event.pin)) {
    return;
  }
  if (!sessions.has(event.pin)) {
    return;
  }
  if (event.type === "answer") {
    if (!Number.isSafeInteger(event.version)
      || !Number.isSafeInteger(event.questionIndex)
      || !isStrictStableId(event.playerId)
      || !Array.isArray(event.selectedOptionIds)
      || event.selectedOptionIds.length === 0
      || event.selectedOptionIds.some((id) => !isStrictStableId(id))
      || !Number.isFinite(event.answeredAt)) {
      return;
    }
    await enqueueSessionOperation(event.pin, () => applyCompactAnswerUpdate(event));
    return;
  }
  await enqueueSessionOperation(event.pin, () => refreshCachedSession(event.pin));
}

async function refreshCachedSessionsAfterListenerStart() {
  for (const pin of [...sessions.keys()]) {
    try {
      await enqueueSessionOperation(pin, () => refreshCachedSession(pin));
    } catch (error) {
      logBackgroundError(`session refresh after listener reconnect (${pin})`, error);
    }
  }
}

async function refreshCachedSession(pin) {
  const previous = sessions.get(pin);
  if (previous) {
    clearQuestionTimer(previous);
  }
  try {
    const refreshed = await loadPersistedSession(pin);
    if (!refreshed) {
      closeSessionClients(previous);
      sessions.delete(pin);
      return;
    }
    pruneRevokedPlayerClients(refreshed);
    scheduleQuestionTimer(refreshed);
    broadcastStateNow(refreshed);
  } catch (error) {
    if (previous) {
      sessions.set(pin, previous);
      scheduleQuestionTimer(previous);
    }
    throw error;
  }
}

async function notifySessionChanged(session) {
  if (!database) {
    return;
  }
  await database.query("SELECT pg_notify($1, $2)", [
    SESSION_EVENTS_CHANNEL,
    JSON.stringify({ pin: session.pin, origin: INSTANCE_ID, version: session.version })
  ]);
}

function logBackgroundError(scope, error) {
  console.error(`[${scope}]`, error instanceof Error ? error.message : error);
}

async function routeRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    if (database) {
      await database.query("SELECT 1");
    }
    sendJson(response, 200, { ok: true, database: database ? "postgres" : "memory" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    await handleEventStream(request, response, url);
    return;
  }

  if (request.method === "GET" && url.pathname === "/auth/google") {
    await handleGoogleAuthStart(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/auth/google/callback") {
    await handleGoogleAuthCallback(request, response, url);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth") {
    await handleAuth(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/google") {
    await handleGoogleCredentialAuth(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    await handleLogout(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    await handleCurrentPresenter(request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      googleClientId: GOOGLE_CLIENT_ID,
      localAuthEnabled: Boolean(BOOTSTRAP_PRESENTER_EMAIL && BOOTSTRAP_PRESENTER_PASSWORD)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/media") {
    await handleCreateMedia(request, response);
    return;
  }

  const mediaMatch = url.pathname.match(/^\/api\/media\/([0-9a-f-]{36})$/);
  if (mediaMatch && isStrictStableId(mediaMatch[1])) {
    if (request.method === "GET" || request.method === "HEAD") {
      await handleGetMedia(request, response, mediaMatch[1]);
      return;
    }
    if (request.method === "DELETE") {
      await handleDeleteMedia(request, response, mediaMatch[1]);
      return;
    }
  }

  if (url.pathname === "/api/presentations") {
    if (request.method === "GET") {
      await handleListPresentations(request, response);
      return;
    }
    if (request.method === "POST") {
      await handleCreatePresentation(request, response);
      return;
    }
  }

  const presentationMatch = url.pathname.match(/^\/api\/presentations\/([0-9a-fA-F-]{36})$/);
  if (presentationMatch) {
    if (request.method === "GET") {
      await handleGetPresentation(request, response, presentationMatch[1]);
      return;
    }
    if (request.method === "PUT") {
      await handleUpdatePresentation(request, response, presentationMatch[1]);
      return;
    }
    if (request.method === "DELETE") {
      await handleDeletePresentation(request, response, presentationMatch[1]);
      return;
    }
  }

  const presentationActionMatch = url.pathname.match(/^\/api\/presentations\/([0-9a-fA-F-]{36})\/([a-z-]+)$/);
  if (presentationActionMatch) {
    if (request.method === "POST" && presentationActionMatch[2] === "duplicate") {
      await handleDuplicatePresentation(request, response, presentationActionMatch[1]);
      return;
    }
    throw new HttpError(404, "Presentation action was not found.");
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    await handleCreateSession(request, response);
    return;
  }

  const qrMatch = url.pathname.match(/^\/api\/sessions\/(\d{6})\/qr\.svg$/);
  if (request.method === "GET" && qrMatch) {
    await handleSessionQr(request, response, qrMatch[1]);
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/sessions\/(\d{6})\/([a-z-]+)$/);
  if (request.method === "POST" && actionMatch) {
    await handleSessionAction(request, response, actionMatch[1], actionMatch[2]);
    return;
  }

  if (request.method === "GET") {
    await serveStatic(response, url.pathname);
    return;
  }

  throw new HttpError(405, "Method not allowed.");
}

async function handleAuth(request, response) {
  const body = await readJson(request);
  const email = normalizeEmail(readString(body.email, "Email"));
  const password = readString(body.password, "Password");
  const presenter = await findPresenterByEmail(email);
  const passwordMatches = await verifyPassword(password, presenter?.passwordHash || dummyPasswordHash);
  if (!presenter || !passwordMatches) {
    throw new HttpError(401, "Email or password is not valid.");
  }

  await establishPresenterSession(response, presenter, shouldPersistPresenterSession(body.keepSignedIn));
}

async function handleGoogleAuthStart(request, response) {
  assertGoogleOAuthConfigured();
  const state = randomBytes(24).toString("base64url");
  const redirectUri = getGoogleRedirectUri(request);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
    state
  });

  setCookie(response, "pinboard_oauth_state", state, { maxAge: 600 });
  response.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  response.end();
}

async function handleGoogleAuthCallback(request, response, url) {
  assertGoogleOAuthConfigured();
  const expectedState = readCookies(request).pinboard_oauth_state;
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const error = url.searchParams.get("error");

  clearCookie(response, "pinboard_oauth_state");

  if (error) {
    throw new HttpError(400, `Google sign-in failed: ${error}`);
  }

  if (!code || !expectedState || state !== expectedState) {
    throw new HttpError(400, "Google sign-in state is not valid.");
  }

  const token = await exchangeGoogleCode(request, code);
  const profile = await fetchGoogleProfile(token.access_token);
  if (!profile.email_verified) {
    throw new HttpError(403, "Google email must be verified.");
  }

  const presenter = await findOrCreateGooglePresenter(profile);
  await establishPresenterSession(response, presenter, true, { redirect: true });
}

async function handleGoogleCredentialAuth(request, response) {
  assertGoogleClientIdConfigured();
  const body = await readJson(request);
  const credential = readString(body.credential, "Google credential");
  const profile = await verifyGoogleCredentialToken(credential);
  const presenter = await findOrCreateGooglePresenter(profile);

  await establishPresenterSession(response, presenter, shouldPersistPresenterSession(body.keepSignedIn));
}

async function handleCurrentPresenter(request, response) {
  const authentication = await readPresenterAuthentication(request);
  if (!authentication) {
    sendJson(response, 200, { presenter: null, csrfToken: null });
    return;
  }
  request.presenterAuth = authentication.session;
  const presenter = await findPresenterById(authentication.session.presenterId);
  if (!presenter) {
    localPresenterSessions.delete(authentication.tokenHash);
    if (database) {
      await database.query("DELETE FROM presenter_sessions WHERE token_hash = $1", [authentication.tokenHash]);
    }
    clearCookie(response, PRESENTER_COOKIE);
    sendJson(response, 200, { presenter: null, csrfToken: null });
    return;
  }
  sendJson(response, 200, {
    presenter: serializePresenter(presenter),
    csrfToken: request.presenterAuth.csrfToken
  });
}

async function handleLogout(request, response) {
  const authentication = await readPresenterAuthentication(request);
  if (authentication) {
    assertCsrfToken(request, authentication.session);
    revokePresenterStreams(authentication.tokenHash);
    localPresenterSessions.delete(authentication.tokenHash);
    if (database) {
      await database.query("DELETE FROM presenter_sessions WHERE token_hash = $1", [authentication.tokenHash]);
    }
  }
  clearCookie(response, PRESENTER_COOKIE);
  sendJson(response, 200, { ok: true });
}

async function handleListPresentations(request, response) {
  const presenter = await requireCurrentPresenter(request);
  const presentations = await listPresentationsForPresenter(presenter.id);
  sendJson(response, 200, { presentations: presentations.map(serializePresentationSummary) });
}

async function handleCreatePresentation(request, response) {
  const presenter = await requireCurrentPresenter(request, { requireCsrf: true });
  const presentation = await createPresentationForPresenter(presenter.id, createBlankPresentationSnapshot());
  sendJson(response, 201, { presentation: serializePresentation(presentation) });
}

async function handleGetPresentation(request, response, presentationId) {
  const presenter = await requireCurrentPresenter(request);
  const presentation = await getPresentationForPresenter(presenter.id, presentationId);
  sendJson(response, 200, { presentation: serializePresentation(presentation) });
}

async function handleUpdatePresentation(request, response, presentationId) {
  const presenter = await requireCurrentPresenter(request, { requireCsrf: true });
  const body = await readJson(request);
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new HttpError(400, "A valid presentation version is required.", "PRESENTATION_VERSION_REQUIRED");
  }
  const snapshot = normalizePresentationSnapshot(body.snapshot);
  await assertPresenterOwnsMedia(presenter.id, snapshot.questions);
  const presentation = await updatePresentationForPresenter(presenter.id, presentationId, snapshot, expectedVersion);
  sendJson(response, 200, { presentation: serializePresentation(presentation) });
}

async function handleCreateMedia(request, response) {
  const presenter = await requireCurrentPresenter(request, { requireCsrf: true });
  const release = acquireMediaUpload(presenter.id);
  try {
    const declaredMimeType = normalizeMimeTypeHeader(request.headers["content-type"]);
    const data = await readRawBody(request, MAX_MEDIA_BYTES);
    const detectedMimeType = detectMediaMimeType(data);
    if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
      throw new HttpError(415, "Media type does not match the file contents.", "MEDIA_SIGNATURE_MISMATCH");
    }
    const name = readMediaFileName(request.headers["x-file-name"]);
    const asset = await createMediaAssetWithQuota({ presenterId: presenter.id, name, mimeType: detectedMimeType, data });
    sendJson(response, 201, { media: serializeMediaAsset(asset) });
  } finally {
    release();
  }
}

function acquireMediaUpload(presenterId) {
  const presenterCount = activeMediaUploadsByPresenter.get(presenterId) ?? 0;
  if (activeMediaUploadCount >= MAX_CONCURRENT_MEDIA_UPLOADS
    || presenterCount >= MAX_CONCURRENT_MEDIA_UPLOADS_PER_PRESENTER) {
    const error = new HttpError(429, "Another media upload is already active. Please retry.", "MEDIA_UPLOAD_CONCURRENCY_LIMIT");
    error.retryAfterSeconds = 1;
    throw error;
  }
  activeMediaUploadCount += 1;
  activeMediaUploadsByPresenter.set(presenterId, presenterCount + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeMediaUploadCount = Math.max(0, activeMediaUploadCount - 1);
    const remaining = (activeMediaUploadsByPresenter.get(presenterId) ?? 1) - 1;
    if (remaining <= 0) {
      activeMediaUploadsByPresenter.delete(presenterId);
    } else {
      activeMediaUploadsByPresenter.set(presenterId, remaining);
    }
  };
}

async function handleGetMedia(request, response, mediaId) {
  const release = acquireMediaRequest(request);
  response.setTimeout(MEDIA_RESPONSE_TIMEOUT_MS, () => response.destroy());
  try {
    const asset = await getMediaAssetMetadata(mediaId);
    if (!asset) {
      throw new HttpError(404, "Media was not found.", "MEDIA_NOT_FOUND");
    }
    await authorizeMediaRequest(request, asset);
    await sendMediaAsset(request, response, asset);
  } finally {
    release();
  }
}

function acquireMediaRequest(request) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const principal = getRequestPrincipalKey(request, url);
  const principalCount = activeMediaRequestsByPrincipal.get(principal) ?? 0;
  if (activeMediaRequestCount >= MAX_CONCURRENT_MEDIA_REQUESTS
    || principalCount >= MAX_CONCURRENT_MEDIA_REQUESTS_PER_PRINCIPAL) {
    const error = new HttpError(429, "Too many media requests are active. Please retry.", "MEDIA_CONCURRENCY_LIMIT");
    error.retryAfterSeconds = 1;
    throw error;
  }
  activeMediaRequestCount += 1;
  activeMediaRequestsByPrincipal.set(principal, principalCount + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeMediaRequestCount = Math.max(0, activeMediaRequestCount - 1);
    const remaining = (activeMediaRequestsByPrincipal.get(principal) ?? 1) - 1;
    if (remaining <= 0) {
      activeMediaRequestsByPrincipal.delete(principal);
    } else {
      activeMediaRequestsByPrincipal.set(principal, remaining);
    }
  };
}

async function handleDeleteMedia(request, response, mediaId) {
  const presenter = await requireCurrentPresenter(request, { requireCsrf: true });
  const deleted = await deleteMediaAsset(presenter.id, mediaId);
  if (!deleted) {
    throw new HttpError(404, "Media was not found.", "MEDIA_NOT_FOUND");
  }
  sendJson(response, 200, { ok: true });
}

async function handleDeletePresentation(request, response, presentationId) {
  const presenter = await requireCurrentPresenter(request, { requireCsrf: true });
  await deletePresentationForPresenter(presenter.id, presentationId);
  sendJson(response, 200, { ok: true });
}

async function handleDuplicatePresentation(request, response, presentationId) {
  const presenter = await requireCurrentPresenter(request, { requireCsrf: true });
  const presentation = await duplicatePresentationForPresenter(presenter.id, presentationId);
  sendJson(response, 201, { presentation: serializePresentation(presentation) });
}

async function handleCreateSession(request, response) {
  const presenter = await requireCurrentPresenter(request, { requireCsrf: true });
  const body = await readJson(request);
  const title = limitText(readString(body.title, "Deck title"), MAX_TITLE_LENGTH, "Deck title");
  const questions = normalizeQuestions(body.questions);
  await assertPresenterOwnsMedia(presenter.id, questions);
  const pin = await createUniquePin();

  /** @type {Session} */
  const session = {
    pin,
    title,
    presenterId: presenter.id,
    questions,
    phase: "lobby",
    currentQuestionIndex: -1,
    players: new Map(),
    answers: new Map(),
    scoredQuestionIndexes: new Set(),
    openedAt: null,
    clients: new Map(),
    endedReason: null,
    endedAt: null,
    createdAt: Date.now(),
    version: 0
  };

  sessions.set(pin, session);
  await persistSession(session);
  sendJson(response, 201, {
    pin,
    session: getStateForRole(session, "host", null)
  });
}

async function handleSessionQr(request, response, pin) {
  const session = await getSession(pin);
  await requireSessionHostEventToken(request, session);
  const origin = PUBLIC_ORIGIN || getRequestOrigin(request);
  const joinUrl = `${origin}/#player?pin=${pin}`;
  const svg = await QRCode.toString(joinUrl, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256
  });
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "image/svg+xml; charset=utf-8"
  });
  response.end(svg);
}

async function handleSessionAction(request, response, pin, action) {
  if (!SESSION_ACTIONS.has(action)) {
    throw new HttpError(404, "Session action was not found.");
  }
  const body = await readJson(request);
  const presenter = HOST_SESSION_ACTIONS.has(action)
    ? await requireCurrentPresenter(request, { requireCsrf: true })
    : null;
  const playerTokenHash = PLAYER_COOKIE_REQUIRED_ACTIONS.has(action)
    ? readSessionPlayerTokenHash(request, pin)
    : readOptionalSessionPlayerTokenHash(request, pin);
  if (database && action === "answer") {
    const answer = await handleConcurrentDatabaseAnswer(pin, body, playerTokenHash);
    if (!answer.fallback) {
      sendJson(response, 200, answer.payload);
      return;
    }
  }
  const result = await withSessionMutation(pin, () => handleSessionActionLocked({
    action,
    body,
    pin,
    playerTokenHash,
    presenter
  }));
  if (result.playerCookie) {
    setCookie(response, getPlayerCookieName(pin), result.playerCookie, { maxAge: PLAYER_SESSION_TTL_SECONDS });
  }
  if (result.clearPlayerCookie) {
    clearCookie(response, getPlayerCookieName(pin));
  }
  sendJson(response, result.statusCode, {
    ...result.payload,
    session: result.includeSession === false
      ? undefined
      : getStateForRole(result.session, result.role, result.playerId)
  });
}

async function handleSessionActionLocked({ action, body, pin, playerTokenHash, presenter }) {
  const session = await getSession(pin);

  switch (action) {
    case "join":
      return handleJoin(body, session);
    case "resume":
      return handleResume(body, playerTokenHash, session);
    case "answer":
      return handleAnswer(body, playerTokenHash, session);
    case "leave":
      return handleLeave(playerTokenHash, session);
    case "start":
      assertSessionHostPresenter(presenter, session);
      startSession(session);
      break;
    case "open":
      assertSessionHostPresenter(presenter, session);
      openAnswers(session);
      break;
    case "reveal":
      assertSessionHostPresenter(presenter, session);
      revealAnswers(session, "manual");
      break;
    case "next":
      assertSessionHostPresenter(presenter, session);
      advanceSession(session);
      break;
    case "end":
      assertSessionHostPresenter(presenter, session);
      handleEndSession(body, session);
      break;
    default:
      throw new HttpError(404, "Session action was not found.");
  }

  await persistSession(session);
  if (action === "reveal") {
    await persistPlayers(session);
  }
  broadcastState(session);
  return createSessionActionResult(session, "host", null);
}

async function handleJoin(body, session) {
  assertPresenterOnline(session);
  const nickname = limitText(readString(body.nickname, "Nickname"), MAX_NICKNAME_LENGTH, "Nickname");
  const activePlayers = [...session.players.values()].filter(isActivePlayer);
  const existingPlayer = activePlayers.find(
    (player) => player.nickname.toLocaleLowerCase() === nickname.toLocaleLowerCase()
  );
  const resumeToken = createPlayerResumeToken();
  if (existingPlayer) {
    throw new HttpError(409, "That nickname is already in use.", "NICKNAME_TAKEN");
  }
  if (activePlayers.length >= MAX_PLAYERS_PER_SESSION) {
    throw new HttpError(409, "This session has reached its player limit.", "SESSION_PLAYER_LIMIT");
  }
  const player = {
    id: randomUUID(),
    nickname: nickname.trim(),
    score: 0,
    joinedAt: Date.now(),
    connected: true,
    lastSeenAt: Date.now(),
    resumeTokenHash: hashSecret(resumeToken),
    leftAt: null
  };

  if (!player.nickname) {
    throw new HttpError(400, "Nickname is required.");
  }

  session.players.set(player.id, player);
  await persistPlayer(session, player);
  broadcastState(session);
  return createSessionActionResult(session, "player", player.id, {
    statusCode: 201,
    payload: { playerId: player.id },
    playerCookie: resumeToken
  });
}

async function handleResume(body, playerTokenHash, session) {
  assertPresenterOnline(session);
  let player;
  let migratedResumeToken = "";
  try {
    player = requireSessionPlayerByTokenHash(playerTokenHash, session);
  } catch (error) {
    const legacyPlayerId = typeof body.legacyPlayerId === "string" ? body.legacyPlayerId : "";
    const legacyPlayer = isStrictStableId(legacyPlayerId) ? session.players.get(legacyPlayerId) : null;
    if (!(error instanceof HttpError) || error.statusCode !== 401 || !legacyPlayer || legacyPlayer.resumeTokenHash || !isActivePlayer(legacyPlayer)) {
      throw error;
    }
    migratedResumeToken = createPlayerResumeToken();
    legacyPlayer.resumeTokenHash = hashSecret(migratedResumeToken);
    player = legacyPlayer;
  }
  applySessionState(session, setPlayerPresence(session, { playerId: player.id, connected: true, now: Date.now() }));
  await persistPlayerPresence(session, session.players.get(player.id));
  broadcastState(session);
  return createSessionActionResult(session, "player", player.id, {
    payload: { playerId: player.id },
    playerCookie: migratedResumeToken || null
  });
}

function normalizeSubmittedOptionIds(body, question) {
  const source = Array.isArray(body.selectedOptionIds)
    ? body.selectedOptionIds
    : typeof body.optionId === "string" ? [body.optionId] : [];
  const selectedOptionIds = source.map((id, index) => readString(id, `Selected option ${index + 1}`));
  const uniqueIds = [...new Set(selectedOptionIds)];
  const validIds = new Set(question?.options?.map((option) => option.id) ?? []);
  const requiredCount = question?.correctOptionIds?.length ?? 1;
  if (uniqueIds.length !== requiredCount || uniqueIds.length !== selectedOptionIds.length || uniqueIds.some((id) => !validIds.has(id))) {
    throw new HttpError(400, `Select exactly ${requiredCount} answer${requiredCount === 1 ? "" : "s"}.`, "INVALID_SELECTION");
  }
  return uniqueIds;
}

async function handleAnswer(body, playerTokenHash, session) {
  const player = requireSessionPlayerByTokenHash(playerTokenHash, session);
  const playerId = player.id;
  const question = getCurrentQuestion(session);

  if (session.phase !== "answering" && session.phase !== "question") {
    throw new HttpError(409, "Answers are not open.");
  }

  if (!question || question.kind === "slide") {
    throw new HttpError(409, "This slide does not accept answers.");
  }

  const selectedOptionIds = normalizeSubmittedOptionIds(body, question);

  const phaseChanged = session.phase === "question";
  if (phaseChanged) {
    session.phase = "answering";
    session.openedAt = session.openedAt ?? Date.now();
    scheduleQuestionTimer(session);
  }

  const result = recordAnswer(session, { playerId, selectedOptionIds, now: Date.now() });
  applySessionState(session, result.session);

  if (result.outcome.duplicate) {
    return createSessionActionResult(session, "player", playerId, {
      payload: result.outcome
    });
  }

  const inserted = await persistAnswer(session, playerId, session.answers.get(playerId));
  if (!inserted) {
    const existing = await getPersistedAnswer(session.pin, session.currentQuestionIndex, playerId);
    if (existing) {
      session.answers.set(playerId, existing);
    }
    return createSessionActionResult(session, "player", playerId, {
      payload: { accepted: false, duplicate: true }
    });
  }
  if (phaseChanged) {
    await persistSession(session);
  }
  broadcastState(session);
  return createSessionActionResult(session, "player", playerId, {
    payload: result.outcome
  });
}

async function handleConcurrentDatabaseAnswer(pin, body, playerTokenHash) {
  const client = await database.connect();
  let transactionFinished = false;
  try {
    await client.query("BEGIN");
    await configureSessionTransaction(client);
    const sessionResult = await client.query(
      "SELECT snapshot, version FROM live_sessions WHERE pin = $1 FOR SHARE",
      [pin]
    );
    const record = sessionResult.rows[0];
    if (!record) {
      throw new HttpError(404, "Session was not found.");
    }
    const snapshot = record.snapshot ?? {};
    if (snapshot.phase === "question") {
      await client.query("ROLLBACK");
      transactionFinished = true;
      return { fallback: true };
    }
    const questionIndex = Number(snapshot.currentQuestionIndex);
    const question = Array.isArray(snapshot.questions) ? snapshot.questions[questionIndex] : null;
    if (snapshot.phase !== "answering" || !question || question.kind === "slide") {
      throw new HttpError(409, "Answers are not open.");
    }
    const selectedOptionIds = normalizeSubmittedOptionIds(body, question);
    const now = Date.now();
    const validation = recordAnswer({
      questions: snapshot.questions,
      currentQuestionIndex: questionIndex,
      phase: snapshot.phase,
      openedAt: snapshot.openedAt,
      answers: new Map()
    }, { playerId: "validation", selectedOptionIds, now });
    if (!validation.outcome.accepted) {
      throw new HttpError(409, "Answers are closed for this question.", "ANSWER_CLOSED");
    }

    const playerResult = await client.query(
      `SELECT id FROM live_session_players
       WHERE pin = $1 AND resume_token_hash = $2 AND left_at IS NULL`,
      [pin, playerTokenHash]
    );
    const playerId = playerResult.rows[0]?.id;
    if (!playerId) {
      throw new HttpError(401, "Player resume authentication is not valid.", "PLAYER_AUTHENTICATION_INVALID");
    }
    const inserted = await client.query(
      `INSERT INTO live_session_answers (pin, question_index, player_id, option_id, selected_option_ids, answered_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (pin, question_index, player_id) DO NOTHING
       RETURNING option_id, selected_option_ids, answered_at`,
      [pin, questionIndex, playerId, selectedOptionIds[0], JSON.stringify(selectedOptionIds), now]
    );
    let persistedSelectedOptionIds = selectedOptionIds;
    let answeredAt = now;
    const accepted = inserted.rowCount > 0;
    if (!accepted) {
      const existing = await client.query(
        `SELECT option_id, selected_option_ids, answered_at FROM live_session_answers
         WHERE pin = $1 AND question_index = $2 AND player_id = $3`,
        [pin, questionIndex, playerId]
      );
      persistedSelectedOptionIds = normalizePersistedSelectedOptionIds(existing.rows[0] ?? { option_id: selectedOptionIds[0] });
      answeredAt = Number(existing.rows[0]?.answered_at ?? now);
    } else {
      await client.query("SELECT pg_notify($1, $2)", [
        SESSION_EVENTS_CHANNEL,
        JSON.stringify({
          type: "answer",
          pin,
          origin: INSTANCE_ID,
          version: Number(record.version),
          questionIndex,
          playerId,
          selectedOptionIds,
          answeredAt
        })
      ]);
    }
    await client.query("COMMIT");
    transactionFinished = true;
    if (accepted) {
      try {
        applyCompactAnswerUpdate({
          pin,
          version: Number(record.version),
          questionIndex,
          playerId,
          selectedOptionIds,
          answeredAt
        });
      } catch (error) {
        logBackgroundError("compact answer broadcast", error);
      }
    }
    return {
      fallback: false,
      payload: {
        accepted,
        duplicate: !accepted,
        selectedOptionIds: persistedSelectedOptionIds,
        selectedOptionId: persistedSelectedOptionIds[0] ?? null,
        version: Number(record.version)
      }
    };
  } catch (error) {
    if (!transactionFinished) {
      await client.query("ROLLBACK").catch((rollbackError) => logBackgroundError("answer transaction rollback", rollbackError));
    }
    throw toSessionDatabaseError(error);
  } finally {
    client.release();
  }
}

function applyCompactAnswerUpdate(event) {
  const session = sessions.get(event.pin);
  if (!session
    || session.currentQuestionIndex !== event.questionIndex
    || event.version < session.version
    || session.answers.has(event.playerId)) {
    return;
  }
  session.answers.set(event.playerId, { selectedOptionIds: event.selectedOptionIds, answeredAt: event.answeredAt });
  for (const client of [...session.clients.values()]) {
    if (client.role === "host") {
      writeSessionEvent(session, client, `event: answer\ndata: ${JSON.stringify({
          pin: session.pin,
          version: session.version,
          answerCount: session.answers.size
      })}\n\n`, { kind: "answer" });
    } else if (client.playerId === event.playerId) {
      writeSessionEvent(session, client, `event: answer\ndata: ${JSON.stringify({
          pin: session.pin,
          version: session.version,
          selectedOptionIds: event.selectedOptionIds,
          selectedOptionId: event.selectedOptionIds[0] ?? null
      })}\n\n`, { kind: "answer" });
    }
  }
}

async function handleLeave(playerTokenHash, session) {
  const player = requireSessionPlayerByTokenHash(playerTokenHash, session);
  const leftAt = Date.now();
  applySessionState(session, setPlayerPresence(session, { playerId: player.id, connected: false, now: leftAt }));
  const updatedPlayer = session.players.get(player.id);
  updatedPlayer.resumeTokenHash = "";
  updatedPlayer.leftAt = leftAt;
  await persistPlayerPresence(session, updatedPlayer);
  afterSessionCommit(() => {
    for (const client of [...session.clients.values()]) {
      if (client.role === "player" && client.playerId === player.id) {
        removeSessionClient(session, client);
        client.response.end();
      }
    }
  });
  broadcastState(session);
  return createSessionActionResult(session, "player", player.id, {
    payload: { left: true },
    includeSession: false,
    clearPlayerCookie: true
  });
}

function createSessionActionResult(session, role, playerId, overrides = {}) {
  return {
    session,
    role,
    playerId,
    statusCode: overrides.statusCode ?? 200,
    payload: overrides.payload ?? {},
    playerCookie: overrides.playerCookie ?? null,
    clearPlayerCookie: overrides.clearPlayerCookie === true,
    includeSession: overrides.includeSession !== false
  };
}

function startSession(session) {
  if (session.phase !== "lobby") {
    throw new HttpError(409, "This session has already started.");
  }

  session.currentQuestionIndex = 0;
  resetCurrentAnswers(session);
  openCurrentQuestion(session);
}

function openAnswers(session) {
  const question = getCurrentQuestion(session);

  if (session.phase !== "question") {
    throw new HttpError(409, "Move to a question before opening answers.");
  }

  if (!question || question.kind === "slide") {
    throw new HttpError(409, "Slides do not accept answers.");
  }

  session.phase = "answering";
  session.openedAt = Date.now();
  scheduleQuestionTimer(session);
}

function revealAnswers(session, reason = "manual") {
  const question = getCurrentQuestion(session);

  if (session.phase !== "answering" && session.phase !== "question") {
    throw new HttpError(409, "There is nothing to reveal right now.");
  }

  if (!question || question.kind === "slide") {
    throw new HttpError(409, "Slides do not have answer results.");
  }

  clearQuestionTimer(session);
  scoreCurrentQuestion(session, question);
  session.phase = "results";
}

function advanceSession(session) {
  const question = getCurrentQuestion(session);
  const isSlideReadyForNext = session.phase === "question" && question?.kind === "slide";

  if (session.phase !== "results" && !isSlideReadyForNext) {
    throw new HttpError(409, "Reveal results before moving on.");
  }

  const nextIndex = session.currentQuestionIndex + 1;
  if (nextIndex >= session.questions.length) {
    endSession(session);
    return;
  }

  session.currentQuestionIndex = nextIndex;
  resetCurrentAnswers(session);
  openCurrentQuestion(session);
}

function openCurrentQuestion(session) {
  const question = getCurrentQuestion(session);
  if (question && question.kind !== "slide") {
    session.phase = "answering";
    session.openedAt = Date.now();
    scheduleQuestionTimer(session);
    return;
  }

  clearQuestionTimer(session);
  session.phase = "question";
  session.openedAt = null;
}

function endSession(session) {
  applySessionState(session, endSessionDomain(session, { discardActiveRound: true }));
  session.endedAt = Date.now();
  clearQuestionTimer(session);
}

function handleEndSession(body, session) {
  applySessionState(session, endSessionDomain(session, { discardActiveRound: body.discardActiveRound === true }));
  session.endedAt = Date.now();
  clearQuestionTimer(session);
}

function resetCurrentAnswers(session) {
  clearQuestionTimer(session);
  session.answers = new Map();
  session.openedAt = null;
}

function scheduleQuestionTimer(session) {
  clearQuestionTimer(session);
  const question = getCurrentQuestion(session);
  if (session.phase !== "answering" || !question || question.kind === "slide" || !session.openedAt) {
    return;
  }

  const remainingMs = getQuestionRemainingMs(session, question);
  const timeout = setTimeout(() => {
    timerHandlesByPin.delete(session.pin);
    void revealQuestionAfterTimer(session.pin).catch((error) => {
      logBackgroundError("question timer", error);
      scheduleQuestionTimerRetry(session.pin);
    });
  }, Math.max(0, remainingMs));
  timerHandlesByPin.set(session.pin, timeout);
}

function scheduleQuestionTimerRetry(pin) {
  if (timerHandlesByPin.has(pin)) {
    return;
  }
  const session = sessions.get(pin);
  if (!session || session.phase !== "answering") {
    return;
  }
  const timeout = setTimeout(() => {
    timerHandlesByPin.delete(pin);
    void revealQuestionAfterTimer(pin).catch((error) => {
      logBackgroundError("question timer retry", error);
      scheduleQuestionTimerRetry(pin);
    });
  }, SESSION_TIMER_RETRY_MS);
  timerHandlesByPin.set(pin, timeout);
}

function clearQuestionTimer(session) {
  const timeout = timerHandlesByPin.get(session.pin);
  if (timeout) {
    clearTimeout(timeout);
    timerHandlesByPin.delete(session.pin);
  }
}

function getQuestionRemainingMs(session, question) {
  const durationMs = getQuestionDurationMs(question);
  return durationMs - Math.max(0, Date.now() - Number(session.openedAt ?? 0));
}

function getQuestionDurationMs(question) {
  return coerceTimerSeconds(question.timerSeconds) * 1000;
}

async function revealQuestionAfterTimer(pin) {
  await withSessionMutation(pin, async () => {
    const session = await getSession(pin);
    if (!session || session.phase !== "answering") {
      return;
    }

    const question = getCurrentQuestion(session);
    if (!question || question.kind === "slide" || getQuestionRemainingMs(session, question) > 0) {
      scheduleQuestionTimer(session);
      return;
    }

    revealAnswers(session, "timer");
    await persistSession(session);
    await persistPlayers(session);
    broadcastState(session);
  });
}

function scoreCurrentQuestion(session, question) {
  applySessionState(session, scoreCurrentQuestionDomain(session));
}

async function handleEventStream(request, response, url) {
  const pin = normalizePin(url.searchParams.get("pin"));
  const role = url.searchParams.get("role") === "host" ? "host" : "player";
  const presenter = role === "host" ? await requireCurrentPresenter(request) : null;
  const playerTokenHash = role === "player" ? readSessionPlayerTokenHash(request, pin) : null;
  let registered = false;

  await withSessionMutation(pin, async () => {
    const session = await getSession(pin);
    let playerId = null;
    if (role === "host") {
      assertSessionHostPresenter(presenter, session);
    } else {
      const player = requireSessionPlayerByTokenHash(playerTokenHash, session);
      playerId = player.id;
      applySessionState(session, setPlayerPresence(session, {
        playerId,
        connected: true,
        now: Date.now()
      }));
      await persistPlayerPresence(session, session.players.get(playerId));
      broadcastState(session);
    }
    assertSessionConnectionCapacity(session, role, playerId);
    afterSessionCommit(() => {
      registerSessionClient(request, response, session, {
        role,
        playerId,
        playerTokenHash,
        presenterTokenHash: role === "host" ? request.presenterTokenHash ?? null : null
      });
      registered = true;
    });
  });
  if (!registered) {
    throw new HttpError(503, "The live connection could not be established.", "EVENT_REGISTRATION_FAILED");
  }
}

function assertSessionConnectionCapacity(session, role, playerId) {
  if (session.clients.size >= MAX_SSE_CLIENTS_PER_SESSION) {
    throw new HttpError(503, "This session has reached its live connection limit.", "SESSION_CONNECTION_LIMIT");
  }
  const principalConnectionCount = [...session.clients.values()].filter((candidate) =>
    role === "host"
      ? candidate.role === "host"
      : candidate.role === "player" && candidate.playerId === playerId
  ).length;
  if (principalConnectionCount >= MAX_SSE_CONNECTIONS_PER_PRINCIPAL) {
    throw new HttpError(429, "Too many live connections for this participant.", "EVENT_CONNECTION_LIMIT");
  }
}

function registerSessionClient(request, response, session, authentication) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const client = {
    id: randomUUID(),
    response,
    role: authentication.role,
    playerId: authentication.playerId,
    playerTokenHash: authentication.playerTokenHash,
    presenterTokenHash: authentication.presenterTokenHash,
    heartbeat: null,
    backpressured: false,
    pendingStatePayload: null,
    pendingAnswerPayload: null,
    drainHandler: null
  };
  let heartbeatCheckPending = false;
  client.heartbeat = setInterval(() => {
    if (heartbeatCheckPending) {
      return;
    }
    heartbeatCheckPending = true;
    void isSessionStreamValid(session, client)
      .then((isValid) => {
        if (!isValid) {
          evictSessionClient(session, client);
          return;
        }
        writeSessionEvent(session, client, ": keep-alive\n\n", { coalesce: false });
      })
      .catch((error) => {
        logBackgroundError("event stream heartbeat", error);
        evictSessionClient(session, client);
      })
      .finally(() => {
        heartbeatCheckPending = false;
      });
  }, SSE_HEARTBEAT_MS);

  session.clients.set(client.id, client);
  sendStateToClient(session, client);

  request.on("close", () => {
    const wasRegistered = session.clients.has(client.id);
    removeSessionClient(session, client);
    if (wasRegistered) {
      void handleClientDisconnect(session, client).catch((error) => logBackgroundError("client disconnect", error));
    }
  });
}

function removeSessionClient(session, client) {
  if (client.heartbeat) {
    clearInterval(client.heartbeat);
    client.heartbeat = null;
  }
  if (client.drainHandler) {
    client.response.off("drain", client.drainHandler);
    client.drainHandler = null;
  }
  client.pendingStatePayload = null;
  client.pendingAnswerPayload = null;
  client.backpressured = false;
  session.clients.delete(client.id);
}

function closeSessionClients(session) {
  if (!session) {
    return;
  }
  for (const client of [...session.clients.values()]) {
    removeSessionClient(session, client);
    client.response.end();
  }
}

async function isSessionStreamValid(session, client) {
  if (client.role === "player") {
    const currentSession = sessions.get(session.pin) ?? session;
    const player = client.playerId ? currentSession.players.get(client.playerId) : null;
    return Boolean(player?.resumeTokenHash && player.resumeTokenHash === client.playerTokenHash);
  }
  const tokenHash = client.presenterTokenHash;
  if (!tokenHash) {
    return false;
  }
  if (database) {
    const result = await database.query(
      "SELECT 1 FROM presenter_sessions WHERE token_hash = $1 AND token_version = $2 AND expires_at > NOW()",
      [tokenHash, PRESENTER_TOKEN_VERSION]
    );
    if (result.rowCount === 0) {
      localPresenterSessions.delete(tokenHash);
      return false;
    }
  }
  const authentication = localPresenterSessions.get(tokenHash);
  return Boolean(authentication && authentication.expiresAt > Date.now());
}

function pruneRevokedPlayerClients(session) {
  for (const client of [...session.clients.values()]) {
    if (client.role !== "player") {
      continue;
    }
    const player = client.playerId ? session.players.get(client.playerId) : null;
    if (player?.resumeTokenHash && player.resumeTokenHash === client.playerTokenHash) {
      continue;
    }
    removeSessionClient(session, client);
    client.response.end();
  }
}

function revokePresenterStreams(tokenHash) {
  for (const session of sessions.values()) {
    for (const client of [...session.clients.values()]) {
      if (client.role !== "host" || client.presenterTokenHash !== tokenHash) {
        continue;
      }
      removeSessionClient(session, client);
      client.response.end();
    }
  }
}

async function handleClientDisconnect(session, client) {
  if (client.role === "host") {
    return;
  }

  if (client.playerId) {
    await handlePlayerDisconnect(session.pin, client.playerId);
  }
}

async function handlePlayerDisconnect(pin, playerId) {
  await withSessionMutation(pin, async () => {
    const session = await getSession(pin);
    if (hasConnectedPlayer(session, playerId)) {
      return;
    }
    applySessionState(session, setPlayerPresence(session, { playerId, connected: false, now: Date.now() }));
    await persistPlayerPresence(session, session.players.get(playerId));
    broadcastState(session);
  });
}

function hasConnectedPlayer(session, playerId) {
  return [...session.clients.values()].some((client) => client.role === "player" && client.playerId === playerId);
}

function assertPresenterOnline(session) {
  if (session.phase === "ended") {
    throw new HttpError(409, "This session has ended.", "SESSION_ENDED");
  }
}

function applySessionState(target, source) {
  Object.assign(target, source, { clients: target.clients });
}

function getPlayerCookieName(pin) {
  return `pinboard_player_${pin}`;
}

function requireSessionPlayer(request, session) {
  return requireSessionPlayerByTokenHash(readSessionPlayerTokenHash(request, session.pin), session);
}

function readOptionalSessionPlayerTokenHash(request, pin) {
  const resumeToken = readCookies(request)[getPlayerCookieName(normalizePin(pin))];
  return isValidPlayerResumeToken(resumeToken) ? hashSecret(resumeToken) : null;
}

function readSessionPlayerTokenHash(request, pin) {
  const tokenHash = readOptionalSessionPlayerTokenHash(request, pin);
  if (!tokenHash) {
    throw new HttpError(401, "Player resume authentication is required.", "PLAYER_AUTHENTICATION_REQUIRED");
  }
  return tokenHash;
}

function requireSessionPlayerByTokenHash(resumeTokenHash, session) {
  const player = resumeTokenHash
    ? [...session.players.values()].find((candidate) => isActivePlayer(candidate) && candidate.resumeTokenHash === resumeTokenHash)
    : null;
  if (!player) {
    throw new HttpError(401, "Player resume authentication is not valid.", "PLAYER_AUTHENTICATION_INVALID");
  }
  return player;
}

async function withSessionMutation(pin, operation) {
  const normalizedPin = normalizePin(pin);
  return enqueueSessionOperation(normalizedPin, async () => {
    if (database) {
      return withDatabaseSessionMutation(normalizedPin, operation);
    }
    return withMemorySessionMutation(operation);
  });
}

async function enqueueSessionOperation(normalizedPin, operation) {
  const previous = sessionMutationQueues.get(normalizedPin) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  sessionMutationQueues.set(normalizedPin, current);
  try {
    return await current;
  } finally {
    if (sessionMutationQueues.get(normalizedPin) === current) {
      sessionMutationQueues.delete(normalizedPin);
    }
  }
}

async function withMemorySessionMutation(operation) {
  const context = createSessionMutationContext(null, null);
  const result = await sessionMutationStorage.run(context, operation);
  if (context.dirty && context.session) {
    context.session.version += 1;
    sessions.set(context.session.pin, context.session);
  }
  runSessionPostCommitCallbacks(context);
  if (context.broadcastRequested && context.session) {
    broadcastStateNow(context.session);
  }
  return result;
}

async function withDatabaseSessionMutation(pin, operation) {
  const client = await database.connect();
  const context = createSessionMutationContext(client, null);
  let committed = false;
  try {
    await client.query("BEGIN");
    await configureSessionTransaction(client);
    context.session = await loadPersistedSession(pin, {
      queryable: client,
      forUpdate: true,
      cache: false
    });
    if (!context.session) {
      throw new HttpError(404, "Session was not found.");
    }

    const result = await sessionMutationStorage.run(context, operation);
    if (context.dirty) {
      const update = await client.query(
        `UPDATE live_sessions
         SET snapshot = $2, version = version + 1, updated_at = NOW()
         WHERE pin = $1 AND version = $3
         RETURNING version`,
        [pin, JSON.stringify(serializeSessionSnapshot(context.session)), context.session.version]
      );
      if (!update.rows[0]) {
        throw new HttpError(409, "Session changed in another process. Please retry.", "SESSION_VERSION_CONFLICT");
      }
      context.session.version = Number(update.rows[0].version);
      await client.query("SELECT pg_notify($1, $2)", [
        SESSION_EVENTS_CHANNEL,
        JSON.stringify({ pin, origin: INSTANCE_ID, version: context.session.version })
      ]);
    }
    await client.query("COMMIT");
    committed = true;
    try {
      sessions.set(pin, context.session);
      pruneRevokedPlayerClients(context.session);
      scheduleQuestionTimer(context.session);
      runSessionPostCommitCallbacks(context);
      if (context.broadcastRequested) {
        broadcastStateNow(context.session);
      }
    } catch (error) {
      logBackgroundError("session post-commit state", error);
    }
    return result;
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK").catch((rollbackError) => logBackgroundError("session transaction rollback", rollbackError));
      if (context.session) {
        clearQuestionTimer(context.session);
        const cachedSession = sessions.get(pin);
        if (cachedSession) {
          scheduleQuestionTimer(cachedSession);
        }
      }
    }
    throw toSessionDatabaseError(error);
  } finally {
    client.release();
  }
}

async function configureSessionTransaction(client) {
  await client.query(
    `SELECT
       set_config('lock_timeout', $1, TRUE),
       set_config('statement_timeout', $2, TRUE),
       set_config('idle_in_transaction_session_timeout', $3, TRUE)`,
    [
      `${SESSION_LOCK_TIMEOUT_MS}ms`,
      `${SESSION_STATEMENT_TIMEOUT_MS}ms`,
      `${SESSION_IDLE_TRANSACTION_TIMEOUT_MS}ms`
    ]
  );
}

function toSessionDatabaseError(error) {
  if (error?.code === "55P03" || error?.code === "57014") {
    const busyError = new HttpError(503, "This session is busy. Please retry.", "SESSION_BUSY");
    busyError.retryAfterSeconds = 1;
    return busyError;
  }
  return error;
}

function createSessionMutationContext(client, session) {
  return {
    client,
    session,
    dirty: false,
    broadcastRequested: false,
    postCommitCallbacks: []
  };
}

function afterSessionCommit(callback) {
  const context = sessionMutationStorage.getStore();
  if (context) {
    context.postCommitCallbacks.push(callback);
    return;
  }
  callback();
}

function runSessionPostCommitCallbacks(context) {
  for (const callback of context.postCommitCallbacks) {
    try {
      callback();
    } catch (error) {
      logBackgroundError("session post-commit callback", error);
    }
  }
  context.postCommitCallbacks.length = 0;
}

function broadcastState(session) {
  const context = sessionMutationStorage.getStore();
  if (context && context.session === session) {
    context.broadcastRequested = true;
    return;
  }
  broadcastStateNow(session);
}

function broadcastStateNow(session) {
  for (const client of [...session.clients.values()]) {
    sendStateToClient(session, client);
  }
}

function sendStateToClient(session, client) {
  const state = getStateForRole(session, client.role, client.playerId);
  writeSessionEvent(session, client, `event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

function writeSessionEvent(session, client, payload, { coalesce = true, kind = "state" } = {}) {
  try {
    if (client.response.destroyed || client.response.writableEnded) {
      evictSessionClient(session, client);
      return false;
    }
    if (client.backpressured) {
      if (coalesce) {
        if (kind === "state") {
          client.pendingStatePayload = payload;
          client.pendingAnswerPayload = null;
        } else {
          client.pendingAnswerPayload = payload;
        }
      }
      if (client.response.writableLength > MAX_SSE_BUFFERED_BYTES) {
        evictSessionClient(session, client);
        return false;
      }
      return true;
    }
    const accepted = client.response.write(payload);
    if (client.response.writableLength > MAX_SSE_BUFFERED_BYTES) {
      evictSessionClient(session, client);
      return false;
    }
    if (!accepted) {
      client.backpressured = true;
      client.drainHandler = () => {
        client.drainHandler = null;
        client.backpressured = false;
        const pendingStatePayload = client.pendingStatePayload;
        const pendingAnswerPayload = client.pendingAnswerPayload;
        client.pendingStatePayload = null;
        client.pendingAnswerPayload = null;
        if (pendingStatePayload && session.clients.has(client.id)) {
          writeSessionEvent(session, client, pendingStatePayload, { kind: "state" });
        }
        if (pendingAnswerPayload && session.clients.has(client.id)) {
          writeSessionEvent(session, client, pendingAnswerPayload, { kind: "answer" });
        }
      };
      client.response.once("drain", client.drainHandler);
    }
    return true;
  } catch (error) {
    logBackgroundError("event stream write", error);
    evictSessionClient(session, client);
    return false;
  }
}

function evictSessionClient(session, client) {
  const wasRegistered = session.clients.has(client.id);
  removeSessionClient(session, client);
  client.response.destroy();
  if (wasRegistered && client.role === "player") {
    void handleClientDisconnect(session, client).catch((error) => logBackgroundError("evicted client disconnect", error));
  }
}

function getStateForRole(session, role, playerId) {
  const question = getCurrentQuestion(session);
  const player = playerId ? session.players.get(playerId) : null;
  const activePlayers = [...session.players.values()].filter(isActivePlayer);
  const showAnswers = role === "host" || session.phase === "results" || session.phase === "ended";

  return {
    pin: session.pin,
    version: session.version,
    title: session.title,
    phase: session.phase,
    currentQuestionIndex: session.currentQuestionIndex,
    questionCount: session.questions.length,
    playerCount: activePlayers.length,
    answerCount: session.answers.size,
    openedAt: session.openedAt,
    currentQuestion: question ? serializeQuestion(question, showAnswers, session.pin) : null,
    answerCounts: showAnswers && question ? buildAnswerCounts(session, question) : {},
    leaderboard: buildLeaderboard(session),
    recentPlayers: role === "host" ? buildRecentPlayers(session) : [],
    me: player ? { id: player.id, nickname: player.nickname, score: player.score } : null,
    selectedOptionIds: playerId ? session.answers.get(playerId)?.selectedOptionIds ?? [] : [],
    selectedOptionId: playerId ? session.answers.get(playerId)?.selectedOptionIds?.[0] ?? null : null,
    endedReason: session.endedReason,
    endedAt: session.endedAt,
    mediaLimitBytes: MAX_MEDIA_BYTES
  };
}

function serializeQuestion(question, showAnswers, pin) {
  return {
    id: question.id,
    kind: question.kind,
    text: question.text,
    points: question.points,
    timerSeconds: question.timerSeconds,
    media: question.media ? {
      ...question.media,
      url: `${question.media.url.split("?", 1)[0]}?pin=${encodeURIComponent(pin)}`
    } : null,
    options: question.options,
    correctOptionIds: showAnswers ? question.correctOptionIds : []
  };
}

function buildAnswerCounts(session, question) {
  const counts = Object.fromEntries(question.options.map((option) => [option.id, 0]));

  for (const answer of session.answers.values()) {
    for (const optionId of answer.selectedOptionIds ?? []) {
      if (Object.hasOwn(counts, optionId)) {
        counts[optionId] += 1;
      }
    }
  }

  return counts;
}

function buildLeaderboard(session) {
  return [...session.players.values()]
    .sort((left, right) => right.score - left.score || left.joinedAt - right.joinedAt)
    .slice(0, LEADERBOARD_LIMIT)
    .map((player, index) => ({
      id: player.id,
      rank: index + 1,
      nickname: player.nickname,
      score: player.score,
      departed: !isActivePlayer(player)
    }));
}

function buildRecentPlayers(session) {
  return [...session.players.values()]
    .filter(isActivePlayer)
    .sort((left, right) => right.joinedAt - left.joinedAt)
    .slice(0, RECENT_PLAYER_LIMIT)
    .map((player) => ({
      nickname: player.nickname,
      score: player.score
    }));
}

function isActivePlayer(player) {
  return player?.leftAt == null;
}

function getCurrentQuestion(session) {
  return session.questions[session.currentQuestionIndex] ?? null;
}

async function serveStatic(response, pathname) {
  const route = staticRoutes.get(pathname) ?? getSpaFallbackRoute(pathname);
  if (!route) {
    throw new HttpError(404, "Page was not found.");
  }

  const file = await readFile(route.path);
  response.writeHead(200, {
    "Content-Type": route.type,
    "Cache-Control": STATIC_CACHE_CONTROL
  });
  response.end(file);
}

function getSpaFallbackRoute(pathname) {
  if (pathname === "/presentation/login" || pathname === "/presentation/homepage" || /^\/presentation\/[0-9a-fA-F-]{36}$/.test(pathname)) {
    return staticRoutes.get("/");
  }
  return null;
}

async function readJson(request) {
  const chunks = [];
  let bytesRead = 0;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const limitBytes = bodyLimitForRoute(request.method, url.pathname, { mediaLimitBytes: MAX_MEDIA_BYTES }) ?? DEFAULT_JSON_BODY_LIMIT;
  const contentLengthResult = validateContentLength(request.headers["content-length"], limitBytes);
  if (!contentLengthResult.ok) {
    const code = contentLengthResult.statusCode === 413 ? "REQUEST_TOO_LARGE" : "INVALID_CONTENT_LENGTH";
    throw new HttpError(contentLengthResult.statusCode, "Request body is not valid for this route.", code);
  }
  const contentType = normalizeOptionalContentType(request.headers["content-type"]);
  if (contentType && contentType !== "application/json") {
    throw new HttpError(415, "Request body must use application/json.", "JSON_CONTENT_TYPE_REQUIRED");
  }
  if (!contentType && Number(contentLengthResult.contentLength ?? 0) > 0) {
    throw new HttpError(415, "Request body must use application/json.", "JSON_CONTENT_TYPE_REQUIRED");
  }

  for await (const chunk of request) {
    bytesRead += chunk.length;
    const bodyLengthResult = validateBodyByteLength(bytesRead, limitBytes);
    if (!bodyLengthResult.ok) {
      throw new HttpError(413, "Request body is larger than the configured limit.", "REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function normalizeOptionalContentType(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.split(";", 1)[0].trim().toLowerCase() : "";
}

async function readRawBody(request, limitBytes) {
  const contentLengthResult = validateContentLength(request.headers["content-length"], limitBytes);
  if (!contentLengthResult.ok) {
    const code = contentLengthResult.statusCode === 413 ? "REQUEST_TOO_LARGE" : "INVALID_CONTENT_LENGTH";
    throw new HttpError(contentLengthResult.statusCode, "Media request size is not valid.", code);
  }
  const chunks = [];
  let bytesRead = 0;
  for await (const chunk of request) {
    bytesRead += chunk.length;
    if (!validateBodyByteLength(bytesRead, limitBytes).ok) {
      throw new HttpError(413, "Media is larger than the configured limit.", "REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (bytesRead === 0) {
    throw new HttpError(400, "Media file is required.", "MEDIA_REQUIRED");
  }
  return Buffer.concat(chunks);
}

function normalizeMimeTypeHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") {
    throw new HttpError(415, "Media Content-Type is required.", "MEDIA_TYPE_REQUIRED");
  }
  const mimeType = raw.split(";", 1)[0].trim().toLowerCase();
  if (!mimeType || /[\r\n]/.test(mimeType)) {
    throw new HttpError(415, "Media Content-Type is not valid.", "MEDIA_TYPE_INVALID");
  }
  return mimeType;
}

function readMediaFileName(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || /[\r\n]/.test(raw)) {
    throw new HttpError(400, "Media filename is required.", "MEDIA_NAME_REQUIRED");
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "Media filename is not valid.", "MEDIA_NAME_INVALID");
  }
  return limitText(decoded, MAX_MEDIA_NAME_LENGTH, "Media filename");
}

function normalizeQuestions(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, "At least one slide or question is required.");
  }

  if (input.length > MAX_QUESTION_COUNT) {
    throw new HttpError(400, `Decks can contain at most ${MAX_QUESTION_COUNT} items.`);
  }

  return input.map((question, index) => normalizeQuestion(question, index));
}

function normalizePresentationSnapshot(input) {
  const source = input?.snapshot && typeof input.snapshot === "object" ? input.snapshot : input;
  const title = limitText(readString(source?.title, "Presentation title"), MAX_TITLE_LENGTH, "Presentation title");
  return {
    title,
    questions: normalizePresentationQuestions(source?.questions)
  };
}

function normalizePresentationQuestions(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, "At least one slide or question is required.");
  }

  if (input.length > MAX_QUESTION_COUNT) {
    throw new HttpError(400, `Decks can contain at most ${MAX_QUESTION_COUNT} items.`);
  }

  const ids = new Set();
  return input.map((question, index) => {
    const normalized = normalizePresentationQuestion(question, index);
    if (ids.has(normalized.id)) {
      throw new HttpError(400, "Item IDs must be unique.");
    }
    ids.add(normalized.id);
    return normalized;
  });
}

function normalizePresentationQuestion(input, index) {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, `Item ${index + 1} is required.`);
  }

  const id = readStableId(input.id, `Item ${index + 1} ID`);
  const kind = normalizeQuestionKind(input.kind);
  const text = limitText(readString(input.text, `Item ${index + 1} text`), MAX_QUESTION_TEXT_LENGTH, `Item ${index + 1} text`);
  const media = normalizeMedia(input.media);

  if (kind === "slide") {
    return {
      id,
      kind,
      text,
      points: 0,
      timerSeconds: 0,
      options: [],
      correctOptionIds: [],
      media
    };
  }

  const options = normalizePresentationOptions(input.options);
  const points = normalizePoints(input.points);
  const timerSeconds = normalizeTimerSeconds(input.timerSeconds);
  const correctOptionIds = normalizeCorrectOptionIds(input, options, kind, `Item ${index + 1}`);

  if (kind === "true_false" && options.length !== 2) {
    throw new HttpError(400, `Item ${index + 1} true or false questions need exactly 2 options.`);
  }

  return {
    id,
    kind,
    text,
    points,
    timerSeconds,
    options,
    correctOptionIds,
    media
  };
}

function normalizePresentationOptions(input) {
  if (!Array.isArray(input) || input.length < MIN_OPTION_COUNT || input.length > MAX_OPTION_COUNT) {
    throw new HttpError(400, `Questions need ${MIN_OPTION_COUNT}-${MAX_OPTION_COUNT} options.`);
  }

  const ids = new Set();
  return input.map((option, index) => {
    const id = readStableId(option?.id, `Option ${index + 1} ID`);
    const text = limitText(readString(option?.text, `Option ${index + 1} text`), MAX_OPTION_TEXT_LENGTH, `Option ${index + 1} text`);

    if (ids.has(id)) {
      throw new HttpError(400, "Option IDs must be unique.");
    }
    ids.add(id);

    return { id, text };
  });
}

function normalizeCorrectOptionIds(input, options, kind, itemLabel) {
  const candidateIds = Array.isArray(input.correctOptionIds)
    ? input.correctOptionIds
    : typeof input.correctOptionId === "string" ? [input.correctOptionId] : [];
  const correctOptionIds = candidateIds.map((id, index) => readString(id, `${itemLabel} correct option ${index + 1}`));
  const uniqueIds = [...new Set(correctOptionIds)];
  const validIds = new Set(options.map((option) => option.id));
  if (uniqueIds.length === 0 || uniqueIds.length !== correctOptionIds.length || uniqueIds.some((id) => !validIds.has(id))) {
    throw new HttpError(400, `${itemLabel} needs unique valid correct options.`);
  }
  if (kind === "true_false" && uniqueIds.length !== 1) {
    throw new HttpError(400, `${itemLabel} true or false questions need exactly 1 correct option.`);
  }
  return uniqueIds;
}

function normalizeQuestion(input, index) {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, `Item ${index + 1} is required.`);
  }
  const id = readStableId(input.id, `Item ${index + 1} ID`);
  const kind = normalizeQuestionKind(input.kind);
  const text = limitText(readString(input.text, `Item ${index + 1} text`), MAX_QUESTION_TEXT_LENGTH, `Item ${index + 1} text`);
  const media = normalizeMedia(input.media);

  if (kind === "slide") {
    return {
      id,
      kind,
      text,
      points: 0,
      timerSeconds: 0,
      options: [],
      correctOptionIds: [],
      media
    };
  }

  const options = normalizeOptions(input.options);
  const points = normalizePoints(input.points);
  const timerSeconds = normalizeTimerSeconds(input.timerSeconds);
  const correctOptionIds = normalizeCorrectOptionIds(input, options, kind, `Item ${index + 1}`);

  if (kind === "true_false" && options.length !== 2) {
    throw new HttpError(400, `Item ${index + 1} true or false questions need exactly 2 options.`);
  }

  return {
    id,
    kind,
    text,
    points,
    timerSeconds,
    options,
    correctOptionIds,
    media
  };
}

function normalizeQuestionKind(value) {
  if (value === "quiz" || value === "true_false" || value === "slide") {
    return value;
  }
  throw new HttpError(400, "Item type must be quiz, true or false, or slide.");
}

function isScoredQuestionKind(kind) {
  return kind === "quiz" || kind === "true_false";
}

function normalizeOptions(input) {
  if (!Array.isArray(input) || input.length < MIN_OPTION_COUNT || input.length > MAX_OPTION_COUNT) {
    throw new HttpError(400, `Questions need ${MIN_OPTION_COUNT}-${MAX_OPTION_COUNT} options.`);
  }

  const ids = new Set();
  return input.map((option, index) => {
    const id = readStableId(option.id, `Option ${index + 1} ID`);
    const text = limitText(readString(option.text, `Option ${index + 1} text`), MAX_OPTION_TEXT_LENGTH, `Option ${index + 1} text`);

    if (ids.has(id)) {
      throw new HttpError(400, "Option IDs must be unique.");
    }
    ids.add(id);

    return { id, text };
  });
}

function normalizePoints(value) {
  const points = Number(value);
  if (!Number.isInteger(points) || points < 0 || points > MAX_POINTS) {
    throw new HttpError(400, `Points must be an integer from 0 to ${MAX_POINTS}.`);
  }
  return points;
}

function normalizeTimerSeconds(value) {
  const timerSeconds = Number(value ?? DEFAULT_TIMER_SECONDS);
  if (!Number.isInteger(timerSeconds) || timerSeconds < MIN_TIMER_SECONDS || timerSeconds > MAX_TIMER_SECONDS) {
    throw new HttpError(400, `Timer must be an integer from ${MIN_TIMER_SECONDS} to ${MAX_TIMER_SECONDS} seconds.`);
  }
  return timerSeconds;
}

function coerceTimerSeconds(value) {
  const timerSeconds = Number(value);
  return Number.isInteger(timerSeconds) && timerSeconds >= MIN_TIMER_SECONDS && timerSeconds <= MAX_TIMER_SECONDS
    ? timerSeconds
    : DEFAULT_TIMER_SECONDS;
}

function normalizeMedia(input) {
  if (!input) {
    return null;
  }

  const media = {
    id: readStableId(input.id, "Media ID"),
    name: limitText(readString(input.name, "Media name"), MAX_TITLE_LENGTH, "Media name"),
    type: limitText(readString(input.type, "Media type"), MAX_TITLE_LENGTH, "Media type"),
    size: Number(input.size),
    url: ""
  };

  if (!Number.isInteger(media.size) || media.size < 0) {
    throw new HttpError(400, "Media size is invalid.");
  }

  if (media.size > MAX_MEDIA_BYTES) {
    throw new HttpError(413, "Question media must be 100 MB or smaller.");
  }
  media.url = `/api/media/${media.id}`;
  return media;
}

async function createMediaAsset({ presenterId, name, mimeType, data }, queryable = database) {
  const asset = {
    id: randomUUID(),
    presenterId,
    name,
    mimeType,
    sizeBytes: data.length,
    data: Buffer.from(data)
  };
  if (!queryable) {
    localMediaAssetsById.set(asset.id, asset);
    return asset;
  }
  await queryable.query(
    `INSERT INTO media_assets (id, presenter_id, name, mime_type, size_bytes, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [asset.id, presenterId, name, mimeType, asset.sizeBytes, asset.data]
  );
  return asset;
}

async function createMediaAssetWithQuota(input) {
  if (!database) {
    const assets = [...localMediaAssetsById.values()].filter((asset) => asset.presenterId === input.presenterId);
    const storedBytes = assets.reduce((total, asset) => total + asset.sizeBytes, 0);
    assertMediaStorageQuota(assets.length, storedBytes, input.data.length);
    return createMediaAsset(input, null);
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('pinboard_media_quota_' || $1))",
      [input.presenterId]
    );
    const usage = await client.query(
      `SELECT COUNT(*) AS asset_count, COALESCE(SUM(size_bytes), 0) AS stored_bytes
       FROM media_assets WHERE presenter_id = $1`,
      [input.presenterId]
    );
    assertMediaStorageQuota(
      Number(usage.rows[0].asset_count),
      Number(usage.rows[0].stored_bytes),
      input.data.length
    );
    const asset = await createMediaAsset(input, client);
    await client.query("COMMIT");
    return asset;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError) => logBackgroundError("media quota rollback", rollbackError));
    throw error;
  } finally {
    client.release();
  }
}

function assertMediaStorageQuota(assetCount, storedBytes, incomingBytes) {
  if (assetCount >= MAX_MEDIA_ASSETS_PER_PRESENTER
    || storedBytes + incomingBytes > MAX_MEDIA_STORAGE_BYTES_PER_PRESENTER) {
    throw new HttpError(413, "Presenter media storage quota has been reached.", "MEDIA_STORAGE_QUOTA");
  }
}

async function getMediaAssetMetadata(mediaId) {
  if (!database) {
    return localMediaAssetsById.get(mediaId) ?? null;
  }
  const result = await database.query(
    `SELECT id, presenter_id, name, mime_type, size_bytes
     FROM media_assets WHERE id = $1`,
    [mediaId]
  );
  return result.rows[0] ? normalizeMediaAssetRecord(result.rows[0]) : null;
}

async function getMediaAssetBytes(mediaId, start, length) {
  if (!database) {
    const asset = localMediaAssetsById.get(mediaId);
    return asset ? asset.data.subarray(start, start + length) : null;
  }
  const result = await database.query(
    `SELECT substring(data FROM $2 FOR $3) AS data
     FROM media_assets WHERE id = $1`,
    [mediaId, start + 1, length]
  );
  return result.rows[0]?.data ? Buffer.from(result.rows[0].data) : null;
}

async function authorizeMediaRequest(request, asset) {
  const presenterAuthentication = await readPresenterAuthentication(request);
  if (presenterAuthentication?.session.presenterId === asset.presenterId) {
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const pinValue = url.searchParams.get("pin");
  if (!pinValue) {
    throw new HttpError(401, "Media authentication is required.", "MEDIA_AUTHENTICATION_REQUIRED");
  }
  const pin = normalizePin(pinValue);
  const playerTokenHash = readSessionPlayerTokenHash(request, pin);
  let authorized = false;
  if (database) {
    const result = await database.query(
      `SELECT 1
       FROM live_session_players AS player
       JOIN live_sessions AS session ON session.pin = player.pin
       WHERE player.pin = $1
         AND player.resume_token_hash = $2
         AND player.left_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(session.snapshot -> 'questions', '[]'::jsonb)) AS question
           WHERE question -> 'media' ->> 'id' = $3
         )`,
      [pin, playerTokenHash, asset.id]
    );
    authorized = result.rowCount > 0;
  } else {
    const session = sessions.get(pin);
    const player = session ? requireSessionPlayerByTokenHash(playerTokenHash, session) : null;
    authorized = Boolean(player && session.questions.some((question) => question.media?.id === asset.id));
  }
  if (!authorized) {
    throw new HttpError(403, "Media is not available to this participant.", "MEDIA_ACCESS_DENIED");
  }
}

async function deleteMediaAsset(presenterId, mediaId) {
  if (!database) {
    const asset = localMediaAssetsById.get(mediaId);
    return Boolean(asset?.presenterId === presenterId && localMediaAssetsById.delete(mediaId));
  }
  const result = await database.query(
    "DELETE FROM media_assets WHERE id = $1 AND presenter_id = $2 RETURNING id",
    [mediaId, presenterId]
  );
  return result.rowCount > 0;
}

function normalizeMediaAssetRecord(record) {
  return {
    id: record.id,
    presenterId: record.presenter_id,
    name: record.name,
    mimeType: record.mime_type,
    sizeBytes: Number(record.size_bytes),
    data: record.data === undefined ? null : Buffer.from(record.data)
  };
}

function serializeMediaAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    type: asset.mimeType,
    size: asset.sizeBytes,
    url: `/api/media/${asset.id}`
  };
}

async function assertPresenterOwnsMedia(presenterId, questions) {
  const mediaById = new Map();
  for (const question of questions) {
    if (question.media) {
      mediaById.set(question.media.id, question.media);
    }
  }
  if (mediaById.size === 0) {
    return;
  }

  const assets = database
    ? (await database.query(
      `SELECT id, presenter_id, name, mime_type, size_bytes
       FROM media_assets WHERE id = ANY($1::uuid[]) AND presenter_id = $2`,
      [[...mediaById.keys()], presenterId]
    )).rows.map(normalizeMediaAssetRecord)
    : [...mediaById.keys()].map((id) => localMediaAssetsById.get(id)).filter((asset) => asset?.presenterId === presenterId);

  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  if (assetsById.size !== mediaById.size) {
    throw new HttpError(400, "One or more media items are not available to this presenter.", "MEDIA_OWNERSHIP_INVALID");
  }
  for (const question of questions) {
    if (question.media) {
      question.media = serializeMediaAsset(assetsById.get(question.media.id));
    }
  }
}

async function sendMediaAsset(request, response, asset) {
  const etag = `"${asset.id}-${asset.sizeBytes}"`;
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { ETag: etag, "Cache-Control": "private, max-age=86400" });
    response.end();
    return;
  }

  const range = parseByteRange(request.headers.range, asset.sizeBytes);
  if (range === false) {
    response.writeHead(416, { "Content-Range": `bytes */${asset.sizeBytes}` });
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? asset.sizeBytes - 1;
  const bodyLength = end - start + 1;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=86400",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
    "Content-Length": String(bodyLength),
    "Content-Type": asset.mimeType,
    ETag: etag
  };
  if (range) {
    headers["Content-Range"] = `bytes ${start}-${end}/${asset.sizeBytes}`;
  }
  if (request.method === "HEAD") {
    response.writeHead(range ? 206 : 200, headers);
    response.end();
    return;
  }
  response.writeHead(range ? 206 : 200, headers);
  await streamMediaAssetBody(response, asset.id, start, bodyLength);
}

async function streamMediaAssetBody(response, mediaId, start, length) {
  let offset = start;
  let remaining = length;
  while (remaining > 0 && !response.destroyed) {
    const requestedBytes = Math.min(remaining, MEDIA_STREAM_CHUNK_BYTES);
    const chunk = await getMediaAssetBytes(mediaId, offset, requestedBytes);
    if (!chunk || chunk.length === 0) {
      response.destroy();
      return;
    }
    offset += chunk.length;
    remaining -= chunk.length;
    if (!response.write(chunk) && !(await waitForResponseDrain(response))) {
      return;
    }
  }
  if (!response.destroyed) {
    await endResponseBody(response);
  }
}

function waitForResponseDrain(response) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (drained) => {
      if (settled) {
        return;
      }
      settled = true;
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
  });
}

function endResponseBody(response, body) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      response.off("finish", finish);
      response.off("close", finish);
      response.off("error", finish);
      resolve();
    };
    response.once("finish", finish);
    response.once("close", finish);
    response.once("error", finish);
    response.end(body);
  });
}

function parseByteRange(value, sizeBytes) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return false;
  }
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    return false;
  }
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return false;
    }
    start = Math.max(0, sizeBytes - suffixLength);
    end = sizeBytes - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : sizeBytes - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= sizeBytes) {
    return false;
  }
  return { start, end: Math.min(end, sizeBytes - 1) };
}

function readString(value, label) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${label} is required.`);
  }
  return value;
}

function readStableId(value, label) {
  const id = readString(value, label).trim();
  if (!isStrictStableId(id)) {
    throw new HttpError(400, `${label} is not valid.`, "INVALID_STABLE_ID");
  }
  return id;
}

function limitText(value, maxLength, label) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HttpError(400, `${label} cannot be empty.`);
  }

  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${label} must be ${maxLength} characters or fewer.`);
  }

  return trimmed;
}

async function requireCurrentPresenter(request, { requireCsrf = false } = {}) {
  const authentication = await readPresenterAuthentication(request);
  if (!authentication) {
    throw new HttpError(401, "Presenter authentication is required.", "AUTHENTICATION_REQUIRED");
  }
  if (requireCsrf) {
    assertCsrfToken(request, authentication.session);
  }
  const presenter = await findPresenterById(authentication.session.presenterId);
  if (!presenter) {
    localPresenterSessions.delete(authentication.tokenHash);
    throw new HttpError(401, "Presenter authentication is not valid.", "AUTHENTICATION_INVALID");
  }
  request.presenterAuth = authentication.session;
  request.presenterTokenHash = authentication.tokenHash;
  return presenter;
}

function assertSessionHostPresenter(presenter, session) {
  if (!presenter || presenter.id !== session.presenterId) {
    throw new HttpError(403, "This presenter cannot control that session.");
  }
}

async function requireSessionHostEventToken(request, session) {
  const presenter = await requireCurrentPresenter(request);
  if (presenter.id !== session.presenterId) {
    throw new HttpError(403, "This presenter cannot control that session.");
  }
}

function validateStartupConfig() {
  if (!AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required in production.");
  }

  if (IS_PRODUCTION && AUTH_SECRET.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters in production.");
  }

  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
  }

  if (!Number.isSafeInteger(MAX_MEDIA_BYTES) || MAX_MEDIA_BYTES < 1 || MAX_MEDIA_BYTES > 500 * MIB) {
    throw new Error("MAX_QUESTION_MEDIA_BYTES must be a positive integer no larger than 500 MB.");
  }
  if (!Number.isSafeInteger(MAX_MEDIA_STORAGE_BYTES_PER_PRESENTER)
    || MAX_MEDIA_STORAGE_BYTES_PER_PRESENTER < MAX_MEDIA_BYTES
    || MAX_MEDIA_STORAGE_BYTES_PER_PRESENTER > 100 * 1024 * MIB) {
    throw new Error("MAX_MEDIA_STORAGE_BYTES_PER_PRESENTER must be between the upload limit and 100 GiB.");
  }
  if (!Number.isSafeInteger(MAX_MEDIA_ASSETS_PER_PRESENTER)
    || MAX_MEDIA_ASSETS_PER_PRESENTER < 1
    || MAX_MEDIA_ASSETS_PER_PRESENTER > 100_000) {
    throw new Error("MAX_MEDIA_ASSETS_PER_PRESENTER must be an integer from 1 to 100000.");
  }

  if (!Number.isSafeInteger(MAX_PLAYERS_PER_SESSION) || MAX_PLAYERS_PER_SESSION < 1 || MAX_PLAYERS_PER_SESSION > 100_000) {
    throw new Error("MAX_PLAYERS_PER_SESSION must be an integer from 1 to 100000.");
  }

  if ((!BOOTSTRAP_PRESENTER_EMAIL || !BOOTSTRAP_PRESENTER_PASSWORD) && !GOOGLE_CLIENT_ID) {
    throw new Error("Configure either PRESENTER_EMAIL/PRESENTER_PASSWORD or GOOGLE_CLIENT_ID.");
  }
  if (IS_PRODUCTION && GOOGLE_CLIENT_ID && GOOGLE_ALLOWED_EMAILS.size === 0 && GOOGLE_ALLOWED_DOMAINS.size === 0) {
    throw new Error("Configure GOOGLE_ALLOWED_EMAILS or GOOGLE_ALLOWED_DOMAINS before enabling Google sign-in in production.");
  }

  const usesDefaultLocalCredentials = !IS_PRODUCTION
    && BOOTSTRAP_PRESENTER_EMAIL === DEFAULT_LOCAL_PRESENTER_EMAIL
    && BOOTSTRAP_PRESENTER_PASSWORD === DEFAULT_LOCAL_PRESENTER_PASSWORD;
  if (usesDefaultLocalCredentials && !ALLOW_INSECURE_LOCAL_AUTH) {
    throw new Error("Set explicit presenter credentials or ALLOW_INSECURE_LOCAL_AUTH=true for local development.");
  }
}

async function initializeDatabase() {
  if (!database) {
    return;
  }

  await database.query(`
    CREATE TABLE IF NOT EXISTS presenters (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query("ALTER TABLE presenters ADD COLUMN IF NOT EXISTS name TEXT");
  await database.query("ALTER TABLE presenters ADD COLUMN IF NOT EXISTS google_sub TEXT");
  await database.query("CREATE UNIQUE INDEX IF NOT EXISTS presenters_google_sub_unique ON presenters (google_sub) WHERE google_sub IS NOT NULL");
  await database.query(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      pin TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query("ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1");
  await database.query(`
    CREATE TABLE IF NOT EXISTS migration_snapshot_backups (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      migration_name TEXT NOT NULL,
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (entity_type, entity_id, migration_name)
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS live_session_players (
      pin TEXT NOT NULL REFERENCES live_sessions(pin) ON DELETE CASCADE,
      id UUID NOT NULL,
      nickname TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      joined_at BIGINT NOT NULL,
      connected BOOLEAN NOT NULL DEFAULT FALSE,
      last_seen_at BIGINT NOT NULL,
      resume_token_hash TEXT NOT NULL DEFAULT '',
      left_at BIGINT,
      PRIMARY KEY (pin, id)
    )
  `);
  await database.query("ALTER TABLE live_session_players ADD COLUMN IF NOT EXISTS left_at BIGINT");
  await database.query("CREATE INDEX IF NOT EXISTS live_session_players_pin_score_idx ON live_session_players (pin, score DESC)");
  await database.query(
    "CREATE INDEX IF NOT EXISTS live_session_players_pin_resume_idx ON live_session_players (pin, resume_token_hash) WHERE resume_token_hash <> ''"
  );
  await database.query(`
    CREATE TABLE IF NOT EXISTS live_session_answers (
      pin TEXT NOT NULL REFERENCES live_sessions(pin) ON DELETE CASCADE,
      question_index INTEGER NOT NULL,
      player_id UUID NOT NULL,
      option_id TEXT NOT NULL,
      selected_option_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      answered_at BIGINT NOT NULL,
      PRIMARY KEY (pin, question_index, player_id)
    )
  `);
  await database.query("ALTER TABLE live_session_answers ADD COLUMN IF NOT EXISTS selected_option_ids JSONB NOT NULL DEFAULT '[]'::jsonb");
  await database.query(`UPDATE live_session_answers
    SET selected_option_ids = jsonb_build_array(option_id)
    WHERE jsonb_array_length(selected_option_ids) = 0`);
  await database.query("CREATE INDEX IF NOT EXISTS live_session_answers_pin_question_idx ON live_session_answers (pin, question_index)");
  await migrateLegacyLiveSessionState();
  await database.query(`
    CREATE TABLE IF NOT EXISTS presentations (
      id UUID PRIMARY KEY,
      presenter_id UUID NOT NULL REFERENCES presenters(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      snapshot JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query("ALTER TABLE presentations ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1");
  await database.query("CREATE INDEX IF NOT EXISTS presentations_presenter_updated_idx ON presentations (presenter_id, updated_at DESC)");
  await database.query(`
    CREATE TABLE IF NOT EXISTS presenter_sessions (
      token_hash TEXT PRIMARY KEY,
      presenter_id UUID NOT NULL REFERENCES presenters(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      token_version SMALLINT NOT NULL DEFAULT 1,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query("ALTER TABLE presenter_sessions ADD COLUMN IF NOT EXISTS token_version SMALLINT NOT NULL DEFAULT 1");
  await database.query("CREATE INDEX IF NOT EXISTS presenter_sessions_expiry_idx ON presenter_sessions (expires_at)");
  await database.query(`
    CREATE TABLE IF NOT EXISTS media_assets (
      id UUID PRIMARY KEY,
      presenter_id UUID NOT NULL REFERENCES presenters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query("CREATE INDEX IF NOT EXISTS media_assets_presenter_idx ON media_assets (presenter_id, created_at DESC)");
  await migrateLegacyMediaAssets();
}

async function migrateLegacyMediaAssets() {
  if (!database) {
    return;
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pinboard_media_migration_v2'))");
    const presentationsResult = await client.query("SELECT id, presenter_id, snapshot FROM presentations");
    for (const record of presentationsResult.rows) {
      const migrated = await migrateSnapshotMedia(client, record.snapshot, record.presenter_id, `presentation ${record.id}`);
      if (migrated.changed) {
        await backupMigrationSnapshot(client, "presentation", record.id, "media_v2", record.snapshot);
        await client.query("UPDATE presentations SET snapshot = $2, updated_at = NOW() WHERE id = $1", [record.id, JSON.stringify(migrated.snapshot)]);
      }
    }

    const sessionsResult = await client.query("SELECT pin, snapshot FROM live_sessions");
    for (const record of sessionsResult.rows) {
      const presenterId = record.snapshot?.presenterId;
      if (typeof presenterId !== "string") {
        continue;
      }
      const migrated = await migrateSnapshotMedia(client, record.snapshot, presenterId, `session ${record.pin}`);
      if (migrated.changed) {
        await backupMigrationSnapshot(client, "live_session", record.pin, "media_v2", record.snapshot);
        await client.query(
          "UPDATE live_sessions SET snapshot = $2, version = version + 1, updated_at = NOW() WHERE pin = $1",
          [record.pin, JSON.stringify(migrated.snapshot)]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function backupMigrationSnapshot(client, entityType, entityId, migrationName, snapshot) {
  await client.query(
    `INSERT INTO migration_snapshot_backups (entity_type, entity_id, migration_name, snapshot)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (entity_type, entity_id, migration_name) DO NOTHING`,
    [entityType, String(entityId), migrationName, JSON.stringify(snapshot ?? {})]
  );
}

async function migrateSnapshotMedia(client, sourceSnapshot, presenterId, label) {
  const normalizedIds = normalizeLegacySnapshotIds(sourceSnapshot);
  const snapshot = normalizedIds.snapshot;
  let changed = normalizedIds.changed;
  for (const question of Array.isArray(snapshot?.questions) ? snapshot.questions : []) {
    const legacyMedia = question?.media;
    if (!legacyMedia || typeof legacyMedia.dataUrl !== "string") {
      continue;
    }
    changed = true;
    const validation = validateMediaDataUrl({
      dataUrl: legacyMedia.dataUrl,
      declaredMimeType: legacyMedia.type,
      maxBytes: MAX_MEDIA_BYTES
    });
    if (!validation.ok) {
      console.warn(`Removed invalid legacy media from ${label}: ${validation.code}`);
      question.media = null;
      continue;
    }
    const name = normalizeLegacyMediaName(legacyMedia.name);
    const asset = await createMediaAsset({
      presenterId,
      name,
      mimeType: validation.mimeType,
      data: validation.bytes
    }, client);
    question.media = serializeMediaAsset(asset);
  }
  return { changed, snapshot };
}

function normalizeLegacyMediaName(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return (candidate || "Migrated media").slice(0, MAX_MEDIA_NAME_LENGTH);
}

async function bootstrapPresenter() {
  if (!BOOTSTRAP_PRESENTER_EMAIL || !BOOTSTRAP_PRESENTER_PASSWORD) {
    return;
  }

  const passwordHash = await createPasswordHash(BOOTSTRAP_PRESENTER_PASSWORD);

  if (!database) {
    localPresentersByEmail.set(BOOTSTRAP_PRESENTER_EMAIL, {
      id: randomUUID(),
      email: BOOTSTRAP_PRESENTER_EMAIL,
      name: DEFAULT_PRESENTER_NAME,
      passwordHash
    });
    return;
  }

  await database.query(
    `
      INSERT INTO presenters (id, email, name, password_hash)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email)
      DO UPDATE SET
        name = COALESCE(presenters.name, EXCLUDED.name),
        password_hash = EXCLUDED.password_hash,
        updated_at = NOW()
    `,
    [randomUUID(), BOOTSTRAP_PRESENTER_EMAIL, DEFAULT_PRESENTER_NAME, passwordHash]
  );
}

async function findPresenterByEmail(email) {
  if (!database) {
    return localPresentersByEmail.get(email) ?? null;
  }

  const result = await database.query(
    "SELECT id, email, COALESCE(name, split_part(email, '@', 1)) AS name, password_hash AS \"passwordHash\", google_sub AS \"googleSub\" FROM presenters WHERE email = $1",
    [email]
  );
  return result.rows[0] ?? null;
}

async function findPresenterById(id) {
  if (!database) {
    return [...localPresentersByEmail.values()].find((presenter) => presenter.id === id) ?? null;
  }

  const result = await database.query(
    "SELECT id, email, COALESCE(name, split_part(email, '@', 1)) AS name, password_hash AS \"passwordHash\", google_sub AS \"googleSub\" FROM presenters WHERE id = $1",
    [id]
  );
  return result.rows[0] ?? null;
}

async function findPresenterByGoogleSub(googleSub) {
  if (!googleSub) {
    return null;
  }

  if (!database) {
    return [...localPresentersByEmail.values()].find((presenter) => presenter.googleSub === googleSub) ?? null;
  }

  const result = await database.query(
    "SELECT id, email, COALESCE(name, split_part(email, '@', 1)) AS name, password_hash AS \"passwordHash\", google_sub AS \"googleSub\" FROM presenters WHERE google_sub = $1",
    [googleSub]
  );
  return result.rows[0] ?? null;
}

async function findOrCreateGooglePresenter(profile) {
  if (!isGooglePresenterAllowed(profile.email)) {
    throw new HttpError(403, "This Google account is not allowed to present.", "GOOGLE_ACCOUNT_NOT_ALLOWED");
  }
  const normalizedEmail = normalizeEmail(profile.email);
  const googleSub = typeof profile.sub === "string" && profile.sub ? profile.sub : null;
  const name = normalizePresenterName(profile.name, normalizedEmail);
  const existing = (await findPresenterByGoogleSub(googleSub)) ?? (await findPresenterByEmail(normalizedEmail));

  if (existing) {
    return updatePresenterGoogleProfile(existing, { email: normalizedEmail, name, googleSub });
  }

  const presenter = {
    id: randomUUID(),
    email: normalizedEmail,
    name,
    googleSub,
    passwordHash: await createPasswordHash(randomBytes(32).toString("base64url"))
  };

  if (!database) {
    localPresentersByEmail.set(normalizedEmail, presenter);
    return presenter;
  }

  const result = await database.query(
    `
      INSERT INTO presenters (id, email, name, google_sub, password_hash)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (email)
      DO UPDATE SET
        name = EXCLUDED.name,
        google_sub = COALESCE(EXCLUDED.google_sub, presenters.google_sub),
        updated_at = NOW()
      RETURNING id, email, COALESCE(name, split_part(email, '@', 1)) AS name, password_hash AS "passwordHash", google_sub AS "googleSub"
    `,
    [presenter.id, presenter.email, presenter.name, presenter.googleSub, presenter.passwordHash]
  );
  return result.rows[0];
}

function isGooglePresenterAllowed(email) {
  const normalized = normalizeEmail(email);
  const domain = normalized.split("@")[1] ?? "";
  return GOOGLE_ALLOWED_EMAILS.has(normalized) || GOOGLE_ALLOWED_DOMAINS.has(domain);
}

async function updatePresenterGoogleProfile(existing, profile) {
  if (!database) {
    localPresentersByEmail.delete(existing.email);
    const updated = {
      ...existing,
      email: profile.email,
      name: profile.name,
      googleSub: profile.googleSub ?? existing.googleSub ?? null
    };
    localPresentersByEmail.set(updated.email, updated);
    return updated;
  }

  const result = await database.query(
    `
      UPDATE presenters
      SET email = $2,
        name = $3,
        google_sub = COALESCE($4, google_sub),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, email, COALESCE(name, split_part(email, '@', 1)) AS name, password_hash AS "passwordHash", google_sub AS "googleSub"
    `,
    [existing.id, profile.email, profile.name, profile.googleSub]
  );
  return result.rows[0];
}

async function listPresentationsForPresenter(presenterId) {
  if (!database) {
    return [...localPresentationsById.values()]
      .filter((presentation) => presentation.presenterId === presenterId)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  const result = await database.query(
    `
      SELECT id, presenter_id AS "presenterId", title, snapshot, version,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM presentations
      WHERE presenter_id = $1
      ORDER BY updated_at DESC
    `,
    [presenterId]
  );
  return result.rows.map(normalizePresentationRecord);
}

async function createPresentationForPresenter(presenterId, snapshot) {
  const now = new Date().toISOString();
  const presentation = {
    id: randomUUID(),
    presenterId,
    title: snapshot.title,
    snapshot,
    createdAt: now,
    updatedAt: now,
    version: 1
  };

  if (!database) {
    localPresentationsById.set(presentation.id, presentation);
    return presentation;
  }

  const result = await database.query(
    `
      INSERT INTO presentations (id, presenter_id, title, snapshot)
      VALUES ($1, $2, $3, $4)
      RETURNING id, presenter_id AS "presenterId", title, snapshot, version,
        created_at AS "createdAt", updated_at AS "updatedAt"
    `,
    [presentation.id, presenterId, snapshot.title, JSON.stringify(snapshot)]
  );
  return normalizePresentationRecord(result.rows[0]);
}

async function getPresentationForPresenter(presenterId, presentationId) {
  if (!database) {
    const presentation = localPresentationsById.get(presentationId);
    if (!presentation || presentation.presenterId !== presenterId) {
      throw new HttpError(404, "Presentation was not found.");
    }
    return presentation;
  }

  const result = await database.query(
    `
      SELECT id, presenter_id AS "presenterId", title, snapshot, version,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM presentations
      WHERE id = $1 AND presenter_id = $2
    `,
    [presentationId, presenterId]
  );

  if (!result.rows[0]) {
    throw new HttpError(404, "Presentation was not found.");
  }
  return normalizePresentationRecord(result.rows[0]);
}

async function updatePresentationForPresenter(presenterId, presentationId, snapshot, expectedVersion) {
  if (!database) {
    const existing = await getPresentationForPresenter(presenterId, presentationId);
    if (existing.version !== expectedVersion) {
      throw new HttpError(409, "This presentation changed in another tab. Reload before saving again.", "PRESENTATION_VERSION_CONFLICT");
    }
    const updated = {
      ...existing,
      title: snapshot.title,
      snapshot,
      updatedAt: new Date().toISOString(),
      version: existing.version + 1
    };
    localPresentationsById.set(presentationId, updated);
    return updated;
  }

  const result = await database.query(
    `
      UPDATE presentations
      SET title = $3,
        snapshot = $4,
        version = version + 1,
        updated_at = NOW()
      WHERE id = $1 AND presenter_id = $2 AND version = $5
      RETURNING id, presenter_id AS "presenterId", title, snapshot, version,
        created_at AS "createdAt", updated_at AS "updatedAt"
    `,
    [presentationId, presenterId, snapshot.title, JSON.stringify(snapshot), expectedVersion]
  );

  if (!result.rows[0]) {
    const exists = await database.query(
      "SELECT 1 FROM presentations WHERE id = $1 AND presenter_id = $2",
      [presentationId, presenterId]
    );
    if (exists.rowCount > 0) {
      throw new HttpError(409, "This presentation changed in another tab. Reload before saving again.", "PRESENTATION_VERSION_CONFLICT");
    }
    throw new HttpError(404, "Presentation was not found.");
  }
  return normalizePresentationRecord(result.rows[0]);
}

async function deletePresentationForPresenter(presenterId, presentationId) {
  if (!database) {
    await getPresentationForPresenter(presenterId, presentationId);
    localPresentationsById.delete(presentationId);
    return;
  }

  const result = await database.query(
    `
      DELETE FROM presentations
      WHERE id = $1 AND presenter_id = $2
      RETURNING id
    `,
    [presentationId, presenterId]
  );

  if (!result.rows[0]) {
    throw new HttpError(404, "Presentation was not found.");
  }
}

async function duplicatePresentationForPresenter(presenterId, presentationId) {
  const source = await getPresentationForPresenter(presenterId, presentationId);
  const snapshot = createDuplicatePresentationSnapshot(source.snapshot);
  return createPresentationForPresenter(presenterId, snapshot);
}

function normalizePresentationRecord(record) {
  const snapshot = typeof record.snapshot === "string" ? JSON.parse(record.snapshot) : record.snapshot;
  return {
    id: record.id,
    presenterId: record.presenterId,
    title: record.title,
    snapshot,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    version: Number(record.version ?? 1)
  };
}

function createDuplicatePresentationSnapshot(snapshot) {
  const clone = JSON.parse(JSON.stringify(snapshot ?? createBlankPresentationSnapshot()));
  const sourceTitle = typeof clone.title === "string" && clone.title.trim()
    ? clone.title.trim()
    : "Untitled presentation";
  return normalizePresentationSnapshot({
    ...clone,
    title: `${sourceTitle}${DUPLICATE_TITLE_SUFFIX}`.slice(0, MAX_TITLE_LENGTH)
  });
}

function createBlankPresentationSnapshot() {
  const options = ["Answer 1", "Answer 2", "Answer 3", "Answer 4"].map((text) => ({
    id: randomUUID(),
    text
  }));

  return {
    title: "Untitled presentation",
    questions: [
      {
        id: randomUUID(),
        kind: "quiz",
        text: "Untitled question",
        points: 1000,
        timerSeconds: DEFAULT_TIMER_SECONDS,
        options,
        correctOptionIds: [options[0].id],
        media: null
      }
    ]
  };
}

function assertGoogleOAuthConfigured() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new HttpError(503, "Google OAuth is not configured yet.");
  }
}

function assertGoogleClientIdConfigured() {
  if (!GOOGLE_CLIENT_ID) {
    throw new HttpError(503, "Google sign-in is not configured yet.");
  }
}

function getGoogleRedirectUri(request) {
  if (GOOGLE_REDIRECT_URI) {
    return GOOGLE_REDIRECT_URI;
  }
  const proto = request.headers["x-forwarded-proto"] ?? "http";
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  return `${proto}://${host}/auth/google/callback`;
}

async function exchangeGoogleCode(request, code) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: getGoogleRedirectUri(request),
      grant_type: "authorization_code"
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new HttpError(502, "Google token exchange failed.");
  }
  return payload;
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.email !== "string") {
    throw new HttpError(502, "Google profile lookup failed.");
  }
  return {
    sub: typeof payload.sub === "string" ? payload.sub : null,
    email: payload.email,
    name: typeof payload.name === "string" ? payload.name : "",
    email_verified: payload.email_verified === true || payload.email_verified === "true"
  };
}

async function verifyGoogleCredentialToken(credential) {
  if (credential.length > GOOGLE_TOKEN_MAX_LENGTH) {
    throw new HttpError(400, "Google credential is too large.");
  }

  const parts = credential.split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "Google credential is not valid.");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseBase64UrlJson(encodedHeader, "Google credential header");
  const payload = parseBase64UrlJson(encodedPayload, "Google credential payload");

  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new HttpError(401, "Google credential signature is not supported.");
  }

  const jwk = await getGoogleJwk(header.kid);
  const isValidSignature = verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(encodedSignature, "base64url")
  );

  if (!isValidSignature) {
    throw new HttpError(401, "Google credential signature is not valid.");
  }

  if (!GOOGLE_ISSUERS.has(payload.iss)) {
    throw new HttpError(401, "Google credential issuer is not valid.");
  }

  if (payload.aud !== GOOGLE_CLIENT_ID) {
    throw new HttpError(401, "Google credential audience is not valid.");
  }

  if (Number(payload.exp) * 1000 < Date.now()) {
    throw new HttpError(401, "Google credential has expired.");
  }

  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new HttpError(403, "Google email must be verified.");
  }

  if (typeof payload.email !== "string" || !payload.email.includes("@")) {
    throw new HttpError(401, "Google credential email is not valid.");
  }

  return {
    sub: typeof payload.sub === "string" ? payload.sub : null,
    email: payload.email,
    name: typeof payload.name === "string" ? payload.name : ""
  };
}

function parseBase64UrlJson(value, label) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(401, `${label} is not valid.`);
  }
}

async function getGoogleJwk(keyId) {
  const now = Date.now();
  if (googleJwksCache.expiresAt <= now || !googleJwksCache.keys.has(keyId)) {
    await refreshGoogleJwks();
  }

  const jwk = googleJwksCache.keys.get(keyId);
  if (!jwk) {
    throw new HttpError(401, "Google credential key is not recognized.");
  }
  return jwk;
}

async function refreshGoogleJwks() {
  const response = await fetch(GOOGLE_JWKS_URL);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !Array.isArray(payload.keys)) {
    throw new HttpError(502, "Google signing keys could not be loaded.");
  }

  const keys = new Map();
  for (const key of payload.keys) {
    if (typeof key.kid === "string") {
      keys.set(key.kid, key);
    }
  }

  googleJwksCache.keys = keys;
  googleJwksCache.expiresAt = Date.now() + parseGoogleCacheTtl(response.headers.get("cache-control"));
}

function parseGoogleCacheTtl(cacheControl) {
  const match = String(cacheControl ?? "").match(/max-age=(\d+)/);
  if (!match) {
    return GOOGLE_JWKS_DEFAULT_TTL_MS;
  }
  return Math.max(60_000, Number(match[1]) * 1000);
}

async function createPasswordHash(password) {
  const salt = randomBytes(PASSWORD_SALT_BYTES).toString("base64url");
  const key = await scryptAsync(password, salt, PASSWORD_KEY_BYTES);
  return `scrypt:${salt}:${Buffer.from(key).toString("base64url")}`;
}

async function verifyPassword(password, passwordHash) {
  const [scheme, salt, storedKey] = passwordHash.split(":");
  if (scheme !== "scrypt" || !salt || !storedKey) {
    return false;
  }

  const candidate = Buffer.from(await scryptAsync(password, salt, PASSWORD_KEY_BYTES));
  const stored = Buffer.from(storedKey, "base64url");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

function constantTimeStringEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function normalizePresenterName(name, email) {
  const trimmed = String(name ?? "").trim().slice(0, MAX_PRESENTER_NAME_LENGTH);
  return trimmed || derivePresenterName(email);
}

function derivePresenterName(email) {
  const localPart = String(email ?? "").split("@")[0]?.trim();
  return localPart || DEFAULT_PRESENTER_NAME;
}

async function getSession(pin) {
  const normalizedPin = normalizePin(pin);
  const context = sessionMutationStorage.getStore();
  if (context?.session?.pin === normalizedPin) {
    return context.session;
  }
  const session = database ? await loadPersistedSession(normalizedPin) : sessions.get(normalizedPin);
  if (!session) {
    throw new HttpError(404, "Session was not found.");
  }
  if (context) {
    context.session = session;
  } else {
    scheduleQuestionTimer(session);
  }
  return session;
}

function normalizePin(pin) {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) {
    throw new HttpError(400, "PIN must be 6 digits.");
  }
  return pin;
}

async function createUniquePin() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pin = String(randomInt(0, 10 ** GAME_PIN_LENGTH)).padStart(GAME_PIN_LENGTH, "0");
    if (!sessions.has(pin) && !(await persistedSessionExists(pin))) {
      return pin;
    }
  }
  throw new HttpError(503, "No session PINs are available right now.");
}

async function persistedSessionExists(pin) {
  if (!database) {
    return false;
  }

  const result = await database.query("SELECT 1 FROM live_sessions WHERE pin = $1", [pin]);
  return result.rowCount > 0;
}

async function persistPlayer(session, player) {
  markSessionDirty(session);
  if (!database || !player) {
    return;
  }
  await upsertPlayerRecord(getSessionQueryable(), session.pin, player);
}

async function persistPlayerPresence(session, player) {
  markSessionDirty(session);
  if (!database || !player) {
    return;
  }
  await getSessionQueryable().query(
    `UPDATE live_session_players
     SET connected = $3, last_seen_at = $4, resume_token_hash = $5, left_at = $6
     WHERE pin = $1 AND id = $2`,
    [session.pin, player.id, player.connected === true, player.lastSeenAt, player.resumeTokenHash, player.leftAt]
  );
}

async function persistPlayers(session) {
  markSessionDirty(session);
  if (!database || session.players.size === 0) {
    return;
  }
  const players = [...session.players.values()];
  await getSessionQueryable().query(
    `INSERT INTO live_session_players
       (pin, id, nickname, score, joined_at, connected, last_seen_at, resume_token_hash, left_at)
     SELECT $1, *
     FROM UNNEST($2::uuid[], $3::text[], $4::integer[], $5::bigint[], $6::boolean[], $7::bigint[], $8::text[], $9::bigint[])
     ON CONFLICT (pin, id) DO UPDATE SET
       nickname = EXCLUDED.nickname,
       score = EXCLUDED.score,
       connected = EXCLUDED.connected,
       last_seen_at = EXCLUDED.last_seen_at,
       resume_token_hash = EXCLUDED.resume_token_hash,
       left_at = EXCLUDED.left_at`,
    [
      session.pin,
      players.map((player) => player.id),
      players.map((player) => player.nickname),
      players.map((player) => player.score),
      players.map((player) => player.joinedAt),
      players.map((player) => player.connected === true),
      players.map((player) => player.lastSeenAt),
      players.map((player) => player.resumeTokenHash),
      players.map((player) => player.leftAt)
    ]
  );
}

async function upsertPlayerRecord(queryable, pin, player) {
  await queryable.query(
    `INSERT INTO live_session_players
       (pin, id, nickname, score, joined_at, connected, last_seen_at, resume_token_hash, left_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (pin, id) DO UPDATE SET
       nickname = EXCLUDED.nickname,
       score = EXCLUDED.score,
       connected = EXCLUDED.connected,
       last_seen_at = EXCLUDED.last_seen_at,
       resume_token_hash = EXCLUDED.resume_token_hash,
       left_at = EXCLUDED.left_at`,
    [pin, player.id, player.nickname, player.score, player.joinedAt, player.connected === true, player.lastSeenAt, player.resumeTokenHash, player.leftAt ?? null]
  );
}

async function persistAnswer(session, playerId, answer) {
  markSessionDirty(session);
  if (!database) {
    return true;
  }
  const result = await getSessionQueryable().query(
    `INSERT INTO live_session_answers (pin, question_index, player_id, option_id, selected_option_ids, answered_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (pin, question_index, player_id) DO NOTHING
     RETURNING player_id`,
    [session.pin, session.currentQuestionIndex, playerId, answer.selectedOptionIds[0], JSON.stringify(answer.selectedOptionIds), answer.answeredAt]
  );
  return result.rowCount > 0;
}

function normalizePersistedSelectedOptionIds(answer) {
  if (Array.isArray(answer?.selected_option_ids) && answer.selected_option_ids.length > 0) {
    return answer.selected_option_ids.filter((id) => typeof id === "string");
  }
  if (Array.isArray(answer?.selectedOptionIds) && answer.selectedOptionIds.length > 0) {
    return answer.selectedOptionIds.filter((id) => typeof id === "string");
  }
  return typeof answer?.option_id === "string" ? [answer.option_id] : [];
}

async function getPersistedAnswer(pin, questionIndex, playerId) {
  if (!database) {
    return null;
  }
  const result = await getSessionQueryable().query(
    `SELECT option_id, selected_option_ids, answered_at
     FROM live_session_answers
     WHERE pin = $1 AND question_index = $2 AND player_id = $3`,
    [pin, questionIndex, playerId]
  );
  return result.rows[0] ? {
    selectedOptionIds: normalizePersistedSelectedOptionIds(result.rows[0]),
    answeredAt: Number(result.rows[0].answered_at)
  } : null;
}

async function markPersistedPlayersOffline() {
  if (database) {
    await database.query("UPDATE live_session_players SET connected = FALSE");
  }
}

async function migrateLegacyLiveSessionState() {
  if (!database) {
    return;
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pinboard_session_state_migration_v2'))");
    const result = await client.query("SELECT pin, snapshot FROM live_sessions");
    for (const record of result.rows) {
      const normalizedIds = normalizeLegacySnapshotIds(record.snapshot ?? {});
      const snapshot = normalizedIds.snapshot;
      const hasEmbeddedState = Object.hasOwn(snapshot, "players") || Object.hasOwn(snapshot, "answers");
      for (const [playerId, source] of Array.isArray(snapshot.players) ? snapshot.players : []) {
        if (!isStrictStableId(playerId) || !source || typeof source.nickname !== "string") {
          continue;
        }
        await upsertPlayerRecord(client, record.pin, {
          id: playerId,
          nickname: source.nickname,
          score: Number(source.score ?? 0),
          joinedAt: Number(source.joinedAt ?? Date.now()),
          connected: false,
          lastSeenAt: Number(source.lastSeenAt ?? source.joinedAt ?? Date.now()),
          resumeTokenHash: typeof source.resumeTokenHash === "string" ? source.resumeTokenHash : ""
        });
      }
      for (const [playerId, answer] of Array.isArray(snapshot.answers) ? snapshot.answers : []) {
        if (!isStrictStableId(playerId) || !isSafeLegacyStableId(answer?.optionId)) {
          continue;
        }
        await client.query(
          `INSERT INTO live_session_answers (pin, question_index, player_id, option_id, selected_option_ids, answered_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (pin, question_index, player_id) DO NOTHING`,
          [record.pin, Number(snapshot.currentQuestionIndex ?? -1), playerId, answer.optionId, JSON.stringify([answer.optionId]), Number(answer.answeredAt ?? Date.now())]
        );
      }
      if (normalizedIds.changed || hasEmbeddedState) {
        const normalizedSnapshot = { ...snapshot };
        delete normalizedSnapshot.players;
        delete normalizedSnapshot.answers;
        await backupMigrationSnapshot(client, "live_session", record.pin, "normalized_state_v2", record.snapshot);
        await client.query(
          "UPDATE live_sessions SET snapshot = $2, version = version + 1, updated_at = NOW() WHERE pin = $1",
          [record.pin, JSON.stringify(normalizedSnapshot)]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function normalizeLegacySnapshotIds(sourceSnapshot) {
  const snapshot = JSON.parse(JSON.stringify(sourceSnapshot ?? {}));
  const questionIds = new Set();
  const optionMaps = [];
  let changed = false;

  for (const question of Array.isArray(snapshot.questions) ? snapshot.questions : []) {
    if (!isStrictStableId(question.id) || questionIds.has(question.id)) {
      question.id = randomUUID();
      changed = true;
    }
    questionIds.add(question.id);

    const optionIds = new Set();
    const optionMap = new Map();
    for (const option of Array.isArray(question.options) ? question.options : []) {
      const oldId = option.id;
      if (!isStrictStableId(oldId) || optionIds.has(oldId)) {
        option.id = randomUUID();
        changed = true;
      }
      optionIds.add(option.id);
      if (typeof oldId === "string" && !optionMap.has(oldId)) {
        optionMap.set(oldId, option.id);
      }
    }
    if (typeof question.correctOptionId === "string" && optionMap.has(question.correctOptionId)) {
      const nextCorrectOptionId = optionMap.get(question.correctOptionId);
      if (nextCorrectOptionId !== question.correctOptionId) {
        question.correctOptionId = nextCorrectOptionId;
        changed = true;
      }
    }
    optionMaps.push(optionMap);
  }

  const currentOptionMap = optionMaps[Number(snapshot.currentQuestionIndex)] ?? new Map();
  if (Array.isArray(snapshot.answers)) {
    for (const entry of snapshot.answers) {
      const answer = entry?.[1];
      if (typeof answer?.optionId === "string" && currentOptionMap.has(answer.optionId)) {
        const nextOptionId = currentOptionMap.get(answer.optionId);
        if (nextOptionId !== answer.optionId) {
          answer.optionId = nextOptionId;
          changed = true;
        }
      }
    }
  }

  return { changed, snapshot };
}

function isSafeLegacyStableId(value) {
  return typeof value === "string" && SAFE_LEGACY_ID_PATTERN.test(value);
}

async function persistSession(session) {
  const context = sessionMutationStorage.getStore();
  if (context && context.session === session) {
    markSessionDirty(session);
    return;
  }

  sessions.set(session.pin, session);

  if (!database) {
    session.version += 1;
    return;
  }

  const snapshot = JSON.stringify(serializeSessionSnapshot(session));
  const result = session.version === 0
    ? await database.query(
      `INSERT INTO live_sessions (pin, snapshot, version, updated_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (pin) DO NOTHING
       RETURNING version`,
      [session.pin, snapshot]
    )
    : await database.query(
      `UPDATE live_sessions
       SET snapshot = $2, version = version + 1, updated_at = NOW()
       WHERE pin = $1 AND version = $3
       RETURNING version`,
      [session.pin, snapshot, session.version]
    );

  if (!result.rows[0]) {
    sessions.delete(session.pin);
    throw new HttpError(409, "Session changed in another process. Please retry.", "SESSION_VERSION_CONFLICT");
  }
  session.version = Number(result.rows[0].version);
  await notifySessionChanged(session).catch((error) => logBackgroundError("new session notification", error));
}

async function loadPersistedSession(pin, options = {}) {
  if (!database) {
    return sessions.get(pin) ?? null;
  }

  const queryable = options.queryable ?? database;
  const lockClause = options.forUpdate === true ? " FOR UPDATE" : "";
  const result = await queryable.query(
    `SELECT snapshot, version FROM live_sessions WHERE pin = $1${lockClause}`,
    [pin]
  );
  if (!result.rows[0]) {
    return null;
  }

  const playersResult = await queryable.query(
    `SELECT id, nickname, score, joined_at, connected, last_seen_at, resume_token_hash, left_at
     FROM live_session_players WHERE pin = $1`,
    [pin]
  );
  const answersResult = await queryable.query(
    `SELECT player_id, option_id, selected_option_ids, answered_at
     FROM live_session_answers
     WHERE pin = $1 AND question_index = $2`,
    [pin, Number(result.rows[0].snapshot?.currentQuestionIndex ?? -1)]
  );
  const localClients = sessions.get(pin)?.clients ?? new Map();
  const session = hydrateSessionSnapshot(
    result.rows[0].snapshot,
    localClients,
    Number(result.rows[0].version),
    playersResult.rows,
    answersResult.rows
  );
  if (options.cache !== false) {
    sessions.set(pin, session);
  }
  return session;
}

function getSessionQueryable() {
  return sessionMutationStorage.getStore()?.client ?? database;
}

function markSessionDirty(session) {
  const context = sessionMutationStorage.getStore();
  if (context && (!context.session || context.session === session)) {
    context.session = session;
    context.dirty = true;
    return;
  }
  sessions.set(session.pin, session);
}

function serializeSessionSnapshot(session) {
  return {
    pin: session.pin,
    title: session.title,
    presenterId: session.presenterId,
    questions: session.questions,
    phase: session.phase,
    currentQuestionIndex: session.currentQuestionIndex,
    scoredQuestionIndexes: [...session.scoredQuestionIndexes],
    openedAt: session.openedAt,
    endedReason: session.endedReason,
    endedAt: session.endedAt,
    createdAt: session.createdAt
  };
}

function hydrateSessionSnapshot(snapshot, clients, version = 0, playerRows = [], answerRows = []) {
  const legacyPlayers = (snapshot.players ?? []).map(([id, player]) => ({
    id,
    nickname: player?.nickname,
    score: player?.score,
    joined_at: player?.joinedAt,
    connected: player?.connected,
    last_seen_at: player?.lastSeenAt,
    resume_token_hash: player?.resumeTokenHash,
    left_at: player?.leftAt
  }));
  const players = new Map((playerRows.length > 0 ? playerRows : legacyPlayers).map((player) => [player.id, {
    id: player.id,
    nickname: player.nickname,
    score: Number(player.score ?? 0),
    joinedAt: Number(player.joined_at ?? Date.now()),
    connected: player.connected === true,
    lastSeenAt: Number(player.last_seen_at ?? player.joined_at ?? Date.now()),
    resumeTokenHash: typeof player.resume_token_hash === "string" ? player.resume_token_hash : "",
    leftAt: player.left_at == null ? null : Number(player.left_at)
  }]));
  const legacyAnswers = (snapshot.answers ?? []).map(([playerId, answer]) => ({
    player_id: playerId,
    option_id: answer?.optionId,
    selected_option_ids: answer?.selectedOptionIds,
    answered_at: answer?.answeredAt
  }));
  const answers = new Map((answerRows.length > 0 ? answerRows : legacyAnswers).map((answer) => [answer.player_id, {
    selectedOptionIds: normalizePersistedSelectedOptionIds(answer),
    answeredAt: Number(answer.answered_at ?? Date.now())
  }]));
  return {
    pin: snapshot.pin,
    title: snapshot.title,
    presenterId: snapshot.presenterId,
    questions: Array.isArray(snapshot.questions) ? snapshot.questions : [],
    phase: snapshot.phase,
    currentQuestionIndex: Number(snapshot.currentQuestionIndex),
    players,
    answers,
    scoredQuestionIndexes: new Set(snapshot.scoredQuestionIndexes ?? []),
    openedAt: snapshot.openedAt ?? null,
    clients,
    endedReason: snapshot.endedReason ?? null,
    endedAt: snapshot.endedAt ?? null,
    createdAt: snapshot.createdAt ?? Date.now(),
    version
  };
}

function serializePresenter(presenter) {
  return {
    id: presenter.id,
    email: presenter.email,
    name: presenter.name || derivePresenterName(presenter.email)
  };
}

function serializePresentationSummary(presentation) {
  const titleCard = getPresentationTitleCard(presentation);
  return {
    id: presentation.id,
    title: presentation.title,
    createdAt: presentation.createdAt,
    updatedAt: presentation.updatedAt,
    version: presentation.version,
    questionCount: Array.isArray(presentation.snapshot?.questions) ? presentation.snapshot.questions.length : 0,
    titleCard
  };
}

function serializePresentation(presentation) {
  return {
    ...serializePresentationSummary(presentation),
    snapshot: presentation.snapshot
  };
}

function getPresentationTitleCard(presentation) {
  const firstItem = Array.isArray(presentation.snapshot?.questions) ? presentation.snapshot.questions[0] : null;
  return {
    title: presentation.title || "Untitled presentation",
    text: typeof firstItem?.text === "string" ? firstItem.text : "",
    kind: typeof firstItem?.kind === "string" ? firstItem.kind : ""
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Cookie"
  });
  response.end(JSON.stringify(payload));
}

async function establishPresenterSession(response, presenter, keepSignedIn, { redirect = false } = {}) {
  const token = createPresenterSessionToken();
  const csrfToken = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + PRESENTER_SESSION_TTL_MS;
  localPresenterSessions.set(hashSecret(token), { presenterId: presenter.id, csrfToken, expiresAt });
  if (database) {
    await database.query(
      `INSERT INTO presenter_sessions (token_hash, presenter_id, csrf_token, token_version, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [hashSecret(token), presenter.id, csrfToken, PRESENTER_TOKEN_VERSION, new Date(expiresAt)]
    );
  }
  setCookie(response, PRESENTER_COOKIE, token, keepSignedIn ? { maxAge: Math.floor(PRESENTER_SESSION_TTL_MS / 1000) } : {});
  if (redirect) {
    response.writeHead(302, { Location: "/presentation/homepage", "Cache-Control": "no-store" });
    response.end();
    return;
  }
  sendJson(response, 200, { csrfToken, presenter: serializePresenter(presenter) });
}

function setCookie(response, name, value, options = {}) {
  const maxAge = Number(options.maxAge ?? 0);
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (IS_PRODUCTION) {
    parts.push("Secure");
  }
  if (maxAge > 0) {
    parts.push(`Max-Age=${maxAge}`);
  }
  appendSetCookie(response, parts.join("; "));
}

function clearCookie(response, name) {
  appendSetCookie(response, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_PRODUCTION ? "; Secure" : ""}`);
}

function appendSetCookie(response, cookie) {
  const existing = response.getHeader("Set-Cookie");
  const values = existing ? (Array.isArray(existing) ? existing : [String(existing)]) : [];
  response.setHeader("Set-Cookie", [...values, cookie]);
}

function readCookies(request) {
  const header = request.headers.cookie ?? "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...valueParts] = part.split("=");
        try {
          return [name, decodeURIComponent(valueParts.join("="))];
        } catch {
          return [name, ""];
        }
      })
  );
}

function handleRouteError(response, error, requestId) {
  if (response.destroyed || !response.writable) {
    return;
  }
  if (response.headersSent) {
    response.end();
    return;
  }

  const isExpected = error instanceof HttpError || error instanceof DomainError;
  const statusCode = isExpected ? error.statusCode : 500;
  const message = isExpected ? error.message : "Unexpected server error.";
  const code = isExpected ? error.code : "INTERNAL_ERROR";
  if (Number.isInteger(error?.retryAfterSeconds)) {
    response.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
  if (!isExpected) {
    console.error(`[${requestId}]`, error);
  }
  sendJson(response, statusCode, { code, error: message, requestId });
}

function applyResponseSecurityHeaders(response, requestId) {
  const headers = createSecurityHeaders({ includeGoogleIdentity: Boolean(GOOGLE_CLIENT_ID) });
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.setHeader("X-Request-ID", requestId);
  if (IS_PRODUCTION) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function enforceMutationOrigin(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) {
    return;
  }
  const trustedOrigins = [getRequestOrigin(request), PUBLIC_ORIGIN].filter(Boolean);
  if (!isTrustedOrigin(request.headers.origin, trustedOrigins, { allowMissing: true })) {
    throw new HttpError(403, "Request origin is not allowed.", "ORIGIN_NOT_ALLOWED");
  }
}

function enforceRequestRateLimit(request) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const clientKey = getClientAddress(request);
  const principalKey = getRequestPrincipalKey(request, url);
  let result = null;

  if (
    (request.method === "POST" && (url.pathname === "/api/auth" || url.pathname === "/api/auth/google"))
    || (request.method === "GET" && (url.pathname === "/auth/google" || url.pathname === "/auth/google/callback"))
  ) {
    result = authRateLimiter.consume(`auth:${clientKey}`);
  } else if (request.method === "POST" && /\/join$/.test(url.pathname)) {
    const pin = url.pathname.match(/^\/api\/sessions\/(\d{6})\//)?.[1] ?? "unknown";
    const ipResult = playerJoinIpRateLimiter.consume(`join-ip:${clientKey}`);
    const pinResult = playerJoinRateLimiter.consume(`join-pin:${pin}:${clientKey}`);
    result = ipResult.allowed ? pinResult : ipResult;
  } else if (request.method === "POST" && /^\/api\/sessions\/\d{6}\/(?:resume|answer|leave)$/.test(url.pathname)) {
    result = playerActionRateLimiter.consume(`player:${principalKey}`);
  } else if (request.method === "GET" && url.pathname === "/events") {
    result = eventStreamRateLimiter.consume(`events:${principalKey}`);
  } else if (request.method === "POST" && url.pathname === "/api/media") {
    result = mediaUploadRateLimiter.consume(`media-upload:${principalKey}`);
  } else if ((request.method === "GET" || request.method === "HEAD") && /^\/api\/media\/[0-9a-f-]{36}$/.test(url.pathname)) {
    result = mediaRequestRateLimiter.consume(`media:${principalKey}`);
  } else if (request.method === "GET" && /^\/api\/sessions\/\d{6}\/qr\.svg$/.test(url.pathname)) {
    result = qrRequestRateLimiter.consume(`qr:${principalKey}`);
  } else if (url.pathname.startsWith("/api/") && principalKey.startsWith("presenter:")) {
    result = presenterRequestRateLimiter.consume(`api:${principalKey}`);
  }

  if (result && !result.allowed) {
    const error = new HttpError(429, "Too many requests. Please try again shortly.", "RATE_LIMITED");
    error.retryAfterSeconds = result.retryAfterSeconds;
    throw error;
  }
}

function getRequestPrincipalKey(request, url) {
  const cookies = readCookies(request);
  const presenterToken = cookies[PRESENTER_COOKIE];
  if (isValidPresenterSessionToken(presenterToken)) {
    return `presenter:${hashSecret(presenterToken)}`;
  }
  const pathPin = url.pathname.match(/^\/api\/sessions\/(\d{6})(?:\/|$)/)?.[1];
  const queryPin = /^\d{6}$/.test(url.searchParams.get("pin") ?? "") ? url.searchParams.get("pin") : null;
  const pin = pathPin ?? queryPin;
  if (pin) {
    const playerToken = cookies[getPlayerCookieName(pin)];
    if (isValidPlayerResumeToken(playerToken)) {
      return `player:${pin}:${hashSecret(playerToken)}`;
    }
  }
  return `ip:${getClientAddress(request)}`;
}

function getClientAddress(request) {
  return resolveClientAddress({
    trustProxy: TRUST_PROXY,
    realIp: Array.isArray(request.headers["x-real-ip"])
      ? request.headers["x-real-ip"][0]
      : request.headers["x-real-ip"],
    remoteAddress: request.socket.remoteAddress
  });
}

function getRequestOrigin(request) {
  const forwardedProto = TRUST_PROXY
    ? String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim()
    : "";
  const protocol = forwardedProto || (IS_PRODUCTION ? "https" : "http");
  const host = TRUST_PROXY ? request.headers["x-forwarded-host"] ?? request.headers.host : request.headers.host;
  return host ? `${protocol}://${String(host).split(",")[0].trim()}` : "";
}

function hashSecret(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function createPresenterSessionToken() {
  const identifier = randomBytes(PRESENTER_TOKEN_BYTES).toString("base64url");
  return `${identifier}.${signScopedSessionIdentifier("presenter", identifier)}`;
}

function isValidPresenterSessionToken(token) {
  return isValidScopedSessionToken(token, "presenter");
}

function createPlayerResumeToken() {
  const identifier = randomBytes(PRESENTER_TOKEN_BYTES).toString("base64url");
  return `${identifier}.${signScopedSessionIdentifier("player", identifier)}`;
}

function isValidPlayerResumeToken(token) {
  return isValidScopedSessionToken(token, "player");
}

function isValidScopedSessionToken(token, scope) {
  if (typeof token !== "string") {
    return false;
  }
  const [identifier, signature, extra] = token.split(".");
  if (extra !== undefined || !BASE64URL_SECRET_PATTERN.test(identifier ?? "") || !BASE64URL_SECRET_PATTERN.test(signature ?? "")) {
    return false;
  }
  return constantTimeStringEquals(signature, signScopedSessionIdentifier(scope, identifier));
}

function signScopedSessionIdentifier(scope, identifier) {
  return createHmac("sha256", AUTH_SECRET).update(`${scope}:${identifier}`).digest("base64url");
}

async function readPresenterAuthentication(request) {
  const token = readCookies(request)[PRESENTER_COOKIE];
  if (!token || !isValidPresenterSessionToken(token)) {
    return null;
  }
  const tokenHash = hashSecret(token);
  let session = null;
  if (database) {
    const result = await database.query(
      `SELECT presenter_id, csrf_token, expires_at
       FROM presenter_sessions
       WHERE token_hash = $1 AND token_version = $2 AND expires_at > NOW()`,
      [tokenHash, PRESENTER_TOKEN_VERSION]
    );
    if (result.rows[0]) {
      session = {
        presenterId: result.rows[0].presenter_id,
        csrfToken: result.rows[0].csrf_token,
        expiresAt: new Date(result.rows[0].expires_at).getTime()
      };
      localPresenterSessions.set(tokenHash, session);
    } else {
      localPresenterSessions.delete(tokenHash);
    }
  } else {
    session = localPresenterSessions.get(tokenHash) ?? null;
  }
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    localPresenterSessions.delete(tokenHash);
    return null;
  }
  return { tokenHash, session };
}

function assertCsrfToken(request, session) {
  const token = request.headers["x-csrf-token"];
  if (typeof token !== "string" || !constantTimeStringEquals(token, session.csrfToken)) {
    throw new HttpError(403, "CSRF token is not valid.", "CSRF_INVALID");
  }
}

async function cleanupExpiredState() {
  const now = Date.now();
  for (const [tokenHash, session] of localPresenterSessions) {
    if (session.expiresAt <= now) {
      localPresenterSessions.delete(tokenHash);
    }
  }
  for (const [pin, session] of sessions) {
    const endedExpired = session.phase === "ended"
      && now - Number(session.endedAt ?? session.createdAt) >= ENDED_SESSION_RETENTION_MS;
    const activeExpired = now - session.createdAt >= ACTIVE_SESSION_RETENTION_MS;
    if (endedExpired || activeExpired) {
      clearQuestionTimer(session);
      closeSessionClients(session);
      sessions.delete(pin);
    }
  }
  if (database) {
    await database.query("DELETE FROM presenter_sessions WHERE expires_at <= NOW()");
    await deleteExpiredSessionsAndNotify();
    await database.query(
      `DELETE FROM media_assets AS media
       WHERE media.created_at < NOW() - ($1::integer * INTERVAL '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM presentations
           WHERE snapshot::text LIKE '%' || media.id::text || '%'
         )
         AND NOT EXISTS (
           SELECT 1 FROM live_sessions
           WHERE snapshot::text LIKE '%' || media.id::text || '%'
         )`,
      [ORPHAN_MEDIA_RETENTION_DAYS]
    );
  }
}

async function deleteExpiredSessionsAndNotify() {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const deletedSessions = await client.query(
      `DELETE FROM live_sessions
       WHERE (updated_at < NOW() - INTERVAL '24 hours' AND snapshot ->> 'phase' = 'ended')
          OR updated_at < NOW() - INTERVAL '7 days'
       RETURNING pin`
    );
    for (const row of deletedSessions.rows) {
      await client.query("SELECT pg_notify($1, $2)", [
        SESSION_EVENTS_CHANNEL,
        JSON.stringify({ pin: row.pin, origin: INSTANCE_ID, deleted: true })
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError) => logBackgroundError("expired session rollback", rollbackError));
    throw error;
  } finally {
    client.release();
  }
}
