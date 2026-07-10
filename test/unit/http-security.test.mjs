import assert from "node:assert/strict";
import test from "node:test";
import * as security from "../../src/http-security.mjs";

test("isStrictStableId accepts only canonical lowercase UUID v4 identifiers", () => {
  const validId = "b89f9f5d-3f8f-4f44-9c2a-6f667c8bb255";

  assert.equal(security.isStrictStableId?.(validId), true);
  assert.equal(security.isStrictStableId?.(validId.toUpperCase()), false);
  assert.equal(security.isStrictStableId?.("00000000-0000-0000-0000-000000000000"), false);
  assert.equal(security.isStrictStableId?.('b89f9f5d-3f8f-4f44-9c2a-6f667c8bb255\" onfocus=\"x'), false);
  assert.equal(security.isStrictStableId?.(null), false);
});

test("bodyLimitForRoute applies conservative limits by route class", () => {
  assert.deepEqual(security.DEFAULT_BODY_LIMITS, {
    AUTH: 16 * 1024,
    PLAYER_ACTION: 8 * 1024,
    PRESENTATION: 1024 * 1024
  });

  assert.equal(security.bodyLimitForRoute?.("POST", "/api/auth"), security.DEFAULT_BODY_LIMITS?.AUTH);
  assert.equal(security.bodyLimitForRoute?.("POST", "/api/auth/google"), security.DEFAULT_BODY_LIMITS?.AUTH);
  assert.equal(
    security.bodyLimitForRoute?.("POST", "/api/sessions/123456/answer"),
    security.DEFAULT_BODY_LIMITS?.PLAYER_ACTION
  );
  assert.equal(
    security.bodyLimitForRoute?.("POST", "/api/sessions/123456/leave"),
    security.DEFAULT_BODY_LIMITS?.PLAYER_ACTION
  );
  assert.equal(
    security.bodyLimitForRoute?.("PUT", "/api/presentations/b89f9f5d-3f8f-4f44-9c2a-6f667c8bb255"),
    security.DEFAULT_BODY_LIMITS?.PRESENTATION
  );
  assert.equal(security.bodyLimitForRoute?.("POST", "/api/sessions"), security.DEFAULT_BODY_LIMITS?.PRESENTATION);
  assert.equal(security.bodyLimitForRoute?.("POST", "/api/media", { mediaLimitBytes: 2_000_000 }), 2_000_000);
  assert.equal(security.bodyLimitForRoute?.("GET", "/api/presentations"), null);
  assert.equal(security.bodyLimitForRoute?.("POST", "/api/unknown"), null);
});

test("validateContentLength rejects malformed, unsafe, and oversized headers", () => {
  const limitBytes = security.DEFAULT_BODY_LIMITS?.AUTH;

  assert.deepEqual(security.validateContentLength?.(undefined, limitBytes), {
    ok: true,
    contentLength: null,
    limitBytes
  });
  assert.deepEqual(security.validateContentLength?.("1024", limitBytes), {
    ok: true,
    contentLength: 1024,
    limitBytes
  });
  assert.deepEqual(security.validateContentLength?.("1e3", limitBytes), {
    ok: false,
    statusCode: 400,
    code: "INVALID_CONTENT_LENGTH",
    limitBytes
  });
  assert.deepEqual(security.validateContentLength?.(["1", "2"], limitBytes), {
    ok: false,
    statusCode: 400,
    code: "INVALID_CONTENT_LENGTH",
    limitBytes
  });
  assert.deepEqual(security.validateContentLength?.(String(limitBytes + 1), limitBytes), {
    ok: false,
    statusCode: 413,
    code: "CONTENT_LENGTH_EXCEEDED",
    contentLength: limitBytes + 1,
    limitBytes
  });
});

test("validateBodyByteLength enforces the same limit when Content-Length is absent", () => {
  assert.deepEqual(security.validateBodyByteLength?.(8192, 8192), {
    ok: true,
    contentLength: 8192,
    limitBytes: 8192
  });
  assert.deepEqual(security.validateBodyByteLength?.(8193, 8192), {
    ok: false,
    statusCode: 413,
    code: "BODY_LIMIT_EXCEEDED",
    contentLength: 8193,
    limitBytes: 8192
  });
});

const MEDIA_FIXTURES = Object.freeze({
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  "image/gif": Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "binary"),
  "image/webp": Buffer.from("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ", "binary"),
  "video/mp4": Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32
  ]),
  "video/webm": Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84,
    0x77, 0x65, 0x62, 0x6d
  ])
});

test("detectMediaMimeType recognizes only the allowed binary signatures", () => {
  for (const [mimeType, bytes] of Object.entries(MEDIA_FIXTURES)) {
    assert.equal(security.detectMediaMimeType?.(bytes), mimeType, mimeType);
  }

  assert.equal(security.detectMediaMimeType?.(Buffer.from("<svg></svg>")), null);
  assert.equal(security.detectMediaMimeType?.(Buffer.from("<html></html>")), null);
});

