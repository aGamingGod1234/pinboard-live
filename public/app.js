const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp", "video/mp4", "video/ogg", "video/webm"]);
const DEFAULT_POINTS = 1000;
const DEFAULT_OPTIONS = ["Red", "Blue", "Gold", "Green"];
const TRUE_FALSE_OPTIONS = ["True", "False"];
const QUESTION_KINDS = ["quiz", "true_false", "slide"];
const OPTION_TONES = ["red", "blue", "gold", "green", "purple", "teal"];
const OPTION_SHAPES = ["triangle", "diamond", "circle", "square", "star", "hexagon"];
const LIVE_RECONNECT_NOTICE = "Live connection is retrying.";
const MESSAGE_AUTO_DISMISS_MS = 4200;
const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const STORAGE_KEYS = {
  presenterSession: "pinboard.presenterSession",
  playerId: "pinboard.playerId",
  playerPin: "pinboard.playerPin"
};

const app = document.querySelector("#app");
const state = {
  mode: getInitialMode(),
  hostToken: localStorage.getItem(STORAGE_KEYS.presenterSession) ?? "",
  playerId: localStorage.getItem(STORAGE_KEYS.playerId) ?? "",
  playerPin: getHashParam("pin") ?? localStorage.getItem(STORAGE_KEYS.playerPin) ?? "",
  presenterEmail: "",
  presenterPassword: "",
  googleClientId: "",
  googleScriptPromise: null,
  nickname: "",
  session: null,
  remote: null,
  restoreKey: "",
  draft: createDraft(),
  activeQuestionId: "",
  eventSource: null,
  error: "",
  notice: "",
  messageTimer: null
};

state.activeQuestionId = state.draft.questions[0]?.id ?? "";
render();
void loadPublicConfig();
void restorePlayerIfPossible();

window.addEventListener("hashchange", () => {
  const nextMode = getInitialMode();
  const hashPin = getHashParam("pin");
  const nextPin = normalizeStoredPin(hashPin);
  const currentPin = normalizeStoredPin(state.playerPin);

  if (nextMode === "player" && nextPin && nextPin !== currentPin) {
    state.playerId = "";
    state.remote = null;
    state.restoreKey = "";
    localStorage.removeItem(STORAGE_KEYS.playerId);
  }

  state.mode = nextMode;
  state.playerPin = hashPin ?? state.playerPin;
  render();
  void restorePlayerIfPossible();
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const action = form.dataset.action;

  try {
    clearMessages();

    if (action === "auth") {
      await authenticatePresenter();
    }

    if (action === "create-session") {
      await createSession();
    }

    if (action === "join") {
      await joinSession();
    }
  } catch (error) {
    showError(error);
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  try {
    clearMessages();

    if (action === "go-home") setMode("home");
    if (action === "go-presenter") setMode("presenter");
    if (action === "go-player") setMode("player");
    if (action === "add-question") addQuestion();
    if (action === "select-question") selectQuestion(button.dataset.questionId);
    if (action === "remove-question") removeQuestion(button.dataset.questionId);
    if (action === "choose-media") chooseMedia(button.dataset.questionId);
    if (action === "copy-link") await copyJoinLink();
    if (action === "reset-deck") resetDeck();
    if (action === "host-start") await hostAction("start");
    if (action === "host-open") await hostAction("open");
    if (action === "host-reveal") await hostAction("reveal");
    if (action === "host-next") await hostAction("next");
    if (action === "host-end") await hostAction("end");
    if (action === "answer") await submitAnswer(button.dataset.optionId);
  } catch (error) {
    showError(error);
  }
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
    return;
  }

  updateFromInput(target);
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    return;
  }

  try {
    if (target.dataset.field === "media") {
      await attachMedia(target);
    } else {
      updateFromInput(target);
    }
  } catch (error) {
    showError(error);
  }
});

function render() {
  const isImmersive = shouldUseImmersiveShell();
  app.className = `app-shell ${isImmersive ? "app-shell-immersive" : ""}`;
  app.innerHTML = `
    ${isImmersive ? "" : renderTopbar()}
    <main class="${isImmersive ? "stage-view" : "view"}">
      <div class="message-layer" data-message-layer>${renderMessages()}</div>
      ${state.mode === "presenter" ? renderPresenter() : ""}
      ${state.mode === "player" ? renderPlayer() : ""}
      ${state.mode === "home" ? renderHome() : ""}
    </main>
  `;

  if (isImmersive) {
    requestAnimationFrame(() => window.scrollTo(0, 0));
    if (state.mode === "presenter" && state.hostToken && !state.session) {
      requestAnimationFrame(syncCreatorScrollTracking);
    }
  } else if (state.mode === "presenter" && state.hostToken && !state.session) {
    requestAnimationFrame(syncCreatorScrollTracking);
  }

  if (state.mode === "presenter" && !state.hostToken) {
    requestAnimationFrame(() => {
      void syncGoogleSignInButton();
    });
  }
}

function shouldUseImmersiveShell() {
  if (state.mode === "home" || state.mode === "player" || state.mode === "presenter") {
    return true;
  }
  return Boolean(state.session);
}

