# Dynamic Quiz Answers and Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship authoritative 2–6 option quizzes with multiple correct answers, millisecond partial-credit scoring, focused presenter results, dedicated leaderboards, improved player states, and image-only question media.

**Architecture:** Extend the existing server-authoritative session snapshot and normalized answer records. Pure scoring and editor transition helpers receive direct unit coverage; the server owns timestamps, effective duration, phases, persistence, and role-scoped serialization; the vanilla JavaScript client renders the approved editor, presenter, and player states.

**Tech Stack:** Node.js 22, vanilla JavaScript modules, PostgreSQL 16, Server-Sent Events, Node test runner, Playwright, Railway.

## Global Constraints

- Regular quizzes contain 2–6 options and 1–6 correct options; True/False remains exactly 2 options with 1 correct option; slides contain none.
- Single-answer questions submit on click; multiple-answer questions require exactly the correct-answer count and an explicit **Submit answers** action.
- Scoring uses authoritative milliseconds: `ceil(points * max(0, 1 - elapsedMs / effectiveDurationMs))`, then `ceil(timeValue * correctlySelected / totalCorrectAnswers)`.
- Natural expiry uses the configured timer; Skip timer uses actual elapsed time clamped to at least 1 ms.
- Wrong and missing answers earn zero; partial correctness earns only the correctly selected shares.
- Preserve existing single-answer presentations and answer rows through compatibility normalization and an additive database migration.
- Accept only signature-validated raster images for new question media; one image per question.
- Do not install dependencies or restructure the project beyond focused helper extraction.
- Every behavior must work after reconnect and across PostgreSQL-backed replicas.
- All UI is keyboard accessible, communicates correctness without color alone, and respects reduced motion.

---

## File responsibility map

- `src/session-domain.mjs` — pure answer acceptance, millisecond award calculation, outcome classification, and idempotent scoring.
- `public/client-state.js` — pure editor option transitions, local multi-selection transitions, and stable phrase choice.
- `server.mjs` — validation, compatibility normalization, PostgreSQL migration, authoritative phases/timing, persistence, and role-scoped state.
- `public/app.js` — editor controls, image preview/removal, presenter result/leaderboard markup, and player selection/wait/reveal behavior.
- `public/styles.css` — responsive 2–6 option layouts, prominent timer, graph, image, editor, waiting, and reveal presentation.
- `test/unit/session-domain.test.mjs` — scoring, partial credit, timing, deadline, and idempotency contracts.
- `test/unit/client-state.test.mjs` — add/remove/correct-selection and local multi-selection contracts.
- `test/integration/session-lifecycle.test.mjs` — HTTP validation, phase flow, player states, and compatibility behavior.
- `test/integration/postgres-concurrency.test.mjs` — additive migration, multi-answer persistence, duplicate submission, and Skip/submission serialization.
- `test/integration/server-hardening.test.mjs` — image-only signature validation and media authorization.
- `tests/e2e/support.mjs` — reusable single/multiple quiz fixtures and host actions.
- `tests/e2e/live-session.desktop.spec.mjs` — editor, presenter, result graph, leaderboard, image, and reconnect flow.
- `tests/e2e/player.mobile.spec.mjs` — 2–6 option responsiveness, multi-submit, waiting, reveal, and timeout flow.
- `README.md`, `PROJECT_LOG.md` — behavior, storage, scoring, deployment, and verification record.

---

### Task 1: Pure multi-answer acceptance and scoring domain

**Files:**
- Modify: `src/session-domain.mjs:1-125`
- Modify: `test/unit/session-domain.test.mjs:1-180`

**Interfaces:**
- Produces: `calculateQuestionAward({ questionPoints, openedAt, submittedAt, effectiveDurationMs, selectedOptionIds, correctOptionIds }) -> { timeValue, awardedPoints, correctlySelected, outcome }`.
- Produces: `recordAnswer(session, { playerId, selectedOptionIds, now })` storing `{ selectedOptionIds, answeredAt }`.
- Produces: `scoreCurrentQuestion(session)` using `session.effectiveDurationMs` and remaining idempotent.

- [ ] **Step 1: Replace the single-answer unit fixtures and write failing award tests**

