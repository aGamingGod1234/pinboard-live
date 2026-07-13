import assert from "node:assert/strict";
import test from "node:test";

import {
  MediaRequestGate,
  MediaRequestGateError
} from "../../src/media-request-gate.mjs";

const PRINCIPAL_A = "presenter-a";
const PRINCIPAL_B = "presenter-b";
const PRINCIPAL_C = "presenter-c";
const DEFAULT_TEST_WAIT_TIMEOUT_MS = 1_000;
const SHORT_WAIT_TIMEOUT_MS = 20;
const TEST_OPTIONS = Object.freeze({
  maxActive: 1,
  maxActivePerPrincipal: 1,
  maxQueued: 4,
  maxQueuedPerPrincipal: 2,
  defaultWaitTimeoutMs: DEFAULT_TEST_WAIT_TIMEOUT_MS
});

function createGate(overrides = {}) {
  return new MediaRequestGate({ ...TEST_OPTIONS, ...overrides });
}

async function assertGateError(promise, expectedCode) {
  await assert.rejects(
    promise,
    (error) => {
      assert.ok(error instanceof MediaRequestGateError);
      assert.equal(error.name, "MediaRequestGateError");
      assert.equal(error.code, expectedCode);
      return true;
    }
  );
}

test("MediaRequestGate enforces the global active limit", async () => {
  const gate = createGate({ maxActive: 2, maxActivePerPrincipal: 2 });
  const releaseFirst = await gate.acquire(PRINCIPAL_A);
  const releaseSecond = await gate.acquire(PRINCIPAL_A);
  const queued = gate.acquire(PRINCIPAL_B);

  assert.equal(gate.snapshot().active, 2);
  assert.deepEqual(gate.snapshot().queue, [PRINCIPAL_B]);

  releaseFirst();
  const releaseQueued = await queued;
  assert.equal(gate.snapshot().active, 2);

  releaseSecond();
  releaseQueued();
});

test("MediaRequestGate enforces the per-principal active limit", async () => {
  const gate = createGate({ maxActive: 2, maxActivePerPrincipal: 1 });
  const releaseFirstA = await gate.acquire(PRINCIPAL_A);
  const queuedA = gate.acquire(PRINCIPAL_A);
  const releaseB = await gate.acquire(PRINCIPAL_B);

  assert.deepEqual(gate.snapshot().principals, [
    { principal: PRINCIPAL_A, active: 1, queued: 1 },
    { principal: PRINCIPAL_B, active: 1, queued: 0 }
  ]);

  releaseFirstA();
  const releaseSecondA = await queuedA;
  releaseSecondA();
  releaseB();
});

test("MediaRequestGate rejects requests beyond the global queue bound", async () => {
  const gate = createGate({ maxQueued: 1, maxQueuedPerPrincipal: 1 });
  const releaseA = await gate.acquire(PRINCIPAL_A);
  const queuedB = gate.acquire(PRINCIPAL_B);

  await assertGateError(gate.acquire(PRINCIPAL_C), "QUEUE_FULL");
  assert.deepEqual(gate.snapshot().queue, [PRINCIPAL_B]);

  releaseA();
  const releaseB = await queuedB;
  releaseB();
});

test("MediaRequestGate rejects requests beyond a principal queue bound", async () => {
  const gate = createGate({ maxQueued: 3, maxQueuedPerPrincipal: 1 });
  const releaseA = await gate.acquire(PRINCIPAL_A);
  const queuedA = gate.acquire(PRINCIPAL_A);

  await assertGateError(gate.acquire(PRINCIPAL_A), "PRINCIPAL_QUEUE_FULL");
  assert.deepEqual(gate.snapshot().queue, [PRINCIPAL_A]);

  releaseA();
  const releaseQueuedA = await queuedA;
  releaseQueuedA();
});

test("MediaRequestGate drains eligible requests in FIFO order", async () => {
  const gate = createGate();
  const releaseBlocker = await gate.acquire(PRINCIPAL_C);
  const first = gate.acquire(PRINCIPAL_A);
  const second = gate.acquire(PRINCIPAL_B);

  releaseBlocker();
  const releaseFirst = await first;
  assert.deepEqual(gate.snapshot().queue, [PRINCIPAL_B]);

  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(gate.snapshot().queue, []);
  releaseSecond();
});

test("MediaRequestGate skips an ineligible queue head without blocking an eligible principal", async () => {
  const gate = createGate({ maxActive: 2, maxActivePerPrincipal: 1 });
  const releaseA = await gate.acquire(PRINCIPAL_A);
  const releaseB = await gate.acquire(PRINCIPAL_B);
  const queuedA = gate.acquire(PRINCIPAL_A);
  const queuedC = gate.acquire(PRINCIPAL_C);

  releaseB();
  const releaseC = await queuedC;
  assert.deepEqual(gate.snapshot().queue, [PRINCIPAL_A]);
  assert.deepEqual(gate.snapshot().principals, [
    { principal: PRINCIPAL_A, active: 1, queued: 1 },
    { principal: PRINCIPAL_C, active: 1, queued: 0 }
  ]);

  releaseA();
  const releaseQueuedA = await queuedA;
  releaseQueuedA();
  releaseC();
});