function renderTopbar() {
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <span>Pinboard Live</span>
      </div>
      <nav class="nav-actions" aria-label="Primary">
        <button class="ghost" type="button" data-action="go-home">Home</button>
        <button class="secondary" type="button" data-action="go-presenter">Presenter</button>
        <button type="button" data-action="go-player">Join</button>
      </nav>
    </header>
  `;
}

function renderMessages() {
  return `
    ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
    ${state.notice ? `<p class="notice">${escapeHtml(state.notice)}</p>` : ""}
  `;
}

function renderHome() {
  return renderJoinScreen(true);
}

function renderPresenter() {
  if (!state.hostToken) {
    return renderPresenterLogin();
  }

  if (state.session) {
    return renderHostConsole();
  }

  return renderCreator();
}

function renderJoinScreen(showPresenterLink = false) {
  return `
    <section class="shader-screen shader-purple join-screen" data-motion-trigger="ambient-drift">
      <div class="screen-action-row">
        <button class="glass-pill" type="button" data-action="go-presenter">Presenter</button>
      </div>
      <div class="join-center">
        <div class="play-wordmark" aria-label="Pinboard Live">Pinboard<span>!</span></div>
        <form class="join-card" data-action="join">
          <input class="pin-input" name="pin" inputmode="numeric" maxlength="6" placeholder="Game PIN" value="${escapeHtml(state.playerPin)}" data-field="playerPin" aria-label="Game PIN" />
          <input class="nickname-input" name="nickname" maxlength="32" placeholder="Nickname" value="${escapeHtml(state.nickname)}" data-field="nickname" aria-label="Nickname" />
          <button class="join-submit" type="submit">Enter</button>
        </form>
      </div>
      <footer class="join-footer">
        <strong>Create and host for free at Pinboard Live</strong>
        <span>Terms | Privacy | Cookie notice</span>
      </footer>
    </section>
  `;
}

function renderPresenterLogin() {
  return `
    <section class="shader-screen shader-management presenter-login-shell" data-motion-trigger="ambient-drift">
      <div class="login-panel presenter-login-card stack">
        <div>
          <p class="eyebrow">Presenter</p>
          <h1 class="panel-title">Sign in to Pinboard</h1>
          <p class="muted">Create decks, edit questions, and host live sessions.</p>
        </div>
        <div class="google-signin-slot" data-google-signin>
          ${state.googleClientId ? `<button class="google-login-button" type="button" disabled>Loading Google sign-in...</button>` : `<button class="google-login-button" type="button" disabled>Google sign-in is not configured</button>`}
        </div>
        <details class="fallback-login">
          <summary>Email/password fallback</summary>
          <form class="stack" data-action="auth">
        <label>Email <input type="email" autocomplete="username" data-field="presenterEmail" value="${escapeHtml(state.presenterEmail)}" /></label>
        <label>Password <input type="password" autocomplete="current-password" data-field="presenterPassword" value="${escapeHtml(state.presenterPassword)}" /></label>
        <button type="submit">Unlock</button>
          </form>
        </details>
      </div>
    </section>
  `;
}

function renderCreator() {
  return `
    <section class="shader-screen shader-management creator-page" data-motion-trigger="ambient-drift">
      <form class="creator-shell" data-action="create-session">
        <aside class="creator-rail panel">
          <div class="panel-header">
            <h1 class="panel-title">Create</h1>
            <button type="button" class="secondary" data-action="add-question">Add item</button>
          </div>
          <div class="question-strip">
            ${state.draft.questions.map((question, index) => `
              <button class="question-mini ${question.id === state.activeQuestionId ? "is-active" : ""}" type="button" data-action="select-question" data-question-id="${question.id}" data-question-mini="${question.id}" aria-current="${question.id === state.activeQuestionId ? "true" : "false"}">
                <span class="question-mini-icon">${index + 1}</span>
                <strong>${escapeHtml(question.text || "Untitled item")}</strong>
                <small>${escapeHtml(getQuestionTypeLabel(question.kind))}</small>
              </button>
            `).join("")}
          </div>
        </aside>
        <div class="creator-main stack" data-creator-main>
          <div class="panel deck-panel">
            <label>Deck title <input data-field="deckTitle" maxlength="120" value="${escapeHtml(state.draft.title)}" /></label>
          </div>
          ${state.draft.questions.map(renderQuestionEditor).join("")}
          <div class="panel creator-launch">
            <button type="submit">Host live</button>
          </div>
        </div>
        <aside class="creator-inspector panel stack">
          <div>
            <p class="eyebrow">Limits</p>
            <h2 class="panel-title">Ready for live play</h2>
          </div>
          <p class="muted">Media is checked at 100 MB per item. Player joins have no app-level cap in this prototype.</p>
          <button type="button" class="secondary" data-action="reset-deck">Reset draft</button>
        </aside>
      </form>
    </section>
  `;
}

function renderQuestionEditor(question, index) {
  const isSlide = question.kind === "slide";
  const mediaLabel = question.media ? `
      <label>Media
        <input type="file" accept="image/*,video/*" data-field="media" data-question-id="${question.id}" />
      </label>
      <p class="muted">${escapeHtml(question.media.name)} - ${formatBytes(question.media.size)}</p>
    ` : `
      <button type="button" class="secondary media-add-button" data-action="choose-media" data-question-id="${question.id}">Add media</button>
      <input class="hidden" type="file" accept="image/*,video/*" data-field="media" data-question-id="${question.id}" />
    `;

  return `
    <article class="question-card creator-question ${question.id === state.activeQuestionId ? "is-active" : ""}" data-question-card="${question.id}">
      <div class="question-head">
        <label class="question-field question-field-type">Type
          <select data-field="questionKind" data-question-id="${question.id}">
            ${renderSelectOption("quiz", "Quiz", question.kind)}
            ${renderSelectOption("true_false", "True or false", question.kind)}
            ${renderSelectOption("slide", "Slide", question.kind)}
          </select>
        </label>
        <label class="question-field question-field-text">Text
          <textarea data-field="questionText" data-question-id="${question.id}" maxlength="500">${escapeHtml(question.text)}</textarea>
        </label>
        <label class="question-field question-field-points">Points
          <input type="number" min="0" max="1000000" step="100" ${isSlide ? "disabled" : ""} data-field="points" data-question-id="${question.id}" value="${question.points}" />
        </label>
        <button type="button" class="ghost remove-question" data-action="remove-question" data-question-id="${question.id}" ${state.draft.questions.length === 1 ? "disabled" : ""}>Remove</button>
      </div>
      ${mediaLabel}
      ${isSlide ? "" : renderOptionEditor(question)}
      <p class="muted">Item ${index + 1} of ${state.draft.questions.length}</p>
    </article>
  `;
}

function renderOptionEditor(question) {
  return `
    <div class="option-list">
      ${question.options.map((option, index) => `
        <div class="option-row" data-tone="${OPTION_TONES[index] ?? "red"}">
          <input type="radio" name="correct-${escapeHtml(question.id)}" data-field="correctOption" data-question-id="${escapeHtml(question.id)}" value="${escapeHtml(option.id)}" ${option.id === question.correctOptionId ? "checked" : ""} aria-label="Correct answer" />
          <span class="answer-shape" data-shape="${OPTION_SHAPES[index] ?? "circle"}" aria-hidden="true"></span>
          <input data-field="optionText" data-question-id="${escapeHtml(question.id)}" data-option-id="${escapeHtml(option.id)}" maxlength="140" value="${escapeHtml(option.text)}" />
        </div>
      `).join("")}
    </div>
  `;
}

function renderHostConsole() {
  const remote = state.remote ?? state.session;
  if (remote.phase === "lobby") {
    return renderHostLobby(remote);
  }

  return renderPresenterStage(remote);
}

function renderHostLobby(remote) {
  const joinLink = getJoinLink(remote.pin);
  const publicJoinPath = `${location.host}${location.pathname}#player`;

  return `
    <section class="shader-screen shader-blue host-lobby" data-motion-trigger="ambient-drift">
      ${renderStageBar(remote, "lobby")}
      <div class="lobby-pin-card">
        <div class="join-instructions">
          <span>Join at</span>
          <a href="${escapeHtml(joinLink)}">${escapeHtml(publicJoinPath)}</a>
          <span>or use the Pinboard Live app screen.</span>
        </div>
        <div class="pin-divider" aria-hidden="true"></div>
        <div class="game-pin-block">
          <span>Game PIN:</span>
          <strong>${formatPin(remote.pin)}</strong>
        </div>
        <button class="qr-tile" type="button" data-action="copy-link" aria-label="Copy join link">
          ${renderJoinCodeArt(remote.pin)}
        </button>
      </div>
      <div class="lobby-center">
        <div class="play-wordmark play-wordmark-small">Pinboard<span>!</span><em>live</em></div>
        <div class="waiting-pill">Waiting for participants<span class="waiting-dots" aria-hidden="true"></span></div>
      </div>
      <div class="participant-dock">
        <div class="dock-stat"><span>Players</span><strong>${remote.playerCount}</strong></div>
        ${renderParticipantList(remote)}
      </div>
    </section>
  `;
}

