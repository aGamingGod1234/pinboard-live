const UUID_BYTE_LENGTH = 16;
const UUID_VERSION_INDEX = 6;
const UUID_VARIANT_INDEX = 8;
const UUID_VERSION_MASK = 0x0f;
const UUID_VERSION_4 = 0x40;
const UUID_VARIANT_MASK = 0x3f;
const UUID_VARIANT_RFC_4122 = 0x80;
const PLAYER_ROLE = "player";
const RETRYABLE_RESUME_STATUSES = new Set([408, 425, 429]);
const SERVER_ERROR_STATUS_MIN = 500;
const SERVER_ERROR_STATUS_MAX = 599;

/**
 * Create a browser-safe UUID without falling back to weak randomness.
 *
 * @param {{ randomUUID?: () => string, getRandomValues?: (bytes: Uint8Array) => Uint8Array }} [cryptoSource]
 * @returns {string}
 */
export function createClientId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === "function") {
    try {
      const id = cryptoSource.randomUUID();
      if (typeof id === "string" && id.length > 0) {
        return id;
      }
    } catch {
      // In insecure contexts, getRandomValues can remain available when randomUUID is not.
    }
  }

  if (typeof cryptoSource?.getRandomValues !== "function") {
    throw new Error("Secure random number generation is unavailable.");
  }

  const bytes = new Uint8Array(UUID_BYTE_LENGTH);
  try {
    cryptoSource.getRandomValues(bytes);
  } catch (error) {
    throw new Error("Secure random number generation is unavailable.", { cause: error });
  }

  bytes[UUID_VERSION_INDEX] = (bytes[UUID_VERSION_INDEX] & UUID_VERSION_MASK) | UUID_VERSION_4;
  bytes[UUID_VARIANT_INDEX] = (bytes[UUID_VARIANT_INDEX] & UUID_VARIANT_MASK) | UUID_VARIANT_RFC_4122;
  return formatUuid(bytes);
}

/**
 * Coordinate revision-aware draft saves through one serialized save loop.
 *
 * @template Snapshot
 * @param {{
 *   createSnapshot: () => Snapshot,
 *   saveSnapshot: (request: { revision: number, snapshot: Snapshot }) => Promise<unknown>
 * }} dependencies
 * @returns {{
 *   markDirty: () => number,
 *   flush: () => Promise<{ revision: number, savedRevision: number, dirty: boolean, saving: boolean }>,
 *   getState: () => { revision: number, savedRevision: number, dirty: boolean, saving: boolean }
 * }}
 */
export function createDraftSaveCoordinator(dependencies) {
  if (typeof dependencies?.createSnapshot !== "function") {
    throw new TypeError("createSnapshot must be a function.");
  }
  if (typeof dependencies?.saveSnapshot !== "function") {
    throw new TypeError("saveSnapshot must be a function.");
  }

  let revision = 0;
  let savedRevision = 0;
  /** @type {Promise<void> | null} */
  let activeSave = null;

  function getState() {
    return {
      revision,
      savedRevision,
      dirty: savedRevision < revision,
      saving: activeSave !== null
    };
  }

  function markDirty() {
    if (revision >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Draft revision limit reached.");
    }
    revision += 1;
    return revision;
  }

  function beginSave() {
    const targetRevision = revision;
    const snapshot = dependencies.createSnapshot();
    let trackedSave;
    const saveOperation = Promise.resolve()
      .then(() => dependencies.saveSnapshot({ revision: targetRevision, snapshot }))
      .then(() => {
        savedRevision = Math.max(savedRevision, targetRevision);
      });

    trackedSave = saveOperation.finally(() => {
      if (activeSave === trackedSave) {
        activeSave = null;
      }
    });
    activeSave = trackedSave;
  }

  async function flush() {
    while (savedRevision < revision) {
      if (!activeSave) {
        beginSave();
      }
      await activeSave;
    }
    return getState();
  }

  return { markDirty, flush, getState };
}

/**
 * Decide whether a failed resume attempt is temporary enough to retain credentials.
 *
 * @param {number | { status?: number } | null | undefined} failure
 * @returns {boolean}
 */
export function shouldRetainResumeCredential(failure) {
  const status = getFailureStatus(failure);
  if (status === null || status === 0) {
    return true;
  }
  return RETRYABLE_RESUME_STATUSES.has(status)
    || (status >= SERVER_ERROR_STATUS_MIN && status <= SERVER_ERROR_STATUS_MAX);
}

/**
 * Keep the password form as a fallback only when Google sign-in is unavailable.
 *
 * @param {boolean} localAuthEnabled
 * @param {string} googleClientId
 * @returns {boolean}
 */
export function shouldShowLocalPresenterAuth(localAuthEnabled, googleClientId) {
  return localAuthEnabled === true && !googleClientId;
}

const QUIZ_OPTION_LABELS = ["Red", "Blue", "Gold", "Green", "Purple", "Teal"];

