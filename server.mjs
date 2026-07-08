import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHmac, createPublicKey, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual, verify } from "node:crypto";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const BYTE = 1;
const KIB = 1024 * BYTE;
const MIB = 1024 * KIB;
const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_LOCAL_AUTH_SECRET = "local-development-secret-change-me";
const DEFAULT_LOCAL_PRESENTER_EMAIL = "presenter@pinboard.local";
const DEFAULT_LOCAL_PRESENTER_PASSWORD = "local-presenter-password";
const GAME_PIN_LENGTH = 6;
const MIN_OPTION_COUNT = 2;
const MAX_OPTION_COUNT = 6;
const MAX_QUESTION_COUNT = 200;
const MAX_TITLE_LENGTH = 120;
const MAX_QUESTION_TEXT_LENGTH = 500;
const MAX_OPTION_TEXT_LENGTH = 140;
const MAX_NICKNAME_LENGTH = 32;
const MAX_POINTS = 1_000_000;
const MAX_MEDIA_BYTES = Number(process.env.MAX_QUESTION_MEDIA_BYTES ?? 100 * MIB);
const BASE64_EXPANSION_RATIO = 4 / 3;
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_BYTES ?? Math.ceil(MAX_MEDIA_BYTES * BASE64_EXPANSION_RATIO) + 16 * MIB);
const MAX_AUTH_REQUEST_BYTES = Number(process.env.MAX_AUTH_REQUEST_BYTES ?? 16 * KIB);
const MAX_PLAYER_ACTION_REQUEST_BYTES = Number(process.env.MAX_PLAYER_ACTION_REQUEST_BYTES ?? 8 * KIB);
const MAX_PASSWORD_LENGTH = Number(process.env.MAX_PASSWORD_LENGTH ?? 256);
const MAX_PLAYERS_PER_SESSION = Number(process.env.MAX_PLAYERS_PER_SESSION ?? 250);
const MAX_SSE_CLIENTS_PER_SESSION = Number(process.env.MAX_SSE_CLIENTS_PER_SESSION ?? 500);
const MAX_SSE_CLIENTS_PER_IP = Number(process.env.MAX_SSE_CLIENTS_PER_IP ?? 50);
const MAX_ACTIVE_SESSIONS_PER_PRESENTER = Number(process.env.MAX_ACTIVE_SESSIONS_PER_PRESENTER ?? 20);
const MAX_SESSION_MEDIA_BYTES = Number(process.env.MAX_SESSION_MEDIA_BYTES ?? MAX_MEDIA_BYTES);
const MAX_SERIALIZED_SESSION_BYTES = Number(process.env.MAX_SERIALIZED_SESSION_BYTES ?? Math.ceil(MAX_SESSION_MEDIA_BYTES * BASE64_EXPANSION_RATIO) + 512 * KIB);
const MAX_RATE_LIMIT_BUCKETS = Number(process.env.MAX_RATE_LIMIT_BUCKETS ?? 5000);
const RATE_LIMIT_PRUNE_INTERVAL_MS = Number(process.env.RATE_LIMIT_PRUNE_INTERVAL_MS ?? 60_000);
const SSE_HEARTBEAT_MS = 25_000;
const RECENT_PLAYER_LIMIT = 80;
const LEADERBOARD_LIMIT = 20;
const PASSWORD_KEY_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PLAYER_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const HOST_DISCONNECT_GRACE_MS = 3000;
const PLAYER_DISCONNECT_GRACE_MS = 2000;
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_TOKEN_MAX_LENGTH = 4096;
const GOOGLE_JWKS_DEFAULT_TTL_MS = 60 * 60 * 1000;
const GOOGLE_JWKS_MIN_REFRESH_INTERVAL_MS = Number(process.env.GOOGLE_JWKS_MIN_REFRESH_INTERVAL_MS ?? 5 * 60 * 1000);
const GOOGLE_UNKNOWN_KID_TTL_MS = Number(process.env.GOOGLE_UNKNOWN_KID_TTL_MS ?? 5 * 60 * 1000);
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const LOGIN_IP_RATE_LIMIT = Number(process.env.LOGIN_IP_RATE_LIMIT ?? 10);
const LOGIN_ACCOUNT_RATE_LIMIT = Number(process.env.LOGIN_ACCOUNT_RATE_LIMIT ?? 20);
const PIN_ACTION_RATE_LIMIT = Number(process.env.PIN_ACTION_RATE_LIMIT ?? 60);
const EVENT_STREAM_RATE_LIMIT = Number(process.env.EVENT_STREAM_RATE_LIMIT ?? 60);
const HOST_COOKIE_NAME = "pinboard_host";
const PLAYER_COOKIE_PREFIX = "pinboard_player_";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const TRUST_PROXY = process.env.TRUST_PROXY === "true" || (IS_PRODUCTION && process.env.TRUST_PROXY !== "false");
const ALLOWED_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/ogg",
  "video/webm"
]);

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? DEFAULT_HOST;
const ALLOW_LOCAL_DEFAULTS = process.env.PINBOARD_ALLOW_LOCAL_DEFAULTS === "true";
const AUTH_SECRET = process.env.AUTH_SECRET ?? (ALLOW_LOCAL_DEFAULTS ? DEFAULT_LOCAL_AUTH_SECRET : "");
const BOOTSTRAP_PRESENTER_EMAIL = normalizeEmail(process.env.PRESENTER_EMAIL ?? (ALLOW_LOCAL_DEFAULTS ? DEFAULT_LOCAL_PRESENTER_EMAIL : ""));
const BOOTSTRAP_PRESENTER_PASSWORD = process.env.PRESENTER_PASSWORD ?? (ALLOW_LOCAL_DEFAULTS ? DEFAULT_LOCAL_PRESENTER_PASSWORD : "");
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? "";
const GOOGLE_ALLOWED_EMAILS = new Set(parseCsv(process.env.GOOGLE_ALLOWED_EMAILS).map(normalizeEmail));
const GOOGLE_ALLOWED_DOMAINS = new Set(parseCsv(process.env.GOOGLE_ALLOWED_DOMAINS).map((domain) => domain.toLowerCase()));
const scryptAsync = promisify(scrypt);
const { Pool } = pg;