function renderPresenterStage(remote) {
  const question = remote.currentQuestion;

  return `
    <section class="shader-screen shader-live-host presenter-stage" data-motion-trigger="ambient-drift">
      ${renderStageBar(remote, "question")}
      ${renderPresenterStageBody(remote, question)}
    </section>
  `;
}

function renderPresenterStageBody(remote, question) {
  if (remote.phase === "ended") {
    return renderPodium(remote.leaderboard);
  }

  if (remote.phase === "results") {
    return `
      ${question ? renderLiveQuestion(remote, true) : renderLobby(remote)}
      ${renderLeaderboardBreak(remote)}
    `;
  }

  return question ? renderLiveQuestion(remote, true) : renderLobby(remote);
}

function renderLobby(remote) {
  return `
    <section class="current-slide">
      <p class="muted">Lobby</p>
      <h1>${escapeHtml(remote.title)}</h1>
      <p class="muted">Players join with PIN ${remote.pin}.</p>
    </section>
  `;
}

function renderHostControls(remote) {
  const question = remote.currentQuestion;
  const isSlide = question?.kind === "slide";
  return `
    <div class="host-controls">
      <button type="button" data-action="host-start" ${remote.phase !== "lobby" ? "disabled" : ""}>Start</button>
      <button type="button" data-action="host-open" ${remote.phase !== "question" || isSlide ? "disabled" : ""}>Open answers</button>
      <button type="button" data-action="host-reveal" ${remote.phase !== "answering" ? "disabled" : ""}>Reveal</button>
      <button type="button" data-action="host-next" ${remote.phase !== "results" && !(remote.phase === "question" && isSlide) ? "disabled" : ""}>Next</button>
    </div>
  `;
}

