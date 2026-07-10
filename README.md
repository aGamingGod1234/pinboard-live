# Pinboard Live

Pinboard Live is a minimal Kahoot-style quiz app with presenter controls, anonymous player joins, live slides, quizzes, polls, scoring, and reconnect support.

## Requirements

- Node.js 22 is used in CI; the application supports Node.js 20 or newer.
- PostgreSQL is strongly recommended for production persistence. Local development can run with the in-memory fallback.

## Run locally

Install dependencies, configure authentication, and start the server:

```powershell
npm ci
$env:AUTH_SECRET = "replace-with-at-least-32-random-characters"
$env:PRESENTER_EMAIL = "presenter@example.com"
$env:PRESENTER_PASSWORD = "replace-with-a-strong-password"
npm start
```

Open `http://localhost:4173`.

The built-in development credentials (`presenter@pinboard.local` / `local-presenter-password`) are disabled by default. To use them for local development only, omit explicit presenter credentials and set `ALLOW_INSECURE_LOCAL_AUTH=true`. Never enable that flag in a shared or production environment.

The server reads environment variables directly from the process. [`.env.example`](.env.example) is a reference; provide the values through PowerShell, your process manager, or Railway.

## Configuration

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Set to `production` in production so cookies are marked `Secure` and production validation is enforced. |
| `PUBLIC_ORIGIN` | Canonical public origin used for same-origin and OAuth checks, for example `https://example.com`. |
| `TRUST_PROXY` | Trust Railway/reverse-proxy forwarding headers for client IP and origin handling. Set `true` only behind a trusted proxy; Railway enables this automatically. |
| `AUTH_SECRET` | Application secret. Production requires at least 32 characters. |
| `PRESENTER_EMAIL` / `PRESENTER_PASSWORD` | Bootstrap presenter credentials. Use a unique strong password. |
| `ALLOW_INSECURE_LOCAL_AUTH` | Explicit opt-in for the built-in local credentials. Keep `false` outside isolated local development. |
| `GOOGLE_CLIENT_ID` | Optional Google presenter sign-in client ID. |
| `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Optional Google OAuth server-flow configuration. |
| `GOOGLE_ALLOWED_EMAILS` / `GOOGLE_ALLOWED_DOMAINS` | Comma-separated Google presenter allowlists. The bootstrap presenter email is always allowed; production Google sign-in is default-deny without an allowlist. |
| `DATABASE_URL` | PostgreSQL connection URL for durable presenters, sessions, players, answers, and media. |
| `MAX_QUESTION_MEDIA_BYTES` | Maximum raw media upload size in bytes; defaults to 100 MiB and cannot exceed 500 MiB. |
| `MAX_MEDIA_STORAGE_BYTES_PER_PRESENTER` | Per-presenter media storage quota; defaults to 1 GiB. |
| `MAX_MEDIA_ASSETS_PER_PRESENTER` | Per-presenter media record quota; defaults to 500. |
| `MAX_PLAYERS_PER_SESSION` | Join guard per live PIN; defaults to 5,000 and is not a capacity guarantee. |
| `PORT` / `HOST` | Listening port and interface; defaults are `4173` and `0.0.0.0`. |

For Google sign-in, register `PUBLIC_ORIGIN` as an authorized origin and configure the exact callback URL from `GOOGLE_REDIRECT_URI` in Google Cloud.

## Security and authentication

- Presenter login creates an opaque server-side session. The browser receives only an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); the stored session token is hashed. Mutating presenter requests also require the session's CSRF token in the `X-CSRF-Token` header.
- Each player receives a random resume token in a PIN-specific `HttpOnly` cookie. Only its hash is retained server-side, so refreshes and temporary disconnects can resume without exposing a player token to JavaScript.
- Request origins, stable IDs, content lengths, and payload shapes are validated. Security headers are applied globally and error responses do not expose internal stack traces.
- Route-specific JSON limits are 16 KiB for authentication, 8 KiB for player actions, and 1 MiB for presentation/session snapshots. Media uses its separately configured raw-byte limit.
- Authentication, joins, and player actions have bounded token-bucket rate limits. These process-local controls reduce abuse but do not replace an edge firewall for a public high-traffic deployment.

## Persistence and live flow

- The Node.js server is authoritative for session phases, deadlines, scoring, and idempotent answer submission.
- Regular quizzes support 2–6 options and one or more correct answers through `correctOptionIds`. True/False remains fixed at two options with exactly one correct answer. Single-answer questions submit immediately; multi-answer questions require exactly the displayed selection count and an explicit submit.
- Player submissions are persisted as `selectedOptionIds`. Awards decrease continuously in milliseconds from the question's configured points to zero at its effective deadline. A manual Skip uses the exact elapsed duration, and multi-answer awards multiply that time value by the fraction of correct choices selected; wrong and missing answers receive zero.
- Live rounds progress through `question -> answering -> results -> leaderboard`. Presenter results contain the answer distribution and explicit correct markers without an embedded leaderboard. Players reconnect into the authoritative selection, waiting, reveal, or leaderboard state, including correct, partial, incorrect, timeout, and awarded-point details.
- PostgreSQL row locks serialize each PIN's mutations. Versioned snapshots, normalized player/answer rows, and score updates commit atomically, so concurrent replicas cannot accept an answer after reveal or partially persist scoring.
- PostgreSQL `LISTEN/NOTIFY` invalidates replica caches and triggers role-scoped SSE updates. Clients reject delayed state versions, while disconnects update presence without deleting durable participant identity.
- Each question accepts one raster image (PNG, JPEG, GIF, or WebP). Media is uploaded as raw bytes into separate `media_assets` records rather than embedded base64 in snapshots. The server detects signatures, rejects videos, active formats, and MIME mismatches, enforces presenter/player authorization and quotas, and streams byte ranges from PostgreSQL with bounded concurrency.

## Tests

```powershell
npm run test:unit
npm run test:integration
npx playwright install --with-deps chromium
npm run test:e2e
npm run check
```

`npm test` runs unit and integration tests. `npm run check` runs the full test suite plus JavaScript syntax checks. CI also runs a production-dependency audit at the `high` severity threshold.

CI provisions a disposable PostgreSQL 16 service and runs the two-replica concurrency suite, including stale presentation writes, a slow-body lock probe, duplicate and 20-player answer bursts, scoring/restart persistence, and cross-replica logout revocation. Local runs skip that single test unless `TEST_DATABASE_URL` points to a local database whose name contains `test`.

## Database migration and rollback

Startup migrations are additive. Before a legacy live-session or presentation snapshot is rewritten, its original JSON is retained in `migration_snapshot_backups`, keyed by entity and migration name. Take a PostgreSQL custom-format backup before upgrading a production database.

The first upgrade from a pre-hardening release must use a brief maintenance restart so the old binary cannot write unversioned snapshots while the new schema is migrating. Do not run old and new application revisions concurrently during that one upgrade. If verification fails, stop the new revision, restore the pre-upgrade database backup, and redeploy the previously successful application revision.

## Scale notes

`MAX_PLAYERS_PER_SESSION` is a safety guard, not a promise that a Railway service can serve that audience. Live-session correctness and SSE cache invalidation are coordinated through PostgreSQL across replicas, but rate-limit buckets and connection quotas remain process-local rather than globally distributed.

Actual safe attendance depends on the container CPU and memory, database latency, question/media sizes, network conditions, and answer bursts. Load-test the deployed configuration with representative content before a large event. PostgreSQL byte storage is durable but can become expensive for heavy media traffic; object storage plus a CDN is the appropriate next step at higher scale.
