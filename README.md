# Pinboard Live

Minimal Kahoot-style live quiz app with presenter controls, anonymous player joins, live synchronization, slides, quizzes, polls, scoring, and 100 MB per-item media validation.

## Run

```powershell
npm start
```

Open `http://localhost:4173`.

Local presenter login:

```text
Email: presenter@pinboard.local
Password: local-presenter-password
```

Set `PRESENTER_EMAIL`, `PRESENTER_PASSWORD`, and `AUTH_SECRET` to change this. Set `DATABASE_URL` to persist presenter accounts in PostgreSQL.

## Current Architecture

- One Node.js server serves the app and owns in-memory session state.
- Presenters authenticate with email/password and receive a signed presenter token.
- PostgreSQL stores presenter credentials when `DATABASE_URL` is configured.
- PostgreSQL stores active live session snapshots when `DATABASE_URL` is configured, so Railway deploys/restarts do not immediately orphan active PINs.
- Players join anonymously with a 6-digit PIN and nickname.
- Player IDs are stored locally so a refresh can resume the same participant while the in-memory session exists.
- Server-Sent Events push live state to presenter and player screens.
- Player actions use POST requests for joins and answers.
- Media is accepted as base64 data URLs and checked against a 100 MB per-item limit on both client and server.

## Scale Notes

This prototype has no hard player cap, but a single Node service is not a true unlimited-user deployment. Production scale still needs a pub/sub fanout layer, rate limits, durable media storage, and load-balanced SSE or WebSocket infrastructure.

The research agents recommended a production shape of server-authoritative rooms, presenter tokens, anonymous player tokens, full-state snapshots after reconnect, acked answer submissions, and either Socket.IO plus Redis/Postgres or a room-actor design such as Cloudflare Durable Objects for large live audiences.