function renderPlayer() {
  if (!state.playerId || !state.remote) {
    return renderJoinScreen(false);
  }

  const remote = state.remote;
  if (!remote.currentQuestion || remote.phase === "lobby") {
    return renderPlayerWaiting(remote);
  }

  return renderPlayerAnswerStage(remote);
}

function renderLeaderboardBreak(remote) {
  return `
    <section class="leaderboard-break">
      <div>
        <p class="eyebrow">Leaderboard</p>
        <h2>Current scores</h2>
      </div>
      ${renderLeaderboard(remote.leaderboard)}
      <div class="leaderboard-callouts">
        <span>Highest climber: ${escapeHtml(remote.leaderboard[0]?.nickname ?? "Waiting")}</span>
        <span>Best streak: ${escapeHtml(remote.leaderboard[1]?.nickname ?? remote.leaderboard[0]?.nickname ?? "Waiting")}</span>
      </div>
    </section>
  `;
}

function renderPodium(players) {
  const top = [...players].slice(0, 3);
  const first = top[0];
  const second = top[1];
  const third = top[2];

  return `
    <section class="podium-screen">
      <div class="play-wordmark play-wordmark-small">Pinboard<span>!</span></div>
      <h1>Final podium</h1>
      <div class="podium-steps">
        ${renderPodiumPlace(second, 2)}
        ${renderPodiumPlace(first, 1)}
        ${renderPodiumPlace(third, 3)}
      </div>
    </section>
  `;
}

function renderPodiumPlace(player, place) {
  return `
    <div class="podium-place podium-place-${place}">
      <strong>${place}</strong>
      <span>${escapeHtml(player?.nickname ?? "Empty")}</span>
      <em>${player?.score ?? 0}</em>
    </div>
  `;
}

function renderPlayerWaiting(remote) {
  return `
    <section class="shader-screen shader-waiting player-waiting" data-motion-trigger="ambient-drift">
      <div class="role-badge">Player lobby</div>
      <div class="player-ready-card">
        <div class="play-wordmark play-wordmark-small">Pinboard<span>!</span></div>
        <p class="eyebrow">PIN ${formatPin(remote.pin)}</p>
        <h1>You're in</h1>
        <p>${escapeHtml(remote.me?.nickname ?? "Player")} - wait for the presenter to start.</p>
        <div class="dock-stat"><span>Players</span><strong>${remote.playerCount}</strong></div>
        <div class="dock-stat"><span>Score</span><strong>${remote.me?.score ?? 0}</strong></div>
      </div>
    </section>
  `;
}

function renderPlayerAnswerStage(remote) {
  const question = remote.currentQuestion;
  const selectedOptionId = remote.selectedOptionId;
  const canAnswer = remote.phase === "answering" && question.kind !== "slide" && !selectedOptionId;
  const isCorrect = remote.phase === "results" && selectedOptionId === question.correctOptionId;
  const earnedPoints = isCorrect ? question.points : 0;

  return `
    <section class="shader-screen shader-player player-stage player-answer-stage" data-motion-trigger="ambient-drift">
      <div class="role-badge">Player</div>
      <div class="player-round-chip">${formatProgress(remote)} ${escapeHtml(getQuestionTypeLabel(question.kind))}</div>
      ${question.kind === "slide" ? `
        <div class="player-ready-card">
          <h1>Look up</h1>
          <p>The presenter is showing a slide.</p>
        </div>
      ` : `
        <div class="player-answer-grid">
          ${question.options.map((option, index) => {
            const isSelected = selectedOptionId === option.id;
            const showResults = remote.phase === "results" || remote.phase === "ended";
            const optionCorrect = showResults && option.id === question.correctOptionId;
            const optionWrong = showResults && isSelected && option.id !== question.correctOptionId;
            return `
              <button type="button" class="answer-button player-answer-button ${isSelected ? "is-selected" : ""} ${optionCorrect ? "is-correct" : ""} ${optionWrong ? "is-wrong" : ""}" data-tone="${OPTION_TONES[index] ?? "red"}" data-action="answer" data-option-id="${escapeHtml(option.id)}" ${canAnswer ? "" : "disabled"}>
                <span class="answer-shape" data-shape="${OPTION_SHAPES[index] ?? "circle"}" aria-hidden="true"></span>
              </button>
            `;
          }).join("")}
        </div>
      `}
      <div class="player-score-dock">
        <strong>${escapeHtml(remote.me?.nickname ?? "Player")}</strong>
        <span>${remote.me?.score ?? 0}</span>
        ${earnedPoints ? `<em>+${earnedPoints}</em>` : ""}
      </div>
    </section>
  `;
}

