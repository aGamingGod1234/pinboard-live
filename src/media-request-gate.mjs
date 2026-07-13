const DEFAULT_MAX_ACTIVE = 4;
const DEFAULT_MAX_ACTIVE_PER_PRINCIPAL = 1;
const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_MAX_QUEUED_PER_PRINCIPAL = 4;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export const MEDIA_REQUEST_GATE_ERROR_CODES = Object.freeze({
  QUEUE_FULL: "QUEUE_FULL",
  PRINCIPAL_QUEUE_FULL: "PRINCIPAL_QUEUE_FULL",
  WAIT_TIMEOUT: "WAIT_TIMEOUT",
  ABORTED: "ABORTED"
});

const ERROR_MESSAGES = Object.freeze({
  [MEDIA_REQUEST_GATE_ERROR_CODES.QUEUE_FULL]: "The media request queue is full.",
  [MEDIA_REQUEST_GATE_ERROR_CODES.PRINCIPAL_QUEUE_FULL]: "The principal media request queue is full.",
  [MEDIA_REQUEST_GATE_ERROR_CODES.WAIT_TIMEOUT]: "The media request timed out while waiting for capacity.",
  [MEDIA_REQUEST_GATE_ERROR_CODES.ABORTED]: "The media request was aborted while waiting for capacity."
});

export const DEFAULT_MEDIA_REQUEST_GATE_OPTIONS = Object.freeze({
  maxActive: DEFAULT_MAX_ACTIVE,
  maxActivePerPrincipal: DEFAULT_MAX_ACTIVE_PER_PRINCIPAL,
  maxQueued: DEFAULT_MAX_QUEUED,
  maxQueuedPerPrincipal: DEFAULT_MAX_QUEUED_PER_PRINCIPAL,
  defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS
});

/**
 * @typedef {"QUEUE_FULL" | "PRINCIPAL_QUEUE_FULL" | "WAIT_TIMEOUT" | "ABORTED"} MediaRequestGateErrorCode
 */

/**
 * @typedef {object} MediaRequestGateOptions
 * @property {number} [maxActive]
 * @property {number} [maxActivePerPrincipal]
 * @property {number} [maxQueued]
 * @property {number} [maxQueuedPerPrincipal]
 * @property {number} [defaultWaitTimeoutMs]
 */

/**
 * @typedef {object} MediaRequestAcquireOptions
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 */

/** @typedef {() => void} MediaRequestRelease */

/**
 * @typedef {object} QueueEntry
 * @property {string} principal
 * @property {(release: MediaRequestRelease) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {AbortSignal | undefined} signal
 * @property {(() => void) | null} abortListener
 * @property {ReturnType<typeof setTimeout> | null} timeout
 */

export class MediaRequestGateError extends Error {
  /** @param {MediaRequestGateErrorCode} code */
  constructor(code) {
    super(messageForErrorCode(code));
    this.name = "MediaRequestGateError";
    this.code = code;
    Error.captureStackTrace?.(this, MediaRequestGateError);
  }
}

export class MediaRequestGate {
  #limits;
  #active = 0;
  #activeByPrincipal = new Map();
  #queuedByPrincipal = new Map();
  /** @type {QueueEntry[]} */
  #queue = [];

  /** @param {MediaRequestGateOptions} [options] */
  constructor(options = {}) {
    this.#limits = normalizeOptions(options);
  }

