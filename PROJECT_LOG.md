## [2026-07-07] — Presenter auth and adaptive live-stage cleanup

### What Was Implemented
- Stopped invalid-PIN and presenter-offline errors from remounting the home shader background; toasts now update in-place, use a content-sized red banner, and auto-dismiss.
- Restored the home Presenter control and added a Google Identity Services presenter login path with server-side ID-token verification.
- Added public Google config, verified-email Google presenter creation, and Railway `GOOGLE_CLIENT_ID` configuration.
- Cleaned the editor, lobby, presenter question, results, leaderboard, and podium surfaces so live presentation uses top-right controls and no bottom control strip.
- Prevented correct-answer reveal before results while keeping live total/per-option answer counts.
- Removed empty media placeholders, fake ready orb, and "No scores yet" text from the live stage.
- Added Google Console Web client configuration for the Railway origin and callback URL.

### Files Modified
- `public/app.js` - non-remounting message layer, Google sign-in client, cleaner editor/lobby/stage rendering, live results and podium flow.
- `public/styles.css` - red toast styling, blue management shader styling, compact adaptive stage/lobby/editor styling, leaderboard and podium styles.
- `server.mjs` - Google ID-token verification, public config endpoint, Google presenter auth endpoint, and OAuth client fallback routes.
- `.env.example` - Google client ID configuration sample.
- `README.md` - Google Identity Services setup notes.
- `PROJECT_LOG.md` - task record.

### Assumptions Made (flag these for review)
- Google Identity Services is the correct production path because the current Google Console no longer reveals OAuth client secrets.
- The existing Google Cloud project `scout-2662b` and Web client `scout` are the intended Google auth project for Pinboard.
- CSS shader approximations remain acceptable for this vanilla JavaScript app; no new shader dependency was installed.

### Known Issues / Deferred
- Google sign-in can take several minutes for the newly saved Google Console origin settings to propagate.
- The hidden email/password fallback remains available for local recovery.
- Existing Google client secrets were left enabled; Google recommends deleting old unused secrets after verifying the new auth path.

### Suggested Next Steps
- Verify Google sign-in manually once Google Console propagation completes.
- Replace the decorative lobby code tile with a real QR generator.

## [2026-07-07] - Shader UI and creator navigation pass

### What Was Implemented
- Reworked the home join surface to use the provided purple ShaderGradient color set as a CSS shader-style background.
- Made the invalid PIN warning use a black, high-contrast banner with white text on immersive screens.
- Removed the duplicate creator header row that contained the inner brand, Join, and Preview join controls.
- Changed creator question types to `quiz`, `true_false`, and `slide`; removed `poll` from client and server validation.
- Added true/false option handling and scoring as a first-class scored question type.
- Added active creator sidebar items, click-to-jump question navigation, and scroll tracking for the question closest to the top of the editor.
- Recolored lobby, presenter live, waiting, and player selection surfaces with the provided black/gold/lime ShaderGradient color family.

### Files Modified
- `public/app.js` - creator navigation state, true/false editor behavior, live session payload changes, and sidebar scroll tracking.
- `public/styles.css` - shader palettes, black invalid PIN banner, creator rail highlight, adaptive center-column scrolling, and responsive fallbacks.
- `server.mjs` - true/false validation/scoring and poll removal.
- `PROJECT_LOG.md` - task record.

### Assumptions Made (flag these for review)
- The ShaderGradient snippets should be implemented as dependency-free CSS shader approximations in this vanilla app rather than adding a React/Three shader package.
- On narrower desktop portrait layouts, natural page scrolling is preferable to trapping the editor in a short internal scroll area.

### Known Issues / Deferred
- The app still does not have a committed automated visual regression suite.
- The podium/result screens are still the existing simplified implementation; this pass focused on the requested backgrounds, creator UX, question types, and live/player selection styling.

### Suggested Next Steps
- Add a small production smoke test script for the exact portrait and landscape dimensions from the screenshots.

## [2026-07-06] - Kahoot-inspired shader UI rebuild

### What Was Implemented
- Rebuilt the player join screen as a full-screen purple shader-gradient experience with compact PIN/nickname entry.
- Rebuilt the live host lobby as a blue shader-gradient stage with a large game PIN banner, join path, copy-link tile, start controls, and participant dock.
- Reworked presenter question/result and player answer screens into large colored answer tiles with shape markers, counts, correct-state badges, and scoreboard panels.
- Reworked the creator into an adaptive workspace with question strip, main editor, launch area, and limits inspector.
- Added responsive rules for desktop portrait, desktop landscape, and mobile so immersive views do not horizontally clip.
- Reset immersive views to the top of the page and tightened lobby spacing for shorter landscape browser windows.
- Fixed a stale player resume notice race after joining a fresh PIN.
- Added a presenter-side live question frame with status orb, answer meter, and media/placeholder area.
- Split live host and player waiting shader palettes so they stay in the same blue-violet family but remain visually distinct.