function renderLiveQuestion(remote, isHost) {
  const question = remote.currentQuestion;
  const selectedOptionId = remote.selectedOptionId;
  const answerTotal = Math.max(1, Object.values(remote.answerCounts ?? {}).reduce((sum, count) => sum + count, 0));
  const canAnswer = !isHost && remote.phase === "answering" && question.kind !== "slide" && !selectedOptionId;
  const showResults = remote.phase === "results" || remote.phase === "ended";

  return `
    <section class="current-slide live-question ${isHost ? "host-question" : "player-question"}">
      <div class="question-meta-row">
        <span>${formatQuestionLabel(question, remote)}</span>
        <strong>${remote.answerCount} answers</strong>
      </div>
      <h1>${escapeHtml(question.text)}</h1>
      ${isHost ? renderPresenterQuestionFrame(question, remote) : `<div class="question-media-frame">${renderMedia(question.media)}</div>`}
      ${question.kind === "slide" ? "" : `
        <div class="answer-grid">
          ${question.options.map((option, index) => {
            const count = remote.answerCounts?.[option.id] ?? 0;
            const isSelected = selectedOptionId === option.id;
            const isCorrect = showResults && option.id === question.correctOptionId;
            const isWrong = showResults && isSelected && option.id !== question.correctOptionId;
            return `
              <button type="button" class="answer-button ${isSelected ? "is-selected" : ""} ${isCorrect ? "is-correct" : ""} ${isWrong ? "is-wrong" : ""}" data-tone="${OPTION_TONES[index] ?? "red"}" data-action="answer" data-option-id="${escapeHtml(option.id)}" ${canAnswer ? "" : "disabled"}>
                <span class="answer-shape" data-shape="${OPTION_SHAPES[index] ?? "circle"}" aria-hidden="true"></span>
                <strong>${escapeHtml(option.text)}</strong>
                ${isHost || remote.phase === "results" ? `<span class="answer-count">${count}</span><span class="bar" style="transform: scaleX(${count / answerTotal})"></span>` : ""}
              </button>
            `;
          }).join("")}
        </div>
      `}
    </section>
  `;
}

function renderPresenterQuestionFrame(question, remote) {
  if (!question.media) {
    return "";
  }

  return `
    <div class="presenter-question-frame presenter-question-frame-media">
      <div class="presenter-media-display">
        ${renderMedia(question.media)}
      </div>
      <div class="host-answer-meter">
        <strong>${remote.answerCount}</strong>
        <span>Answers</span>
      </div>
    </div>
  `;
}

function renderMedia(media) {
  if (!media) {
    return "";
  }

  const src = escapeHtml(media.dataUrl);
  if (media.type.startsWith("video/")) {
    return `<video class="media-preview" src="${src}" controls></video>`;
  }

  return `<img class="media-preview" src="${src}" alt="" />`;
}

function renderLeaderboard(players) {
  if (!players.length) {
    return "";
  }

  return `
    <div class="leaderboard">
      ${players.map((player) => `
        <div class="leader-row">
          <span>${player.rank}</span>
          <strong>${escapeHtml(player.nickname)}</strong>
          <span>${player.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSelectOption(value, label, selectedValue) {
  return `<option value="${value}" ${value === selectedValue ? "selected" : ""}>${label}</option>`;
}

function renderStageBar(remote, variant) {
  return `
    <header class="stage-bar">
      <button class="stage-brand" type="button" data-action="go-presenter" aria-label="Back to presenter">
        <span>Pinboard<span>!</span></span>
        <em>${variant === "lobby" ? "live" : formatPhase(remote.phase)}</em>
      </button>
      <div class="stage-tools" aria-label="Host tools">
        <span class="role-badge role-badge-inline">Presenter</span>
        <span>${remote.playerCount}</span>
        <button type="button" data-action="copy-link">Copy link</button>
        ${renderStagePrimaryButton(remote)}
        <button type="button" data-action="host-end" ${remote.phase === "ended" ? "disabled" : ""}>End</button>
      </div>
    </header>
  `;
}

function renderStagePrimaryButton(remote) {
  const action = getStagePrimaryAction(remote);
  if (!action) {
    return "";
  }

  return `<button class="stage-next-button" type="button" data-action="${action.action}">${action.label}</button>`;
}

function getStagePrimaryAction(remote) {
  const question = remote.currentQuestion;
  const isSlide = question?.kind === "slide";

  if (remote.phase === "lobby") return { action: "host-start", label: "Start" };
  if (remote.phase === "question") return isSlide ? { action: "host-next", label: "Next" } : { action: "host-open", label: "Next" };
  if (remote.phase === "answering") return { action: "host-reveal", label: "Reveal" };
  if (remote.phase === "results") return { action: "host-next", label: "Next" };
  return null;
}

function renderParticipantList(remote) {
  if (!remote.recentPlayers.length) {
    return "";
  }

  return `
    <div class="participant-list">
      ${remote.recentPlayers.slice(0, 8).map((player) => `
        <span>${escapeHtml(player.nickname)}</span>
      `).join("")}
    </div>
  `;
}

function renderJoinCodeArt(pin) {
  const seed = pin.split("").reduce((sum, digit, index) => sum + Number(digit) * (index + 3), 17);
  const cells = Array.from({ length: 64 }, (_, index) => {
    const active = (seed + index * 7 + Math.floor(index / 8) * 11) % 5 !== 0;
    return `<span class="${active ? "is-on" : ""}"></span>`;
  }).join("");

  return `<span class="qr-grid" aria-hidden="true">${cells}</span><span class="copy-icon" aria-hidden="true"></span><strong>Copy link</strong>`;
}

async function authenticatePresenter() {
  const response = await postJson("/api/auth", {
    email: state.presenterEmail,
    password: state.presenterPassword
  });
  acceptPresenterSession();
  state.presenterPassword = "";
  showNotice("Presenter unlocked.");
  render();
}

async function loadPublicConfig() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json();
    state.googleClientId = typeof config.googleClientId === "string" ? config.googleClientId : "";
    if (state.mode === "presenter" && !state.hostToken) {
      render();
    }
  } catch {
    state.googleClientId = "";
  }
}

