import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MUSICGPT_API_KEY = process.env.MUSICGPT_API_KEY ?? "";
const MUSICGPT_API_BASE = "https://api.musicgpt.com/api/public";
const MUSICGPT_MUSIC_AI_URL = `${MUSICGPT_API_BASE}/v2/MusicAI`;
const MUSICGPT_SOUND_URL = `${MUSICGPT_API_BASE}/v1/sound_generator`;
const MUSICGPT_BY_ID_URL = `${MUSICGPT_API_BASE}/v1/byId`;
const DEFAULT_BUDGET_USD = 20;
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const OUTPUT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");
const MANIFEST_PATH = path.join(OUTPUT_DIRECTORY, "game-audio.json");

const AUDIO_REQUESTS = [
  {
    key: "lobby",
    collection: "loops",
    kind: "music",
    fileName: "lobby-loop.mp3",
    src: "/audio/lobby-loop.mp3",
    title: "Lobby Loop",
    prompt: "Create a polished instrumental lobby loop for a live quiz game. Bright, welcoming, loopable, seamless, and cleanly mixed.",
    musicStyle: "Upbeat game-lobby synth-pop with bright plucks, soft pulse bass, and a confident but friendly bounce",
    outputLength: 60,
    trimSeconds: 60,
    volume: 0.86
  },
  {
    key: "question",
    collection: "loops",
    kind: "music",
    fileName: "question-loop.mp3",
    src: "/audio/question-loop.mp3",
    title: "Question Loop",
    prompt: "Create an energetic instrumental loop for the live-question phase of a quiz game. Driving, playful, loopable, and tension-building without being harsh.",
    musicStyle: "Punchy electronic game-show underscore with propulsive drums, elastic synth bass, and bright arpeggios",
    outputLength: 60,
    trimSeconds: 60,
    volume: 0.88
  },
  {
    key: "answerSubmit",
    collection: "effects",
    kind: "music",
    fileName: "answer-submit.mp3",
    src: "/audio/answer-submit.mp3",
    title: "Answer Submit",
    prompt: "Create a short instrumental quiz-game sound effect for submitting an answer. Crisp click, soft whoosh, subtle digital sparkle, immediate impact.",
    musicStyle: "Short UI confirmation sting with bright synth transients, minimal bass, and a polished digital snap",
    outputLength: 12,
    trimSeconds: 3,
    fadeOutSeconds: 0.3,
    volume: 0.9,
    cooldownMs: 700
  },
  {
    key: "answerAccepted",
    collection: "effects",
    kind: "music",
    fileName: "answer-accepted.mp3",
    src: "/audio/answer-accepted.mp3",
    title: "Answer Accepted",
    prompt: "Create a short celebratory confirmation cue for an answer being accepted. Warm success pop, tiny ascending flourish, clean game-show sheen.",
    musicStyle: "Bright success sting with a quick rising synth accent, soft chime tail, and a confident polished finish",
    outputLength: 12,
    trimSeconds: 3,
    fadeOutSeconds: 0.3,
    volume: 0.9,
    cooldownMs: 1_000
  },
  {
    key: "timerUrgency",
    collection: "effects",
    kind: "music",
    fileName: "timer-urgency.mp3",
    src: "/audio/timer-urgency.mp3",
    title: "Timer Urgency",
    prompt: "Create a tense countdown sting for a quiz timer reaching the danger zone. Ticking energy, rising pressure, and a sharp polished finish.",
    musicStyle: "Urgent countdown sting with tight ticking percussion, rising synth tension, and a clean dramatic hit",
    outputLength: 12,
    trimSeconds: 4,
    fadeOutSeconds: 0.35,
    volume: 0.88,
    cooldownMs: 6_000
  },
  {
    key: "leaderboardTransition",
    collection: "effects",
    kind: "music",
    fileName: "leaderboard-transition.mp3",
    src: "/audio/leaderboard-transition.mp3",
    title: "Leaderboard Transition",
    prompt: "Create a fast whoosh-and-sparkle transition cue for revealing the leaderboard in a quiz game.",
    musicStyle: "Fast transition effect with a polished whoosh, sparkling synth lift, and a crisp game-show sheen",
    outputLength: 12,
    trimSeconds: 3,
    fadeOutSeconds: 0.25,
    volume: 0.9,
    cooldownMs: 1_200
  },
  {
    key: "podiumReveal",
    collection: "effects",
    kind: "music",
    fileName: "podium-reveal.mp3",
    src: "/audio/podium-reveal.mp3",
    title: "Podium Reveal",
    prompt: "Create a triumphant reveal hit for the final podium. Celebratory rise, punchy finish, and a premium game-show feel.",
    musicStyle: "Triumphant reveal sting with bold brass-like synths, sparkling accents, and a satisfying final hit",
    outputLength: 12,
    trimSeconds: 4,
    fadeOutSeconds: 0.35,
    volume: 0.92,
    cooldownMs: 1_500
  },
  {
    key: "confettiCelebration",
    collection: "effects",
    kind: "music",
    fileName: "confetti-celebration.mp3",
    src: "/audio/confetti-celebration.mp3",
    title: "Confetti Celebration",
    prompt: "Create a bright confetti burst with sparkling party energy and a joyful celebratory finish.",
    musicStyle: "Party confetti burst with shimmering synth sprinkles, quick celebratory lift, and a clean festive tail",
    outputLength: 12,
    trimSeconds: 4,
    fadeOutSeconds: 0.35,
    volume: 0.92,
    cooldownMs: 4_000
  }
];

