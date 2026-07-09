# Pinboard Live full-hardening implementation plan

> Execute test-first. Every behavior change begins with a failing test, then the smallest implementation, then the full relevant suite.

**Goal:** Resolve all High/Medium review findings, publish through GitHub, deploy to Railway production, and prove the live presenter/participant flow.

**Architecture:** PostgreSQL-locked/versioned room mutations, normalized players/answers, cookie authentication, separately stored media, compact SSE events, scoped client rendering, and tracked Node/Playwright regression suites.

**Tech stack:** Node.js ESM, PostgreSQL/`pg`, vanilla browser JavaScript/CSS, `node:test`, `qrcode`, `@playwright/test`, GitHub CLI, Railway CLI.

---

## Task 1: Establish test and module seams

**Files**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/constants.mjs`
- Create: `src/http-security.mjs`
- Create: `src/session-domain.mjs`
- Create: `test/session-domain.test.mjs`
- Create: `test/http-security.test.mjs`

**Steps**

1. Add failing `node:test` cases for deadline rejection, idempotent answers, strict stable IDs, safe media MIME detection, per-route limits, and rate-limit reset behavior.
2. Run `npm test`; confirm the new tests fail because the modules/behavior do not exist.
3. Add only the approved dependencies and scripts: `test`, `test:unit`, `test:integration`, `test:e2e`, `check`.
4. Extract pure constants/domain/security helpers without changing route behavior yet.
5. Run `npm run test:unit`; expect all Task 1 tests to pass.
6. Commit: `test: establish hardening regression seams`.

## Task 2: Route-specific limits, headers, origin checks, and abuse controls

**Files**

- Modify: `server.mjs`
- Modify: `src/http-security.mjs`
- Create: `test/server-security.integration.test.mjs`

**Steps**

1. Add failing spawned-server tests for early `Content-Length` rejection, small login/join limits, generic 500s, request IDs, CSP/security headers, same-origin mutation checks, login backoff, join/answer limits, and SSE caps.
2. Verify RED with `npm run test:integration -- server-security`.
3. Implement route metadata, bounded JSON/raw-body readers, centralized headers, safe errors, token buckets, and room/connection caps.
4. Verify GREEN with security integration tests and `npm run test:unit`.
5. Commit: `fix: enforce request and abuse boundaries`.

## Task 3: Cookie auth and participant resume tokens

**Files**

- Modify: `server.mjs`
- Modify: `public/app.js`
- Modify: `.env.example`
- Create: `test/auth.integration.test.mjs`

**Steps**

1. Add failing tests for HttpOnly presenter cookies, keep-signed-in lifetime, sign-out invalidation, legacy token exchange, origin enforcement, cookie-only host SSE, hashed participant resume tokens, and cookie-only answer/resume/SSE.
2. Verify RED.
3. Add presenter session versions, cookie helpers, logout/exchange routes, participant token hashing, and migration-compatible authentication.
4. Remove client token storage/query parameters after successful exchange. Restore the configured email login form.
5. Verify GREEN and confirm no host/player credential appears in generated EventSource URLs.
6. Commit: `fix: move live authorization to secure cookies`.

## Task 4: Transactional room state and durable presence

**Files**

- Modify: `server.mjs`
- Modify: `src/session-domain.mjs`
- Create: `src/session-store.mjs`
- Create: `test/session-store.integration.test.mjs`
- Create: `test/realtime.integration.test.mjs`

**Steps**

1. Add failing tests for 50 concurrent answers with no loss, unique first-answer semantics, monotonic versions, timer deadline checks, explicit-only host ending, player persistence after disconnect, presenter reconnect, and stale delayed-callback resistance.
2. Verify RED.
3. Add additive tables/columns and `mutateSession` with per-PIN queues plus PostgreSQL row locks.
4. Normalize players/answers, convert disconnects to presence updates, and route timers through stable identifiers.
5. Add compact mutation notifications and versioned SSE messages.
6. Verify GREEN locally; run database-path tests through an isolated schema/transaction when a database URL is available.
7. Commit: `fix: serialize durable live session state`.

## Task 5: Media extraction, validation, and migration

**Files**

- Modify: `server.mjs`
- Modify: `public/app.js`
- Create: `src/media-store.mjs`
- Create: `scripts/restore-media-snapshots.mjs`
- Create: `test/media.integration.test.mjs`

**Steps**

1. Add failing tests for authenticated raw upload, public-route body isolation, MIME/magic-byte validation, SVG/HTML rejection, owner checks, cache/safety headers, compact question payloads, lazy legacy migration, and backup restoration.
2. Verify RED.
3. Add `media_assets` and snapshot-backup tables, raw upload/stream endpoints, reference cleanup, and legacy migration.
4. Replace client data-URL reads with upload progress and media metadata.
5. Verify GREEN and assert SSE/API session JSON contains no base64 media.
6. Commit: `fix: store and stream media outside room state`.

## Task 6: Eliminate stored DOM XSS

**Files**

- Modify: `server.mjs`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Create: `test/xss.integration.test.mjs`

**Steps**

1. Add failing hostile ID/media/name tests and browser assertions that injected attributes/scripts never execute.
2. Verify RED.
3. Enforce stable-ID/MIME allowlists, server-generated media URLs, attribute escaping, safe element/property assignment for media, and CSP-compatible Google auth callback behavior.
4. Verify GREEN with integration and browser security tests.
5. Commit: `fix: close stored rendering injection paths`.

## Task 7: Scoped rendering, save revisions, and navigation safety

**Files**

- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `test/client-state.test.mjs`
- Create: `tests/e2e/editor.spec.mjs`

**Steps**

1. Add failing tests for continuous typing/caret retention, edits during an in-flight save, queued save before navigation, dirty back/unload guards, pending-action dedupe, and realtime counter updates without answer-grid replacement.
2. Verify RED.
3. Stop global renders for text edits, add keyed patches/focus restoration, monotonic draft revisions, save queuing, navigation guards, and action pending state.
4. Verify GREEN on desktop and mobile.
5. Commit: `fix: preserve interactive client state`.

## Task 8: Reconnect, completion, QR, accessibility, and UUID compatibility

**Files**

- Modify: `server.mjs`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `tests/e2e/live-flow.spec.mjs`
- Create: `tests/e2e/accessibility.spec.mjs`

**Steps**

1. Add failing tests for long player/host disconnect recovery, retryable resume errors, leave/replay/return actions, answer accessible names, error/status live regions, keyboard flow, real QR image decoding/loading, and non-localhost HTTP UUID fallback.
2. Verify RED.
3. Implement durable reconnect states, completion actions, server PNG QR, ARIA/live-region semantics, focus management, and secure UUID fallback.
4. Verify GREEN across desktop/tablet/mobile and reduced-motion mode.
5. Commit: `fix: complete accessible resilient live flows`.

## Task 9: Cleanup, retention, documentation, and full local verification

**Files**

- Modify: `server.mjs`
- Modify: `README.md`
- Modify: `railway.json`
- Modify: `CODEBASE_REVIEW.md`
- Modify: `PROJECT_LOG.md`
- Create: `playwright.config.mjs`

**Steps**

1. Add retention/cleanup tests for ended rooms, player data, answers, media, timers, and rate-limit buckets.
2. Implement scheduled cleanup and graceful shutdown.
3. Update setup, auth, media, limits, migration, rollback, and test documentation.
4. Run `npm run check`, `npm audit --omit=dev`, and all local Playwright projects.
5. Require zero failures, zero browser console errors, no horizontal overflow, and no known dependency advisories.
6. Commit: `test: verify complete hardening release`.

## Task 10: GitHub publication and Railway release

**Files**

- No new application files unless release verification finds a defect.

**Steps**

1. Re-read the final diff; ensure the pre-existing `.gitignore` change and approved review/docs are included and no secret/artifact is staged.
2. Push `codex/full-hardening`.
3. Open a ready PR with root cause, migration, security, UX, test, and rollback details.
4. Run/record all PR checks, review the PR diff, then merge to `main`.
5. Record the current successful Railway deployment ID and deploy the merged main tree with Railway CLI.
6. Wait for Railway `SUCCESS`; inspect build/runtime logs and health.
7. On failure, execute the rollback sequence from the design.

## Task 11: Live production verification

**Files**

- Modify tests/docs only if a production-only defect is found and fixed through another red-green cycle.

**Steps**

1. Run header/health/security smoke checks against `https://pinboard-live-production.up.railway.app`.
2. Run secret-safe Playwright E2E using Railway-injected credentials.
3. Verify presentation CRUD, media, QR, host, two players, answer idempotency, scoring, reconnects, completion, cleanup, accessibility, console/network errors, and responsive screenshots.
4. Delete test presentations/media and confirm health again.
5. Update `PROJECT_LOG.md` with deployment ID, commit, live URL, test counts, assumptions, deferred limits, and rollback evidence.
6. Commit/push the verification log if changed, redeploy only if application output changed, and deliver final evidence.