### Files Modified
- `public/app.js` - new join, creator, lobby, presenter-stage, player-stage, presenter question frame, and answer tile renderers.
- `public/styles.css` - shader-gradient backgrounds, Kahoot-style stage layout, presenter question frame, answer tile system, and responsive fixes.
- `PROJECT_LOG.md` - task record.

### Assumptions Made (flag these for review)
- "Use shadergradients" can be satisfied with CSS shader-style animated gradients because the app is vanilla JavaScript and adding the React/WebGL package would be disproportionate.
- The UI should be Kahoot-inspired but keep original Pinboard branding and original assets to avoid shipping copied Kahoot marks or artwork.
- The QR-looking tile should act as a copy-link control instead of pretending to be a scannable QR code.

### Known Issues / Deferred
- The copy-link tile is decorative, not a generated QR code.
- The creator is simplified and does not yet include Kahoot's full media/effects/sidebar feature depth.
- Local verification used Chrome for E2E and installed Chrome via Playwright for fixed viewport measurements because the Chrome plugin wrapper does not expose viewport resize.

### Suggested Next Steps
- Add a real QR code generator for the lobby join link.
- Add question timers and full-screen presenter controls.
- Add more question types and per-question settings.

## [2026-07-06] — Minimal Kahoot-style live quiz app

### What Was Implemented
- Built a no-dependency Node.js app with presenter authentication, session hosting, anonymous player joins, and live synchronization.
- Added presenter deck creation for slides, scored quiz questions, polls, points, answer reveal, next/end controls, and leaderboard.
- Added client/server validation for 100 MB media per slide/question.
- Added refresh resume for anonymous players while a live in-memory session still exists.
- Added inline favicon metadata so browser verification has no missing favicon request.
- Added hidden username metadata to the presenter access form to satisfy browser password-form expectations.
- Added minimal responsive UI for home, presenter, and player flows.

### Files Modified
- `package.json` — project scripts and Node module mode.
- `.gitignore` — excludes local dependencies, logs, and environment files.
- `server.mjs` — HTTP API, static hosting, in-memory sessions, SSE live updates, validation, and scoring.
- `public/index.html` — app entrypoint and inline favicon.
- `public/styles.css` — minimal responsive UI styling.
- `public/app.js` — presenter/player frontend behavior and live event handling.
- `README.md` — run instructions, default presenter key, and architecture notes.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- A local no-dependency prototype is preferable to installing a framework before confirmation.
- Presenter authentication can start with a configurable shared key instead of full account registration.
- Anonymous players can join for free with PIN plus nickname.
- "Unlimited users" means no app-level player cap in this prototype, not guaranteed production-scale fanout on one server.
- Server-Sent Events plus POST requests are acceptable for this prototype, even though the research agents recommended Socket.IO/WebSockets for the production path.

### Known Issues / Deferred
- Sessions are in memory and reset when the server restarts.
- Media is stored in memory as base64 and should move to object storage for production.
- No rate limiting, moderation, permanent accounts, or anti-abuse controls yet.
- No horizontal scaling, pub/sub, or database layer yet.

### Suggested Next Steps
- Add persistent storage for decks and sessions.
- Add real presenter accounts and session ownership.
- Add a WebSocket or managed realtime layer for large audience scaling.
- Add upload-backed media storage instead of base64-in-session payloads.

## [2026-07-06] — Railway production auth prep

### What Was Implemented
- Added PostgreSQL-backed presenter email/password authentication when `DATABASE_URL` is configured.
- Added local fallback presenter credentials for development.
- Added signed presenter tokens using `AUTH_SECRET`.
- Added Railway deployment metadata and documented required environment variables.
- Excluded generated verification screenshots and local agent/browser artifact folders from the deploy repository.