```js
const SECOND_CORRECT_OPTION_ID = "option-second-correct";

test("calculateQuestionAward decreases every millisecond and reaches zero at the deadline", () => {
  assert.deepEqual(calculateQuestionAward({
    questionPoints: 1_000,
    openedAt: NOW,
    submittedAt: NOW + 15_000,
    effectiveDurationMs: 30_000,
    selectedOptionIds: [CORRECT_OPTION_ID],
    correctOptionIds: [CORRECT_OPTION_ID]
  }), { timeValue: 500, awardedPoints: 500, correctlySelected: 1, outcome: "correct" });

  assert.equal(calculateQuestionAward({
    questionPoints: 1_000,
    openedAt: NOW,
    submittedAt: NOW + 30_000,
    effectiveDurationMs: 30_000,
    selectedOptionIds: [CORRECT_OPTION_ID],
    correctOptionIds: [CORRECT_OPTION_ID]
  }).awardedPoints, 0);
});

test("calculateQuestionAward gives partial credit without rewarding wrong selections", () => {
  const award = calculateQuestionAward({
    questionPoints: 1_000,
    openedAt: NOW,
    submittedAt: NOW + 2_000,
    effectiveDurationMs: 10_000,
    selectedOptionIds: [CORRECT_OPTION_ID, INCORRECT_OPTION_ID],
    correctOptionIds: [CORRECT_OPTION_ID, SECOND_CORRECT_OPTION_ID]
  });
  assert.deepEqual(award, {
    timeValue: 800,
    awardedPoints: 400,
    correctlySelected: 1,
    outcome: "partial"
  });
});
```

- [ ] **Step 2: Run the targeted unit test and confirm the red state**

Run: `node --test test/unit/session-domain.test.mjs`  
Expected: FAIL because `calculateQuestionAward` is not exported and `recordAnswer` still accepts `optionId`.

- [ ] **Step 3: Implement the pure award and array submission contract**

```js
export function calculateQuestionAward({
  questionPoints,
  openedAt,
  submittedAt,
  effectiveDurationMs,
  selectedOptionIds,
  correctOptionIds
}) {
  const duration = Math.max(1, Number(effectiveDurationMs));
  const elapsed = Math.max(0, Number(submittedAt) - Number(openedAt));
  const ratio = Math.max(0, 1 - elapsed / duration);
  const timeValue = Math.ceil(Number(questionPoints) * ratio);
  const correctIds = new Set(correctOptionIds);
  const correctlySelected = selectedOptionIds.filter((id) => correctIds.has(id)).length;
  const awardedPoints = Math.ceil(timeValue * correctlySelected / correctIds.size);
  const outcome = correctlySelected === correctIds.size
    ? "correct"
    : correctlySelected > 0 ? "partial" : "incorrect";
  return { timeValue, awardedPoints, correctlySelected, outcome };
}

export function recordAnswer(session, { playerId, selectedOptionIds, now }) {
  const question = getCurrentQuestion(session);
  if (!question || !ACTIVE_ROUND_PHASES.has(session.phase) || isAnswerDeadlineReached(session, question, now)) {
    throw new DomainError(HTTP_CONFLICT, ANSWER_CLOSED_CODE, ANSWER_CLOSED_MESSAGE);
  }
  if (session.answers.has(playerId)) return { session, outcome: DUPLICATE_OUTCOME };
  const expectedCount = question.correctOptionIds.length;
  const uniqueIds = [...new Set(selectedOptionIds)];
  const validIds = new Set(question.options.map((option) => option.id));
  if (uniqueIds.length !== expectedCount || uniqueIds.some((id) => !validIds.has(id))) {
    throw new DomainError(400, "INVALID_SELECTION", `Select exactly ${expectedCount} answers.`);
  }
  const answers = new Map(session.answers);
  answers.set(playerId, { selectedOptionIds: uniqueIds, answeredAt: now });
  return { session: { ...session, answers }, outcome: ACCEPTED_OUTCOME };
}
```

Update `scoreCurrentQuestion` to call `calculateQuestionAward`, add only `awardedPoints`, and keep `scoredQuestionIndexes` idempotency.

- [ ] **Step 4: Run domain tests**

Run: `node --test test/unit/session-domain.test.mjs`  
Expected: all deadline, duplicate, partial, Skip-duration, zero-at-deadline, timeout, and score-once tests PASS.

- [ ] **Step 5: Commit the pure domain increment**

```powershell
git add src/session-domain.mjs test/unit/session-domain.test.mjs
git commit -m "Add dynamic multi-answer scoring domain"
```

---

### Task 2: Question normalization and legacy compatibility

**Files:**
- Modify: `server.mjs:138-148, 1889-1920, 2101-2235`
- Modify: `test/integration/session-lifecycle.test.mjs:62-242`

**Interfaces:**
- Consumes: `Question.correctOptionIds` from Task 1.
- Produces: `normalizeCorrectOptionIds(input, options, kind, itemLabel) -> string[]`.
- Produces: role state with `correctOptionIds` only when answers are revealable.

- [ ] **Step 1: Write failing integration cases for legacy and multiple-correct payloads**