  /**
   * Acquires capacity for a media request.
   *
   * @param {string} principal
   * @param {MediaRequestAcquireOptions} [options]
   * @returns {Promise<MediaRequestRelease>}
   */
  async acquire(principal, options = {}) {
    const safePrincipal = assertPrincipal(principal);
    const { signal, timeoutMs } = normalizeAcquireOptions(options, this.#limits.defaultWaitTimeoutMs);

    if (signal?.aborted) {
      throw createGateError(MEDIA_REQUEST_GATE_ERROR_CODES.ABORTED);
    }

    if (this.#canGrant(safePrincipal)) {
      return this.#grant(safePrincipal);
    }

    this.#assertQueueCapacity(safePrincipal);
    return this.#enqueue(safePrincipal, signal, timeoutMs);
  }

  /**
   * Returns a deeply immutable point-in-time view of gate utilization.
   *
   * @returns {{
   *   active: number,
   *   queued: number,
   *   limits: Readonly<Required<MediaRequestGateOptions>>,
   *   principals: ReadonlyArray<Readonly<{ principal: string, active: number, queued: number }>>,
   *   queue: ReadonlyArray<string>
   * }}
   */
  snapshot() {
    const principalNames = new Set([
      ...this.#activeByPrincipal.keys(),
      ...this.#queuedByPrincipal.keys()
    ]);
    const principals = [...principalNames].map((principal) => Object.freeze({
      principal,
      active: countFor(this.#activeByPrincipal, principal),
      queued: countFor(this.#queuedByPrincipal, principal)
    }));

    return Object.freeze({
      active: this.#active,
      queued: this.#queue.length,
      limits: Object.freeze({ ...this.#limits }),
      principals: Object.freeze(principals),
      queue: Object.freeze(this.#queue.map((entry) => entry.principal))
    });
  }

  #canGrant(principal) {
    return this.#active < this.#limits.maxActive
      && countFor(this.#activeByPrincipal, principal) < this.#limits.maxActivePerPrincipal;
  }

  #assertQueueCapacity(principal) {
    if (countFor(this.#queuedByPrincipal, principal) >= this.#limits.maxQueuedPerPrincipal) {
      throw createGateError(MEDIA_REQUEST_GATE_ERROR_CODES.PRINCIPAL_QUEUE_FULL);
    }
    if (this.#queue.length >= this.#limits.maxQueued) {
      throw createGateError(MEDIA_REQUEST_GATE_ERROR_CODES.QUEUE_FULL);
    }
  }

  #grant(principal) {
    this.#active += 1;
    incrementCount(this.#activeByPrincipal, principal);
    return this.#createRelease(principal);
  }

  #createRelease(principal) {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active -= 1;
      decrementCount(this.#activeByPrincipal, principal);
      this.#drainQueue();
    };
  }

  #enqueue(principal, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      /** @type {QueueEntry} */
      const entry = {
        principal,
        resolve,
        reject,
        signal,
        abortListener: null,
        timeout: null
      };

      this.#queue.push(entry);
      incrementCount(this.#queuedByPrincipal, principal);
      this.#attachCancellation(entry, timeoutMs);
    });
  }

  #attachCancellation(entry, timeoutMs) {
    if (entry.signal) {
      entry.abortListener = () => {
        this.#rejectQueuedEntry(entry, MEDIA_REQUEST_GATE_ERROR_CODES.ABORTED);
      };
      entry.signal.addEventListener("abort", entry.abortListener, { once: true });
    }

    entry.timeout = setTimeout(() => {
      this.#rejectQueuedEntry(entry, MEDIA_REQUEST_GATE_ERROR_CODES.WAIT_TIMEOUT);
    }, timeoutMs);
    entry.timeout.unref?.();
  }

  #rejectQueuedEntry(entry, code) {
    const index = this.#queue.indexOf(entry);
    if (index < 0) {
      return;
    }

    this.#removeQueuedEntry(index);
    this.#cleanUpEntry(entry);
    entry.reject(createGateError(code));
    this.#drainQueue();
  }

  #removeQueuedEntry(index) {
    const [entry] = this.#queue.splice(index, 1);
    decrementCount(this.#queuedByPrincipal, entry.principal);
    return entry;
  }

  #cleanUpEntry(entry) {
    if (entry.timeout !== null) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
    }
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = null;
    }
  }

  #drainQueue() {
    while (this.#active < this.#limits.maxActive) {
      const nextIndex = this.#queue.findIndex((entry) => this.#canGrant(entry.principal));
      if (nextIndex < 0) {
        return;
      }

      const entry = this.#removeQueuedEntry(nextIndex);
      this.#cleanUpEntry(entry);
      entry.resolve(this.#grant(entry.principal));
    }
  }
}

function normalizeOptions(options) {
  if (!isPlainOptionsObject(options)) {
    throw new TypeError("MediaRequestGate options must be an object.");
  }

  const merged = { ...DEFAULT_MEDIA_REQUEST_GATE_OPTIONS, ...options };
  return Object.freeze({
    maxActive: assertPositiveSafeInteger(merged.maxActive, "maxActive"),
    maxActivePerPrincipal: assertPositiveSafeInteger(merged.maxActivePerPrincipal, "maxActivePerPrincipal"),
    maxQueued: assertNonNegativeSafeInteger(merged.maxQueued, "maxQueued"),
    maxQueuedPerPrincipal: assertNonNegativeSafeInteger(
      merged.maxQueuedPerPrincipal,
      "maxQueuedPerPrincipal"
    ),
    defaultWaitTimeoutMs: assertNonNegativeSafeInteger(
      merged.defaultWaitTimeoutMs,
      "defaultWaitTimeoutMs"
    )
  });
}

function normalizeAcquireOptions(options, defaultWaitTimeoutMs) {
  if (!isPlainOptionsObject(options)) {
    throw new TypeError("Acquire options must be an object.");
  }

  const signal = assertAbortSignal(options.signal);
  const timeoutMs = options.timeoutMs === undefined
    ? defaultWaitTimeoutMs
    : assertNonNegativeSafeInteger(options.timeoutMs, "timeoutMs");
  return { signal, timeoutMs };
}

function isPlainOptionsObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPrincipal(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("principal must be a non-empty string.");
  }
  return value;
}

function assertAbortSignal(signal) {
  if (signal === undefined) {
    return undefined;
  }
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal.");
  }
  return signal;
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function countFor(counts, principal) {
  return counts.get(principal) ?? 0;
}

function incrementCount(counts, principal) {
  counts.set(principal, countFor(counts, principal) + 1);
}

function decrementCount(counts, principal) {
  const nextCount = countFor(counts, principal) - 1;
  if (nextCount === 0) {
    counts.delete(principal);
    return;
  }
  counts.set(principal, nextCount);
}

function createGateError(code) {
  return new MediaRequestGateError(code);
}

function messageForErrorCode(code) {
  const message = ERROR_MESSAGES[code];
  if (!message) {
    throw new TypeError("Unknown media request gate error code.");
  }
  return message;
}