async function main() {
  if (!MUSICGPT_API_KEY) {
    throw new Error("MUSICGPT_API_KEY is required.");
  }

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const budgetUsd = normalizeBudget(process.env.MUSICGPT_BUDGET_USD, DEFAULT_BUDGET_USD);
  const manifest = {
    version: 1,
    loops: {},
    effects: {}
  };

  let estimatedSpendUsd = 0;
  let actualSpendUsd = 0;

  for (const request of AUDIO_REQUESTS) {
    const queue = await queueMusicRequest(request);

    const estimatedCost = toFiniteNumber(queue.credit_estimate);
    if (estimatedSpendUsd + estimatedCost > budgetUsd) {
      throw new Error(`Budget exceeded before generating ${request.key}: ${estimatedSpendUsd.toFixed(2)} + ${estimatedCost.toFixed(2)} > ${budgetUsd.toFixed(2)}`);
    }

    estimatedSpendUsd += estimatedCost;

    const conversionId = pickConversionId(queue, request.kind);
    const conversionType = request.kind === "music" ? "MUSIC_AI" : "SOUND_GENERATOR";
    const conversion = await waitForConversion(conversionType, conversionId);
    const audioUrl = extractAudioUrl(conversion, conversionId);
    if (!audioUrl) {
      throw new Error(`MusicGPT did not return an audio URL for ${request.key}.`);
    }

    const outputPath = path.join(OUTPUT_DIRECTORY, request.fileName);
    await downloadAndTrimAudio(audioUrl, outputPath, request.trimSeconds, request.fadeOutSeconds);

    const actualCost = toFiniteNumber(conversion.conversion_cost ?? conversion.cost ?? 0);
    actualSpendUsd += actualCost;

    addManifestEntry(manifest, request);

    console.log(`${request.key}: saved ${request.fileName} (${formatCurrency(estimatedCost)} estimated, ${formatCurrency(actualCost)} actual)`);
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`manifest: ${path.relative(process.cwd(), MANIFEST_PATH)}`);
  console.log(`estimated spend: ${formatCurrency(estimatedSpendUsd)}`);
  console.log(`actual spend: ${formatCurrency(actualSpendUsd)}`);
}

async function queueMusicRequest(request) {
  const response = await fetch(MUSICGPT_MUSIC_AI_URL, {
    method: "POST",
    headers: {
      Authorization: MUSICGPT_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      prompt: request.prompt,
      music_style: request.musicStyle,
      lyrics: "",
      title: request.title,
      make_instrumental: true,
      vocal_only: false,
      output_length: request.outputLength,
      generate_album_cover: false
    })
  });
  return parseQueueResponse(response, request.key);
}

async function parseQueueResponse(response, requestKey) {
  const payload = await safeJson(response);
  if (!response.ok) {
    throw new Error(`MusicGPT queue request for ${requestKey} failed with HTTP ${response.status}: ${describePayload(payload)}`);
  }
  if (payload?.success === false) {
    throw new Error(`MusicGPT queue request for ${requestKey} failed: ${describePayload(payload)}`);
  }
  return payload;
}