```js
const legacyQuestion = { ...baseQuestion, correctOptionId: firstOptionId };
const multiQuestion = {
  ...baseQuestion,
  correctOptionId: undefined,
  correctOptionIds: [firstOptionId, secondOptionId]
};

assert.equal((await savePresentation(legacyQuestion)).status, 201);
assert.equal((await savePresentation(multiQuestion)).status, 201);
assert.deepEqual(savedMulti.snapshot.questions[0].correctOptionIds, [firstOptionId, secondOptionId]);
```

Also assert rejection of duplicate IDs, missing IDs, zero correct IDs, six options with seven correct IDs, and multiple correct IDs on True/False.

- [ ] **Step 2: Run the lifecycle test and confirm it fails on `correctOptionIds`**

Run: `node --test test/integration/session-lifecycle.test.mjs`  
Expected: FAIL because the server still reads only `correctOptionId`.

- [ ] **Step 3: Add compatibility normalization and serializer fields**

```js
function normalizeCorrectOptionIds(input, options, kind, itemLabel) {
  const candidate = Array.isArray(input.correctOptionIds)
    ? input.correctOptionIds
    : typeof input.correctOptionId === "string" ? [input.correctOptionId] : [];
  const ids = candidate.map((id, index) => readString(id, `${itemLabel} correct option ${index + 1}`));
  const uniqueIds = [...new Set(ids)];
  const optionIds = new Set(options.map((option) => option.id));
  if (uniqueIds.length === 0 || uniqueIds.length !== ids.length || uniqueIds.some((id) => !optionIds.has(id))) {
    throw new HttpError(400, `${itemLabel} needs unique valid correct options.`);
  }
  if (kind === "true_false" && uniqueIds.length !== 1) {
    throw new HttpError(400, `${itemLabel} true or false questions need exactly 1 correct option.`);
  }
  return uniqueIds;
}
```

Change both question normalizers, typedefs, snapshot serializers, and `serializeQuestion` to use `correctOptionIds`. Keep legacy reads but stop emitting new `correctOptionId` saves.

- [ ] **Step 4: Run lifecycle and syntax checks**

Run: `node --test test/integration/session-lifecycle.test.mjs && node --check server.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit validation compatibility**

```powershell
git add server.mjs test/integration/session-lifecycle.test.mjs
git commit -m "Support multiple correct quiz options"
```

---

### Task 3: PostgreSQL multi-selection persistence and concurrency

**Files:**
- Modify: `server.mjs:971-1140, 2773-2810, 3561-3595`
- Modify: `test/integration/postgres-concurrency.test.mjs:23-420`

**Interfaces:**
- Consumes: `recordAnswer(session, { playerId, selectedOptionIds, now })`.
- Produces: additive `selected_option_ids JSONB` column; legacy `option_id` remains populated with the first selection for rollback compatibility.
- Produces: `persistAnswer` and `getPersistedAnswer` returning `{ selectedOptionIds, answeredAt }`.

- [ ] **Step 1: Write failing PostgreSQL persistence and race tests**

```js
const selectedOptionIds = [firstOptionId, secondOptionId];
const accepted = await postJson(firstServer.baseUrl, `/api/sessions/${pin}/answer`,
  { selectedOptionIds }, { Cookie: playerCookie, Origin: firstServer.baseUrl });
assert.equal(accepted.status, 200);
assert.deepEqual((await accepted.json()).session.selectedOptionIds, selectedOptionIds);

const duplicate = await postJson(secondServer.baseUrl, `/api/sessions/${pin}/answer`,
  { selectedOptionIds: [thirdOptionId, fourthOptionId] },
  { Cookie: playerCookie, Origin: secondServer.baseUrl });
assert.equal(duplicate.status, 200);
assert.equal((await duplicate.json()).duplicate, true);
```

Restart both test servers and assert the original array and timestamp restore exactly.

- [ ] **Step 2: Run the PostgreSQL test and confirm the red state**

Run: `$env:TEST_DATABASE_URL='postgresql://pinboard_test:pinboard_test@127.0.0.1:5432/pinboard_test'; node --test test/integration/postgres-concurrency.test.mjs`  
Expected: FAIL because `live_session_answers` stores only `option_id`.

- [ ] **Step 3: Add the additive migration and update all answer queries**

```sql
ALTER TABLE live_session_answers
ADD COLUMN IF NOT EXISTS selected_option_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE live_session_answers
SET selected_option_ids = jsonb_build_array(option_id)
WHERE jsonb_array_length(selected_option_ids) = 0 AND option_id IS NOT NULL;
```

Use parameterized inserts:

```sql
INSERT INTO live_session_answers
  (pin, question_index, player_id, option_id, selected_option_ids, answered_at)