test("validateMediaDataUrl accepts allowlisted media when MIME and magic bytes agree", () => {
  for (const [mimeType, bytes] of Object.entries(MEDIA_FIXTURES)) {
    const result = security.validateMediaDataUrl?.({
      dataUrl: toDataUrl(mimeType, bytes),
      declaredMimeType: mimeType,
      maxBytes: 1024
    });

    assert.equal(result?.ok, true, mimeType);
    assert.equal(result?.mimeType, mimeType, mimeType);
    assert.equal(result?.sizeBytes, bytes.length, mimeType);
    assert.deepEqual(result?.bytes, bytes, mimeType);
  }
});

test("validateMediaDataUrl rejects active formats, MIME mismatches, and malformed headers", () => {
  const jpegBytes = MEDIA_FIXTURES["image/jpeg"];
  const pngBytes = MEDIA_FIXTURES["image/png"];
  const svgBytes = Buffer.from("<svg><script>alert(1)</script></svg>");

  assert.equal(
    security.validateMediaDataUrl?.({
      dataUrl: toDataUrl("image/svg+xml", svgBytes),
      declaredMimeType: "image/svg+xml",
      maxBytes: 1024
    })?.code,
    "UNSUPPORTED_MEDIA_TYPE"
  );
  assert.equal(
    security.validateMediaDataUrl?.({
      dataUrl: toDataUrl("text/html", Buffer.from("<html></html>")),
      declaredMimeType: "text/html",
      maxBytes: 1024
    })?.code,
    "UNSUPPORTED_MEDIA_TYPE"
  );
  assert.equal(
    security.validateMediaDataUrl?.({
      dataUrl: toDataUrl("image/jpeg", jpegBytes),
      declaredMimeType: "image/png",
      maxBytes: 1024
    })?.code,
    "MEDIA_TYPE_MISMATCH"
  );
  assert.equal(
    security.validateMediaDataUrl?.({
      dataUrl: toDataUrl("image/png", jpegBytes),
      declaredMimeType: "image/png",
      maxBytes: 1024
    })?.code,
    "MEDIA_SIGNATURE_MISMATCH"
  );
  assert.equal(
    security.validateMediaDataUrl?.({
      dataUrl: `data:image/png\" onerror=\"alert(1);base64,${pngBytes.toString("base64")}`,
      declaredMimeType: "image/png",
      maxBytes: 1024
    })?.code,
    "INVALID_MEDIA_DATA_URL"
  );
  assert.equal(
    security.validateMediaDataUrl?.({
      dataUrl: toDataUrl("image/png", pngBytes),
      declaredMimeType: "image/png",
      maxBytes: pngBytes.length - 1
    })?.code,
    "MEDIA_TOO_LARGE"
  );
});

