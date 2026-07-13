import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

const TEST_EMAIL = "session-lifecycle@example.test";
const TEST_PASSWORD = "session-lifecycle-password-123";
const JSON_HEADERS = { "Content-Type": "application/json" };
const HEALTH_ATTEMPTS = 80;
const HEALTH_RETRY_DELAY_MS = 100;
const STREAM_READ_TIMEOUT_MS = 2_000;
const SERVER_STOP_TIMEOUT_MS = 1_000;

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
      AUTH_SECRET: "session-lifecycle-secret-with-more-than-thirty-two-characters",
      PRESENTER_EMAIL: TEST_EMAIL,
      PRESENTER_PASSWORD: TEST_PASSWORD,
      DATABASE_URL: "",
      PUBLIC_ORIGIN: baseUrl,
      MAX_PLAYERS_PER_SESSION: "1",
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
  if (!serverProcess || serverProcess.exitCode !== null) {
    return;
  }
  serverProcess.kill();
  await Promise.race([
    new Promise((resolve) => serverProcess.once("exit", resolve)),
    delay(SERVER_STOP_TIMEOUT_MS)
  ]);
  if (serverProcess.exitCode === null) {
    serverProcess.kill("SIGKILL");
  }
});

test("cookie-authenticated session lifecycle is durable across SSE disconnects", async (context) => {
  const presenter = await loginPresenter();
  assert.match(presenter.setCookie, /pinboard_presenter=/);
  assert.match(presenter.setCookie, /HttpOnly/i);
  assert.equal(typeof presenter.csrfToken, "string");
  assert.ok(presenter.csrfToken.length >= 32);

  const firstOptionId = randomUUID();
  const secondOptionId = randomUUID();
  const createResponse = await postJson(
    "/api/sessions",
    {
      title: "Lifecycle integration",
      questions: [{
        id: randomUUID(),
        kind: "quiz",
        text: "Choose the first option",
        points: 1_000,
        timerSeconds: 60,
        options: [
          { id: firstOptionId, text: "First" },
          { id: secondOptionId, text: "Second" }
        ],
        correctOptionId: firstOptionId,
        media: null
      }]
    },
    presenterMutationHeaders(presenter)
  );
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.match(created.pin, /^\d{6}$/);
  const pin = created.pin;

  const joinResponse = await postJson(`/api/sessions/${pin}/join`, { nickname: "Cookie Player" }, {
    Origin: baseUrl
  });
  assert.equal(joinResponse.status, 201);
  const joined = await joinResponse.json();
  const playerSetCookie = joinResponse.headers.get("set-cookie") ?? "";
  const playerCookie = cookiePair(playerSetCookie);
  assert.match(playerSetCookie, new RegExp(`pinboard_player_${pin}=`));
  assert.match(playerSetCookie, /HttpOnly/i);
  assert.notEqual(playerCookie, presenter.cookie);
  assert.match(joined.playerId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const resumeResponse = await postJson(`/api/sessions/${pin}/resume`, {}, {
    Cookie: playerCookie,
    Origin: baseUrl
  });
  assert.equal(resumeResponse.status, 200);
  const resumed = await resumeResponse.json();
  assert.equal(resumed.playerId, joined.playerId);

  const startResponse = await postJson(`/api/sessions/${pin}/start`, {}, presenterMutationHeaders(presenter));
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.equal(started.session.phase, "answering");

  const answerWithoutCookie = await postJson(`/api/sessions/${pin}/answer`, { optionId: firstOptionId }, {
    Origin: baseUrl
  });
  assert.equal(answerWithoutCookie.status, 401);

  const firstAnswerResponse = await postJson(`/api/sessions/${pin}/answer`, { optionId: firstOptionId }, {
    Cookie: playerCookie,
    Origin: baseUrl
  });
  assert.equal(firstAnswerResponse.status, 200);
  const firstAnswer = await firstAnswerResponse.json();
  assert.equal(firstAnswer.accepted, true);
  assert.equal(firstAnswer.duplicate, false);
  assert.equal(firstAnswer.session.selectedOptionId, firstOptionId);

  const duplicateResponse = await postJson(`/api/sessions/${pin}/answer`, { optionId: secondOptionId }, {
    Cookie: playerCookie,
    Origin: baseUrl
  });
  assert.equal(duplicateResponse.status, 200);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.session.selectedOptionId, firstOptionId);

  const hostEventsUrl = new URL(`/events?pin=${pin}&role=host`, baseUrl);
  assert.equal(hostEventsUrl.searchParams.has("token"), false);
  const hostStream = await openEventStream(hostEventsUrl, presenter.cookie);
  context.after(() => closeEventStream(hostStream));
  assert.equal(hostStream.state.pin, pin);
  assert.equal(hostStream.state.phase, "answering");

  const playerEventsUrl = new URL(`/events?pin=${pin}&role=player`, baseUrl);
  assert.equal(playerEventsUrl.searchParams.has("playerId"), false);
  const playerStream = await openEventStream(playerEventsUrl, playerCookie);
  context.after(() => closeEventStream(playerStream));
  assert.equal(playerStream.state.me.id, joined.playerId);
  assert.equal(playerStream.state.selectedOptionId, firstOptionId);

  await Promise.all([closeEventStream(hostStream), closeEventStream(playerStream)]);

  const postDisconnectResumeResponse = await postJson(`/api/sessions/${pin}/resume`, {}, {
    Cookie: playerCookie,
    Origin: baseUrl
  });
  assert.equal(postDisconnectResumeResponse.status, 200);
  const postDisconnectResume = await postDisconnectResumeResponse.json();
  assert.equal(postDisconnectResume.playerId, joined.playerId);
  assert.equal(postDisconnectResume.session.me.id, joined.playerId);
  assert.equal(postDisconnectResume.session.phase, "answering");

  const leavingStream = await openEventStream(playerEventsUrl, playerCookie);
  context.after(() => closeEventStream(leavingStream));

  const leaveResponse = await postJson(`/api/sessions/${pin}/leave`, {}, {
    Cookie: playerCookie,
    Origin: baseUrl
  });
  assert.equal(leaveResponse.status, 200);
  assert.match(leaveResponse.headers.get("set-cookie") ?? "", /Max-Age=0/i);
  await waitForEventStreamEnd(leavingStream);
  const resumeAfterLeave = await postJson(`/api/sessions/${pin}/resume`, {}, {
    Cookie: playerCookie,
    Origin: baseUrl
  });
  assert.equal(resumeAfterLeave.status, 401);

  const legacyResumeAfterLeave = await postJson(`/api/sessions/${pin}/resume`, {
    legacyPlayerId: joined.playerId
  }, { Origin: baseUrl });
  assert.equal(legacyResumeAfterLeave.status, 401);

  const nicknameReuseResponse = await postJson(`/api/sessions/${pin}/join`, { nickname: "Cookie Player" }, {
    Origin: baseUrl
  });
  assert.equal(nicknameReuseResponse.status, 201);
  const nicknameReuse = await nicknameReuseResponse.json();
  assert.notEqual(nicknameReuse.playerId, joined.playerId);
  assert.equal(nicknameReuse.session.playerCount, 1);
  assert.deepEqual(
    nicknameReuse.session.leaderboard
      .filter((player) => player.nickname === "Cookie Player")
      .map((player) => ({ id: player.id, departed: player.departed })),
    [
      { id: joined.playerId, departed: true },
      { id: nicknameReuse.playerId, departed: false }
    ]
  );
  const nicknameReuseCookie = cookiePair(nicknameReuseResponse.headers.get("set-cookie") ?? "");

  const secondLeaveResponse = await postJson(`/api/sessions/${pin}/leave`, {}, {
    Cookie: nicknameReuseCookie,
    Origin: baseUrl
  });
  assert.equal(secondLeaveResponse.status, 200);

  const replacementResponse = await postJson(`/api/sessions/${pin}/join`, { nickname: "Replacement Player" }, {
    Origin: baseUrl
  });
  assert.equal(replacementResponse.status, 201);
  const replacement = await replacementResponse.json();
  assert.equal(replacement.session.playerCount, 1);
  const replacementHostStream = await openEventStream(hostEventsUrl, presenter.cookie);
  assert.equal(replacementHostStream.state.playerCount, 1);
  assert.deepEqual(replacementHostStream.state.recentPlayers.map((player) => player.nickname), ["Replacement Player"]);
  await closeEventStream(replacementHostStream);

  const guardedEndResponse = await postJson(`/api/sessions/${pin}/end`, {}, presenterMutationHeaders(presenter));
  assert.equal(guardedEndResponse.status, 409);
  const guardedEnd = await guardedEndResponse.json();
  assert.equal(guardedEnd.code, "ACTIVE_ROUND");

  const confirmedEndResponse = await postJson(
    `/api/sessions/${pin}/end`,
    { discardActiveRound: true },
    presenterMutationHeaders(presenter)
  );
  assert.equal(confirmedEndResponse.status, 200);
  const confirmedEnd = await confirmedEndResponse.json();
  assert.equal(confirmedEnd.session.phase, "ended");
});