async function syncGoogleSignInButton() {
  const slot = document.querySelector("[data-google-signin]");
  if (!slot || !state.googleClientId || slot.dataset.ready === "true") {
    return;
  }

  await loadGoogleIdentityScript();
  if (!window.google?.accounts?.id || !document.body.contains(slot)) {
    return;
  }

  window.google.accounts.id.initialize({
    client_id: state.googleClientId,
    callback: handleGoogleCredential
  });
  slot.innerHTML = "";
  window.google.accounts.id.renderButton(slot, {
    theme: "filled_black",
    size: "large",
    type: "standard",
    text: "continue_with",
    shape: "rectangular",
    width: Math.min(360, Math.max(240, Math.round(slot.getBoundingClientRect().width || 320)))
  });
  slot.dataset.ready = "true";
}

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }

  if (state.googleScriptPromise) {
    return state.googleScriptPromise;
  }

  state.googleScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GOOGLE_IDENTITY_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error("Google sign-in could not be loaded.")), { once: true });
    document.head.append(script);
  });

  return state.googleScriptPromise;
}

async function handleGoogleCredential(result) {
  try {
    clearMessages();
    const credential = typeof result?.credential === "string" ? result.credential : "";
    if (!credential) {
      throw new Error("Google sign-in did not return a credential.");
    }
    const response = await postJson("/api/auth/google", { credential });
    acceptPresenterSession();
    showNotice("Presenter unlocked.");
    render();
  } catch (error) {
    showError(error);
  }
}

function acceptPresenterSession() {
  state.hostToken = "1";
  localStorage.removeItem("pinboard.hostToken");
  localStorage.setItem(STORAGE_KEYS.presenterSession, state.hostToken);
}

function clearPresenterSession() {
  state.hostToken = "";
  state.session = null;
  state.remote = null;
  localStorage.removeItem(STORAGE_KEYS.presenterSession);
  localStorage.removeItem("pinboard.hostToken");
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

async function createSession() {
  const payload = {
    title: state.draft.title,
    questions: state.draft.questions.map((question) => ({
      kind: question.kind,
      text: question.text,
      points: question.kind === "slide" ? 0 : Number(question.points),
      options: question.kind === "slide" ? [] : question.options,
      correctOptionId: isScoredQuestionKind(question.kind) ? question.correctOptionId : null,
      media: question.media
    }))
  };

  const response = await postJson("/api/sessions", payload);
  state.session = response.session;
  state.remote = response.session;
  connectEvents(response.pin, "host", null);
  render();
}

async function joinSession() {
  const pin = normalizePinInput(state.playerPin);
  const response = await postJson(`/api/sessions/${pin}/join`, { nickname: state.nickname });
  state.playerId = response.playerId;
  state.playerPin = pin;
  state.remote = response.session;
  state.restoreKey = `${pin}:${state.playerId}`;
  state.notice = "";
  localStorage.setItem(STORAGE_KEYS.playerId, state.playerId);
  localStorage.setItem(STORAGE_KEYS.playerPin, state.playerPin);
  setMode("player");
  connectEvents(pin, "player", state.playerId);
  render();
}

async function restorePlayerIfPossible() {
  const pin = normalizeStoredPin(state.playerPin);
  const restoreKey = `${pin}:${state.playerId}`;

  if (state.mode !== "player" || state.remote || !pin || !state.playerId || state.restoreKey === restoreKey) {
    return;
  }

  state.restoreKey = restoreKey;

  try {
    const response = await postJson(`/api/sessions/${pin}/resume`, {});
    if (state.restoreKey !== restoreKey || state.mode !== "player") {
      return;
    }
    state.playerPin = pin;
    state.remote = response.session;
    connectEvents(pin, "player", state.playerId);
    render();
  } catch {
    if (state.restoreKey !== restoreKey || state.remote?.pin === pin) {
      return;
    }
    localStorage.removeItem(STORAGE_KEYS.playerId);
    state.playerId = "";
    state.notice = "Join again to enter this live session.";
    render();
  }
}

async function hostAction(action) {
  if (!state.remote?.pin) {
    throw new Error("No hosted session is active.");
  }
  const response = await postJson(`/api/sessions/${state.remote.pin}/${action}`, {});
  state.remote = response.session;
  render();
}

async function submitAnswer(optionId) {
  if (!state.remote?.pin || !state.playerId) {
    throw new Error("Join a session before answering.");
  }
  const response = await postJson(`/api/sessions/${state.remote.pin}/answer`, {
    optionId
  });
  state.remote = response.session;
  render();
}

async function postJson(url, payload) {
  const headers = { "Content-Type": "application/json" };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = body.error ?? "Request failed.";
    if (response.status === 401 && isPresenterRequest(url)) {
      clearPresenterSession();
      state.mode = "presenter";
      location.hash = "presenter";
      state.notice = "Presenter session expired. Sign in again.";
      render();
    }
    throw new Error(message);
  }

  return body;
}

function isPresenterRequest(url) {
  return url === "/api/sessions" || /^\/api\/sessions\/\d{6}\/(?:start|open|reveal|next|end)$/.test(url);
}

