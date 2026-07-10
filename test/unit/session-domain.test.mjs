import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainError,
  endSession,
  recordAnswer,
  scoreCurrentQuestion,
  setPlayerPresence
} from "../../src/session-domain.mjs";

const NOW = 1_700_000_000_000;
const QUESTION_DURATION_SECONDS = 30;
const QUESTION_DURATION_MS = QUESTION_DURATION_SECONDS * 1_000;
const QUESTION_POINTS = 100;
const PLAYER_ONE_ID = "player-one";
const PLAYER_TWO_ID = "player-two";
const CORRECT_OPTION_ID = "option-correct";
const INCORRECT_OPTION_ID = "option-incorrect";

function createSession(overrides = {}) {
  const question = {
    id: "question-one",
    kind: "quiz",
    text: "Which option is correct?",
    points: QUESTION_POINTS,
    timerSeconds: QUESTION_DURATION_SECONDS,
    correctOptionId: CORRECT_OPTION_ID,
    options: [
      { id: CORRECT_OPTION_ID, text: "Correct" },
      { id: INCORRECT_OPTION_ID, text: "Incorrect" }
    ]
  };

  return {
    phase: "answering",
    currentQuestionIndex: 0,
    questions: [question],
    openedAt: NOW - 1_000,
    endedReason: null,
    players: new Map([
      [PLAYER_ONE_ID, { id: PLAYER_ONE_ID, nickname: "One", score: 250, connected: true, lastSeenAt: NOW - 500 }],
      [PLAYER_TWO_ID, { id: PLAYER_TWO_ID, nickname: "Two", score: 75, connected: true, lastSeenAt: NOW - 500 }]
    ]),
    answers: new Map(),
    scoredQuestionIndexes: new Set(),
    ...overrides
  };
}

test("recordAnswer rejects an answer at the authoritative deadline", () => {
  const session = createSession({ openedAt: NOW - QUESTION_DURATION_MS });

  assert.throws(
    () => recordAnswer(session, { playerId: PLAYER_ONE_ID, optionId: CORRECT_OPTION_ID, now: NOW }),
    (error) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.status, 409);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "ANSWER_CLOSED");
      return true;
    }
  );
  assert.equal(session.answers.size, 0);
});

test("recordAnswer records the first answer without mutating the source session", () => {
  const session = createSession();

  const result = recordAnswer(session, {
    playerId: PLAYER_ONE_ID,
    optionId: CORRECT_OPTION_ID,
    now: NOW
  });

  assert.notStrictEqual(result.session, session);
  assert.equal(session.answers.size, 0);
  assert.deepEqual(result.session.answers.get(PLAYER_ONE_ID), {
    optionId: CORRECT_OPTION_ID,
    answeredAt: NOW
  });
  assert.deepEqual(result.outcome, { accepted: true, duplicate: false });
});

test("recordAnswer returns an explicit duplicate outcome and preserves the first answer", () => {
  const first = recordAnswer(createSession(), {
    playerId: PLAYER_ONE_ID,
    optionId: CORRECT_OPTION_ID,
    now: NOW - 100
  });

  const duplicate = recordAnswer(first.session, {
    playerId: PLAYER_ONE_ID,
    optionId: INCORRECT_OPTION_ID,
    now: NOW
  });

  assert.strictEqual(duplicate.session, first.session);
  assert.deepEqual(duplicate.session.answers.get(PLAYER_ONE_ID), {
    optionId: CORRECT_OPTION_ID,
    answeredAt: NOW - 100
  });
  assert.deepEqual(duplicate.outcome, { accepted: false, duplicate: true });
});

test("endSession rejects ending an active round without explicit discard confirmation", () => {
  const session = createSession();

  assert.throws(
    () => endSession(session, { discardActiveRound: false }),
    (error) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "ACTIVE_ROUND");
      return true;
    }
  );
  assert.equal(session.phase, "answering");
});

test("endSession ends an active round only after discard is confirmed", () => {
  const answers = new Map([
    [PLAYER_ONE_ID, { optionId: CORRECT_OPTION_ID, answeredAt: NOW - 100 }]
  ]);
  const session = createSession({ answers });

  const ended = endSession(session, { discardActiveRound: true });

  assert.notStrictEqual(ended, session);
  assert.equal(session.phase, "answering");
  assert.equal(ended.phase, "ended");
  assert.equal(ended.endedReason, "host_ended");
  assert.equal(ended.openedAt, null);
  assert.strictEqual(ended.answers, answers);
  assert.strictEqual(ended.players, session.players);
});

test("setPlayerPresence marks a player offline without deleting durable game state", () => {
  const answers = new Map([
    [PLAYER_ONE_ID, { optionId: CORRECT_OPTION_ID, answeredAt: NOW - 100 }]
  ]);
  const session = createSession({ answers });

  const updated = setPlayerPresence(session, {
    playerId: PLAYER_ONE_ID,
    connected: false,
    now: NOW
  });

  assert.notStrictEqual(updated, session);
  assert.equal(updated.players.size, session.players.size);
  assert.equal(updated.players.get(PLAYER_ONE_ID).score, 250);
  assert.equal(updated.players.get(PLAYER_ONE_ID).connected, false);
  assert.equal(updated.players.get(PLAYER_ONE_ID).lastSeenAt, NOW);
  assert.equal(session.players.get(PLAYER_ONE_ID).connected, true);
  assert.strictEqual(updated.answers, answers);
  assert.deepEqual(updated.answers.get(PLAYER_ONE_ID), answers.get(PLAYER_ONE_ID));
});

test("scoreCurrentQuestion awards points exactly once", () => {
  const answers = new Map([
    [PLAYER_ONE_ID, { optionId: CORRECT_OPTION_ID, answeredAt: NOW - 100 }],
    [PLAYER_TWO_ID, { optionId: INCORRECT_OPTION_ID, answeredAt: NOW - 100 }]
  ]);
  const session = createSession({ answers });

  const scored = scoreCurrentQuestion(session);
  const scoredAgain = scoreCurrentQuestion(scored);

  assert.equal(session.players.get(PLAYER_ONE_ID).score, 250);
  assert.equal(scored.players.get(PLAYER_ONE_ID).score, 350);
  assert.equal(scored.players.get(PLAYER_TWO_ID).score, 75);
  assert.ok(scored.scoredQuestionIndexes.has(0));
  assert.strictEqual(scoredAgain, scored);
  assert.equal(scoredAgain.players.get(PLAYER_ONE_ID).score, 350);
});