test("authenticated presenter can recover the latest active hosted session", async () => {
  const presenter = await loginPresenter();
  const createResponse = await postJson(
    "/api/sessions",
    {
      title: "Host recovery integration",
      questions: [{
        id: randomUUID(),
        kind: "slide",
        text: "Recovery slide",
        points: 0,
        timerSeconds: 0,
        options: [],
        correctOptionIds: [],
        media: null
      }]
    },
    presenterMutationHeaders(presenter)
  );
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();

  const recoveryResponse = await fetch(`${baseUrl}/api/sessions/active`, {
    headers: { Cookie: presenter.cookie }
  });
  assert.equal(recoveryResponse.status, 200);
  const recovered = await recoveryResponse.json();
  assert.equal(recovered.pin, created.pin);
  assert.equal(recovered.session.pin, created.pin);
  assert.equal(recovered.session.phase, "lobby");

  const endResponse = await postJson(
    `/api/sessions/${created.pin}/end`,
    { discardActiveRound: true },
    presenterMutationHeaders(presenter)
  );
  assert.equal(endResponse.status, 200);

  const emptyResponse = await fetch(`${baseUrl}/api/sessions/active`, {
    headers: { Cookie: presenter.cookie }
  });
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(await emptyResponse.json(), { pin: null, session: null });
});