async function waitForConversion(conversionType, conversionId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastPayload = null;
  while (Date.now() <= deadline) {
    const response = await fetch(`${MUSICGPT_BY_ID_URL}?${new URLSearchParams({
      conversionType,
      conversion_id: conversionId
    })}`, {
      headers: { Authorization: MUSICGPT_API_KEY }
    });
    const payload = await safeJson(response);
    lastPayload = payload;
    if (!response.ok) {
      throw new Error(`MusicGPT byId lookup failed for ${conversionId} with HTTP ${response.status}: ${describePayload(payload)}`);
    }
    if (payload?.success === false) {
      throw new Error(`MusicGPT byId lookup failed for ${conversionId}: ${describePayload(payload)}`);
    }

    const conversion = payload?.conversion ?? payload ?? {};
    if (isConversionReady(conversion, conversionId)) {
      return conversion;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for MusicGPT conversion ${conversionId}: ${describePayload(lastPayload)}`);
}

function isConversionReady(conversion, requestedConversionId = "") {
  if (!conversion || typeof conversion !== "object") {
    return false;
  }
  const status = String(conversion.status ?? "").toUpperCase();
  return Boolean(extractAudioUrl(conversion, requestedConversionId)) || status === "COMPLETED" || status === "DONE" || status === "SUCCESS";
}

function extractAudioUrl(conversion, requestedConversionId = "") {
  if (!conversion || typeof conversion !== "object") {
    return "";
  }

  const suffix = getConversionSuffix(conversion, requestedConversionId);
  const candidates = suffix
    ? [
        conversion[`conversion_path_${suffix}`],
        conversion[`output_path_${suffix}`],
        conversion[`audio_url_${suffix}`],
        conversion[`output_file_path_${suffix}`],
        conversion[`conversion_path_wav_${suffix}`]
      ]
    : [];
  candidates.push(
    conversion.audio_url,
    conversion.output_file_path,
    conversion.output_path,
    conversion.conversion_path,
    conversion.url,
    conversion.conversion_path_1,
    conversion.conversion_path_2,
    conversion.output_path_1,
    conversion.output_path_2,
    conversion.audio_url_1,
    conversion.audio_url_2,
    conversion.conversion_path_wav_1,
    conversion.conversion_path_wav_2
  );
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  const maps = [conversion.conversion_paths, conversion.conversion_paths_wav];
  for (const map of maps) {
    if (!map || typeof map !== "object") {
      continue;
    }
    for (const value of Object.values(map)) {
      if (typeof value === "string" && value) {
        return value;
      }
    }
  }

  return "";
}

function getConversionSuffix(conversion, requestedConversionId) {
  if (typeof requestedConversionId === "string" && requestedConversionId) {
    if (conversion.conversion_id_1 === requestedConversionId) {
      return "1";
    }
    if (conversion.conversion_id_2 === requestedConversionId) {
      return "2";
    }
  }
  if (typeof conversion.conversion_id_1 === "string" && conversion.conversion_id_1) {
    return "1";
  }
  if (typeof conversion.conversion_id_2 === "string" && conversion.conversion_id_2) {
    return "2";
  }
  return "";
}

function pickConversionId(queue, kind) {
  void kind;
  return queue.conversion_id_1 ?? queue.conversion_id_2 ?? queue.conversion_id ?? queue.task_id ?? "";
}

async function downloadAndTrimAudio(url, destination, trimSeconds, fadeOutSeconds = 0) {
  const temporaryPath = `${destination}.download.mp3`;
  await downloadAudio(url, temporaryPath);
  if (Number.isFinite(Number(trimSeconds)) && Number(trimSeconds) > 0) {
    await trimAudioFile(temporaryPath, destination, Number(trimSeconds), Number(fadeOutSeconds) > 0 ? Number(fadeOutSeconds) : 0);
    await removeFileIfExists(temporaryPath);
    return;
  }
  await moveFile(temporaryPath, destination);
}

async function downloadAudio(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download audio from ${url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
}

async function trimAudioFile(source, destination, trimSeconds, fadeOutSeconds = 0) {
  const { spawn } = await import("node:child_process");
  const args = ["-y", "-i", source, "-t", String(trimSeconds)];
  const fadeDuration = Math.min(Number(fadeOutSeconds) || 0, Math.max(0, trimSeconds));
  if (fadeDuration > 0 && trimSeconds > fadeDuration) {
    args.push("-af", `afade=t=out:st=${Math.max(0, trimSeconds - fadeDuration)}:d=${fadeDuration}`);
  }
  args.push("-c:a", "libmp3lame", "-q:a", "2", destination);
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}.`));
    });
  });
}

async function removeFileIfExists(filePath) {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function moveFile(source, destination) {
  const { rename } = await import("node:fs/promises");
  await rename(source, destination);
}

function addManifestEntry(manifest, request) {
  const entry = {
    src: request.src,
    volume: request.volume
  };

  if (request.collection === "loops") {
    manifest.loops[request.key] = entry;
  } else {
    entry.cooldownMs = request.cooldownMs;
    manifest.effects[request.key] = entry;
  }
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function describePayload(payload) {
  if (typeof payload?.message === "string" && payload.message) {
    return payload.message;
  }
  if (typeof payload?.error === "string" && payload.error) {
    return payload.error;
  }
  if (typeof payload?.raw === "string" && payload.raw) {
    return payload.raw;
  }
  return JSON.stringify(payload ?? {});
}

function normalizeBudget(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundCurrency(value) {
  return Math.round(toFiniteNumber(value) * 100) / 100;
}

function formatCurrency(value) {
  return `$${roundCurrency(value).toFixed(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
