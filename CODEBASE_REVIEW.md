# Pinboard Live codebase review

**Date:** 2026-07-10  
**Scope:** Application logic, security, UX/accessibility, and the supporting deployment configuration.  
**Review type:** Read-only code and runtime review, not a formal penetration test or production load test.

## Executive summary

The app has a coherent small-prototype shape, but three architectural choices currently reinforce one another:

1. Live sessions are persisted and broadcast as whole snapshots.
2. Connection presence is treated as durable game identity.
3. The client replaces the entire DOM for most edits and realtime events.

That combination creates correctness races under PostgreSQL, makes brief network interruptions destructive, turns large media into a bandwidth/DB amplification problem, and causes focus/accessibility failures. The first production pass should therefore fix the state model and security boundaries before adding more presentation features.

## Remediation status — 2026-07-10

All High and Medium findings in this report have been implemented on `codex/full-hardening` and covered by tracked unit, integration, PostgreSQL CI, or Playwright checks. Production deployment and live-URL evidence are recorded separately in `PROJECT_LOG.md` after release.

- **L-01–L-08:** PostgreSQL row locks/CAS and atomic scoring protect phase mutations; ordinary answers use a compact normalized-row fast path with shared locking and idempotent uniqueness; listener reconnect refresh, timer retry, durable identities, cleanup, presentation revision conflicts, and CI coverage are in place.
- **S-01–S-07:** untrusted rendering/IDs, route body limits, signed opaque cookies, CSRF/origin checks, strict headers, generic errors, principal-aware abuse limits, SSE backpressure, media authentication/streaming/quotas, and Google presenter allowlists are enforced.
- **U-01–U-11:** local login, scoped input/live updates, focus restoration, named/result-aware controls, persistent dismissible messages, real responsive QR, guarded navigation/autosave, pending states, reconnect/resume, explicit completion actions, and secure client UUID fallback are implemented.

The remaining scale notes are operational constraints rather than unresolved review defects: process-local rate buckets are not a distributed WAF, PostgreSQL media is quota-bound but object storage/CDN is still preferable at higher traffic, and `MAX_PLAYERS_PER_SESSION` remains a safety ceiling rather than a tested attendance guarantee.

## Verification performed

- `node --check server.mjs` — passed.
- `node --check public/app.js` — passed.
- `npm audit --omit=dev --json` — 0 known vulnerabilities across 14 production/optional packages at review time.
- `npm run` — only `start` and `dev` exist; there is no tracked test, lint, typecheck, or build script.
- A local API flow verified authentication, session creation, SSE connection, join, start, and answer behavior.
- Runtime checks reproduced player deletion after an 8.5-second connection gap and permanent session termination after a 3.5-second presenter gap.
- Runtime checks also confirmed that a second answer returns `accepted: true` while silently retaining the first option.
- Headless browser checks reproduced editor focus loss, realtime DOM replacement, missing answer-button names, and broken completion navigation.
- Railway edge policies and live environment-variable values were not inspected, so edge-level headers/rate limits are marked separately from confirmed application behavior.

## Recommended order of work

1. **Block stored XSS and request amplification:** strict ID/MIME validation, safe DOM construction, route-specific body limits, rate limits, and connection quotas.
2. **Make the server authoritative and serial:** keep one canonical room object or room actor, serialize mutations per PIN, and use transactional/versioned persistence instead of last-write-wins snapshots.
3. **Separate presence from identity:** retain players, answers, and scores through reconnects; use presence timestamps and a session TTL instead of deleting game records on socket loss.
4. **Move media out of state snapshots:** object storage plus compact URLs/metadata; broadcast deltas rather than the full question/media payload after every answer.
5. **Replace full-DOM rerenders in interactive flows:** keyed/scoped updates, save revision tracking, pending states, accessible names/live regions, and explicit completion actions.
6. **Add regression coverage:** state-machine unit tests, concurrent PostgreSQL answer tests, reconnect tests, hostile-input tests, and browser accessibility/keyboard flows.

## Logic findings

### L-01 — High — PostgreSQL requests can overwrite newer room state

`getSession()` reloads and hydrates a detached snapshot on every database-backed request. Concurrent answers/actions can read the same old row and then write last-one-wins snapshots. SSE disconnect callbacks retain older session-object references and may later persist those stale objects over newer phases, answers, or scores.

**Evidence:** `server.mjs:454-487`, `server.mjs:645-718`, `server.mjs:1776-1843`.

**Improve:** serialize mutations per PIN and keep one canonical in-process room object. Add a database revision/compare-and-swap or transaction boundary; preferably store answers as idempotent rows with a unique `(session_id, question_id, player_id)` constraint.

