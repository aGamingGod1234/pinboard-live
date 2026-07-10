import assert from "node:assert/strict";
import test from "node:test";

import {
  addQuizOption,
  createAnswerAccessibleName,
  createClientId,
  createDraftSaveCoordinator,
  removeQuizOption,
  shouldAcceptLiveState,
  shouldShowLocalPresenterAuth,
  shouldPatchLiveState,
  shouldRetainResumeCredential,
  toggleCorrectOption,
  togglePendingSelection
} from "../../public/client-state.js";

const quizQuestion = {
  kind: "quiz",
  options: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, text: id.toUpperCase() })),
  correctOptionIds: ["b", "d"]
};

test("quiz option helpers enforce limits and promote the nearest correct answer", () => {
  const removed = removeQuizOption(quizQuestion, "b");
  assert.deepEqual(removed.options.map(({ id }) => id), ["a", "c", "d", "e", "f"]);
  assert.deepEqual(removed.correctOptionIds, ["d", "c"]);
  assert.throws(() => addQuizOption(quizQuestion, () => "g"), /at most 6/);
  assert.throws(() => removeQuizOption({ ...quizQuestion, options: quizQuestion.options.slice(0, 2), correctOptionIds: ["a"] }, "a"), /at least 2/);
});

test("added quiz options continue the six-color answer label theme", () => {
  const fourOptionQuestion = {
    ...quizQuestion,
    options: quizQuestion.options.slice(0, 4),
    correctOptionIds: ["a"]
  };
  const withPurple = addQuizOption(fourOptionQuestion, () => "e");
  const withTeal = addQuizOption(withPurple, () => "f");

  assert.equal(withPurple.options.at(-1).text, "Purple");
  assert.equal(withTeal.options.at(-1).text, "Teal");
});

test("correct toggles retain at least one correct answer", () => {
  assert.deepEqual(toggleCorrectOption(quizQuestion, "a").correctOptionIds, ["b", "d", "a"]);
  assert.deepEqual(toggleCorrectOption(quizQuestion, "b").correctOptionIds, ["d"]);
  assert.throws(() => toggleCorrectOption({ ...quizQuestion, correctOptionIds: ["b"] }, "b"), /at least 1/);
});

test("true or false questions always switch to exactly one correct answer", () => {
  const question = {
    kind: "true_false",
    options: quizQuestion.options.slice(0, 2),
    correctOptionIds: ["a"]
  };
  assert.deepEqual(toggleCorrectOption(question, "b").correctOptionIds, ["b"]);
});

test("pending multi-selection toggles choices without exceeding the limit", () => {
  assert.deepEqual(togglePendingSelection(["a"], "b", 2), ["a", "b"]);
  assert.deepEqual(togglePendingSelection(["a", "b"], "a", 2), ["b"]);
  assert.throws(() => togglePendingSelection(["a", "b"], "c", 2), /Select 2/);
});

test("createClientId uses randomUUID when it is available", () => {
  const expectedId = "1183ac8e-6a20-4e35-82ec-7bc612b71876";

  const id = createClientId({
    randomUUID: () => expectedId
  });

  assert.equal(id, expectedId);
});

