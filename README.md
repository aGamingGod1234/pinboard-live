# Pinboard Live

Minimal Kahoot-style live quiz app with presenter controls, anonymous player joins, live synchronization, slides, quizzes, polls, scoring, and 100 MB per-item media validation.

## Run

```powershell
npm start
```

Open `http://localhost:4173`.

The server now fails closed unless presenter auth is configured. For local-only development with the demo presenter, start with:

```powershell
$env:PINBOARD_ALLOW_LOCAL_DEFAULTS="true"; npm start
```

Local-only demo presenter login:

```text
Email: presenter@pinboard.local
Password: local-presenter-password
```

For any shared or deployed environment, set `PRESENTER_EMAIL`, `PRESENTER_PASSWORD`, and `AUTH_SECRET` instead of enabling local defaults. Set `DATABASE_URL` to persist presenter accounts in PostgreSQL.
For reverse-proxy deployments such as Railway, keep `TRUST_PROXY=true` so per-client rate limits and SSE connection caps use the first `X-Forwarded-For` address instead of the platform router address.

Google presenter login:

```text
GOOGLE_CLIENT_ID=...
GOOGLE_ALLOWED_EMAILS=presenter@example.com
```

Create or select a Google Web client ID, add the app origin to Authorized JavaScript origins, and set `GOOGLE_CLIENT_ID`. Google presenter login also requires `GOOGLE_ALLOWED_EMAILS` or `GOOGLE_ALLOWED_DOMAINS`; the server verifies the Google ID token and then checks that application allowlist before issuing a presenter session. If you use the OAuth redirect flow, set `GOOGLE_CLIENT_SECRET` and a fixed `GOOGLE_REDIRECT_URI`.

## Current Architecture

- One Node.js server serves the app and owns in-memory session state.
- Presenters authenticate with email/password and receive a signed presenter token.
- PostgreSQL stores presenter credentials when `DATABASE_URL` is configured.
- PostgreSQL stores active live session snapshots when `DATABASE_URL` is configured, so Railway deploys/restarts do not immediately orphan active PINs.
- Players join with a 6-digit PIN and nickname, then receive an HttpOnly player session cookie.
- Player IDs are stored locally only to trigger refresh restore; authorization uses the player session cookie.
- Server-Sent Events push live state to presenter and player screens after cookie-backed membership checks.
- Player actions use POST requests for joins and answers.
- Media is accepted as allowlisted base64 data URLs and checked against per-item and per-session limits on both client and server.

## Scale Notes

This prototype has configurable player, SSE, request-size, login, rate-limit bucket, and media/session caps, but a single Node service is not a true unlimited-user deployment. Production scale still needs a pub/sub fanout layer, durable media storage, and load-balanced SSE or WebSocket infrastructure.

The research agents recommended a production shape of server-authoritative rooms, presenter tokens, anonymous player tokens, full-state snapshots after reconnect, acked answer submissions, and either Socket.IO plus Redis/Postgres or a room-actor design such as Cloudflare Durable Objects for large live audiences.