/** @typedef {"lobby" | "question" | "answering" | "results" | "ended"} Phase */
/** @typedef {"quiz" | "true_false" | "slide"} QuestionKind */
/** @typedef {{ id: string, text: string }} Option */
/** @typedef {{ name: string, type: string, size: number, dataUrl: string }} MediaAsset */
/** @typedef {{ id: string, kind: QuestionKind, text: string, points: number, options: Option[], correctOptionId: string | null, media: MediaAsset | null }} Question */
/** @typedef {{ id: string, nickname: string, score: number, joinedAt: number }} Player */
/** @typedef {{ optionId: string, answeredAt: number }} Answer */
/** @typedef {{ id: string, response: import("node:http").ServerResponse, role: "host" | "player", playerId: string | null, ip: string, heartbeat: NodeJS.Timeout }} Client */
/** @typedef {{ id: string, email: string, passwordHash: string }} Presenter */
/** @typedef {{ pin: string, title: string, presenterId: string, questions: Question[], phase: Phase, currentQuestionIndex: number, players: Map<string, Player>, answers: Map<string, Answer>, scoredQuestionIndexes: Set<number>, openedAt: number | null, clients: Map<string, Client>, endedReason: string | null, createdAt: number }} Session */

const staticRoutes = new Map([
  ["/", { path: new URL("./public/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/index.html", { path: new URL("./public/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/styles.css", { path: new URL("./public/styles.css", import.meta.url), type: "text/css; charset=utf-8" }],
  ["/app.js", { path: new URL("./public/app.js", import.meta.url), type: "text/javascript; charset=utf-8" }]
]);

const database = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
/** @type {Map<string, Presenter>} */
const localPresentersByEmail = new Map();
/** @type {Map<string, Session>} */
const sessions = new Map();
/** @type {{ expiresAt: number, keys: Map<string, JsonWebKey> }} */
const googleJwksCache = { expiresAt: 0, keys: new Map() };
/** @type {Map<string, { count: number, resetAt: number }>} */
const rateLimitBuckets = new Map();
/** @type {Map<string, number>} */
const googleUnknownKidCache = new Map();
let googleJwksLastRefreshAt = 0;
let rateLimitLastPrunedAt = 0;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

const server = createServer(async (request, response) => {
  try {
    await routeRequest(request, response);
  } catch (error) {
    handleRouteError(response, error);
  }
});

if (isMainModule()) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

async function startServer() {
  validateStartupConfig();
  await initializeDatabase();
  await bootstrapPresenter();

  server.listen(PORT, HOST, () => {
    console.log(`Pinboard Live running at http://localhost:${PORT}`);
    console.log(`Presenter email: ${BOOTSTRAP_PRESENTER_EMAIL}`);
  });
}

async function routeRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const clientAddress = getClientAddress(request);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, database: database ? "postgres" : "memory" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    enforceRateLimit(`events:${clientAddress}`, EVENT_STREAM_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);
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

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      googleClientId: GOOGLE_CLIENT_ID
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    await handleCreateSession(request, response);
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/sessions\/(\d{6})\/([a-z-]+)$/);
  if (request.method === "POST" && actionMatch) {
    enforceRateLimit(`pin-action:${clientAddress}:${actionMatch[2]}`, PIN_ACTION_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);
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
  const body = await readJson(request, MAX_AUTH_REQUEST_BYTES);
  const email = normalizeEmail(readString(body.email, "Email"));
  const password = limitSecret(readString(body.password, "Password"), MAX_PASSWORD_LENGTH, "Password");
  enforceRateLimit(`login:ip:${getClientAddress(request)}`, LOGIN_IP_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);
  enforceRateLimit(`login:account:${email}`, LOGIN_ACCOUNT_RATE_LIMIT, 15 * RATE_LIMIT_WINDOW_MS);
  const presenter = await findPresenterByEmail(email);

  if (!presenter || !(await verifyPassword(password, presenter.passwordHash))) {
    throw new HttpError(401, "Email or password is not valid.");
  }

  const hostToken = signPresenterToken(presenter);
  setHostAuthCookie(response, hostToken);
  sendJson(response, 200, {
    presenter: { email: presenter.email }
  });
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

  const presenter = await findOrCreateGooglePresenter(profile.email);
  const hostToken = signPresenterToken(presenter);
  setHostAuthCookie(response, hostToken);
  sendGoogleLoginSuccess(response);
}

async function handleGoogleCredentialAuth(request, response) {
  assertGoogleClientIdConfigured();
  enforceRateLimit(`google-auth:${getClientAddress(request)}`, LOGIN_IP_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);
  const body = await readJson(request, GOOGLE_TOKEN_MAX_LENGTH + 1024);
  const credential = readString(body.credential, "Google credential");
  const profile = await verifyGoogleCredentialToken(credential);
  const presenter = await findOrCreateGooglePresenter(profile.email);

  setHostAuthCookie(response, signPresenterToken(presenter));
  sendJson(response, 200, {
    presenter: { email: presenter.email }
  });
}

async function handleCreateSession(request, response) {
  const presenter = requirePresenterToken(request);
  const body = await readJson(request);
  const title = limitText(readString(body.title, "Deck title"), MAX_TITLE_LENGTH, "Deck title");
  const questions = normalizeQuestions(body.questions);
  assertDeckResourceLimits(questions);
  await assertPresenterSessionQuota(presenter.id);
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
    createdAt: Date.now()
  };

  sessions.set(pin, session);
  await persistSession(session, { persistDeck: true });
  sendJson(response, 201, {
    pin,
    session: getStateForRole(session, "host", null)
  });
}

async function handleSessionAction(request, response, pin, action) {
  const session = await getSession(pin);

  switch (action) {
    case "join":
      await handleJoin(request, response, session);
      return;
    case "resume":
      await handleResume(request, response, session);
      return;
    case "answer":
      await handleAnswer(request, response, session);
      return;
    case "start":
      requireSessionHostToken(request, session);
      startSession(session);
      break;
    case "open":
      requireSessionHostToken(request, session);
      openAnswers(session);
      break;
    case "reveal":
      requireSessionHostToken(request, session);
      revealAnswers(session);
      break;
    case "next":
      requireSessionHostToken(request, session);
      advanceSession(session);
      break;
    case "end":
      requireSessionHostToken(request, session);
      endSession(session);
      break;
    default:
      throw new HttpError(404, "Session action was not found.");
  }

  await persistSession(session);
  broadcastState(session);
  sendJson(response, 200, { session: getStateForRole(session, "host", null) });
}

async function handleJoin(request, response, session) {
  assertPresenterOnline(session);
  assertSessionJoinCapacity(session);
  const body = await readJson(request, MAX_PLAYER_ACTION_REQUEST_BYTES);
  const nickname = limitText(readString(body.nickname, "Nickname"), MAX_NICKNAME_LENGTH, "Nickname");
  const player = {
    id: randomUUID(),
    nickname: nickname.trim(),
    score: 0,
    joinedAt: Date.now()
  };

  if (!player.nickname) {
    throw new HttpError(400, "Nickname is required.");
  }

  session.players.set(player.id, player);
  await persistSession(session);
  broadcastState(session);
  setPlayerAuthCookie(response, session.pin, signPlayerToken(session.pin, player.id));
  sendJson(response, 201, {
    playerId: player.id,
    session: getStateForRole(session, "player", player.id)
  });
}

async function handleResume(request, response, session) {
  assertPresenterOnline(session);
  await readJson(request, MAX_PLAYER_ACTION_REQUEST_BYTES);
  const playerId = requireSessionPlayerToken(request, session);

  if (!session.players.has(playerId)) {
    throw new HttpError(404, "Player was not found in this session.");
  }

  setPlayerAuthCookie(response, session.pin, signPlayerToken(session.pin, playerId));
  sendJson(response, 200, {
    playerId,
    session: getStateForRole(session, "player", playerId)
  });
}

async function handleAnswer(request, response, session) {
  const body = await readJson(request, MAX_PLAYER_ACTION_REQUEST_BYTES);
  const playerId = requireSessionPlayerToken(request, session);
  const optionId = readString(body.optionId, "Option ID");
  const question = getCurrentQuestion(session);

  if (session.phase !== "answering") {
    throw new HttpError(409, "Answers are not open.");
  }

  if (!question || question.kind === "slide") {
    throw new HttpError(409, "This slide does not accept answers.");
  }

  if (!session.players.has(playerId)) {
    throw new HttpError(404, "Player was not found in this session.");
  }

  if (!question.options.some((option) => option.id === optionId)) {
    throw new HttpError(400, "Selected option does not exist.");
  }

  if (!session.answers.has(playerId)) {
    session.answers.set(playerId, { optionId, answeredAt: Date.now() });
  }

  await persistSession(session);
  broadcastState(session);
  sendJson(response, 200, {
    accepted: true,
    session: getStateForRole(session, "player", playerId)
  });
}

function startSession(session) {
  if (session.phase !== "lobby") {
    throw new HttpError(409, "This session has already started.");
  }

  session.currentQuestionIndex = 0;
  session.phase = "question";
  resetCurrentAnswers(session);
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
}

function revealAnswers(session) {
  const question = getCurrentQuestion(session);

  if (session.phase !== "answering" && session.phase !== "question") {
    throw new HttpError(409, "There is nothing to reveal right now.");
  }

  if (!question || question.kind === "slide") {
    throw new HttpError(409, "Slides do not have answer results.");
  }

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
  session.phase = "question";
  resetCurrentAnswers(session);
}

function endSession(session) {
  session.phase = "ended";
  session.openedAt = null;
  session.endedReason = "host_ended";
}

function resetCurrentAnswers(session) {
  session.answers = new Map();
  session.openedAt = null;
}

function scoreCurrentQuestion(session, question) {
  if (session.scoredQuestionIndexes.has(session.currentQuestionIndex) || !isScoredQuestionKind(question.kind)) {
    return;
  }

  for (const [playerId, answer] of session.answers.entries()) {
    const player = session.players.get(playerId);
    if (player && answer.optionId === question.correctOptionId) {
      player.score += question.points;
    }
  }

  session.scoredQuestionIndexes.add(session.currentQuestionIndex);
}

async function handleEventStream(request, response, url) {
  const pin = normalizePin(url.searchParams.get("pin"));
  const role = url.searchParams.get("role") === "host" ? "host" : "player";
  const session = await getSession(pin);
  const clientAddress = getClientAddress(request);
  let playerId = null;
  if (role === "host") {
    requireSessionHostEventToken(request, session);
  } else {
    playerId = requireSessionPlayerToken(request, session);
  }
  assertEventStreamCapacity(session, clientAddress);

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const client = {
    id: randomUUID(),
    response,
    role,
    playerId,
    ip: clientAddress,
    heartbeat: setInterval(() => response.write(": keep-alive\n\n"), SSE_HEARTBEAT_MS)
  };

  session.clients.set(client.id, client);
  sendStateToClient(session, client);

  request.on("close", () => {
    clearInterval(client.heartbeat);
    session.clients.delete(client.id);
    void handleClientDisconnect(session, client);
  });
}

async function handleClientDisconnect(session, client) {
  if (client.role === "host") {
    await handleHostDisconnect(session);
    return;
  }

  if (client.playerId) {
    await handlePlayerDisconnect(session, client.playerId);
  }
}

async function handleHostDisconnect(session) {
  await wait(HOST_DISCONNECT_GRACE_MS);

  if (session.phase === "ended" || hasConnectedHost(session)) {
    return;
  }

  session.phase = "ended";
  session.endedReason = "presenter_left";
  session.openedAt = null;
  await persistSession(session);
  broadcastState(session);
}

async function handlePlayerDisconnect(session, playerId) {
  await wait(PLAYER_DISCONNECT_GRACE_MS);

  if (hasConnectedPlayer(session, playerId)) {
    return;
  }

  const removed = session.players.delete(playerId);
  session.answers.delete(playerId);
  if (!removed) {
    return;
  }

  await persistSession(session);
  broadcastState(session);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasConnectedHost(session) {
  return [...session.clients.values()].some((client) => client.role === "host");
}

function hasConnectedPlayer(session, playerId) {
  return [...session.clients.values()].some((client) => client.role === "player" && client.playerId === playerId);
}

function assertPresenterOnline(session) {
  if (session.phase === "ended" || !hasConnectedHost(session)) {
    throw new HttpError(409, "Presenter is not online.");
  }
}

function broadcastState(session) {
  for (const client of session.clients.values()) {
    sendStateToClient(session, client);
  }
}

function sendStateToClient(session, client) {
  const state = getStateForRole(session, client.role, client.playerId);
  client.response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

function getStateForRole(session, role, playerId) {
  const question = getCurrentQuestion(session);
  const player = playerId ? session.players.get(playerId) : null;
  const showAnswers = role === "host" || session.phase === "results" || session.phase === "ended";

  return {
    pin: session.pin,
    title: session.title,
    phase: session.phase,
    currentQuestionIndex: session.currentQuestionIndex,
    questionCount: session.questions.length,
    playerCount: session.players.size,
    answerCount: session.answers.size,
    currentQuestion: question ? serializeQuestion(question, showAnswers) : null,
    answerCounts: showAnswers && question ? buildAnswerCounts(session, question) : {},
    leaderboard: buildLeaderboard(session),
    recentPlayers: role === "host" ? buildRecentPlayers(session) : [],
    me: player ? { id: player.id, nickname: player.nickname, score: player.score } : null,
    selectedOptionId: playerId ? session.answers.get(playerId)?.optionId ?? null : null,
    endedReason: session.endedReason,
    mediaLimitBytes: MAX_MEDIA_BYTES
  };
}

function serializeQuestion(question, showAnswers) {
  return {
    id: question.id,
    kind: question.kind,
    text: question.text,
    points: question.points,
    media: question.media,
    options: question.options,
    correctOptionId: showAnswers ? question.correctOptionId : null
  };
}

function buildAnswerCounts(session, question) {
  const counts = Object.fromEntries(question.options.map((option) => [option.id, 0]));

  for (const answer of session.answers.values()) {
    if (Object.hasOwn(counts, answer.optionId)) {
      counts[answer.optionId] += 1;
    }
  }

  return counts;
}

function buildLeaderboard(session) {
  return [...session.players.values()]
    .sort((left, right) => right.score - left.score || left.joinedAt - right.joinedAt)
    .slice(0, LEADERBOARD_LIMIT)
    .map((player, index) => ({
      rank: index + 1,
      nickname: player.nickname,
      score: player.score
    }));
}

function buildRecentPlayers(session) {
  return [...session.players.values()]
    .sort((left, right) => right.joinedAt - left.joinedAt)
    .slice(0, RECENT_PLAYER_LIMIT)
    .map((player) => ({
      nickname: player.nickname,
      score: player.score
    }));
}

function getCurrentQuestion(session) {
  return session.questions[session.currentQuestionIndex] ?? null;
}

async function serveStatic(response, pathname) {
  const route = staticRoutes.get(pathname);
  if (!route) {
    throw new HttpError(404, "Page was not found.");
  }

  const file = await readFile(route.path);
  response.writeHead(200, { "Content-Type": route.type });
  response.end(file);
}

async function readJson(request, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = [];
  let bytesRead = 0;

  for await (const chunk of request) {
    bytesRead += chunk.length;
    if (bytesRead > maxBytes) {
      throw new HttpError(413, "Request is larger than the configured limit.");
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

function normalizeQuestions(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, "At least one slide or question is required.");
  }

  if (input.length > MAX_QUESTION_COUNT) {
    throw new HttpError(400, `Decks can contain at most ${MAX_QUESTION_COUNT} items.`);
  }

  return input.map((question, index) => normalizeQuestion(question, index));
}

function normalizeQuestion(input, index) {
  const kind = normalizeQuestionKind(input.kind);
  const text = limitText(readString(input.text, `Item ${index + 1} text`), MAX_QUESTION_TEXT_LENGTH, `Item ${index + 1} text`);
  const media = normalizeMedia(input.media);

  if (kind === "slide") {
    return {
      id: randomUUID(),
      kind,
      text,
      points: 0,
      options: [],
      correctOptionId: null,
      media
    };
  }

  const options = normalizeOptions(input.options);
  const points = normalizePoints(input.points);
  const correctOptionId = readString(input.correctOptionId, `Item ${index + 1} correct option`);

  if (kind === "true_false" && options.length !== 2) {
    throw new HttpError(400, `Item ${index + 1} true or false questions need exactly 2 options.`);
  }

  if (!options.some((option) => option.id === correctOptionId)) {
    throw new HttpError(400, `Item ${index + 1} needs a valid correct option.`);
  }

  return {
    id: randomUUID(),
    kind,
    text,
    points,
    options,
    correctOptionId,
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
    const id = readString(option.id, `Option ${index + 1} ID`);
    const text = limitText(readString(option.text, `Option ${index + 1} text`), MAX_OPTION_TEXT_LENGTH, `Option ${index + 1} text`);

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new HttpError(400, "Option IDs must use only letters, numbers, underscores, and hyphens.");
    }

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

function normalizeMedia(input) {
  if (!input) {
    return null;
  }

  const media = {
    name: limitText(readString(input.name, "Media name"), MAX_TITLE_LENGTH, "Media name"),
    type: limitText(readString(input.type, "Media type"), MAX_TITLE_LENGTH, "Media type"),
    size: Number(input.size),
    dataUrl: readString(input.dataUrl, "Media data")
  };

  if (!Number.isInteger(media.size) || media.size < 0) {
    throw new HttpError(400, "Media size is invalid.");
  }

  const parsed = parseDataUrl(media.dataUrl);
  if (media.type.toLowerCase() !== parsed.mimeType) {
    throw new HttpError(400, "Media type must match the data URL MIME type.");
  }

  const estimatedBytes = parsed.bytes;
  if (media.size > MAX_MEDIA_BYTES || estimatedBytes > MAX_MEDIA_BYTES) {
    throw new HttpError(413, "Question media must be 100 MB or smaller.");
  }

  return media;
}

function estimateDataUrlBytes(dataUrl) {
  return parseDataUrl(dataUrl).bytes;
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    throw new HttpError(400, "Media must be a base64 data URL.");
  }

  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.has(mimeType)) {
    throw new HttpError(400, "Media type is not allowed.");
  }

  const base64 = match[2];
  if (base64.length % 4 === 1) {
    throw new HttpError(400, "Media base64 data is invalid.");
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return { mimeType, bytes: Math.floor((base64.length * 3) / 4) - padding };
}

function readString(value, label) {
  if (typeof value !== "string") {
    throw new HttpError(400, `${label} is required.`);
  }
  return value;
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

function limitSecret(value, maxLength, label) {
  if (value.length > maxLength) {
    throw new HttpError(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return value;
}

function requireGlobalHostToken(request) {
  return requirePresenterToken(request);
}

function requirePresenterToken(request) {
  const token = readCookies(request)[HOST_COOKIE_NAME] ?? request.headers["x-host-token"];
  if (typeof token !== "string") {
    throw new HttpError(401, "Presenter authentication is required.");
  }
  return verifyPresenterToken(token);
}

function requireSessionHostToken(request, session) {
  const presenter = requirePresenterToken(request);
  if (presenter.id !== session.presenterId) {
    throw new HttpError(403, "This presenter cannot control that session.");
  }
}

function requireSessionHostEventToken(request, session) {
  const token = readCookies(request)[HOST_COOKIE_NAME];
  if (!token) {
    throw new HttpError(401, "Presenter authentication is required.");
  }

  const presenter = verifyPresenterToken(token);
  if (presenter.id !== session.presenterId) {
    throw new HttpError(403, "This presenter cannot control that session.");
  }
}

function requireSessionPlayerToken(request, session) {
  const token = readCookies(request)[playerCookieName(session.pin)];
  if (!token) {
    throw new HttpError(401, "Player session authentication is required.");
  }

  const player = verifyPlayerToken(token);
  if (player.pin !== session.pin || !session.players.has(player.playerId)) {
    throw new HttpError(403, "Player session authentication is not valid for this session.");
  }
  return player.playerId;
}

function validateStartupConfig() {
  assertPositiveInteger(MAX_REQUEST_BYTES, "MAX_REQUEST_BYTES");
  assertPositiveInteger(MAX_AUTH_REQUEST_BYTES, "MAX_AUTH_REQUEST_BYTES");
  assertPositiveInteger(MAX_PLAYER_ACTION_REQUEST_BYTES, "MAX_PLAYER_ACTION_REQUEST_BYTES");
  assertPositiveInteger(MAX_PASSWORD_LENGTH, "MAX_PASSWORD_LENGTH");
  assertPositiveInteger(MAX_PLAYERS_PER_SESSION, "MAX_PLAYERS_PER_SESSION");
  assertPositiveInteger(MAX_SSE_CLIENTS_PER_SESSION, "MAX_SSE_CLIENTS_PER_SESSION");
  assertPositiveInteger(MAX_SSE_CLIENTS_PER_IP, "MAX_SSE_CLIENTS_PER_IP");
  assertPositiveInteger(MAX_ACTIVE_SESSIONS_PER_PRESENTER, "MAX_ACTIVE_SESSIONS_PER_PRESENTER");
  assertPositiveInteger(MAX_SESSION_MEDIA_BYTES, "MAX_SESSION_MEDIA_BYTES");
  assertPositiveInteger(MAX_SERIALIZED_SESSION_BYTES, "MAX_SERIALIZED_SESSION_BYTES");
  assertPositiveInteger(MAX_RATE_LIMIT_BUCKETS, "MAX_RATE_LIMIT_BUCKETS");
  assertPositiveInteger(RATE_LIMIT_PRUNE_INTERVAL_MS, "RATE_LIMIT_PRUNE_INTERVAL_MS");

  if (ALLOW_LOCAL_DEFAULTS && IS_PRODUCTION) {
    throw new Error("PINBOARD_ALLOW_LOCAL_DEFAULTS cannot be true when NODE_ENV=production.");
  }

  if (!AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required. Set PINBOARD_ALLOW_LOCAL_DEFAULTS=true only for local development defaults.");
  }

  if (!ALLOW_LOCAL_DEFAULTS && AUTH_SECRET === DEFAULT_LOCAL_AUTH_SECRET) {
    throw new Error("AUTH_SECRET must not use the local development default.");
  }

  if ((!BOOTSTRAP_PRESENTER_EMAIL || !BOOTSTRAP_PRESENTER_PASSWORD) && !GOOGLE_CLIENT_ID) {
    throw new Error("Configure either PRESENTER_EMAIL/PRESENTER_PASSWORD or GOOGLE_CLIENT_ID.");
  }

  if (!ALLOW_LOCAL_DEFAULTS && BOOTSTRAP_PRESENTER_PASSWORD === DEFAULT_LOCAL_PRESENTER_PASSWORD) {
    throw new Error("PRESENTER_PASSWORD must not use the local development default.");
  }

  if (GOOGLE_CLIENT_ID && !hasGooglePresenterAllowlist()) {
    throw new Error("GOOGLE_ALLOWED_EMAILS or GOOGLE_ALLOWED_DOMAINS is required when GOOGLE_CLIENT_ID is configured.");
  }

  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && !GOOGLE_REDIRECT_URI) {
    throw new Error("GOOGLE_REDIRECT_URI is required for Google OAuth code flow.");
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
  await database.query(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      pin TEXT PRIMARY KEY,
      snapshot JSONB NOT NULL,
      questions JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query("ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS questions JSONB");
  await database.query("UPDATE live_sessions SET questions = snapshot->'questions' WHERE questions IS NULL AND snapshot ? 'questions'");
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
      passwordHash
    });
    return;
  }

  await database.query(
    `
      INSERT INTO presenters (id, email, password_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()
    `,
    [randomUUID(), BOOTSTRAP_PRESENTER_EMAIL, passwordHash]
  );
}

async function findPresenterByEmail(email) {
  if (!database) {
    return localPresentersByEmail.get(email) ?? null;
  }

  const result = await database.query(
    "SELECT id, email, password_hash AS \"passwordHash\" FROM presenters WHERE email = $1",
    [email]
  );
  return result.rows[0] ?? null;
}

async function findOrCreateGooglePresenter(email) {
  const normalizedEmail = normalizeEmail(email);
  assertGooglePresenterAllowed(normalizedEmail);
  const existing = await findPresenterByEmail(normalizedEmail);
  if (existing) {
    return existing;
  }

  const presenter = {
    id: randomUUID(),
    email: normalizedEmail,
    passwordHash: await createPasswordHash(randomBytes(32).toString("base64url"))
  };

  if (!database) {
    localPresentersByEmail.set(normalizedEmail, presenter);
    return presenter;
  }

  const result = await database.query(
    `
      INSERT INTO presenters (id, email, password_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO UPDATE SET updated_at = NOW()
      RETURNING id, email, password_hash AS "passwordHash"
    `,
    [presenter.id, presenter.email, presenter.passwordHash]
  );
  return result.rows[0];
}

function assertGoogleOAuthConfigured() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new HttpError(503, "Google OAuth is not configured yet.");
  }
}

function assertGoogleClientIdConfigured() {
  if (!GOOGLE_CLIENT_ID) {
    throw new HttpError(503, "Google sign-in is not configured yet.");
  }
  if (!hasGooglePresenterAllowlist()) {
    throw new HttpError(503, "Google presenter allowlist is not configured yet.");
  }
}

function getGoogleRedirectUri() {
  return GOOGLE_REDIRECT_URI;
}

async function exchangeGoogleCode(_request, code) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: getGoogleRedirectUri(),
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
    email: payload.email,
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

  return { email: payload.email };
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
  pruneExpiredGoogleKidMisses(now);

  if (googleJwksCache.expiresAt <= now) {
    await refreshGoogleJwks();
  }

  let jwk = googleJwksCache.keys.get(keyId);
  if (jwk) {
    return jwk;
  }

  if (googleUnknownKidCache.has(keyId) && now - googleJwksLastRefreshAt < GOOGLE_JWKS_MIN_REFRESH_INTERVAL_MS) {
    throw new HttpError(401, "Google credential key is not recognized.");
  }

  if (now - googleJwksLastRefreshAt >= GOOGLE_JWKS_MIN_REFRESH_INTERVAL_MS) {
    await refreshGoogleJwks();
    jwk = googleJwksCache.keys.get(keyId);
    if (jwk) {
      return jwk;
    }
  }

  googleUnknownKidCache.set(keyId, Date.now() + GOOGLE_UNKNOWN_KID_TTL_MS);
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
  googleJwksLastRefreshAt = Date.now();
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

function signPresenterToken(presenter) {
  const payload = Buffer.from(
    JSON.stringify({
      typ: "host",
      sub: presenter.id,
      email: presenter.email,
      exp: Date.now() + TOKEN_TTL_MS
    })
  ).toString("base64url");
  const signature = createTokenSignature(payload);
  return `${payload}.${signature}`;
}

function verifyPresenterToken(token) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new HttpError(401, "Presenter authentication is required.");
  }

  const expected = createTokenSignature(payload);
  if (!constantTimeStringEquals(signature, expected)) {
    throw new HttpError(401, "Presenter authentication is not valid.");
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded.typ !== "host" || typeof decoded.sub !== "string" || typeof decoded.email !== "string" || Number(decoded.exp) < Date.now()) {
      throw new Error("Invalid token payload.");
    }
    return { id: decoded.sub, email: decoded.email };
  } catch {
    throw new HttpError(401, "Presenter authentication is not valid.");
  }
}

function signPlayerToken(pin, playerId) {
  const payload = Buffer.from(
    JSON.stringify({
      typ: "player",
      pin,
      playerId,
      exp: Date.now() + PLAYER_TOKEN_TTL_MS
    })
  ).toString("base64url");
  return `${payload}.${createTokenSignature(payload)}`;
}

function verifyPlayerToken(token) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new HttpError(401, "Player session authentication is required.");
  }

  const expected = createTokenSignature(payload);
  if (!constantTimeStringEquals(signature, expected)) {
    throw new HttpError(401, "Player session authentication is not valid.");
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded.typ !== "player" || typeof decoded.pin !== "string" || typeof decoded.playerId !== "string" || Number(decoded.exp) < Date.now()) {
      throw new Error("Invalid player token payload.");
    }
    return { pin: decoded.pin, playerId: decoded.playerId };
  } catch {
    throw new HttpError(401, "Player session authentication is not valid.");
  }
}

