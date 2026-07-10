const STRICT_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTENT_LENGTH_PATTERN = /^\d+$/;
const BASE64_DATA_URL_PATTERN = /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/;
const CSP_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const PLAYER_ACTION_PATH_PATTERN = /^\/api\/sessions\/\d{6}\/(?:join|resume|answer|leave)$/;
const PRESENTATION_ITEM_PATH_PATTERN = /^\/api\/presentations\/([0-9a-f-]{36})$/;
const ALLOWED_MEDIA_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm"
]);
const MP4_BRANDS = new Set(["avc1", "iso2", "isom", "m4v ", "mp41", "mp42"]);
const MAX_LIMITER_KEY_LENGTH = 256;
const MEDIA_SNIFF_BYTES = 4096;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
const DEFAULT_REFILL_TOKENS = 1;
const DEFAULT_REFILL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_LIMITER_ENTRIES = 10_000;
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;

export const DEFAULT_BODY_LIMITS = Object.freeze({
  AUTH: 16 * 1024,
  PLAYER_ACTION: 8 * 1024,
  PRESENTATION: 1024 * 1024
});

export function isStrictStableId(value) {
  return typeof value === "string" && STRICT_UUID_V4_PATTERN.test(value);
}

export function bodyLimitForRoute(method, pathname, options = {}) {
  const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "";
  const normalizedPathname = typeof pathname === "string" ? pathname : "";

  if (normalizedMethod === "POST" && (normalizedPathname === "/api/auth" || normalizedPathname === "/api/auth/google")) {
    return DEFAULT_BODY_LIMITS.AUTH;
  }

  if (normalizedMethod === "POST" && PLAYER_ACTION_PATH_PATTERN.test(normalizedPathname)) {
    return DEFAULT_BODY_LIMITS.PLAYER_ACTION;
  }

  if (
    (normalizedMethod === "POST" && (normalizedPathname === "/api/presentations" || normalizedPathname === "/api/sessions"))
    || (normalizedMethod === "PUT" && isPresentationItemPath(normalizedPathname))
  ) {
    return DEFAULT_BODY_LIMITS.PRESENTATION;
  }

  if (normalizedMethod === "POST" && normalizedPathname === "/api/media" && options.mediaLimitBytes !== undefined) {
    return assertPositiveSafeInteger(options.mediaLimitBytes, "mediaLimitBytes");
  }

  return null;
}

export function validateContentLength(headerValue, limitBytes) {
  const safeLimitBytes = assertPositiveSafeInteger(limitBytes, "limitBytes");

  if (headerValue === undefined || headerValue === null) {
    return { ok: true, contentLength: null, limitBytes: safeLimitBytes };
  }

  if (typeof headerValue !== "string" || !CONTENT_LENGTH_PATTERN.test(headerValue)) {
    return invalidContentLength(safeLimitBytes);
  }

  const parsedLength = BigInt(headerValue);
  if (parsedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    return invalidContentLength(safeLimitBytes);
  }

  return bodyLengthResult(Number(parsedLength), safeLimitBytes, "CONTENT_LENGTH_EXCEEDED");
}

export function validateBodyByteLength(contentLength, limitBytes) {
  const safeLimitBytes = assertPositiveSafeInteger(limitBytes, "limitBytes");
  const safeContentLength = assertNonNegativeSafeInteger(contentLength, "contentLength");

  return bodyLengthResult(safeContentLength, safeLimitBytes, "BODY_LIMIT_EXCEEDED");
}

function bodyLengthResult(contentLength, limitBytes, exceededCode) {
  if (contentLength > limitBytes) {
    return {
      ok: false,
      statusCode: HTTP_PAYLOAD_TOO_LARGE,
      code: exceededCode,
      contentLength,
      limitBytes
    };
  }

  return { ok: true, contentLength, limitBytes };
}

export function detectMediaMimeType(value) {
  const bytes = toBuffer(value);
  if (!bytes) {
    return null;
  }

  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) {
    return "image/gif";
  }
  if (startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  if (asciiAt(bytes, 4, 4) === "ftyp" && MP4_BRANDS.has(asciiAt(bytes, 8, 4).toLowerCase())) {
    return "video/mp4";
  }
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && bytes.subarray(0, MEDIA_SNIFF_BYTES).includes(Buffer.from("webm"))) {
    return "video/webm";
  }
  return null;
}

