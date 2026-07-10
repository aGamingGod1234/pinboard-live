# Pinboard Live full-hardening design

**Date:** 2026-07-10  
**Status:** Approved for implementation  
**Source:** `CODEBASE_REVIEW.md`

## Goal

Resolve every actionable High and Medium finding in the codebase review, preserve existing presenter data and the current visual direction, add regression coverage, and release the result through GitHub and Railway with live production verification.

## Constraints

- Keep the vanilla Node.js browser/server architecture and PostgreSQL as the only backing service.
- Do not reset or destructively rewrite production data.
- Preserve existing presentations, including legacy base64 media.
- Keep the live presenter/participant split and the current minimal information architecture.
- Add only the approved dependencies: `qrcode` and development-only `@playwright/test`.
- Do not claim unlimited horizontal scale. The release must be safe for the current Railway service and remove the known single-process correctness bugs.

## Architecture

### 1. Server-authoritative, serialized session mutations

Session mutation moves behind a single `mutateSession(pin, operation)` boundary.

- In memory mode, a per-PIN promise queue serializes mutations.
- In PostgreSQL mode, each mutation opens a transaction and locks the `live_sessions` row with `SELECT ... FOR UPDATE`.
- The row gains a monotonically increasing `version`.
- Delayed timer/disconnect work captures only stable identifiers and re-enters through `mutateSession`; it never persists an old object reference.
- A PostgreSQL `LISTEN/NOTIFY` channel carries compact mutation notifications to other app instances. Notifications cause role-relevant local SSE updates or a versioned reload.
- Client state messages include `version`; older state is ignored.

The live-session snapshot stores only core room/question/phase state. Players and answers move to normalized tables:

- `live_session_players(pin, player_id, resume_token_hash, nickname, score, joined_at, last_seen_at)`
- `live_session_answers(pin, question_index, player_id, option_id, answered_at)`

The answer primary key is `(pin, question_index, player_id)`, making submissions idempotent. Ordinary answers insert one row and send compact host count/player acknowledgement events instead of rewriting and broadcasting the room.

### 2. Presence is not identity

SSE disconnects update presence metadata only.

- A participant record, answer, and score survive refreshes and network gaps until session expiry.
- A presenter disconnect never ends the game. Only an authenticated explicit end action changes the room to `ended`.
- Resume uses a random participant token stored only in an HttpOnly, SameSite cookie; the database stores its hash.
- Host/player SSE authorization reads cookies, so credentials no longer appear in URLs.
- Ended rooms and associated player/answer rows expire through a scheduled retention cleanup.

### 3. Cookie authentication and request boundaries

Presenter bearer tokens move to an HttpOnly, SameSite cookie. The existing HMAC token remains the signed cookie payload, gains a server-checked session version, and has shorter session/persistent lifetimes.

- Email and Google login set the cookie.
- Sign-out invalidates the server-side session version and clears the cookie.
- A one-time compatibility exchange accepts an existing stored host token, sets the cookie, and the client deletes browser storage.
- State-changing requests validate same-origin metadata.
- Host/player EventSource URLs contain only the PIN and role.

Every route declares an explicit body limit:

- login, join, answer, and control routes: small JSON limits;
- presentation JSON: bounded independently without media bytes;
- authenticated media upload: the configured media limit.

The server rejects oversized `Content-Length` before buffering. Login, join, answer, media, and SSE routes receive per-IP/account/PIN token buckets plus hard room/connection caps.

### 4. Media stored once and streamed

Media leaves presentation/session payloads and SSE state.

- The browser uploads the raw file to an authenticated media endpoint.
- The server validates a strict image/video MIME allowlist, size, and magic bytes.
- PostgreSQL stores one `media_assets` row with binary bytes and presenter ownership; memory mode uses a bounded map.
- Questions store only `{ id, name, type, size, url }`.
- A cacheable media GET endpoint streams bytes with `nosniff` and a safe content disposition.
- Deleting a presentation removes unreferenced presenter media after a grace period.

Legacy data URLs migrate lazily inside a transaction. Before first migration, the original presentation snapshot is copied to a backup table so a rollback script can restore it.

### 5. Safe rendering and UX state

The visual design remains intact, but interactive state no longer relies on blind full-page replacement.

- Text inputs update state without calling the global renderer; structural changes still render.
- Render commits capture/restore focus and selection as a fallback.
- Realtime answer/presence/count events patch keyed regions; unrelated player events do not replace the answer grid.
- Draft revisions make saves monotonic. A completed older save cannot clear a newer dirty revision, and navigation waits for queued saves.
- Pending actions disable only the initiating control and use idempotency-aware server responses.
- Presenter/player completion screens expose explicit return, replay, and leave actions.
- Reconnect UI distinguishes offline, retrying, expired, and ended states.

All server-derived attribute values are escaped and constrained. Stable IDs use a strict UUID/slug character allowlist; media URLs are server-generated. A CSP and standard security headers provide defense in depth.

### 6. Accessibility and compatibility

- Player answer buttons include option text, color, and shape in their accessible names.
- Errors use `role="alert"`; notices and game status use polite live regions.
- A server-generated PNG is used as the real join QR code.
- UUID generation uses `crypto.randomUUID` when available and a `crypto.getRandomValues` fallback otherwise.
- The documented email/password presenter form is available when the server reports that email login is configured.
- Keyboard focus, reduced motion, touch targets, and responsive layouts remain supported.

## Error handling

- Expected validation/rate-limit/authentication failures use stable public error codes and messages.
- Unexpected errors are logged server-side with a request ID; clients receive a generic 500 response.
- Database transactions always roll back on failure.
- Background timers, cleanup, notifications, and disconnect handlers catch and log rejections.
- SSE writes remove dead clients without mutating durable game records.

## Testing strategy

### Unit and integration

- Pure validation, rate limiter, token/cookie, UUID fallback, and session-domain tests.
- API integration tests for body limits, origin enforcement, authentication exchange, hostile IDs/media, answer idempotency, deadlines, caps, reconnects, and cleanup.
- A concurrent-answer test proves no lost updates.
- Migration tests prove legacy snapshots survive and can be restored.

### Browser

Playwright covers local presenter login, editor focus and save revisions, two-player join/answer flows, realtime updates without focus loss, reconnects beyond the former grace periods, accessible names/live regions, real QR loading, completion navigation, mobile layouts, and insecure-context UUID fallback.

### Production

After GitHub merge and Railway deployment:

- health and response-header checks;
- authenticated presentation CRUD;
- host plus two isolated participant contexts;
- answer/reveal/score/next/end;
- reconnect and resume;
- media upload/render;
- responsive screenshots and accessibility assertions;
- cleanup of test presentations.

## Deployment and rollback

Database changes are additive and initialized before serving traffic. The deployment is accepted only if health, migration, authentication, and smoke gates pass. The previous successful Railway deployment ID is recorded before release.

If a gate fails:

1. stop testing and preserve logs;
2. redeploy the previous successful Railway deployment;
3. run the media snapshot restore script only if a migrated presentation fails compatibility;
4. verify health and the previous presenter flow;
5. leave the feature branch/PR available for diagnosis.