### L-02 — High — Connection loss destroys durable game state

After eight seconds without a player SSE connection, the server deletes the player and current answer. That also removes their score from the leaderboard. After three seconds without a host connection, it permanently ends the room. Both behaviors were reproduced locally and conflict with the documented resume behavior.

**Evidence:** `server.mjs:690-718`, `README.md:37`.

**Improve:** track `online/offline/lastSeenAt` separately from player records. Keep scores and answers until session expiry. Give the presenter a configurable reconnect window and a deliberate “end session” action.

### L-03 — High — Every answer rewrites and rebroadcasts the whole room

An answer persists the entire JSON snapshot and sends a freshly serialized full state to every SSE client. The current question includes its base64 media, so a single answer can retransmit a very large asset to every participant. Cost grows with players, answers, and media size.

**Evidence:** `server.mjs:454-487`, `server.mjs:739-785`, `server.mjs:1812-1827`.

**Improve:** store media externally, cache immutable question data client-side, send small events/deltas, batch answer-count updates, and persist compact answer rows asynchronously or transactionally.

### L-04 — High — Edits can be marked saved when they were never persisted

An edit made while a save is in flight sets `presentationDirty`, but the older response later clears it unconditionally. Navigation can also continue while `savePresentation()` returns early because another save is active.

**Evidence:** `public/app.js:1348-1387`, `public/app.js:1518-1523`.

**Improve:** attach a monotonically increasing draft revision to each save. Clear dirty state only when the completed revision is still current, and queue a follow-up save before navigation.

### L-05 — Medium — Deadline and duplicate-answer semantics are inaccurate

The answer handler checks phase but not the authoritative deadline, so a request can be accepted after time has elapsed if it runs before the delayed timer callback. Repeated answers return `accepted: true` even though only the first option is retained; the no-op is still persisted and broadcast.

**Evidence:** `server.mjs:454-487`, `server.mjs:582-627`; reproduced by the local API flow.

**Improve:** reject when `Date.now() >= openedAt + duration`, return an explicit idempotent result for duplicates, and avoid persistence/broadcast for no-op submissions.

### L-06 — Medium — Ending can discard an active round

The host can end at any phase. `endSession()` does not score the active question, so an accidental end during answering silently drops that round.

**Evidence:** `server.mjs:520-532`, `server.mjs:569-574`, `public/app.js:1066`.

**Improve:** require reveal first, or show a confirmation that clearly says the active round will not be scored.

### L-07 — Medium — Sessions have no lifecycle cleanup

Ended sessions remain in memory and PostgreSQL indefinitely, along with media, nicknames, IDs, answers, and scores. Persisted PINs are therefore never reusable.

**Evidence:** `server.mjs:85-87`, `server.mjs:569-574`, `server.mjs:1812-1860`.

**Improve:** define active/ended retention windows, delete or anonymize expired rows, clean timer handles, and apply object-storage lifecycle rules.

### L-08 — Medium — The most failure-prone behavior has no tracked tests

There are no package scripts for unit, integration, concurrency, reconnect, browser, lint, or type checks.

**Evidence:** `package.json:6-9`.

**Improve:** start with Node's built-in test runner for server state transitions and API tests, then add a tracked browser suite for the presenter/player flows.

## Security findings

### S-01 — High — Stored DOM XSS is reachable through trusted presentation data

The server accepts arbitrary stable-ID characters and a permissive data-URL media header. The client interpolates option IDs and media URLs into HTML attributes and then assigns the string to `innerHTML`. A crafted authenticated presentation can break an attribute boundary and execute script in host/player clients on the shared origin.

**Evidence:** `server.mjs:1031-1047`, `server.mjs:1073-1105`, `server.mjs:775-785`, `public/app.js:313-316`, `public/app.js:982-992`, `public/app.js:1019-1028`.

**Improve:** allowlist UUID/slug characters, strictly allowlist media MIME types, decode and verify file signatures, reject SVG/HTML, set DOM properties on created elements, escape every attribute, and add CSP plus Trusted Types as defense in depth.

### S-02 — High — Public routes can buffer roughly 149 MB per request

The global JSON limit is derived from the 100 MB media feature and is applied to login, join, answer, and all other JSON routes. The body is fully buffered and then converted/parsing creates additional copies. Concurrent unauthenticated login requests can exhaust memory and CPU before credentials are checked.

**Evidence:** `server.mjs:31-33`, `server.mjs:223-230`, `server.mjs:846-866`, `server.mjs:1762-1764`.

