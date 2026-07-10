import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer as createNetServer } from "node:net";
import { test } from "node:test";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
const TEST_EMAIL = "postgres-integration@example.test";
const TEST_PASSWORD = "postgres-integration-password-123";
const AUTH_SECRET = "postgres-integration-secret-with-more-than-thirty-two-characters";
const PLAYER_NICKNAME = "Concurrent Player";
const QUESTION_POINTS = 1_000;
const QUESTION_TIMER_SECONDS = 60;
const HEALTH_ATTEMPTS = 120;
const HEALTH_RETRY_DELAY_MS = 100;
const SERVER_STOP_TIMEOUT_MS = 2_000;
const CONCURRENT_PLAYER_COUNT = 20;

if (TEST_DATABASE_URL) {
  assertDisposableTestDatabase(TEST_DATABASE_URL);
}

test("PostgreSQL serializes cross-instance answers and restores scored state after restart", {
  skip: TEST_DATABASE_URL ? false : "TEST_DATABASE_URL is required for PostgreSQL integration coverage"
}, async (context) => {
  const servers = new Set();
  context.after(async () => {
    await Promise.all([...servers].map((server) => stopServer(server)));
  });

  const firstServer = await startServer();
  servers.add(firstServer);
  const secondServer = await startServer();
  servers.add(secondServer);

  const presenter = await loginPresenter(firstServer.baseUrl);
  const presentationCreateResponse = await postJson(firstServer.baseUrl, "/api/presentations", {},
    presenterMutationHeaders(firstServer.baseUrl, presenter));
  assert.equal(presentationCreateResponse.status, 201);
  const presentation = (await presentationCreateResponse.json()).presentation;
  const revisionWrites = [firstServer, secondServer].map((server, index) => putJson(
    server.baseUrl,
    `/api/presentations/${presentation.id}`,
    {
      snapshot: { ...presentation.snapshot, title: `Concurrent revision ${index + 1}` },
      expectedVersion: presentation.version
    },
    presenterMutationHeaders(server.baseUrl, presenter)
  ));
  const revisionResponses = await Promise.all(revisionWrites);
  assert.deepEqual(revisionResponses.map((response) => response.status).sort(), [200, 409]);

  const correctOptionId = randomUUID();
  const secondCorrectOptionId = randomUUID();
  const incorrectOptionId = randomUUID();
  const createResponse = await postJson(firstServer.baseUrl, "/api/sessions", {
    title: "PostgreSQL concurrency",
    questions: [{
      id: randomUUID(),
      kind: "quiz",
      text: "Choose the correct option",
      points: QUESTION_POINTS,
      timerSeconds: QUESTION_TIMER_SECONDS,
      options: [
        { id: correctOptionId, text: "Correct" },
        { id: secondCorrectOptionId, text: "Also correct" },
        { id: incorrectOptionId, text: "Incorrect" }
      ],
      correctOptionIds: [correctOptionId, secondCorrectOptionId],
      media: null
    }]
  }, presenterMutationHeaders(firstServer.baseUrl, presenter));
  assert.equal(createResponse.status, 201);
  const { pin } = await createResponse.json();

  const joinResponse = await postJson(firstServer.baseUrl, `/api/sessions/${pin}/join`, {
    nickname: PLAYER_NICKNAME
  }, { Origin: firstServer.baseUrl });
  assert.equal(joinResponse.status, 201);
  const joined = await joinResponse.json();
  const playerCookie = cookiePair(joinResponse.headers.get("set-cookie") ?? "");

  const slowResume = await openSlowJsonRequest(firstServer.baseUrl, `/api/sessions/${pin}/resume`, playerCookie);
  const startResponse = await withTimeout(postJson(secondServer.baseUrl, `/api/sessions/${pin}/start`, {},
    presenterMutationHeaders(secondServer.baseUrl, presenter)), 2_000, "Host start was blocked by a slow player body.");
  slowResume.destroy();
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assertPositiveVersion(started.session.version);

  const answerRequests = [firstServer, secondServer].map((server) => postJson(
    server.baseUrl,
    `/api/sessions/${pin}/answer`,
    { selectedOptionIds: [correctOptionId, secondCorrectOptionId] },
    { Cookie: playerCookie, Origin: server.baseUrl }
  ));
  const answerResponses = await Promise.all(answerRequests);
  assert.deepEqual(answerResponses.map((response) => response.status), [200, 200]);
  const answers = await Promise.all(answerResponses.map((response) => response.json()));
  assert.equal(answers.filter((answer) => answer.accepted === true).length, 1);
  assert.equal(answers.filter((answer) => answer.duplicate === true).length, 1);
  assert.ok(answers.every((answer) => (
    JSON.stringify(answer.selectedOptionIds) === JSON.stringify([correctOptionId, secondCorrectOptionId])
  )));
  assert.ok(answers.every((answer) => Number.isSafeInteger(answer.version)));
  const answeredVersion = Math.max(...answers.map((answer) => answer.version));
  assert.ok(answeredVersion >= started.session.version);

  const additionalPlayers = [];
  for (let index = 0; index < CONCURRENT_PLAYER_COUNT; index += 1) {
    const target = index % 2 === 0 ? firstServer : secondServer;
    const response = await postJson(target.baseUrl, `/api/sessions/${pin}/join`, {
      nickname: `Burst player ${index + 1}`
    }, { Origin: target.baseUrl });
    assert.equal(response.status, 201);
    additionalPlayers.push({
      baseUrl: target.baseUrl,
      cookie: cookiePair(response.headers.get("set-cookie") ?? "")
    });
  }
  const burstResponses = await Promise.all(additionalPlayers.map((player) => postJson(
    player.baseUrl,
    `/api/sessions/${pin}/answer`,
    { selectedOptionIds: [correctOptionId, secondCorrectOptionId] },
    { Cookie: player.cookie, Origin: player.baseUrl }
  )));
  assert.ok(burstResponses.every((response) => response.status === 200));
  const burstAnswers = await Promise.all(burstResponses.map((response) => response.json()));
  assert.ok(burstAnswers.every((answer) => answer.accepted === true && answer.duplicate === false));

  const revealResponse = await postJson(secondServer.baseUrl, `/api/sessions/${pin}/reveal`, {},
    presenterMutationHeaders(secondServer.baseUrl, presenter));
  assert.equal(revealResponse.status, 200);
  const revealed = await revealResponse.json();
  assert.ok(revealed.session.version > answeredVersion);
  assert.equal(revealed.session.answerCount, CONCURRENT_PLAYER_COUNT + 1);
  const scoredPlayer = revealed.session.leaderboard.find((player) => player.nickname === PLAYER_NICKNAME);
  assert.ok(scoredPlayer);
  assert.ok(scoredPlayer.score > 0);

  const logoutResponse = await postJson(firstServer.baseUrl, "/api/logout", {},
    presenterMutationHeaders(firstServer.baseUrl, presenter));
  assert.equal(logoutResponse.status, 200);
  const revokedOnReplica = await postJson(secondServer.baseUrl, `/api/sessions/${pin}/end`, { discardActiveRound: true },
    presenterMutationHeaders(secondServer.baseUrl, presenter));
  assert.equal(revokedOnReplica.status, 401);

  await Promise.all([stopServer(firstServer), stopServer(secondServer)]);
  servers.delete(firstServer);
  servers.delete(secondServer);

  const restartedServer = await startServer();
  servers.add(restartedServer);
  const resumeResponse = await postJson(restartedServer.baseUrl, `/api/sessions/${pin}/resume`, {}, {
    Cookie: playerCookie,
    Origin: restartedServer.baseUrl
  });
  assert.equal(resumeResponse.status, 200);
  const resumed = await resumeResponse.json();
  assert.equal(resumed.playerId, joined.playerId);
  assert.equal(resumed.session.phase, "results");
  assert.equal(resumed.session.selectedOptionId, correctOptionId);
  assert.deepEqual(resumed.session.selectedOptionIds, [correctOptionId, secondCorrectOptionId]);
  assert.equal(resumed.session.me.score, scoredPlayer.score);
  assert.ok(resumed.session.version >= revealed.session.version);
});