function createTokenSignature(payload) {
  return createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
}

function constantTimeStringEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

async function getSession(pin) {
  const normalizedPin = normalizePin(pin);
  const session = database ? await loadPersistedSession(normalizedPin) : sessions.get(normalizedPin);
  if (!session) {
    throw new HttpError(404, "Session was not found.");
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

async function persistSession(session, options = {}) {
  const snapshot = serializeSessionSnapshot(session);
  const serializedSnapshot = JSON.stringify(snapshot);
  if (Buffer.byteLength(serializedSnapshot, "utf8") > MAX_SERIALIZED_SESSION_BYTES) {
    throw new HttpError(413, "Session state is larger than the configured limit.");
  }
  const serializedQuestions = options.persistDeck ? JSON.stringify(session.questions) : null;

  sessions.set(session.pin, session);

  if (!database) {
    return;
  }

  await database.query(
    `
      INSERT INTO live_sessions (pin, snapshot, questions, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (pin)
      DO UPDATE SET snapshot = EXCLUDED.snapshot, questions = COALESCE(EXCLUDED.questions, live_sessions.questions), updated_at = NOW()
    `,
    [session.pin, serializedSnapshot, serializedQuestions]
  );
}

async function loadPersistedSession(pin) {
  if (!database) {
    return sessions.get(pin) ?? null;
  }

  const result = await database.query("SELECT snapshot, questions FROM live_sessions WHERE pin = $1", [pin]);
  if (!result.rows[0]) {
    return null;
  }

  const localClients = sessions.get(pin)?.clients ?? new Map();
  const session = hydrateSessionSnapshot(result.rows[0].snapshot, localClients, result.rows[0].questions);
  sessions.set(pin, session);
  return session;
}

function serializeSessionSnapshot(session) {
  return {
    pin: session.pin,
    deckId: session.pin,
    title: session.title,
    presenterId: session.presenterId,
    phase: session.phase,
    currentQuestionIndex: session.currentQuestionIndex,
    players: [...session.players.entries()],
    answers: [...session.answers.entries()],
    scoredQuestionIndexes: [...session.scoredQuestionIndexes],
    openedAt: session.openedAt,
    endedReason: session.endedReason,
    createdAt: session.createdAt
  };
}

function hydrateSessionSnapshot(snapshot, clients, questions = null) {
  const persistedQuestions = Array.isArray(questions) ? questions : snapshot.questions;
  return {
    pin: snapshot.pin,
    title: snapshot.title,
    presenterId: snapshot.presenterId,
    questions: Array.isArray(persistedQuestions) ? persistedQuestions : [],
    phase: snapshot.phase,
    currentQuestionIndex: Number(snapshot.currentQuestionIndex),
    players: new Map(snapshot.players ?? []),
    answers: new Map(snapshot.answers ?? []),
    scoredQuestionIndexes: new Set(snapshot.scoredQuestionIndexes ?? []),
    openedAt: snapshot.openedAt ?? null,
    clients,
    endedReason: snapshot.endedReason ?? null,
    createdAt: snapshot.createdAt ?? Date.now()
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendGoogleLoginSuccess(response) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signing in</title></head>
<body>
<script>
localStorage.removeItem("pinboard.hostToken");
localStorage.setItem("pinboard.presenterSession", "1");
location.replace("/#presenter");
</script>
</body>
</html>`);
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
  if (!existing) {
    response.setHeader("Set-Cookie", cookie);
    return;
  }
  response.setHeader("Set-Cookie", Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}

function setHostAuthCookie(response, token) {
  setCookie(response, HOST_COOKIE_NAME, token, { maxAge: Math.floor(TOKEN_TTL_MS / 1000) });
}

function setPlayerAuthCookie(response, pin, token) {
  setCookie(response, playerCookieName(pin), token, { maxAge: Math.floor(PLAYER_TOKEN_TTL_MS / 1000) });
}

function playerCookieName(pin) {
  return `${PLAYER_COOKIE_PREFIX}${pin}`;
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
        return [name, decodeURIComponent(valueParts.join("="))];
      })
  );
}

function getClientAddress(request) {
  if (TRUST_PROXY) {
    const forwardedFor = firstHeaderValue(request.headers["x-forwarded-for"]);
    const address = forwardedFor ? forwardedFor.split(",")[0]?.trim() : parseForwardedFor(firstHeaderValue(request.headers.forwarded));
    if (address) {
      return address;
    }
  }
  return request.socket.remoteAddress ?? "unknown";
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseForwardedFor(value) {
  if (typeof value !== "string") {
    return "";
  }
  const firstHop = value.split(",")[0] ?? "";
  const part = firstHop.split(";").find((item) => item.trim().toLowerCase().startsWith("for="));
  if (!part) {
    return "";
  }
  return part.slice(part.indexOf("=") + 1).trim().replace(/^"|"$/g, "");
}

function enforceRateLimit(key, limit, windowMs) {
  const now = Date.now();
  pruneRateLimitBucketsIfNeeded(now);
  ensureRateLimitBucketCapacity(key, now);
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new HttpError(429, "Too many requests. Try again later.");
  }
}

function pruneRateLimitBucketsIfNeeded(now) {
  if (now - rateLimitLastPrunedAt >= RATE_LIMIT_PRUNE_INTERVAL_MS) {
    pruneExpiredRateLimitBuckets(now);
  }
}

function ensureRateLimitBucketCapacity(key, now) {
  if (rateLimitBuckets.has(key) || rateLimitBuckets.size < MAX_RATE_LIMIT_BUCKETS) {
    return;
  }

  pruneExpiredRateLimitBuckets(now);
  if (!rateLimitBuckets.has(key) && rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
    throw new HttpError(429, "Too many requests. Try again later.");
  }
}

function pruneExpiredRateLimitBuckets(now = Date.now()) {
  rateLimitLastPrunedAt = now;
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
}

function assertSessionJoinCapacity(session) {
  if (session.players.size >= MAX_PLAYERS_PER_SESSION) {
    throw new HttpError(429, "This session has reached its player limit.");
  }
}

function assertEventStreamCapacity(session, clientAddress) {
  if (session.clients.size >= MAX_SSE_CLIENTS_PER_SESSION) {
    throw new HttpError(429, "This session has reached its live connection limit.");
  }

  const clientsForAddress = [...session.clients.values()].filter((client) => client.ip === clientAddress).length;
  if (clientsForAddress >= MAX_SSE_CLIENTS_PER_IP) {
    throw new HttpError(429, "This client has reached the live connection limit.");
  }
}

function assertDeckResourceLimits(questions) {
  const totalMediaBytes = questions.reduce((total, question) => total + (question.media ? estimateDataUrlBytes(question.media.dataUrl) : 0), 0);
  if (totalMediaBytes > MAX_SESSION_MEDIA_BYTES) {
    throw new HttpError(413, "Session media is larger than the configured total limit.");
  }

  const serializedQuestionsBytes = Buffer.byteLength(JSON.stringify(questions), "utf8");
  if (serializedQuestionsBytes > MAX_SERIALIZED_SESSION_BYTES) {
    throw new HttpError(413, "Session state is larger than the configured limit.");
  }
}

async function assertPresenterSessionQuota(presenterId) {
  const memoryCount = [...sessions.values()].filter((session) => session.presenterId === presenterId && session.phase !== "ended").length;
  if (memoryCount >= MAX_ACTIVE_SESSIONS_PER_PRESENTER) {
    throw new HttpError(429, "Presenter has reached the active session limit.");
  }

  if (!database) {
    return;
  }

  const result = await database.query(
    "SELECT COUNT(*)::int AS count FROM live_sessions WHERE snapshot->>'presenterId' = $1 AND COALESCE(snapshot->>'phase', '') <> 'ended'",
    [presenterId]
  );
  if (Number(result.rows[0]?.count ?? 0) >= MAX_ACTIVE_SESSIONS_PER_PRESENTER) {
    throw new HttpError(429, "Presenter has reached the active session limit.");
  }
}

function parseCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasGooglePresenterAllowlist() {
  return GOOGLE_ALLOWED_EMAILS.size > 0 || GOOGLE_ALLOWED_DOMAINS.size > 0;
}

function assertGooglePresenterAllowed(email) {
  const normalizedEmail = normalizeEmail(email);
  const domain = normalizedEmail.split("@")[1] ?? "";
  if (GOOGLE_ALLOWED_EMAILS.has(normalizedEmail) || GOOGLE_ALLOWED_DOMAINS.has(domain)) {
    return;
  }
  throw new HttpError(403, "Google account is not authorized as a presenter.");
}

function pruneExpiredGoogleKidMisses(now = Date.now()) {
  for (const [keyId, expiresAt] of googleUnknownKidCache.entries()) {
    if (expiresAt <= now) {
      googleUnknownKidCache.delete(keyId);
    }
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function handleRouteError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }

  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  sendJson(response, statusCode, { error: message });
}

export const __test = {
  HttpError,
  assertDeckResourceLimits,
  assertGooglePresenterAllowed,
  createUniquePin,
  enforceRateLimit,
  estimateDataUrlBytes,
  getGoogleJwk,
  getClientAddress,
  googleJwksCache,
  googleUnknownKidCache,
  hydrateSessionSnapshot,
  MAX_RATE_LIMIT_BUCKETS,
  normalizeMedia,
  normalizeOptions,
  parseDataUrl,
  rateLimitBuckets,
  setRateLimitLastPrunedAt(value) {
    rateLimitLastPrunedAt = value;
  },
  serializeSessionSnapshot,
  setGoogleJwksLastRefreshAt(value) {
    googleJwksLastRefreshAt = value;
  },
  signPlayerToken,
  validateStartupConfig,
  verifyPlayerToken
};
