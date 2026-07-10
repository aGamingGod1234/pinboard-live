const HTTP_CONFLICT = 409;
const HTTP_BAD_REQUEST = 400;
const MILLISECONDS_PER_SECOND = 1_000;
const HOST_ENDED_REASON = "host_ended";
const ANSWER_CLOSED_CODE = "ANSWER_CLOSED";
const ACTIVE_ROUND_CODE = "ACTIVE_ROUND";
const ANSWER_CLOSED_MESSAGE = "Answers are closed for this question.";
const INVALID_SELECTION_CODE = "INVALID_SELECTION";
const ACTIVE_ROUND_MESSAGE = "The active round must be revealed or explicitly discarded before ending.";
const ACTIVE_ROUND_PHASES = new Set(["question", "answering"]);
const SCORED_QUESTION_KINDS = new Set(["quiz", "true_false"]);
const ACCEPTED_OUTCOME = Object.freeze({ accepted: true, duplicate: false });
const DUPLICATE_OUTCOME = Object.freeze({ accepted: false, duplicate: true });

export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function getCurrentQuestion(session) {
  return session.questions[session.currentQuestionIndex] ?? null;
}

function isAnswerDeadlineReached(session, question, now) {
  if (!Number.isFinite(session.openedAt) || !Number.isFinite(question?.timerSeconds)) {
    return false;
  }

  const deadline = session.openedAt + question.timerSeconds * MILLISECONDS_PER_SECOND;
  return now >= deadline;
}

function getCorrectOptionIds(question) {
  if (Array.isArray(question?.correctOptionIds)) {
    return question.correctOptionIds;
  }
  return typeof question?.correctOptionId === "string" ? [question.correctOptionId] : [];
}

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
  const timeValue = Math.ceil(Number(questionPoints) * Math.max(0, 1 - elapsed / duration));
  const correctIds = new Set(correctOptionIds);
  if (correctIds.size === 0) {
    throw new TypeError("At least one correct option is required.");
  }
  const correctlySelected = selectedOptionIds.filter((id) => correctIds.has(id)).length;
  const awardedPoints = Math.ceil(timeValue * correctlySelected / correctIds.size);
  const outcome = correctlySelected === correctIds.size
    ? "correct"
    : correctlySelected > 0 ? "partial" : "incorrect";
  return { timeValue, awardedPoints, correctlySelected, outcome };
}

export function recordAnswer(session, { playerId, selectedOptionIds, optionId, now }) {
  const question = getCurrentQuestion(session);
  if (!question || !ACTIVE_ROUND_PHASES.has(session.phase) || isAnswerDeadlineReached(session, question, now)) {
    throw new DomainError(HTTP_CONFLICT, ANSWER_CLOSED_CODE, ANSWER_CLOSED_MESSAGE);
  }

  if (session.answers.has(playerId)) {
    return { session, outcome: DUPLICATE_OUTCOME };
  }

  const selections = Array.isArray(selectedOptionIds) ? selectedOptionIds : [optionId].filter(Boolean);
  const uniqueSelections = [...new Set(selections)];
  const validIds = new Set(question.options.map((option) => option.id));
  const expectedCount = getCorrectOptionIds(question).length;
  if (uniqueSelections.length !== expectedCount || uniqueSelections.some((id) => !validIds.has(id))) {
    throw new DomainError(
      HTTP_BAD_REQUEST,
      INVALID_SELECTION_CODE,
      `Select exactly ${expectedCount} answer${expectedCount === 1 ? "" : "s"}.`
    );
  }

  const answers = new Map(session.answers);
  answers.set(playerId, { selectedOptionIds: uniqueSelections, answeredAt: now });

  return {
    session: { ...session, answers },
    outcome: ACCEPTED_OUTCOME
  };
}

export function endSession(session, { discardActiveRound = false } = {}) {
  if (ACTIVE_ROUND_PHASES.has(session.phase) && !discardActiveRound) {
    throw new DomainError(HTTP_CONFLICT, ACTIVE_ROUND_CODE, ACTIVE_ROUND_MESSAGE);
  }

  if (session.phase === "ended") {
    return session;
  }

  return {
    ...session,
    phase: "ended",
    endedReason: HOST_ENDED_REASON,
    openedAt: null
  };
}

export function setPlayerPresence(session, { playerId, connected, now }) {
  const player = session.players.get(playerId);
  if (!player) {
    return session;
  }

  const players = new Map(session.players);
  players.set(playerId, {
    ...player,
    connected,
    lastSeenAt: now
  });

  return { ...session, players };
}

export function scoreCurrentQuestion(session) {
  const questionIndex = session.currentQuestionIndex;
  const question = getCurrentQuestion(session);
  if (!question || !SCORED_QUESTION_KINDS.has(question.kind) || session.scoredQuestionIndexes.has(questionIndex)) {
    return session;
  }

  const players = new Map(session.players);
  const correctOptionIds = getCorrectOptionIds(question);
  const effectiveDurationMs = Number.isFinite(session.effectiveDurationMs)
    ? session.effectiveDurationMs
    : question.timerSeconds * MILLISECONDS_PER_SECOND;
  for (const [playerId, answer] of session.answers) {
    const player = players.get(playerId);
    if (player) {
      const selectedOptionIds = Array.isArray(answer.selectedOptionIds)
        ? answer.selectedOptionIds
        : [answer.optionId].filter(Boolean);
      const award = calculateQuestionAward({
        questionPoints: question.points,
        openedAt: session.openedAt,
        submittedAt: answer.answeredAt,
        effectiveDurationMs,
        selectedOptionIds,
        correctOptionIds
      });
      players.set(playerId, { ...player, score: player.score + award.awardedPoints });
    }
  }

  const scoredQuestionIndexes = new Set(session.scoredQuestionIndexes);
  scoredQuestionIndexes.add(questionIndex);

  return { ...session, players, scoredQuestionIndexes };
}