test("createSecurityHeaders returns a strict centralized CSP and browser protections", () => {
  const headers = security.createSecurityHeaders?.();
  const csp = headers?.["Content-Security-Policy"] ?? "";

  assert.equal(headers?.["X-Content-Type-Options"], "nosniff");
  assert.equal(headers?.["X-Frame-Options"], "DENY");
  assert.equal(headers?.["Referrer-Policy"], "no-referrer");
  assert.equal(headers?.["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
  assert.equal(headers?.["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(headers?.["Permissions-Policy"], "camera=(), geolocation=(), microphone=()");
  assert.equal(headers?.["X-XSS-Protection"], "0");
  assert.equal(Object.isFrozen(headers), true);

  for (const directive of [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "frame-src https://accounts.google.com/gsi/",
    "style-src 'self' https://accounts.google.com/gsi/style",
    "img-src 'self' data:",
    "media-src 'self' data: blob:"
  ]) {
    assert.equal(csp.includes(directive), true, directive);
  }

  assert.equal(csp.includes("'unsafe-inline'"), false);
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.equal(csp.includes("*"), false);
  assert.equal(Object.hasOwn(headers, "Strict-Transport-Security"), false);
});

test("createSecurityHeaders can omit Google Identity and add a validated script nonce", () => {
  const nonce = "z9Cj04a4R6qFYPwNndwA9Q";
  const headers = security.createSecurityHeaders?.({ includeGoogleIdentity: false, scriptNonce: nonce });
  const csp = headers?.["Content-Security-Policy"] ?? "";

  assert.equal(csp.includes("accounts.google.com"), false);
  assert.equal(csp.includes(`'nonce-${nonce}'`), true);
  assert.equal(headers?.["Cross-Origin-Opener-Policy"], "same-origin");
  assert.throws(
    () => security.createSecurityHeaders?.({ scriptNonce: 'bad\"; script-src *' }),
    { name: "TypeError" }
  );
});

test("isTrustedOrigin requires an exact configured HTTP origin", () => {
  const trustedOrigins = ["https://quiz.example", "https://quiz.example:8443"];

  assert.equal(security.isTrustedOrigin?.("https://quiz.example", trustedOrigins), true);
  assert.equal(security.isTrustedOrigin?.("HTTPS://QUIZ.EXAMPLE", trustedOrigins), true);
  assert.equal(security.isTrustedOrigin?.("https://quiz.example:8443", trustedOrigins), true);
  assert.equal(security.isTrustedOrigin?.("https://evil.quiz.example", trustedOrigins), false);
  assert.equal(security.isTrustedOrigin?.("https://quiz.example.evil.test", trustedOrigins), false);
  assert.equal(security.isTrustedOrigin?.("https://quiz.example/path", trustedOrigins), false);
  assert.equal(security.isTrustedOrigin?.("https://user@quiz.example", trustedOrigins), false);
  assert.equal(security.isTrustedOrigin?.("null", trustedOrigins), false);
  assert.equal(security.isTrustedOrigin?.("javascript:alert(1)", trustedOrigins), false);
});

test("isTrustedOrigin denies missing Origin unless explicitly allowed", () => {
  const trustedOrigins = new Set(["https://quiz.example"]);

  assert.equal(security.isTrustedOrigin?.(undefined, trustedOrigins), false);
  assert.equal(security.isTrustedOrigin?.("", trustedOrigins), false);
  assert.equal(security.isTrustedOrigin?.(undefined, trustedOrigins, { allowMissing: true }), true);
  assert.throws(
    () => security.isTrustedOrigin?.("https://quiz.example", ["*"]),
    { name: "TypeError" }
  );
});

test("createTokenBucketLimiter refills lazily and returns Retry-After metadata", () => {
  let now = 0;
  const limiter = security.createTokenBucketLimiter?.({
    capacity: 2,
    refillTokens: 1,
    refillIntervalMs: 1000,
    maxEntries: 2,
    idleTtlMs: 5000,
    now: () => now
  });

  assert.deepEqual(limiter?.consume("client-a"), {
    allowed: true,
    reason: "allowed",
    limit: 2,
    remaining: 1,
    retryAfterSeconds: 0
  });
  assert.equal(limiter?.consume("client-a").allowed, true);
  assert.deepEqual(limiter?.consume("client-a"), {
    allowed: false,
    reason: "rate_limited",
    limit: 2,
    remaining: 0,
    retryAfterSeconds: 1
  });

  now = 500;
  assert.equal(limiter?.consume("client-a").retryAfterSeconds, 1);
  now = 1000;
  assert.equal(limiter?.consume("client-a").allowed, true);
});

test("createTokenBucketLimiter bounds keys and admits new keys after idle expiry", () => {
  let now = 0;
  const limiter = security.createTokenBucketLimiter?.({
    capacity: 1,
    refillTokens: 1,
    refillIntervalMs: 1000,
    maxEntries: 1,
    idleTtlMs: 1000,
    now: () => now
  });

  assert.equal(limiter?.consume("client-a").allowed, true);
  assert.equal(limiter?.size, 1);
  assert.deepEqual(limiter?.consume("client-b"), {
    allowed: false,
    reason: "limiter_capacity",
    limit: 1,
    remaining: 0,
    retryAfterSeconds: 1
  });
  assert.equal(limiter?.size, 1);

  now = 1001;
  assert.equal(limiter?.consume("client-b").allowed, true);
  assert.equal(limiter?.size, 1);
  limiter?.clear();
  assert.equal(limiter?.size, 0);
});

test("createTokenBucketLimiter defers whole-map idle pruning until capacity", () => {
  let now = 0;
  const limiter = security.createTokenBucketLimiter?.({
    capacity: 1,
    refillTokens: 1,
    refillIntervalMs: 1000,
    maxEntries: 2,
    idleTtlMs: 1000,
    now: () => now
  });

  assert.equal(limiter?.consume("client-a").allowed, true);
  assert.equal(limiter?.consume("client-b").allowed, true);
  now = 1000;
  assert.equal(limiter?.consume("client-a").allowed, true);
  assert.equal(limiter?.size, 2);
});

test("presenter sessions persist only when the request explicitly opts in", () => {
  assert.equal(typeof security.shouldPersistPresenterSession, "function");
  assert.equal(security.shouldPersistPresenterSession?.(true), true);
  assert.equal(security.shouldPersistPresenterSession?.(false), false);
  assert.equal(security.shouldPersistPresenterSession?.("true"), false);
  assert.equal(security.shouldPersistPresenterSession?.(undefined), false);
});

test("createTokenBucketLimiter rejects unsafe configuration and keys", () => {
  assert.throws(() => security.createTokenBucketLimiter?.({ capacity: 0 }), { name: "TypeError" });

  const limiter = security.createTokenBucketLimiter?.({
    capacity: 1,
    refillTokens: 1,
    refillIntervalMs: 1000,
    maxEntries: 1,
    idleTtlMs: 1000
  });
  assert.throws(() => limiter?.consume(""), { name: "TypeError" });
  assert.throws(() => limiter?.consume("x", 2), { name: "RangeError" });
});

function toDataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}
