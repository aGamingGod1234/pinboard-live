import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
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
const SSE_HEARTBEAT_MS = 25_000;
const RECENT_PLAYER_LIMIT = 80;
const LEADERBOARD_LIMIT = 20;
const PASSWORD_KEY_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_DISCONNECT_GRACE_MS = 3000;
const PLAYER_DISCONNECT_GRACE_MS = 2000;

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const HOST = process.env.HOST ?? DEFAULT_HOST;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const AUTH_SECRET = process.env.AUTH_SECRET ?? (IS_PRODUCTION ? "" : DEFAULT_LOCAL_AUTH_SECRET);
const BOOTSTRAP_PRESENTER_EMAIL = normalizeEmail(process.env.PRESENTER_EMAIL ?? (IS_PRODUCTION ? "" : DEFAULT_LOCAL_PRESENTER_EMAIL));
const BOOTSTRAP_PRESENTER_PASSWORD = process.env.PRESENTER_PASSWORD ?? (IS_PRODUCTION ? "" : DEFAULT_LOCAL_PRESENTER_PASSWORD);
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const scryptAsync = promisify(scrypt);
const { Pool } = pg;

/** @typedef {"lobby" | "question" | "answering" | "results" | "ended"} Phase */
/** @typedef {"quiz" | "true_false" | "slide"} QuestionKind */
/** @typedef {{ id: string, text: string }} Option */
/** @typedef {{ name: string, type: string, size: number, dataUrl: string }} MediaAsset */
/** @typedef {{ id: string, kind: QuestionKind, text: string, points: number, options: Option[], correctOptionId: string | null, media: MediaAsset | null }} Question */
/** @typedef {{ id: string, nickname: string, score: number, joinedAt: number }} Player */
/** @typedef {{ optionId: string, answeredAt: number }} Answer */
/** @typedef {{ id: string, response: import("node:http").ServerResponse, role: "host" | "player", playerId: string | null, heartbeat: NodeJS.Timeout }} Client */
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

startServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

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

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, database: database ? "postgres" : "memory" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    await handleEventStream(request, response, url);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth") {
    await handleAuth(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    await handleCreateSession(request, response);
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

  if (!presenter || !(await verifyPassword(password, presenter.passwordHash))) {
    throw new HttpError(401, "Email or password is not valid.");
  }

  sendJson(response, 200, {
    hostToken: signPresenterToken(presenter),
    presenter: { email: presenter.email }
  });
}

async function handleCreateSession(request, response) {
  const presenter = requirePresenterToken(request);
  const body = await readJson(request);
  const title = limitText(readString(body.title, "Deck title"), MAX_TITLE_LENGTH, "Deck title");
  const questions = normalizeQuestions(body.questions);
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
  await persistSession(session);
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
  const body = await readJson(request);
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
  sendJson(response, 201, {
    playerId: player.id,
    session: getStateForRole(session, "player", player.id)
  });
}

async function handleResume(request, response, session) {
  assertPresenterOnline(session);
  const body = await readJson(request);
  const playerId = readString(body.playerId, "Player ID");

  if (!session.players.has(playerId)) {
    throw new HttpError(404, "Player was not found in this session.");
  }

  sendJson(response, 200, {
    playerId,
    session: getStateForRole(session, "player", playerId)
  });
}

async function handleAnswer(request, response, session) {
  const body = await readJson(request);
  const playerId = readString(body.playerId, "Player ID");
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
  const playerId = url.searchParams.get("playerId");
  const session = await getSession(pin);
  if (role === "host") {
    requireSessionHostEventToken(url, session);
  }

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

async function readJson(request) {
  const chunks = [];
  let bytesRead = 0;

  for await (const chunk of request) {
    bytesRead += chunk.length;
    if (bytesRead > MAX_REQUEST_BYTES) {
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

  const estimatedBytes = estimateDataUrlBytes(media.dataUrl);
  if (media.size > MAX_MEDIA_BYTES || estimatedBytes > MAX_MEDIA_BYTES) {
    throw new HttpError(413, "Question media must be 100 MB or smaller.");
  }

  return media;
}

function estimateDataUrlBytes(dataUrl) {
  const match = dataUrl.match(/^data:[^;]+;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new HttpError(400, "Media must be a base64 data URL.");
  }

  const base64 = match[1];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
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

function requireGlobalHostToken(request) {
  return requirePresenterToken(request);
}

function requirePresenterToken(request) {
  const token = request.headers["x-host-token"];
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

function requireSessionHostEventToken(url, session) {
  const token = url.searchParams.get("token");
  if (!token) {
    throw new HttpError(401, "Presenter authentication is required.");
  }

  const presenter = verifyPresenterToken(token);
  if (presenter.id !== session.presenterId) {
    throw new HttpError(403, "This presenter cannot control that session.");
  }
}

function validateStartupConfig() {
  if (!AUTH_SECRET) {
    throw new Error("AUTH_SECRET is required in production.");
  }

  if (!BOOTSTRAP_PRESENTER_EMAIL || !BOOTSTRAP_PRESENTER_PASSWORD) {
    throw new Error("PRESENTER_EMAIL and PRESENTER_PASSWORD are required in production.");
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function bootstrapPresenter() {
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
    if (typeof decoded.sub !== "string" || typeof decoded.email !== "string" || Number(decoded.exp) < Date.now()) {
      throw new Error("Invalid token payload.");
    }
    return { id: decoded.sub, email: decoded.email };
  } catch {
    throw new HttpError(401, "Presenter authentication is not valid.");
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
    const pin = String(Math.floor(Math.random() * 10 ** GAME_PIN_LENGTH)).padStart(GAME_PIN_LENGTH, "0");
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

async function persistSession(session) {
  sessions.set(session.pin, session);

  if (!database) {
    return;
  }

  await database.query(
    `
      INSERT INTO live_sessions (pin, snapshot, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (pin)
      DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW()
    `,
    [session.pin, JSON.stringify(serializeSessionSnapshot(session))]
  );
}

async function loadPersistedSession(pin) {
  if (!database) {
    return sessions.get(pin) ?? null;
  }

  const result = await database.query("SELECT snapshot FROM live_sessions WHERE pin = $1", [pin]);
  if (!result.rows[0]) {
    return null;
  }

  const localClients = sessions.get(pin)?.clients ?? new Map();
  const session = hydrateSessionSnapshot(result.rows[0].snapshot, localClients);
  sessions.set(pin, session);
  return session;
}

function serializeSessionSnapshot(session) {
  return {
    pin: session.pin,
    title: session.title,
    presenterId: session.presenterId,
    questions: session.questions,
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

function hydrateSessionSnapshot(snapshot, clients) {
  return {
    pin: snapshot.pin,
    title: snapshot.title,
    presenterId: snapshot.presenterId,
    questions: Array.isArray(snapshot.questions) ? snapshot.questions : [],
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

function handleRouteError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }

  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  sendJson(response, statusCode, { error: message });
}