VALUES ($1, $2, $3, $4, $5::jsonb, $6)
ON CONFLICT (pin, question_index, player_id) DO NOTHING
RETURNING selected_option_ids, answered_at;
```

Update `handleAnswer`, `handleConcurrentDatabaseAnswer`, persisted session hydration, and notification payloads to validate and carry `selectedOptionIds` arrays.

- [ ] **Step 4: Run PostgreSQL and lifecycle integration tests**

Run: `npm run test:integration` with `TEST_DATABASE_URL` configured.  
Expected: all integration tests PASS, including duplicate, restart, and cross-replica cases.

- [ ] **Step 5: Commit persistence**

```powershell
git add server.mjs test/integration/postgres-concurrency.test.mjs
git commit -m "Persist multi-answer player submissions"
```

---

### Task 4: Authoritative effective duration, result outcomes, and leaderboard phase

**Files:**
- Modify: `server.mjs:138-148, 863-930, 1231-1405, 1861-1925`
- Modify: `test/integration/session-lifecycle.test.mjs:62-242`
- Modify: `test/integration/postgres-concurrency.test.mjs:23-420`

**Interfaces:**
- Produces: `Phase` includes `leaderboard`.
- Produces: session `effectiveDurationMs: number | null` reset for each question and persisted in snapshots.
- Produces: player role state fields `selectedOptionIds`, `answerOutcome`, `awardedPoints`, and `requiredSelectionCount`.

- [ ] **Step 1: Write failing phase and dynamic Skip tests**

```js
const revealResponse = await postJson(baseUrl, `/api/sessions/${pin}/reveal`, {},
  presenterMutationHeaders(presenter));
const revealed = await revealResponse.json();
assert.equal(revealed.session.phase, "results");

const playerRevealResponse = await postJson(baseUrl, `/api/sessions/${pin}/resume`, {}, {
  Cookie: playerCookie,
  Origin: baseUrl
});
const playerReveal = await playerRevealResponse.json();
assert.equal(playerReveal.session.answerOutcome, "partial");
assert.equal(playerReveal.session.awardedPoints, expectedPartialAward);

const leaderboardResponse = await postJson(baseUrl, `/api/sessions/${pin}/next`, {},
  presenterMutationHeaders(presenter));
assert.equal((await leaderboardResponse.json()).session.phase, "leaderboard");

const nextQuestionResponse = await postJson(baseUrl, `/api/sessions/${pin}/next`, {},
  presenterMutationHeaders(presenter));
assert.equal((await nextQuestionResponse.json()).session.currentQuestionIndex, 1);
```

Use a controlled clock fixture to assert manual Skip uses `max(1, skippedAt - openedAt)` while natural timeout uses `timerSeconds * 1_000`.

- [ ] **Step 2: Run lifecycle tests and verify phase assertions fail**

Run: `node --test test/integration/session-lifecycle.test.mjs`  
Expected: FAIL because results currently embed the leaderboard and `next` advances directly.

- [ ] **Step 3: Implement phase, duration, and role-state transitions**

```js
function revealAnswers(session, reason = "manual", now = Date.now()) {
  const question = getCurrentQuestion(session);
  if (!question || question.kind === "slide") throw new HttpError(409, "No answers can be revealed.");
  const configuredMs = question.timerSeconds * 1_000;
  session.effectiveDurationMs = reason === "timer"
    ? configuredMs
    : Math.max(1, now - Number(session.openedAt ?? now));
  applySessionState(session, scoreCurrentQuestion(session));
  session.phase = "results";
  clearQuestionTimer(session.pin);
}