export function addQuizOption(question, createId) {
  if (question.kind !== "quiz") throw new TypeError("Only regular quiz answers can be added.");
  if (question.options.length >= 6) throw new RangeError("Quiz questions can have at most 6 answers.");
  const id = createId();
  return {
    ...question,
    options: [...question.options, {
      id,
      text: QUIZ_OPTION_LABELS[question.options.length]
    }]
  };
}

export function removeQuizOption(question, optionId) {
  if (question.kind !== "quiz") throw new TypeError("Only regular quiz answers can be removed.");
  if (question.options.length <= 2) throw new RangeError("Quiz questions need at least 2 answers.");
  const removedIndex = question.options.findIndex((option) => option.id === optionId);
  if (removedIndex < 0) return question;
  const options = question.options.filter((option) => option.id !== optionId);
  const correctOptionIds = question.correctOptionIds.filter((id) => id !== optionId);
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

export function toggleCorrectOption(question, optionId) {
  if (!question.options.some((option) => option.id === optionId)) return question;
  if (question.kind === "true_false") return { ...question, correctOptionIds: [optionId] };
  if (question.correctOptionIds.includes(optionId)) {
    if (question.correctOptionIds.length === 1) throw new RangeError("Quiz questions need at least 1 correct answer.");
    return { ...question, correctOptionIds: question.correctOptionIds.filter((id) => id !== optionId) };
  }
  return { ...question, correctOptionIds: [...question.correctOptionIds, optionId] };
}

export function togglePendingSelection(currentIds, optionId, limit) {
  if (currentIds.includes(optionId)) return currentIds.filter((id) => id !== optionId);
  if (currentIds.length >= limit) throw new RangeError(`Select ${limit} answers.`);
  return [...currentIds, optionId];
}

/**
 * Build a unique accessible name for a shape-only answer control.
 *
 * @param {{ index: number, tone: string, shape: string }} answer
 * @returns {string}
 */
export function createAnswerAccessibleName(answer) {
  if (!Number.isInteger(answer?.index) || answer.index < 0) {
    throw new RangeError("Answer index must be a non-negative integer.");
  }

  const tone = normalizeAccessibleToken(answer.tone, "Answer tone");
  const shape = normalizeAccessibleToken(answer.shape, "Answer shape");
  return `Option ${answer.index + 1}, ${tone} ${shape}`;
}

/**
 * Return true when a player snapshot can update in place without replacing its answer grid.
 *
 * @param {Record<string, unknown> | null | undefined} previousState
 * @param {Record<string, unknown> | null | undefined} nextState
 * @param {string} role
 * @returns {boolean}
 */
export function shouldPatchLiveState(previousState, nextState, role) {
  if (role !== PLAYER_ROLE || !previousState || !nextState) {
    return false;
  }
  if (!isNonEmptyString(previousState.pin) || previousState.pin !== nextState.pin) {
    return false;
  }
  if (!isNonEmptyString(previousState.phase) || previousState.phase !== nextState.phase) {
    return false;
  }

  const previousSelections = Array.isArray(previousState.selectedOptionIds)
    ? previousState.selectedOptionIds
    : [];
  const nextSelections = Array.isArray(nextState.selectedOptionIds)
    ? nextState.selectedOptionIds
    : [];
  if (
    previousSelections.length !== nextSelections.length
    || previousSelections.some((optionId, index) => optionId !== nextSelections[index])
  ) {
    return false;
  }

  const previousQuestionId = getCurrentQuestionId(previousState);
  const nextQuestionId = getCurrentQuestionId(nextState);
  return previousQuestionId !== null && previousQuestionId === nextQuestionId;
}

/**
 * Reject a delayed state event when a newer version of the same session is already rendered.
 *
 * @param {Record<string, unknown> | null | undefined} currentState
 * @param {Record<string, unknown> | null | undefined} nextState
 * @returns {boolean}
 */
export function shouldAcceptLiveState(currentState, nextState) {
  if (!nextState || typeof nextState !== "object") {
    return false;
  }
  if (!currentState || currentState.pin !== nextState.pin) {
    return true;
  }
  const currentVersion = Number(currentState.version);
  const nextVersion = Number(nextState.version);
  if (!Number.isSafeInteger(currentVersion) || !Number.isSafeInteger(nextVersion)) {
    return true;
  }
  return nextVersion >= currentVersion;
}

/** @param {Uint8Array} bytes */
function formatUuid(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {number | { status?: number } | null | undefined} failure */
function getFailureStatus(failure) {
  const value = typeof failure === "number" ? failure : failure?.status;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** @param {unknown} value @param {string} label */
function normalizeAccessibleToken(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim().replace(/\s+/g, " ");
}

/** @param {Record<string, unknown>} state */
function getCurrentQuestionId(state) {
  const question = state.currentQuestion;
  if (!question || typeof question !== "object") {
    return null;
  }
  const id = question.id;
  return isNonEmptyString(id) ? id : null;
}

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