export function validateMediaDataUrl({ dataUrl, declaredMimeType, maxBytes }) {
  const safeMaxBytes = assertPositiveSafeInteger(maxBytes, "maxBytes");
  const normalizedDeclaredType = normalizeMimeType(declaredMimeType);

  if (!ALLOWED_MEDIA_MIME_TYPES.has(normalizedDeclaredType)) {
    return mediaError(HTTP_UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_MEDIA_TYPE");
  }

  if (typeof dataUrl !== "string") {
    return mediaError(HTTP_BAD_REQUEST, "INVALID_MEDIA_DATA_URL");
  }

  const match = dataUrl.match(BASE64_DATA_URL_PATTERN);
  if (!match || match[2].length % 4 !== 0) {
    return mediaError(HTTP_BAD_REQUEST, "INVALID_MEDIA_DATA_URL");
  }

  const dataUrlMimeType = normalizeMimeType(match[1]);
  if (!ALLOWED_MEDIA_MIME_TYPES.has(dataUrlMimeType)) {
    return mediaError(HTTP_UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_MEDIA_TYPE");
  }
  if (dataUrlMimeType !== normalizedDeclaredType) {
    return {
      ...mediaError(HTTP_UNSUPPORTED_MEDIA_TYPE, "MEDIA_TYPE_MISMATCH"),
      declaredMimeType: normalizedDeclaredType,
      dataUrlMimeType
    };
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== match[2]) {
    return mediaError(HTTP_BAD_REQUEST, "INVALID_MEDIA_DATA_URL");
  }
  if (bytes.length > safeMaxBytes) {
    return {
      ...mediaError(HTTP_PAYLOAD_TOO_LARGE, "MEDIA_TOO_LARGE"),
      sizeBytes: bytes.length,
      limitBytes: safeMaxBytes
    };
  }

  const detectedMimeType = detectMediaMimeType(bytes);
  if (detectedMimeType !== normalizedDeclaredType) {
    return {
      ...mediaError(HTTP_UNSUPPORTED_MEDIA_TYPE, "MEDIA_SIGNATURE_MISMATCH"),
      declaredMimeType: normalizedDeclaredType,
      detectedMimeType
    };
  }

  return {
    ok: true,
    mimeType: detectedMimeType,
    sizeBytes: bytes.length,
    bytes
  };
}

export function createSecurityHeaders({ includeGoogleIdentity = true, scriptNonce } = {}) {
  const csp = buildContentSecurityPolicy({ includeGoogleIdentity, scriptNonce });
  return Object.freeze({
    "Content-Security-Policy": csp,
    "Cross-Origin-Opener-Policy": includeGoogleIdentity ? "same-origin-allow-popups" : "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-DNS-Prefetch-Control": "off",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "0"
  });
}

function buildContentSecurityPolicy({ includeGoogleIdentity = true, scriptNonce } = {}) {
  const nonceSource = validateScriptNonce(scriptNonce);
  const scriptSources = ["'self'"];
  const connectSources = ["'self'"];
  const frameSources = [];
  const styleSources = ["'self'"];

  if (nonceSource) {
    scriptSources.push(nonceSource);
  }
  if (includeGoogleIdentity) {
    scriptSources.push("https://accounts.google.com/gsi/client");
    connectSources.push("https://accounts.google.com/gsi/");
    frameSources.push("https://accounts.google.com/gsi/");
    styleSources.push("https://accounts.google.com/gsi/style");
  }

  const directives = [
    ["default-src", "'self'"],
    ["base-uri", "'none'"],
    ["object-src", "'none'"],
    ["frame-ancestors", "'none'"],
    ["form-action", "'self'"],
    ["script-src", ...scriptSources],
    ["script-src-attr", "'none'"],
    ["connect-src", ...connectSources],
    ["frame-src", ...(frameSources.length > 0 ? frameSources : ["'none'"])],
    ["style-src", ...styleSources],
    ["img-src", "'self'", "data:"],
    ["media-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    ["manifest-src", "'self'"],
    ["worker-src", "'self'"]
  ];

  return directives.map((parts) => parts.join(" ")).join("; ");
}

export function isTrustedOrigin(origin, trustedOrigins, { allowMissing = false } = {}) {
  if (origin === undefined || origin === null || origin === "") {
    return allowMissing === true;
  }

  const normalizedOrigin = parseHttpOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  const normalizedTrustedOrigins = normalizeTrustedOrigins(trustedOrigins);
  return normalizedTrustedOrigins.has(normalizedOrigin);
}

export function shouldPersistPresenterSession(value) {
  return value === true;
}

export function createTokenBucketLimiter({
  capacity,
  refillTokens = DEFAULT_REFILL_TOKENS,
  refillIntervalMs = DEFAULT_REFILL_INTERVAL_MS,
  maxEntries = DEFAULT_MAX_LIMITER_ENTRIES,
  idleTtlMs = DEFAULT_IDLE_TTL_MS,
  now = Date.now
}) {
  const safeCapacity = assertPositiveSafeInteger(capacity, "capacity");
  const safeRefillTokens = assertPositiveFiniteNumber(refillTokens, "refillTokens");
  const safeRefillIntervalMs = assertPositiveSafeInteger(refillIntervalMs, "refillIntervalMs");
  const safeMaxEntries = assertPositiveSafeInteger(maxEntries, "maxEntries");
  const safeIdleTtlMs = assertPositiveSafeInteger(idleTtlMs, "idleTtlMs");
  if (typeof now !== "function") {
    throw new TypeError("now must be a function.");
  }

  const buckets = new Map();

  function consume(key, cost = 1) {
    assertLimiterKey(key);
    const safeCost = assertPositiveFiniteNumber(cost, "cost");
    if (safeCost > safeCapacity) {
      throw new RangeError("cost cannot exceed limiter capacity.");
    }

    const timestamp = readTimestamp(now);
    let bucket = buckets.get(key);
    if (bucket && timestamp - bucket.lastSeen >= safeIdleTtlMs) {
      buckets.delete(key);
      bucket = undefined;
    }

    if (!bucket) {
      if (buckets.size >= safeMaxEntries) {
        pruneIdleBuckets(buckets, timestamp, safeIdleTtlMs);
      }
      if (buckets.size >= safeMaxEntries) {
        return limiterCapacityResult(buckets, timestamp, safeIdleTtlMs, safeCapacity);
      }
      bucket = { tokens: safeCapacity, lastRefill: timestamp, lastSeen: timestamp };
      buckets.set(key, bucket);
    }

    refillBucket(bucket, timestamp, safeCapacity, safeRefillTokens, safeRefillIntervalMs);
    bucket.lastSeen = timestamp;

    if (bucket.tokens >= safeCost) {
      bucket.tokens -= safeCost;
      return limiterResult(true, "allowed", safeCapacity, bucket.tokens, 0);
    }

    const missingTokens = safeCost - bucket.tokens;
    const retryAfterMs = (missingTokens / safeRefillTokens) * safeRefillIntervalMs;
    return limiterResult(
      false,
      "rate_limited",
      safeCapacity,
      bucket.tokens,
      Math.max(1, Math.ceil(retryAfterMs / 1000))
    );
  }

  return Object.freeze({
    consume,
    clear() {
      buckets.clear();
    },
    get size() {
      return buckets.size;
    }
  });
}

function isPresentationItemPath(pathname) {
  const match = pathname.match(PRESENTATION_ITEM_PATH_PATTERN);
  return Boolean(match && isStrictStableId(match[1]));
}

function invalidContentLength(limitBytes) {
  return {
    ok: false,
    statusCode: HTTP_BAD_REQUEST,
    code: "INVALID_CONTENT_LENGTH",
    limitBytes
  };
}

function toBuffer(value) {
  if (!(value instanceof Uint8Array)) {
    return null;
  }
  return Buffer.from(value);
}

function startsWithBytes(bytes, signature) {
  if (bytes.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes, signature) {
  return asciiAt(bytes, 0, signature.length) === signature;
}

function asciiAt(bytes, start, length) {
  if (bytes.length < start + length) {
    return "";
  }
  return bytes.toString("ascii", start, start + length);
}

function normalizeMimeType(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function mediaError(statusCode, code) {
  return { ok: false, statusCode, code };
}

function validateScriptNonce(value) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !CSP_NONCE_PATTERN.test(value)) {
    throw new TypeError("scriptNonce must be a 16-128 character base64url value.");
  }
  return `'nonce-${value}'`;
}

function normalizeTrustedOrigins(values) {
  if (!(Array.isArray(values) || values instanceof Set)) {
    throw new TypeError("trustedOrigins must be an array or Set of exact origins.");
  }

  const normalized = new Set();
  for (const value of values) {
    const origin = parseHttpOrigin(value);
    if (!origin) {
      throw new TypeError("trustedOrigins contains an invalid HTTP origin.");
    }
    normalized.add(origin);
  }
  return normalized;
}

function parseHttpOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value === "null") {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username
      || parsed.password
      || (parsed.pathname !== "/" && parsed.pathname !== "")
      || parsed.search
      || parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function assertLimiterKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LIMITER_KEY_LENGTH) {
    throw new TypeError(`limiter key must be a non-empty string of at most ${MAX_LIMITER_KEY_LENGTH} characters.`);
  }
}

function assertPositiveFiniteNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return value;
}