**Improve:** use route-specific 4–16 KB limits for ordinary APIs, reject oversized `Content-Length` immediately, enforce field-length caps, and upload media directly to object storage with a separate constrained path.

### S-03 — High — Authentication, rooms, answers, and SSE have no abuse controls

There are no per-IP/account/PIN rate limits, player caps, connection quotas, or meaningful duplicate-answer suppression. Password attempts invoke scrypt, while known PINs can create players, long-lived SSE timers, full snapshot writes, and full fanout broadcasts.

**Evidence:** `server.mjs:223-230`, `server.mjs:415-435`, `server.mjs:454-491`, `server.mjs:645-676`, `server.mjs:739-747`, `server.mjs:1700-1715`.

**Improve:** add layered token buckets, room/player caps, per-PIN connection quotas, login backoff, proxy timeouts, and idempotent/no-op answer handling.

### S-04 — Medium — Long-lived bearer identities leak through browser storage and URLs

Presenter tokens live for seven days, are stored in local/session storage, and are placed in the SSE query string. Query tokens are commonly captured by access logs and proxies. A player UUID is also both identity and authority for resume/answer and is sent in the SSE URL.

**Evidence:** `server.mjs:39`, `server.mjs:439-490`, `server.mjs:1164-1173`, `server.mjs:1717-1754`, `public/app.js:1228-1238`, `public/app.js:1666-1680`, `public/app.js:1958-1960`.

**Improve:** prefer HttpOnly SameSite sessions with Origin/CSRF protections, or short-lived memory-only access tokens plus one-use SSE tickets. Give participants separate hashed resume tokens and add rotation/revocation.

### S-05 — Medium — Development defaults become remotely dangerous on non-production binds

Known email/password and signing-secret defaults are enabled whenever `NODE_ENV` is not exactly `production`, while the default host is `0.0.0.0`. The Railway manifest does not itself enforce `NODE_ENV`; the checked-in `.env.example` does set it correctly, so live exposure depends on deployment configuration.

**Evidence:** `server.mjs:10-14`, `server.mjs:49-52`, `server.mjs:1176-1183`, `railway.json:1-10`, `.env.example:1-4`.

**Improve:** default local binding to `127.0.0.1`, require an explicit `ALLOW_INSECURE_LOCAL_AUTH`, reject known/short secrets on non-loopback interfaces, and fail closed when a managed-host environment is detected without production settings.

### S-06 — Medium — Application responses lack defense-in-depth headers

Static, JSON, and OAuth success responses set only basic content/cache headers. The app does not set CSP, `frame-ancestors`/`X-Frame-Options`, `X-Content-Type-Options`, or Referrer-Policy, and private API responses do not explicitly set `Cache-Control: private, no-store` plus `Vary`.

**Evidence:** `server.mjs:825-835`, `server.mjs:1917-1933`, `public/index.html:1-14`.

**Improve:** apply centralized headers to every response and explicit no-store policies to auth/private APIs. Verify what Railway already adds before treating this as fully edge-exposed.

### S-07 — Low — Operational responses disclose more than necessary

`/health` reveals the storage mode, startup logs expose the presenter email, and unexpected internal/DB exception messages are returned to clients.

**Evidence:** `server.mjs:117-128`, `server.mjs:1971-1979`.

**Improve:** keep public health output generic, redact account identifiers in logs, log full errors server-side, and return a generic 500 message.

## UX and accessibility findings

### U-01 — High — The documented local presenter flow is blocked

The README gives local email/password credentials, but when Google is not configured the UI renders only a disabled “Google sign-in is not configured” button. The email/password endpoint exists but has no usable form.

**Evidence:** `README.md:11-20`, `public/app.js:498-516`.

**Improve:** either restore an explicitly local-only email/password form or require Google at startup and remove the misleading local-login documentation.

### U-02 — High — Typing replaces the focused element

Question/option input handlers mutate state and call the global renderer. `commitRender()` replaces the whole application HTML, so the active input and caret are destroyed after a keystroke; headless Chrome reproduced focus moving to the document body.

**Evidence:** `public/app.js:226-233`, `public/app.js:258-316`, `public/app.js:1707-1763`.

**Improve:** update form controls locally, render keyed components/regions, or preserve and restore selection as a temporary bridge.

### U-03 — High — Realtime updates interrupt participant interaction

Every join/answer broadcast causes the player client to replace its DOM. Browser verification showed a focused answer button becoming detached when another player joined.

**Evidence:** `server.mjs:415-435`, `server.mjs:739-747`, `public/app.js:1687`.