function connectEvents(pin, role, playerId) {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const params = new URLSearchParams({ pin, role });

  state.eventSource = new EventSource(`/events?${params.toString()}`);
  state.eventSource.addEventListener("open", () => {
    if (state.notice === LIVE_RECONNECT_NOTICE) {
      state.notice = "";
      render();
    }
  });
  state.eventSource.addEventListener("state", (event) => {
    const nextState = JSON.parse(event.data);
    if (role === "player" && nextState.endedReason === "presenter_left") {
      return leavePresentationWithNotice("The presenter has left the presentation.");
    }

    state.remote = nextState;
    if (state.notice === LIVE_RECONNECT_NOTICE) {
      state.notice = "";
    }
    render();
  });
  state.eventSource.onerror = () => {
    if (state.notice !== LIVE_RECONNECT_NOTICE) {
      state.notice = LIVE_RECONNECT_NOTICE;
      render();
    }
  };
}

function updateFromInput(target) {
  const field = target.dataset.field;
  const questionId = target.dataset.questionId;
  const optionId = target.dataset.optionId;

  if (field === "presenterEmail") state.presenterEmail = target.value;
  if (field === "presenterPassword") state.presenterPassword = target.value;
  if (field === "playerPin") state.playerPin = target.value.replace(/\D/g, "").slice(0, 6);
  if (field === "nickname") state.nickname = target.value;
  if (field === "deckTitle") state.draft.title = target.value;

  if (!questionId) {
    return;
  }

  const question = findQuestion(questionId);
  if (!question) {
    return;
  }

  if (field === "questionKind") {
    applyQuestionKind(question, target.value);
  }
  if (field === "questionText") question.text = target.value;
  if (field === "points") question.points = Number(target.value);
  if (field === "correctOption") question.correctOptionId = target.value;
  if (field === "optionText") {
    const option = question.options.find((item) => item.id === optionId);
    if (option) option.text = target.value;
  }

  render();
}

async function attachMedia(target) {
  const question = findQuestion(target.dataset.questionId);
  const file = target.files?.[0];

  if (!question || !file) {
    return;
  }

  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error("Media must be 100 MB or smaller.");
  }
  if (!ALLOWED_MEDIA_TYPES.has(file.type)) {
    throw new Error("Media type is not supported.");
  }

  question.media = {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    dataUrl: await readFileAsDataUrl(file)
  };
  render();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(new Error("Media could not be read.")));
    reader.readAsDataURL(file);
  });
}

function addQuestion() {
  const question = createQuestion();
  state.draft.questions.push(question);
  state.activeQuestionId = question.id;
  render();
  requestAnimationFrame(() => selectQuestion(question.id));
}

function removeQuestion(questionId) {
  state.draft.questions = state.draft.questions.filter((question) => question.id !== questionId);
  if (state.draft.questions.length === 0) {
    state.draft.questions.push(createQuestion());
  }
  if (!findQuestion(state.activeQuestionId)) {
    state.activeQuestionId = state.draft.questions[0]?.id ?? "";
  }
  render();
}

function resetDeck() {
  state.session = null;
  state.remote = null;
  state.draft = createDraft();
  state.activeQuestionId = state.draft.questions[0]?.id ?? "";
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  render();
}

async function copyJoinLink() {
  if (!state.remote?.pin) {
    throw new Error("No join link is available.");
  }
  await navigator.clipboard.writeText(getJoinLink(state.remote.pin));
  showNotice("Join link copied.");
}

function chooseMedia(questionId) {
  document.querySelector(`input[type="file"][data-field="media"][data-question-id="${CSS.escape(questionId ?? "")}"]`)?.click();
}

function setMode(mode) {
  state.mode = mode;
  location.hash = mode === "home" ? "" : mode;
  render();
}

function createDraft() {
  return {
    title: "Untitled live deck",
    questions: [createQuestion()]
  };
}

function createQuestion() {
  const options = createOptions(DEFAULT_OPTIONS);
  return {
    id: crypto.randomUUID(),
    kind: "quiz",
    text: "What should this question ask?",
    points: DEFAULT_POINTS,
    options,
    correctOptionId: options[0].id,
    media: null
  };
}

function leavePresentationWithNotice(message) {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  localStorage.removeItem(STORAGE_KEYS.playerId);
  state.playerId = "";
  state.remote = null;
  state.restoreKey = "";
  state.mode = "home";
  state.notice = message;
  location.hash = "";
  render();
}

function createOptions(labels) {
  return labels.map((text) => ({ id: crypto.randomUUID(), text }));
}

function applyQuestionKind(question, kind) {
  if (!QUESTION_KINDS.includes(kind) || question.kind === kind) {
    return;
  }

  question.kind = kind;

  if (kind === "slide") {
    question.points = 0;
    question.correctOptionId = null;
    return;
  }

  if (kind === "true_false") {
    question.options = createOptions(TRUE_FALSE_OPTIONS);
    question.correctOptionId = question.options[0].id;
    question.points = question.points > 0 ? question.points : DEFAULT_POINTS;
    return;
  }

  if (question.options.length < 3 || isTrueFalseOptionSet(question.options)) {
    question.options = createOptions(DEFAULT_OPTIONS);
  }

  question.points = question.points > 0 ? question.points : DEFAULT_POINTS;
  if (!question.options.some((option) => option.id === question.correctOptionId)) {
    question.correctOptionId = question.options[0]?.id ?? null;
  }
}

