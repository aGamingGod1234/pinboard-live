import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ALLOWED_TOP_LEVEL_KEYS = new Set(["version", "loops", "effects"]);
const ALLOWED_TRACK_KEYS = new Set(["src", "volume"]);
const ALLOWED_EFFECT_KEYS = new Set(["src", "volume", "cooldownMs"]);
const PRIVATE_GENERATION_KEYS = new Set([
  "taskId",
  "conversionId",
  "audioUrl",
  "estimatedCost",
  "actualCost",
  "prompt",
  "sources"
]);

test("public audio manifest contains only runtime playback metadata", async () => {
  const manifestUrl = new URL("../../public/audio/game-audio.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  assert.deepEqual(
    Object.keys(manifest).sort(),
    [...ALLOWED_TOP_LEVEL_KEYS].sort()
  );
  assert.equal(containsPrivateGenerationKey(manifest), false);

  for (const track of Object.values(manifest.loops ?? {})) {
    assert.deepEqual(Object.keys(track).sort(), [...ALLOWED_TRACK_KEYS].sort());
    assertLocalAudioSource(track.src);
  }
  for (const effect of Object.values(manifest.effects ?? {})) {
    assert.deepEqual(Object.keys(effect).sort(), [...ALLOWED_EFFECT_KEYS].sort());
    assertLocalAudioSource(effect.src);
  }
});

function containsPrivateGenerationKey(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => (
    PRIVATE_GENERATION_KEYS.has(key) || containsPrivateGenerationKey(nested)
  ));
}

function assertLocalAudioSource(value) {
  assert.match(value, /^\/audio\/[a-z0-9-]+\.mp3$/);
}