test("presentation saves reject a stale revision", async () => {
  const presenter = await loginPresenter();
  const createResponse = await postJson("/api/presentations", {}, presenterMutationHeaders(presenter));
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).presentation;
  assert.equal(created.version, 1);

  const snapshot = {
    title: "Revision guarded",
    questions: created.snapshot.questions
  };
  const firstSave = await putJson(`/api/presentations/${created.id}`, {
    snapshot,
    expectedVersion: created.version
  }, presenterMutationHeaders(presenter));
  assert.equal(firstSave.status, 200);
  const firstSavedPresentation = (await firstSave.json()).presentation;
  assert.equal(firstSavedPresentation.version, 2);

  const staleSave = await putJson(`/api/presentations/${created.id}`, {
    snapshot: { ...snapshot, title: "Stale overwrite" },
    expectedVersion: created.version
  }, presenterMutationHeaders(presenter));
  assert.equal(staleSave.status, 409);
  assert.equal((await staleSave.json()).code, "PRESENTATION_VERSION_CONFLICT");
});

test("presentation saves normalize multiple and legacy correct option fields", async () => {
  const presenter = await loginPresenter();
  const createResponse = await postJson("/api/presentations", {}, presenterMutationHeaders(presenter));
  const created = (await createResponse.json()).presentation;
  const optionIds = [randomUUID(), randomUUID(), randomUUID()];
  const question = {
    id: randomUUID(),
    kind: "quiz",
    text: "Choose two",
    points: 1_000,
    timerSeconds: 30,
    options: optionIds.map((id, index) => ({ id, text: `Option ${index + 1}` })),
    correctOptionIds: optionIds.slice(0, 2),
    media: null
  };

  const multiSave = await putJson(`/api/presentations/${created.id}`, {
    snapshot: { title: "Multiple correct", questions: [question] },
    expectedVersion: created.version
  }, presenterMutationHeaders(presenter));
  assert.equal(multiSave.status, 200);
  const multiSaved = (await multiSave.json()).presentation;
  assert.deepEqual(multiSaved.snapshot.questions[0].correctOptionIds, optionIds.slice(0, 2));

  const legacySave = await putJson(`/api/presentations/${created.id}`, {
    snapshot: {
      title: "Legacy correct",
      questions: [{ ...question, correctOptionIds: undefined, correctOptionId: optionIds[0] }]
    },
    expectedVersion: multiSaved.version
  }, presenterMutationHeaders(presenter));
  assert.equal(legacySave.status, 200);
  assert.deepEqual((await legacySave.json()).presentation.snapshot.questions[0].correctOptionIds, [optionIds[0]]);
});