function readTimestamp(now) {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("now must return a non-negative finite timestamp.");
  }
  return value;
}

function refillBucket(bucket, timestamp, capacity, refillTokens, refillIntervalMs) {
  const elapsedMs = Math.max(0, timestamp - bucket.lastRefill);
  if (elapsedMs === 0) {
    return;
  }
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs / refillIntervalMs) * refillTokens);
  bucket.lastRefill = timestamp;
}

function pruneIdleBuckets(buckets, timestamp, idleTtlMs) {
  for (const [key, bucket] of buckets) {
    if (timestamp - bucket.lastSeen >= idleTtlMs) {
      buckets.delete(key);
    }
  }
}

function limiterCapacityResult(buckets, timestamp, idleTtlMs, capacity) {
  let retryAfterMs = idleTtlMs;
  for (const bucket of buckets.values()) {
    retryAfterMs = Math.min(retryAfterMs, Math.max(0, bucket.lastSeen + idleTtlMs - timestamp));
  }
  return limiterResult(
    false,
    "limiter_capacity",
    capacity,
    0,
    Math.max(1, Math.ceil(retryAfterMs / 1000))
  );
}

function limiterResult(allowed, reason, limit, tokens, retryAfterSeconds) {
  return {
    allowed,
    reason,
    limit,
    remaining: Math.max(0, Math.floor(tokens)),
    retryAfterSeconds
  };
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}