test("createClientId securely falls back to RFC 4122 bytes", () => {
  const id = createClientId({
    randomUUID: () => {
      throw new Error("randomUUID is unavailable in this context");
    },
    getRandomValues: (bytes) => {
      bytes.set(Array.from({ length: bytes.length }, (_, index) => index));
      return bytes;
    }
  });

  assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("createClientId refuses an insecure fallback", () => {
  assert.throws(
    () => createClientId({}),
    /Secure random number generation is unavailable/
  );
});

test("draft save coordinator loops until the newest revision is persisted", async () => {
  let releaseFirstSave;
  let announceFirstSave;
  let draft = { title: "First revision" };
  const firstSaveStarted = new Promise((resolve) => {
    announceFirstSave = resolve;
  });
  const firstSaveGate = new Promise((resolve) => {
    releaseFirstSave = resolve;
  });
  const saves = [];
  const coordinator = createDraftSaveCoordinator({
    createSnapshot: () => ({ ...draft }),
    saveSnapshot: async (request) => {
      saves.push(request);
      if (saves.length === 1) {
        announceFirstSave();
        await firstSaveGate;
      }
    }
  });

  coordinator.markDirty();
  const flushPromise = coordinator.flush();
  await firstSaveStarted;

  draft = { title: "Newest revision" };
  coordinator.markDirty();
  releaseFirstSave();
  await flushPromise;

  assert.deepEqual(saves, [
    { revision: 1, snapshot: { title: "First revision" } },
    { revision: 2, snapshot: { title: "Newest revision" } }
  ]);
  assert.deepEqual(coordinator.getState(), {
    revision: 2,
    savedRevision: 2,
    dirty: false,
    saving: false
  });
});

test("draft save coordinator remains dirty after failure and can retry", async () => {
  let shouldFail = true;
  const coordinator = createDraftSaveCoordinator({
    createSnapshot: () => ({ title: "Retry me" }),
    saveSnapshot: async () => {
      if (shouldFail) {
        throw new Error("Save failed");
      }
    }
  });

  coordinator.markDirty();
  await assert.rejects(coordinator.flush(), /Save failed/);
  assert.deepEqual(coordinator.getState(), {
    revision: 1,
    savedRevision: 0,
    dirty: true,
    saving: false
  });

  shouldFail = false;
  await coordinator.flush();
  assert.equal(coordinator.getState().dirty, false);
});

test("retryable resume failures retain the saved credential", () => {
  for (const failure of [undefined, 0, 408, 425, 429, 500, 503, new TypeError("offline")]) {
    assert.equal(shouldRetainResumeCredential(failure), true, String(failure));
  }

  for (const status of [400, 401, 403, 404, 409, 410, 422]) {
    assert.equal(shouldRetainResumeCredential({ status }), false, String(status));
  }
});

test("Google sign-in replaces the visible local presenter form", () => {
  assert.equal(shouldShowLocalPresenterAuth(true, ""), true);
  assert.equal(shouldShowLocalPresenterAuth(true, "google-client-id"), false);
  assert.equal(shouldShowLocalPresenterAuth(false, ""), false);
});

test("answer accessible names distinguish shape-only controls", () => {
  assert.equal(
    createAnswerAccessibleName({ index: 0, tone: "red", shape: "triangle" }),
    "Option 1, red triangle"
  );
  assert.equal(
    createAnswerAccessibleName({ index: 1, tone: "blue", shape: "diamond" }),
    "Option 2, blue diamond"
  );
});

test("live player state is patched only when answer-grid identity is stable", () => {
  const previous = {
    pin: "123456",
    phase: "answering",
    currentQuestion: { id: "question-1" },
    selectedOptionIds: []
  };
  const next = {
    ...previous,
    playerCount: 2,
    selectedOptionIds: ["option-1"]
  };

  assert.equal(shouldPatchLiveState(previous, next, "player"), false);
  assert.equal(
    shouldPatchLiveState({ ...previous, selectedOptionIds: ["option-1"] }, next, "player"),
    true
  );
  assert.equal(shouldPatchLiveState(previous, { ...next, pin: "654321" }, "player"), false);
  assert.equal(shouldPatchLiveState(previous, { ...next, phase: "results" }, "player"), false);
  assert.equal(
    shouldPatchLiveState(previous, { ...next, currentQuestion: { id: "question-2" } }, "player"),
    false
  );
  assert.equal(shouldPatchLiveState(previous, next, "host"), false);
  assert.equal(shouldPatchLiveState(previous, { ...next, currentQuestion: null }, "player"), false);
});

test("delayed live state cannot replace a newer session version", () => {
  const current = { pin: "123456", version: 12 };
  assert.equal(shouldAcceptLiveState(current, { pin: "123456", version: 11 }), false);
  assert.equal(shouldAcceptLiveState(current, { pin: "123456", version: 12 }), true);
  assert.equal(shouldAcceptLiveState(current, { pin: "123456", version: 13 }), true);
  assert.equal(shouldAcceptLiveState(current, { pin: "654321", version: 1 }), true);
  assert.equal(shouldAcceptLiveState(null, { pin: "123456", version: 1 }), true);
});