test("MediaRequestGate removes and rejects an aborted queued request", async () => {
  const gate = createGate();
  const controller = new AbortController();
  const releaseA = await gate.acquire(PRINCIPAL_A);
  const queuedB = gate.acquire(PRINCIPAL_B, { signal: controller.signal });

  controller.abort();

  await assertGateError(queuedB, "ABORTED");
  assert.equal(gate.snapshot().queued, 0);
  releaseA();
});

test("MediaRequestGate rejects a pre-aborted request before consuming capacity", async () => {
  const gate = createGate();
  const controller = new AbortController();
  controller.abort();

  await assertGateError(gate.acquire(PRINCIPAL_A, { signal: controller.signal }), "ABORTED");
  assert.equal(gate.snapshot().active, 0);
  assert.equal(gate.snapshot().queued, 0);
});

test("MediaRequestGate times out and removes a queued request", async () => {
  const gate = createGate({ defaultWaitTimeoutMs: SHORT_WAIT_TIMEOUT_MS });
  const releaseA = await gate.acquire(PRINCIPAL_A);

  await assertGateError(gate.acquire(PRINCIPAL_B), "WAIT_TIMEOUT");
  assert.equal(gate.snapshot().queued, 0);
  releaseA();
});

test("MediaRequestGate honors an acquire-specific queue wait timeout", async () => {
  const gate = createGate();
  const releaseA = await gate.acquire(PRINCIPAL_A);

  await assertGateError(
    gate.acquire(PRINCIPAL_B, { timeoutMs: SHORT_WAIT_TIMEOUT_MS }),
    "WAIT_TIMEOUT"
  );
  assert.equal(gate.snapshot().queued, 0);
  releaseA();
});

test("MediaRequestGate release functions are idempotent", async () => {
  const gate = createGate({ maxQueued: 2, maxQueuedPerPrincipal: 1 });
  const releaseA = await gate.acquire(PRINCIPAL_A);
  const queuedB = gate.acquire(PRINCIPAL_B);
  const queuedC = gate.acquire(PRINCIPAL_C);

  releaseA();
  const releaseB = await queuedB;
  releaseA();

  assert.equal(gate.snapshot().active, 1);
  assert.deepEqual(gate.snapshot().queue, [PRINCIPAL_C]);

  releaseB();
  const releaseC = await queuedC;
  releaseC();
});

test("MediaRequestGate exposes an immutable operational snapshot", async () => {
  const options = { ...TEST_OPTIONS, maxActive: 2 };
  const gate = new MediaRequestGate(options);
  const releaseA = await gate.acquire(PRINCIPAL_A);
  const releaseB = await gate.acquire(PRINCIPAL_B);
  const queuedA = gate.acquire(PRINCIPAL_A);

  const snapshot = gate.snapshot();
  assert.deepEqual(snapshot, {
    active: 2,
    queued: 1,
    limits: options,
    principals: [
      { principal: PRINCIPAL_A, active: 1, queued: 1 },
      { principal: PRINCIPAL_B, active: 1, queued: 0 }
    ],
    queue: [PRINCIPAL_A]
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.limits), true);
  assert.equal(Object.isFrozen(snapshot.principals), true);
  assert.equal(Object.isFrozen(snapshot.principals[0]), true);
  assert.equal(Object.isFrozen(snapshot.queue), true);
  assert.throws(() => snapshot.queue.push(PRINCIPAL_C), TypeError);

  releaseA();
  const releaseQueuedA = await queuedA;
  releaseQueuedA();
  releaseB();
});

test("MediaRequestGate validates configuration and acquire inputs", async () => {
  assert.throws(() => createGate({ maxActive: 0 }), RangeError);
  assert.throws(() => createGate({ maxActivePerPrincipal: 0 }), RangeError);
  assert.throws(() => createGate({ maxQueued: -1 }), RangeError);
  assert.throws(() => createGate({ maxQueuedPerPrincipal: -1 }), RangeError);
  assert.throws(() => createGate({ defaultWaitTimeoutMs: -1 }), RangeError);

  const gate = createGate();
  await assert.rejects(gate.acquire(""), TypeError);
  await assert.rejects(gate.acquire(PRINCIPAL_A, { timeoutMs: -1 }), RangeError);
  await assert.rejects(gate.acquire(PRINCIPAL_A, { signal: {} }), TypeError);
});