function advanceSession(session) {
  if (session.phase === "results") {
    if (session.currentQuestionIndex === session.questions.length - 1) {
      endSession(session);
      return;
    }
    session.phase = "leaderboard";
    return;
  }
  const question = getCurrentQuestion(session);
  const isSlideReadyForNext = session.phase === "question" && question?.kind === "slide";
  if (session.phase !== "leaderboard" && !isSlideReadyForNext) {
    throw new HttpError(409, "The session cannot advance yet.");
  }
  const nextIndex = session.currentQuestionIndex + 1;
  if (nextIndex >= session.questions.length) {
    endSession(session);
    return;
  }
  session.currentQuestionIndex = nextIndex;
  resetCurrentAnswers(session);
  openCurrentQuestion(session);
  session.effectiveDurationMs = null;
}
```

Serialize correct IDs only in results/leaderboard/ended, compute answer counts across every selected ID, and expose each player's derived award/outcome without leaking another player's selections.

- [ ] **Step 4: Run unit, lifecycle, and PostgreSQL concurrency tests**

Run: `npm run test` with `TEST_DATABASE_URL` configured.  
Expected: PASS with serialized concurrent answer/Skip ordering.

- [ ] **Step 5: Commit authoritative phases**

```powershell
git add server.mjs test/integration/session-lifecycle.test.mjs test/integration/postgres-concurrency.test.mjs
git commit -m "Add authoritative results and leaderboard phases"
```

---

### Task 5: Pure editor option transitions and editor controls

**Files:**
- Modify: `public/client-state.js:1-270`
- Modify: `test/unit/client-state.test.mjs:1-240`
- Modify: `public/app.js:180-330, 937-990, 1690-1785, 2209-2285, 2568-2590`

**Interfaces:**
- Produces: `addQuizOption(question, createId)`, `removeQuizOption(question, optionId)`, and `toggleCorrectOption(question, optionId)` returning new question objects.
- Produces: editor actions `add-answer`, `remove-answer`, and checkbox field `correctOption`.

- [ ] **Step 1: Write failing nearest-correct and limit tests**

```js
test("removeQuizOption promotes the nearest remaining option", () => {
  const question = {
    kind: "quiz",
    options: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, text: id.toUpperCase() })),
    correctOptionIds: ["b", "d"]
  };
  const updated = removeQuizOption(question, "b");
  assert.deepEqual(updated.options.map(({ id }) => id), ["a", "c", "d", "e", "f"]);
  assert.deepEqual(updated.correctOptionIds, ["c", "d"]);
});