### Files Modified
- `server.mjs` — database initialization, presenter bootstrap, password hashing, token signing, and presenter-owned sessions.
- `public/app.js` — presenter login changed from shared key to email/password.
- `package.json` — app package name and `pg` dependency.
- `package-lock.json` — dependency lockfile for Railway builds.
- `railway.json` — Railway start command, healthcheck, and restart policy.
- `.env.example` — production/local environment variable template.
- `.gitignore` — excludes generated screenshots and local tool artifacts from commits.
- `README.md` — updated auth and architecture docs.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- `pinboard-live` is the desired GitHub/Railway project name.
- The first Railway presenter email can default to the Railway account email unless changed later.
- PostgreSQL should persist presenter credentials first; live sessions remain in memory for the MVP.
- `pg` is acceptable as the only new runtime dependency.

### Known Issues / Deferred
- Decks, active sessions, players, and answers are still ephemeral across server restarts.
- Media still travels as base64 JSON and should move to object storage before heavy usage.
- Presenter password rotation currently happens by updating `PRESENTER_PASSWORD` and redeploying.

### Suggested Next Steps
- Persist decks and completed game reports in PostgreSQL.
- Move media uploads to signed object storage.
- Add rate limits and lobby moderation controls.

## [2026-07-06] — Chrome presenter layout fix

### What Was Implemented
- Used the Chrome plugin against the live Railway URL to reproduce the presenter flow.
- Changed the presenter console to stack the side rail earlier so it does not crop on narrower or scaled Chrome windows.
- Added min-width and overflow wrapping safeguards for panels, long PIN/join-link text, and compact controls.
- Cleared stale live-reconnect notices when the SSE connection opens or receives state.
- Fixed player hash-route changes so opening a different PIN in an already-used player tab resets the stale player session.
- Made join-link PINs take precedence over stored local PINs on initial page load.

### Files Modified
- `public/styles.css` — responsive presenter layout and overflow hardening.
- `public/app.js` — clears stale live connection retry notice after reconnect/state, resets stale player state on new PIN links, and prioritizes join-link PINs.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- Preserving a non-cropped presenter console is more important than keeping the side rail beside the main console at medium desktop widths.

### Known Issues / Deferred
- Active live sessions are still in memory and reset on deployment.

### Suggested Next Steps
- Add automated Chrome viewport checks for presenter and player routes before each deploy.

## [2026-07-06] — PostgreSQL live session snapshots

### What Was Implemented
- Added PostgreSQL persistence for active live session snapshots.
- Hydrated sessions from PostgreSQL on session API and SSE requests to avoid orphaning PINs after Railway restarts or process changes.
- Preserved local SSE clients when refreshing a session from the database.

### Files Modified
- `server.mjs` — `live_sessions` table, session serialization, persistence, hydration, and async session lookups.
- `README.md` — updated architecture and scale notes.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- Snapshot persistence is the fastest acceptable production hardening step before a full normalized sessions/answers schema.

### Known Issues / Deferred
- Cross-instance SSE fanout still needs Redis, WebSockets with an adapter, or a room actor service for very large audiences.
- Concurrent writes use last-write-wins JSON snapshots instead of transactional per-answer rows.

### Suggested Next Steps
- Normalize live sessions, players, answers, and reports into relational tables.
- Add a pub/sub layer for cross-instance live updates.

## [2026-07-06] — Portrait desktop builder layout fix

### What Was Implemented
- Made the build-deck screen single-column at all widths so the secondary Limits panel cannot be clipped in portrait desktop windows.
- Kept side rails available only for host/player views on very wide screens.
- Added a max-width fallback and horizontal overflow guard for the page shell.

### Files Modified
- `public/app.js` — adds specific layout classes for builder, host, and player screens.
- `public/styles.css` — defaults layouts to single-column, only enabling side rails for host/player at very wide widths.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- Builder usability and fitting the desktop portrait shell is more important than keeping the Limits panel beside the editor.

### Known Issues / Deferred
- No automated visual regression suite yet for the desktop portrait shell size.

### Suggested Next Steps
- Add Chrome viewport checks for desktop portrait, desktop landscape, and mobile.

## [2026-07-06] — Landscape desktop builder layout fix

### What Was Implemented
- Increased the page shell max width so landscape desktop uses available space instead of staying in a narrow centered column.
- Re-enabled the build-deck side rail only at very wide widths where it can fit inside the viewport.

### Files Modified
- `public/styles.css` — wider page shell and landscape-safe builder side rail breakpoint.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- The landscape desktop view should use more horizontal space while portrait desktop remains single-column.

### Known Issues / Deferred
- Chrome plugin viewport cannot be resized from this session, so live Chrome verification is done at the available Chrome viewport plus CSS breakpoint inspection.