test("answer results advance through a dedicated leaderboard before the next question", async () => {
  const presenter = await loginPresenter();
  const optionIds = [randomUUID(), randomUUID()];
  const questions = ["First question", "Second question"].map((text) => ({
    id: randomUUID(),
    kind: "quiz",
    text,
    points: 1_000,
    timerSeconds: 30,
    options: optionIds.map((id, index) => ({ id, text: `Option ${index + 1}` })),
    correctOptionIds: [optionIds[0]],
    media: null
  }));
  const created = await postJson("/api/sessions", { title: "Leaderboard phases", questions }, presenterMutationHeaders(presenter));
  const { pin } = await created.json();
  const joinResponse = await postJson(`/api/sessions/${pin}/join`, { nickname: "Phase player" }, { Origin: baseUrl });
  const playerCookie = cookiePair(joinResponse.headers.get("set-cookie") ?? "");

  await postJson(`/api/sessions/${pin}/start`, {}, presenterMutationHeaders(presenter));
  await postJson(`/api/sessions/${pin}/open`, {}, presenterMutationHeaders(presenter));
  await postJson(`/api/sessions/${pin}/answer`, { selectedOptionIds: [optionIds[0]] }, { Cookie: playerCookie, Origin: baseUrl });
  const reveal = await postJson(`/api/sessions/${pin}/reveal`, {}, presenterMutationHeaders(presenter));
  const revealed = await reveal.json();
  assert.equal(revealed.session.phase, "results");
  assert.ok(revealed.session.effectiveDurationMs >= 1);

  const leaderboard = await postJson(`/api/sessions/${pin}/next`, {}, presenterMutationHeaders(presenter));
  const leaderboardState = await leaderboard.json();
  assert.equal(leaderboardState.session.phase, "leaderboard");
  assert.equal(leaderboardState.session.currentQuestionIndex, 0);

  const next = await postJson(`/api/sessions/${pin}/next`, {}, presenterMutationHeaders(presenter));
  const nextState = await next.json();
  assert.equal(nextState.session.phase, "answering");
  assert.equal(nextState.session.currentQuestionIndex, 1);
});

async function loginPresenter() {
  const response = await postJson("/api/auth", {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    keepSignedIn: false
  }, {
    Origin: baseUrl
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const setCookie = response.headers.get("set-cookie") ?? "";
  return {
    cookie: cookiePair(setCookie),
    csrfToken: body.csrfToken,
    setCookie
  };
}

function presenterMutationHeaders(presenter) {
  return {
    Cookie: presenter.cookie,
    "X-CSRF-Token": presenter.csrfToken,
    Origin: baseUrl
  };
}

function postJson(pathname, body, extraHeaders = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body)
  });
}

function putJson(pathname, body, extraHeaders = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: "PUT",
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body)
  });
}

async function openEventStream(url, cookie) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: {
      Accept: "text/event-stream",
      Cookie: cookie
    },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/i);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const state = await readFirstStateEvent(reader);
  return { controller, reader, state, closed: false };
}

async function closeEventStream(stream) {
  if (stream.closed) {
    return;
  }
  stream.closed = true;
  await stream.reader.cancel().catch(() => {});
  stream.controller.abort();
}

async function waitForEventStreamEnd(stream) {
  while (true) {
    const result = await readWithTimeout(stream.reader);
    if (result.done) {
      stream.closed = true;
      return;
    }
  }
}

async function readFirstStateEvent(reader) {
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await readWithTimeout(reader);
    if (done) {
      throw new Error("SSE stream closed before the initial state event.");
    }
    buffered += decoder.decode(value, { stream: true });
    const boundary = buffered.indexOf("\n\n");
    if (boundary === -1) {
      continue;
    }
    const eventBlock = buffered.slice(0, boundary);
    const data = eventBlock
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) {
      return JSON.parse(data);
    }
    buffered = buffered.slice(boundary + 2);
  }
}

function readWithTimeout(reader) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting ${STREAM_READ_TIMEOUT_MS}ms for an SSE state event.`));
    }, STREAM_READ_TIMEOUT_MS);
    reader.read().then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function cookiePair(setCookie) {
  const pair = setCookie.split(";", 1)[0];
  assert.ok(pair.includes("="), "Expected a Set-Cookie response header.");
  return pair;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
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
    await delay(HEALTH_RETRY_DELAY_MS);
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