**Improve:** send role-relevant deltas and patch only changed counters/status. Never replace a focused answer grid for unrelated roster changes.

### U-04 — High — Player answer buttons have no accessible name

The buttons contain only an `aria-hidden` shape. Screen-reader users cannot tell the options apart.

**Evidence:** `public/app.js:925-953`.

**Improve:** add an `aria-label` that includes the option/color/shape meaning, preserve visible shape parity, and announce submitted/correct/incorrect state in a polite live region.

### U-05 — High — Completion leaves both roles at dead ends

Players stay on a disabled, buttonless answer screen. The host's “Back to presenter” action changes navigation but leaves `state.session` set, so `renderPresenter()` immediately returns the podium/live console again.

**Evidence:** `public/app.js:455-462`, `public/app.js:810-925`, `public/app.js:1868-1889`.

**Improve:** add explicit “Leave,” “Play again,” and “Return to projects” actions, and clear/archive the live session before navigating away.

### U-06 — High — Reconnect messaging promises recovery the server does not provide

The client says it is retrying, but the server deletes players after eight seconds and ends a room after three seconds. A transient resume failure also clears the saved player ID, including retryable network/server errors.

**Evidence:** `server.mjs:690-718`, `public/app.js:1565-1591`, `public/app.js:1632-1663`, `public/app.js:1699-1702`.

**Improve:** retain identity/state, distinguish offline from ended, retry with backoff, preserve credentials on retryable failures, and expose a clear reconnect status.

### U-07 — High — Browser navigation can lose edits

The app listens to `popstate`/`hashchange` without flushing or confirming dirty work, and the save race described in L-04 can falsely mark newer edits saved.

**Evidence:** `public/app.js:1348-1387`, `public/app.js:2155`.

**Improve:** use route guards, revision-aware save completion, and `beforeunload` only while unsaved work truly remains.

### U-08 — Medium — Actions lack pending/idempotent feedback

Join, host, and answer controls do not consistently enter a pending state, so double-clicks can send duplicate requests. The server's misleading duplicate-answer response compounds the issue.

**Evidence:** `public/app.js:1525-1702`, `server.mjs:482-491`.

**Improve:** disable per-action controls while pending, show progress, attach idempotency keys to important mutations, and return accurate server outcomes.

### U-09 — Medium — The QR-looking tile is not a QR code

The lobby graphic is a decorative PIN-derived pattern whose action copies a link. Users will reasonably try to scan it.

**Evidence:** `public/app.js:1090-1110`.

**Improve:** generate a real QR code or replace the graphic with an unmistakable copy-link icon and copy.

### U-10 — Medium — Error/notice feedback is not announced reliably

Toast markup lacks live-region/alert semantics and messages clear on a timer, so assistive-technology users can miss important failures.

**Evidence:** `public/app.js:432-436`, `public/app.js:2487-2518`.

**Improve:** use `role="alert"` for errors and `aria-live="polite"` for notices; retain actionable errors until dismissed or resolved.

### U-11 — Medium — Plain-HTTP LAN access can fail before first render

The initial draft calls `crypto.randomUUID()`, which is unavailable in tested insecure non-localhost contexts. A Tailscale HTTP runtime check failed with `TypeError: crypto.randomUUID is not a function`. Railway HTTPS and localhost are unaffected.

**Evidence:** `public/app.js:1996-2028`; runtime check against a non-localhost HTTP origin.

**Improve:** require HTTPS with a clear error/redirect, or generate IDs through a `crypto.getRandomValues()` fallback/server API.

## What is already solid

- Presenter ownership checks are applied consistently to presentation/session controls.
- PostgreSQL statements use parameters rather than concatenated user input.
- Passwords use salted scrypt hashes and signature comparisons are timing-safe.
- Google OAuth state uses HttpOnly, SameSite cookies and Secure in production.
- Google credential verification checks issuer, audience, signature, expiry, and verified email.
- There is no permissive CORS configuration and no high-confidence committed production secret was found.
- Text content is escaped in many common rendering paths, even though attribute/media paths remain unsafe.
- The CSS includes responsive layouts, focus-visible rules, touch-size work, and reduced-motion handling.

## Assumptions and limits

- The app is intended for public Railway deployment and anonymous, untrusted participants.
- Authenticated presenters are still treated as potentially malicious because their content renders in other users' browsers.
- Railway/CDN/WAF configuration and current live environment values were not inspected.
- No production load, multi-instance, or formal penetration testing was performed.
- No application fixes or dependency changes were made in this review.