### Suggested Next Steps
- Add scripted viewport visual checks outside the plugin for 1080x1800 and 2048x1152.

## [2026-07-06] — Builder form row clipping fix

### What Was Implemented
- Fixed the question editor row that still clipped in the desktop app shell by stacking `Type`, `Text`, `Points`, and `Remove` below 1500px instead of waiting until mobile width.
- Added shrink guards for form labels, question-head children, and option-row children.
- Removed global horizontal clipping so layout bugs are not silently hidden.
- Added safer max-width behavior for builder inputs, selects, and textareas.

### Files Modified
- `public/styles.css` — desktop-app-width builder form layout and clipping fixes.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- At desktop-app landscape widths, a stacked editor row is preferable to a compact horizontal row that risks clipping.

### Known Issues / Deferred
- A formal viewport regression suite is still not in place.

### Suggested Next Steps
- Add automated checks for the exact desktop app viewport sizes shown in screenshots.

## [2026-07-06] — Fluid adaptive layout pass

### What Was Implemented
- Replaced orientation-specific layout tuning with fluid auto-fit grid columns.
- Added viewport-driven page gutters so desktop app, landscape browser, portrait desktop, and mobile widths use proportional spacing.
- Added container-query behavior for the question editor row so `Type`, `Text`, `Points`, and `Remove` adapt to the actual card width.
- Added explicit page background/min-height handling so the app surface fills the browser area consistently.

### Files Modified
- `public/app.js` — added stable field classes for adaptive editor layout.
- `public/styles.css` — fluid page shell, auto-fit grids, and container-query editor layout.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- A component/container-based layout is preferable to maintaining separate portrait and landscape breakpoints.

### Known Issues / Deferred
- Automated visual regression tests still need to be added for the exact desktop shell dimensions.

### Suggested Next Steps
- Add a small scripted Chrome viewport audit that fails if any important panel extends beyond the viewport.

## [2026-07-06] — Builder single-column production fix

### What Was Implemented
- Forced the builder route into a single adaptive column instead of allowing the secondary Limits panel to sit beside the editor.
- Capped the builder working width to a readable editor surface that stays inside desktop app portrait and landscape shells.

### Files Modified
- `public/styles.css` — builder-specific grid override and max working width.
- `PROJECT_LOG.md` — task record.

### Assumptions Made (flag these for review)
- The builder should prioritize fitting and editor readability over side-by-side secondary panels.

### Known Issues / Deferred
- Host/player screens still use adaptive multi-column layout where space permits.

### Suggested Next Steps
- Add automated production viewport checks before deploy.

## [2026-07-07] - Live lobby lifecycle and player controller fix

### What Was Implemented
- Made the home, lobby, host, and player shader backgrounds visibly animated with faster drift and brighter live-game color values.
- Removed the `EN-GB` language pill from the join screen and removed the related CSS selector.
- Added a dedicated player waiting lobby after PIN/name join with the PIN, player count, and score.
- Split the live experience into clearly labeled Presenter and Player sections.
- Changed the player live question view into a strict four-button answer controller with score pinned at the bottom left.
- Added presenter top-right primary flow controls: Start, Next, Reveal, and Next based on live phase.
- Added server-side online presence checks for presenter and players using the live event stream connection.
- Required presenter authentication on host event streams before counting the presenter as online.
- Kicked players back to the home page with `The presenter has left the presentation.` when the presenter disconnects.
- Removed disconnected players from presenter-side player lists and answer tracking after a short reconnect grace period.

### Files Modified
- `public/app.js` - player lobby, four-button answer controller, presenter primary action button, and presenter-left client redirect.
- `public/styles.css` - animated shader background tuning, role badges, player controller grid, and score dock styles.
- `server.mjs` - presenter/player connection presence, authenticated presenter event streams, presenter-left session ending, and player disconnect cleanup.
- `PROJECT_LOG.md` - task record.

### Assumptions Made (flag these for review)
- The current vanilla static app should keep a CSS shader implementation instead of installing `@shadergradient/react`, `three`, and React Three dependencies, because adding them would require a React/Three migration rather than a small production fix.
- A short reconnect grace period is acceptable so a refresh does not instantly end a host session or remove a player.

### Known Issues / Deferred
- The CSS shader mimics the supplied ShaderGradient colors and motion but is not the React ShaderGradient WebGL component.
- A full visual regression suite is still deferred.

### Suggested Next Steps
- Add automated production viewport checks for home, host lobby, player lobby, presenter question, player answer, and presenter-left redirect.