test("quiz option helpers enforce two through six and one correct", () => {
  const two = { kind: "quiz", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], correctOptionIds: ["a"] };
  const six = { kind: "quiz", options: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, text: id })), correctOptionIds: ["a"] };
  assert.throws(() => removeQuizOption(two, "a"), /at least 2/);
  assert.throws(() => addQuizOption(six, () => "g"), /at most 6/);
  assert.throws(() => toggleCorrectOption(two, "a"), /at least 1/);
});
```

- [ ] **Step 2: Run the targeted unit tests and confirm missing exports**

Run: `node --test test/unit/client-state.test.mjs`  
Expected: FAIL because the option transition helpers do not exist.

- [ ] **Step 3: Implement immutable helpers and editor markup**

```js
export function removeQuizOption(question, optionId) {
  if (question.options.length <= 2) throw new RangeError("Quiz questions need at least 2 answers.");
  const removedIndex = question.options.findIndex((option) => option.id === optionId);
  const options = question.options.filter((option) => option.id !== optionId);
  let correctOptionIds = question.correctOptionIds.filter((id) => id !== optionId);
  const targetCount = Math.min(question.correctOptionIds.length, options.length);
  while (correctOptionIds.length < targetCount) {
    const targetIndex = Math.min(removedIndex, options.length - 1);
    const replacement = options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !correctOptionIds.includes(option.id))
      .sort((left, right) => Math.abs(left.index - targetIndex) - Math.abs(right.index - targetIndex) || left.index - right.index)[0]?.option;
    if (!replacement) break;
    correctOptionIds.push(replacement.id);
  }
  return { ...question, options, correctOptionIds };
}
```

Render a checkbox correct toggle, answer text, shape, remove button, `Answers N/6`, and **Add answer** only for regular quizzes. Wire synchronous click actions through the existing dirty/autosave path. Normalize opened legacy presentations to `correctOptionIds` before rendering.

- [ ] **Step 4: Run client unit and syntax tests**

Run: `npm run test:unit && node --check public/app.js && node --check public/client-state.js`  
Expected: PASS.

- [ ] **Step 5: Commit editor answer controls**

```powershell
git add public/client-state.js public/app.js test/unit/client-state.test.mjs
git commit -m "Add two to six answer editor controls"
```

---

### Task 6: Image-only editor preview and live image behavior

**Files:**
- Modify: `public/app.js:322-335, 937-977, 1280-1345, 2292-2345`
- Modify: `server.mjs:650-720, 2240-2310`
- Modify: `test/integration/server-hardening.test.mjs:194-250`
- Modify: `tests/e2e/live-session.desktop.spec.mjs:60-188`

**Interfaces:**
- Produces: editor action `remove-question-media`.
- Produces: a single `.question-media-editor` preview with an accessible remove button.
- Server accepts only existing signature-detected raster MIME types.

- [ ] **Step 1: Write failing image security and editor browser tests**

```js
const login = await loginPresenter();
const videoUpload = await fetch(`${baseUrl}/api/media`, {
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
assert.equal(videoUpload.status, 400);
assert.match((await videoUpload.json()).error, /image/i);
```

```js
await page.getByLabel("Question image").setInputFiles({
  name: "question.png",
  mimeType: "image/png",
  buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
});
await expect(page.locator(".question-media-editor img")).toBeVisible();
await expect(page.getByLabel("Question image")).toHaveCount(0);
await page.getByRole("button", { name: "Remove question image" }).click();
await expect(page.getByLabel("Question image")).toBeVisible();
```

- [ ] **Step 2: Run focused integration and Playwright tests to confirm failures**

Run: `node --test test/integration/server-hardening.test.mjs` and `npx playwright test tests/e2e/live-session.desktop.spec.mjs --grep "question image"`  
Expected: FAIL because video is accepted and the editor does not replace the chooser.

- [ ] **Step 3: Implement image-only validation and preview/removal**

```js
if (!detectedMimeType.startsWith("image/")) {
  throw new HttpError(400, "Question media must be a supported image.");
}
```

Use `accept="image/png,image/jpeg,image/gif,image/webp"`, render the uploaded image immediately from the returned media URL, hide the chooser while media exists, and preserve the prior media object until a replacement upload succeeds. Center `renderMedia` output and remove the video branch for new editor rendering.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/integration/server-hardening.test.mjs && npx playwright test tests/e2e/live-session.desktop.spec.mjs --grep "question image"`  
Expected: PASS.

- [ ] **Step 5: Commit image behavior**

```powershell
git add public/app.js server.mjs test/integration/server-hardening.test.mjs tests/e2e/live-session.desktop.spec.mjs
git commit -m "Improve question image editing and display"
```

---

### Task 7: Presenter timer, result graph, and separate leaderboard UI

**Files:**
- Modify: `public/app.js:1038-1087, 1237-1428`
- Modify: `public/styles.css:1690-1950`
- Modify: `tests/e2e/live-session.desktop.spec.mjs:60-188`

**Interfaces:**
- Consumes: `phase`, `effectiveDurationMs`, `answerCounts`, and `correctOptionIds` from Task 4.
- Produces: `renderPresenterResults(remote)` and `renderPresenterLeaderboard(remote)`.

- [ ] **Step 1: Write failing presenter assertions**

```js
await expect(page.locator(".stage-timer-prominent")).toContainText("30");
await page.getByRole("button", { name: "Skip timer" }).click();
await expect(page.locator(".answer-distribution-chart")).toBeVisible();
await expect(page.locator(".answer-result-bar[aria-label*='correct']")).toHaveCount(2);
await expect(page.locator(".leaderboard-break")).toHaveCount(0);
await page.getByRole("button", { name: "Next" }).click();
await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
```

- [ ] **Step 2: Run the presenter E2E test and confirm current layout fails**

Run: `npx playwright test tests/e2e/live-session.desktop.spec.mjs --grep "result graph"`  
Expected: FAIL because the timer is in the stage toolbar and leaderboard is embedded under results.

- [ ] **Step 3: Implement focused phase renderers and graph markup**

```js
function renderPresenterStageBody(remote, question) {
  if (remote.phase === "ended") return renderPodium(remote.leaderboard, remote.pin);
  if (remote.phase === "leaderboard") return renderPresenterLeaderboard(remote);
  if (remote.phase === "results") return renderPresenterResults(remote);
  return question ? renderLiveQuestion(remote, true) : renderLobby(remote);
}
```

Move timer markup into the question stage, add `data-live-timer-*` to the prominent element, render 2–6 bars with counts/percentages/correct text labels, center the optional image, and update primary actions so results advance to leaderboard and leaderboard advances to the next question.

- [ ] **Step 4: Run presenter E2E and accessibility assertions**

Run: `npx playwright test tests/e2e/live-session.desktop.spec.mjs --grep "result graph|timer|leaderboard"`  
Expected: PASS with no horizontal or vertical page overflow at 1440×900.

- [ ] **Step 5: Commit presenter experience**

```powershell
git add public/app.js public/styles.css tests/e2e/live-session.desktop.spec.mjs
git commit -m "Focus presenter timing and result phases"
```

---

### Task 8: Player multi-selection, waiting, reveal, and timeout states

**Files:**
- Modify: `public/client-state.js:220-290`
- Modify: `test/unit/client-state.test.mjs:1-290`
- Modify: `public/app.js:497-518, 1185-1235, 2077-2115`
- Modify: `public/styles.css:1540-1690`
- Modify: `tests/e2e/player.mobile.spec.mjs:10-80`

**Interfaces:**
- Produces: `togglePendingSelection(currentIds, optionId, limit) -> string[]`.
- Produces: `selectStablePhrase(seed, phrases) -> string`.
- Consumes: player `selectedOptionIds`, `requiredSelectionCount`, `answerOutcome`, and `awardedPoints`.

- [ ] **Step 1: Write failing helper and player-flow tests**

```js
test("togglePendingSelection caps choices and allows deselection", () => {
  assert.deepEqual(togglePendingSelection(["a"], "b", 2), ["a", "b"]);
  assert.deepEqual(togglePendingSelection(["a", "b"], "a", 2), ["b"]);
  assert.throws(() => togglePendingSelection(["a", "b"], "c", 2), /Select 2/);
});
```

```js
const firstOption = page.getByRole("button", { name: /Option 1/ });
const wrongOption = page.getByRole("button", { name: /Option 3/ });
await firstOption.click();
await wrongOption.click();
await expect(page.getByText("2 of 2 selected")).toBeVisible();
await page.getByRole("button", { name: "Submit answers" }).click();
await expect(page.getByText(/did you get it right/i)).toBeVisible();
await apiHostAction(request, host, "reveal");
await expect(page.getByRole("heading", { name: "Partially correct" })).toBeVisible();
await expect(page.getByText(/\+400 points/)).toBeVisible();
```

- [ ] **Step 2: Run unit and mobile tests to confirm the red state**

Run: `node --test test/unit/client-state.test.mjs && npx playwright test tests/e2e/player.mobile.spec.mjs`  
Expected: FAIL because the current client submits one option and keeps the answer grid visible.

- [ ] **Step 3: Implement local selection and server-driven player states**

```js
export function togglePendingSelection(currentIds, optionId, limit) {
  if (currentIds.includes(optionId)) return currentIds.filter((id) => id !== optionId);
  if (currentIds.length >= limit) throw new RangeError(`Select ${limit} answers.`);
  return [...currentIds, optionId];
}

export function selectStablePhrase(seed, phrases) {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return phrases[hash % phrases.length];
}
```

Keep pending selections keyed by question ID. Single-answer clicks call `submitAnswer([optionId])`; multi-answer clicks toggle and render the counter; `submit-multi-answer` posts the array. Replace the grid with stable waiting markup after acceptance and with correct/partial/incorrect/timeout reveal markup during results. Include selected and correct option labels and points gained.

- [ ] **Step 4: Run unit and mobile flow tests**

Run: `node --test test/unit/client-state.test.mjs && npx playwright test tests/e2e/player.mobile.spec.mjs`  
Expected: PASS, including reconnect after submission and zero-point timeout.

- [ ] **Step 5: Commit player experience**

```powershell
git add public/client-state.js public/app.js public/styles.css test/unit/client-state.test.mjs tests/e2e/player.mobile.spec.mjs
git commit -m "Add multi-answer player feedback flow"
```

---

### Task 9: Responsive 2–6 layouts, accessibility, and complete browser coverage

**Files:**
- Modify: `public/app.js:977-990, 1185-1345`
- Modify: `public/styles.css:1177-1240, 1540-1950, 2258-2280, 2700-2780`
- Modify: `tests/e2e/support.mjs:37-110`
- Modify: `tests/e2e/live-session.desktop.spec.mjs:60-220`
- Modify: `tests/e2e/player.mobile.spec.mjs:10-120`

**Interfaces:**
- Produces: `data-option-count="2"` through `data-option-count="6"` on editor, presenter, graph, and player grids.
- Extends `createApiHostedQuiz(request, title, options)` with explicit options, correct IDs, points, timer, and image.

- [ ] **Step 1: Parameterize browser fixtures and write failing count matrix tests**

```js
for (const optionCount of [2, 3, 4, 5, 6]) {
  test(`player layout supports ${optionCount} answers without overflow`, async ({ page, request }) => {
    const host = await createApiHostedQuiz(request, `Quiz ${optionCount}`, { optionCount });
    await joinAsPlayer(page, host.pin, `Player ${optionCount}`);
    await apiHostAction(request, host, "start");
    await expect(page.locator(`.player-answer-grid[data-option-count='${optionCount}']`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
}
```

Add assertions for keyboard toggle state, live-region counters, graph accessible labels, text wrapping, reduced motion, and focus-visible image removal.

- [ ] **Step 2: Run the matrix and capture failing counts**

Run: `npm run test:e2e`  
Expected: FAIL for 3, 5, and 6 option balance and missing accessibility attributes.

- [ ] **Step 3: Implement explicit count layouts and accessibility styling**

```css
.answer-grid[data-option-count="2"],
.player-answer-grid[data-option-count="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }

.answer-grid[data-option-count="3"],
.player-answer-grid[data-option-count="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }

.answer-grid[data-option-count="4"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }

.answer-grid[data-option-count="5"],
.answer-grid[data-option-count="6"],
.player-answer-grid[data-option-count="5"],
.player-answer-grid[data-option-count="6"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }

@media (max-width: 720px) {
  .answer-grid,
  .player-answer-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
```

Add stagger delays for fifth/sixth options, readable minimum tile sizes, wrap/overflow guards, visible focus styles, non-color correct icons/text, and `prefers-reduced-motion` overrides.

- [ ] **Step 4: Run all browser tests at desktop and mobile project sizes**

Run: `npm run test:e2e`  
Expected: all tests PASS with zero runtime errors and no horizontal overflow.

- [ ] **Step 5: Commit responsive/accessibility completion**

```powershell
git add public/app.js public/styles.css tests/e2e/support.mjs tests/e2e/live-session.desktop.spec.mjs tests/e2e/player.mobile.spec.mjs
git commit -m "Complete responsive quiz answer layouts"
```

---

### Task 10: Full verification, documentation, GitHub, Railway, and live audit

**Files:**
- Modify: `README.md:58-90`
- Modify: `PROJECT_LOG.md` (append the required dated task entry)

**Interfaces:**
- Consumes: all completed feature behavior.
- Produces: release evidence tied to the exact merged commit and Railway deployment ID.

- [ ] **Step 1: Update behavior and operations documentation**

Document `correctOptionIds`, array answer persistence, dynamic effective-duration scoring, `results -> leaderboard`, image-only media, and reconnect outcomes in `README.md`. Append to `PROJECT_LOG.md` with the required headings: What Was Implemented, Files Modified, Assumptions Made, Known Issues / Deferred, Suggested Next Steps.

- [ ] **Step 2: Run the complete local verification suite**

Run: `npm audit --omit=dev --audit-level=high`  
Expected: zero high/critical production vulnerabilities.

Run: `npm run check`  
Expected: all unit/integration tests and syntax checks PASS; only the documented local PostgreSQL skip is allowed when `TEST_DATABASE_URL` is absent.

Run: `npm run test:e2e`  
Expected: every desktop/mobile browser test PASS with zero captured runtime errors.

- [ ] **Step 3: Commit documentation and push the branch**

```powershell
git add README.md PROJECT_LOG.md
git commit -m "Document dynamic quiz result flow"
git push -u origin codex/dynamic-quiz-results
```

- [ ] **Step 4: Open a pull request and wait for every required check**

Run: `gh pr create --base main --head codex/dynamic-quiz-results --title "Add dynamic quiz answers and result flow" --body "## Summary`n- add 2-6 answer and multiple-correct quiz editing`n- add authoritative millisecond scoring and separate result phases`n- improve presenter, player, image, and responsive experiences`n`n## Verification`n- npm run check`n- npm run test:e2e"`  
Expected: PR URL returned; GitHub CI and CodeRabbit both PASS with no unresolved actionable review comments.

- [ ] **Step 5: Merge and deploy the exact main commit**

Run: `$prNumber = gh pr view --json number --jq '.number'; gh pr merge $prNumber --merge --delete-branch` followed by `git checkout main` and `git pull --ff-only origin main`.  
Expected: local `HEAD` equals `origin/main`.

Run: `railway up --detach --service pinboard-live`.  
Expected: the new Railway deployment reaches `SUCCESS` and the previous deployment is removed.

- [ ] **Step 6: Perform production API, log, and live-browser verification**

Verify on `https://pinboard-live-production.up.railway.app`:

- `/health` returns HTTP 200 with PostgreSQL healthy.
- Deployment logs contain zero application runtime errors.
- Editor visibly adds/removes 2–6 answers, maintains nearest correct answers, supports multiple correct toggles, and previews/removes one image.
- Presenter timer is prominent; Skip uses actual elapsed milliseconds; results show only the graph; Next shows the leaderboard.
- Single-answer player submits immediately; multi-answer player toggles exactly N and submits explicitly.
- Submitted players see stable waiting copy, then correct/partial/incorrect/timeout outcomes and accurate points.
- A controlled 1,000-point scenario verifies maximum, partial, late, Skip-adjusted, and zero-at-deadline awards.
- Desktop and mobile live screenshots confirm centered images, readable 2–6 layouts, correct markers, and no overflow.

- [ ] **Step 7: Record final deployment evidence**

Amend the dated `PROJECT_LOG.md` entry with the merged commit, PR URL, Railway deployment ID, CI result, test totals, and live audit outcome; commit and push the documentation-only evidence update, then redeploy that exact final `main` commit if needed so GitHub and Railway match.