function assertDisposableTestDatabase(connectionString) {
  const databaseUrl = new URL(connectionString);
  const localHosts = new Set(["127.0.0.1", "localhost", "postgres"]);
  const databaseName = databaseUrl.pathname.slice(1);
  if (!localHosts.has(databaseUrl.hostname) || !databaseName.includes("test")) {
    throw new Error("TEST_DATABASE_URL must target a local disposable database whose name contains 'test'.");
  }
}

function assertPositiveVersion(version) {
  assert.ok(Number.isSafeInteger(version));
  assert.ok(version > 0);
}

async function startServer() {
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "development",
      AUTH_SECRET,
      PRESENTER_EMAIL: TEST_EMAIL,
      PRESENTER_PASSWORD: TEST_PASSWORD,
      DATABASE_URL: TEST_DATABASE_URL,
      PUBLIC_ORIGIN: baseUrl,
      ALLOW_INSECURE_LOCAL_AUTH: "true"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const server = { baseUrl, child, output: "", stopped: false };
  child.stdout.on("data", (chunk) => {
    server.output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    server.output += chunk.toString();
  });
  try {
    await waitForHealth(server);
    return server;
  } catch (error) {
    await stopServer(server);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${server.output}`);
  }
}

async function stopServer(server) {
  if (server.stopped) {
    return;
  }
  server.stopped = true;
  if (server.child.exitCode !== null) {
    return;
  }
  server.child.kill();
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    delay(SERVER_STOP_TIMEOUT_MS)
  ]);
  if (server.child.exitCode === null) {
    const forcedExit = new Promise((resolve) => server.child.once("exit", resolve));
    server.child.kill("SIGKILL");
    await Promise.race([forcedExit, delay(SERVER_STOP_TIMEOUT_MS)]);
  }
}

async function waitForHealth(server) {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    if (server.child.exitCode !== null) {
      throw new Error(`Server exited with code ${server.child.exitCode}.`);
    }
    try {
      const response = await fetch(`${server.baseUrl}/`);
      if (response.ok) {
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }
    await delay(HEALTH_RETRY_DELAY_MS);
  }
  throw new Error("Server did not become healthy.");
}

async function loginPresenter(baseUrl) {
  const response = await postJson(baseUrl, "/api/auth", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    keepSignedIn: false
  }, { Origin: baseUrl });
  assert.equal(response.status, 200);
  const body = await response.json();
  return {
    cookie: cookiePair(response.headers.get("set-cookie") ?? ""),
    csrfToken: body.csrfToken
  };
}

function presenterMutationHeaders(baseUrl, presenter) {
  return {
    Cookie: presenter.cookie,
    "X-CSRF-Token": presenter.csrfToken,
    Origin: baseUrl
  };
}

function postJson(baseUrl, path, body, extraHeaders = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body)
  });
}

function putJson(baseUrl, path, body, extraHeaders = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body)
  });
}

async function openSlowJsonRequest(baseUrl, path, cookie) {
  const url = new URL(baseUrl);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `POST ${path} HTTP/1.1`,
    `Host: ${url.host}`,
    `Origin: ${baseUrl}`,
    `Cookie: ${cookie}`,
    "Content-Type: application/json",
    "Transfer-Encoding: chunked",
    "Connection: close",
    "",
    "1",
    "{",
    ""
  ].join("\r\n"));
  await delay(100);
  return socket;
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function cookiePair(setCookie) {
  return setCookie.split(";", 1)[0];
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