function isTrueFalseOptionSet(options) {
  return options.length === TRUE_FALSE_OPTIONS.length && options.every((option, index) => option.text === TRUE_FALSE_OPTIONS[index]);
}

function findQuestion(questionId) {
  return state.draft.questions.find((question) => question.id === questionId);
}

function selectQuestion(questionId) {
  const question = findQuestion(questionId);
  if (!question) {
    return;
  }

  setActiveQuestionId(question.id);
  requestAnimationFrame(() => {
    const main = document.querySelector("[data-creator-main]");
    const card = document.querySelector(`[data-question-card="${CSS.escape(question.id)}"]`);
    if (!(main instanceof HTMLElement) || !(card instanceof HTMLElement)) {
      return;
    }

    main.scrollTo({ top: Math.max(0, card.offsetTop - main.offsetTop), behavior: "auto" });
    updateCreatorSelection();
  });
}

function syncCreatorScrollTracking() {
  const main = document.querySelector("[data-creator-main]");
  if (!(main instanceof HTMLElement)) {
    return;
  }

  main.onscroll = updateActiveQuestionFromScroll;
  updateCreatorSelection();
}

function updateActiveQuestionFromScroll() {
  const main = document.querySelector("[data-creator-main]");
  const cards = [...document.querySelectorAll("[data-question-card]")];
  if (!(main instanceof HTMLElement) || cards.length === 0) {
    return;
  }

  const mainTop = main.getBoundingClientRect().top;
  const closest = cards.reduce((best, card) => {
    if (!(card instanceof HTMLElement)) {
      return best;
    }
    const rect = card.getBoundingClientRect();
    const distance = Math.abs(rect.top - mainTop);
    return !best || distance < best.distance ? { id: card.dataset.questionCard, distance } : best;
  }, null);

  setActiveQuestionId(closest?.id ?? "");
}

function setActiveQuestionId(questionId) {
  if (!questionId || state.activeQuestionId === questionId) {
    updateCreatorSelection();
    return;
  }

  state.activeQuestionId = questionId;
  updateCreatorSelection();
}

function updateCreatorSelection() {
  for (const mini of document.querySelectorAll("[data-question-mini]")) {
    const isActive = mini.dataset.questionMini === state.activeQuestionId;
    mini.classList.toggle("is-active", isActive);
    mini.setAttribute("aria-current", isActive ? "true" : "false");
  }

  for (const card of document.querySelectorAll("[data-question-card]")) {
    card.classList.toggle("is-active", card.dataset.questionCard === state.activeQuestionId);
  }
}

function getInitialMode() {
  const mode = location.hash.replace("#", "").split("?")[0];
  if (mode === "presenter" || mode === "player") {
    return mode;
  }
  return "home";
}

function getHashParam(name) {
  const query = location.hash.split("?")[1] ?? "";
  return new URLSearchParams(query).get(name);
}

function getJoinLink(pin) {
  return `${location.origin}${location.pathname}#player?pin=${pin}`;
}

function normalizePinInput(pin) {
  const normalized = pin.replace(/\D/g, "");
  if (!/^\d{6}$/.test(normalized)) {
    throw new Error("PIN must be 6 digits.");
  }
  return normalized;
}

function normalizeStoredPin(pin) {
  const normalized = String(pin ?? "").replace(/\D/g, "");
  return /^\d{6}$/.test(normalized) ? normalized : "";
}

function formatPhase(phase) {
  const labels = {
    lobby: "Lobby",
    question: "Question",
    answering: "Answering",
    results: "Results",
    ended: "Ended"
  };
  return labels[phase] ?? phase;
}

function formatProgress(remote) {
  if (remote.currentQuestionIndex < 0) {
    return `0/${remote.questionCount}`;
  }
  return `${remote.currentQuestionIndex + 1}/${remote.questionCount}`;
}

function formatQuestionLabel(question, remote) {
  const type = question.kind === "slide" ? "Slide" : `${question.points} points`;
  return `${formatProgress(remote)} - ${type}`;
}

function formatPin(pin) {
  return String(pin).replace(/^(\d{3})(\d{3})$/, "$1 $2");
}

function getQuestionTypeLabel(kind) {
  const labels = {
    quiz: "Quiz",
    true_false: "True or false",
    slide: "Slide"
  };
  return labels[kind] ?? kind;
}

function isScoredQuestionKind(kind) {
  return kind === "quiz" || kind === "true_false";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function clearMessages() {
  state.error = "";
  state.notice = "";
  clearMessageTimer();
  syncMessages();
}

function showError(error) {
  state.error = error instanceof Error ? error.message : "Something went wrong.";
  syncMessages();
  scheduleMessageDismiss();
}

function showNotice(message) {
  state.notice = message;
  syncMessages();
  scheduleMessageDismiss();
}

function syncMessages() {
  const layer = document.querySelector("[data-message-layer]");
  if (layer) {
    layer.innerHTML = renderMessages();
  }
}

function scheduleMessageDismiss() {
  clearMessageTimer();
  state.messageTimer = window.setTimeout(() => {
    state.error = "";
    state.notice = "";
    syncMessages();
  }, MESSAGE_AUTO_DISMISS_MS);
}

function clearMessageTimer() {
  if (state.messageTimer) {
    window.clearTimeout(state.messageTimer);
    state.messageTimer = null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
