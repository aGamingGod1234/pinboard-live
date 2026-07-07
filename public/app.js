const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const DEFAULT_POINTS = 1000;
const DEFAULT_OPTIONS = ["Red", "Blue", "Gold", "Green"];
const TRUE_FALSE_OPTIONS = ["True", "False"];
const QUESTION_KINDS = ["quiz", "true_false", "slide"];
const OPTION_TONES = ["red", "blue", "gold", "green", "purple", "teal"];
const OPTION_SHAPES = ["triangle", "diamond", "circle", "square", "star", "hexagon"];
const LIVE_RECONNECT_NOTICE = "Live connection is retrying.";
const STORAGE_KEYS = {
  hostToken: "pinboard.hostToken",
  playerId: "pinboard.playerId",
  playerPin: "pinboard.playerPin"
};

const app = document.querySelector("#app");
const state = {
  mode: getInitialMode(),
  hostToken: localStorage.getItem(STORAGE_KEYS.hostToken) ?? "",
  playerId: localStorage.getItem(STORAGE_KEYS.playerId) ?? "",
  playerPin: getHashParam("pin") ?? localStorage.getItem(STORAGE_KEYS.playerPin) ?? "",
  presenterEmail: "",
  presenterPassword: "",
  nickname: "",
  session: null,
  remote: null,
  restoreKey: "",
  draft: createDraft(),
  activeQuestionId: "",
  eventSource: null,
  error: "",
  notice: ""
};

state.activeQuestionId = state.draft.questions[0]?.id ?? "";
render();
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
      ${renderMessages()}
      ${state.mode === "presenter" ? renderPresenter() : ""}
      ${state.mode === "player" ? renderPlayer() : ""}
      ${state.mode === "home" ? renderHome() : ""}
    </main>
  `;

  if (isImmersive) {
    requestAnimationFrame(() => window.scrollTo(0, 0));
  } else if (state.mode === "presenter" && state.hostToken && !state.session) {
    requestAnimationFrame(syncCreatorScrollTracking);
  }
}

function shouldUseImmersiveShell() {
  if (state.mode === "home" || state.mode === "player") {
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
        ${showPresenterLink ? `<button class="glass-pill" type="button" data-action="go-presenter">Presenter</button>` : ""}
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
    <section class="presenter-login-shell">
      <form class="panel presenter-login-card stack" data-action="auth">
        <div>
          <p class="eyebrow">Presenter</p>
          <h1 class="panel-title">Unlock your live decks</h1>
        </div>
        <label>Email <input type="email" autocomplete="username" data-field="presenterEmail" value="${escapeHtml(state.presenterEmail)}" /></label>
        <label>Password <input type="password" autocomplete="current-password" data-field="presenterPassword" value="${escapeHtml(state.presenterPassword)}" /></label>
        <button type="submit">Unlock</button>
      </form>
    </section>
  `;
}

function renderCreator() {
  return `
    <section class="creator-page">
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
      <label>Media
        <input type="file" accept="image/*,video/*" data-field="media" data-question-id="${question.id}" />
      </label>
      ${question.media ? `<p class="muted">${escapeHtml(question.media.name)} - ${formatBytes(question.media.size)}</p>` : ""}
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
          <input type="radio" name="correct-${question.id}" data-field="correctOption" data-question-id="${question.id}" value="${option.id}" ${option.id === question.correctOptionId ? "checked" : ""} aria-label="Correct answer" />
          <span class="answer-shape" data-shape="${OPTION_SHAPES[index] ?? "circle"}" aria-hidden="true"></span>
          <input data-field="optionText" data-question-id="${question.id}" data-option-id="${option.id}" maxlength="140" value="${escapeHtml(option.text)}" />
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
          <strong>${escapeHtml(publicJoinPath)}</strong>
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
      <div class="host-start-cluster">
        <button class="lock-button" type="button" data-action="copy-link" aria-label="Copy join link">Link</button>
        <button class="start-button" type="button" data-action="host-start">Start</button>
      </div>
      <div class="lobby-center">
        <div class="play-wordmark play-wordmark-small">Pinboard<span>!</span><em>live</em></div>
        <div class="waiting-pill">Waiting for participants</div>
        <p class="lobby-link">${escapeHtml(joinLink)}</p>
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
      <div class="stage-status-strip">
        <div><span>Players</span><strong>${remote.playerCount}</strong></div>
        <div><span>Answers</span><strong>${remote.answerCount}</strong></div>
        <div><span>Phase</span><strong>${formatPhase(remote.phase)}</strong></div>
        <div><span>Item</span><strong>${formatProgress(remote)}</strong></div>
      </div>
      ${question ? renderLiveQuestion(remote, true) : renderLobby(remote)}
      <div class="stage-bottom-row">
        ${renderHostControls(remote)}
        <section class="leaderboard-panel">
          <h2>Leaderboard</h2>
          ${renderLeaderboard(remote.leaderboard)}
        </section>
      </div>
    </section>
  `;
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
              <button type="button" class="answer-button player-answer-button ${isSelected ? "is-selected" : ""} ${optionCorrect ? "is-correct" : ""} ${optionWrong ? "is-wrong" : ""}" data-tone="${OPTION_TONES[index] ?? "red"}" data-action="answer" data-option-id="${option.id}" ${canAnswer ? "" : "disabled"}>
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

  return `
    <section class="current-slide live-question ${isHost ? "host-question" : "player-question"}">
      <div class="question-meta-row">
        <span>${formatQuestionLabel(question, remote)}</span>
        <strong>${formatPhase(remote.phase)}</strong>
      </div>
      <h1>${escapeHtml(question.text)}</h1>
      ${isHost ? renderPresenterQuestionFrame(question, remote) : `<div class="question-media-frame">${renderMedia(question.media)}</div>`}
      ${question.kind === "slide" ? "" : `
        <div class="answer-grid">
          ${question.options.map((option, index) => {
            const count = remote.answerCounts?.[option.id] ?? 0;
            const isSelected = selectedOptionId === option.id;
            const isCorrect = remote.phase !== "answering" && option.id === question.correctOptionId;
            const isWrong = remote.phase !== "answering" && isSelected && option.id !== question.correctOptionId;
            return `
              <button type="button" class="answer-button ${isSelected ? "is-selected" : ""} ${isCorrect ? "is-correct" : ""} ${isWrong ? "is-wrong" : ""}" data-tone="${OPTION_TONES[index] ?? "red"}" data-action="answer" data-option-id="${option.id}" ${canAnswer ? "" : "disabled"}>
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
  const phaseLabel = {
    question: "Ready",
    answering: "Open",
    results: "Done",
    ended: "Done"
  }[remote.phase] ?? "Live";

  return `
    <div class="presenter-question-frame">
      <div class="host-timer-orb" aria-label="Question status">${phaseLabel}</div>
      <div class="presenter-media-display">
        ${question.media ? renderMedia(question.media) : `
          <div class="presenter-media-placeholder" aria-hidden="true">
            <span class="placeholder-mark">Pinboard<span>!</span></span>
            <span class="placeholder-lines"></span>
          </div>
        `}
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

  if (media.type.startsWith("video/")) {
    return `<video class="media-preview" src="${media.dataUrl}" controls></video>`;
  }

  return `<img class="media-preview" src="${media.dataUrl}" alt="" />`;
}

function renderLeaderboard(players) {
  if (!players.length) {
    return `<p class="muted">No scores yet.</p>`;
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
    return `<p class="dock-empty">No one has joined yet.</p>`;
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

  return `<span class="qr-grid" aria-hidden="true">${cells}</span><strong>Copy link</strong>`;
}

async function authenticatePresenter() {
  const response = await postJson("/api/auth", {
    email: state.presenterEmail,
    password: state.presenterPassword
  });
  state.hostToken = response.hostToken;
  state.presenterPassword = "";
  localStorage.setItem(STORAGE_KEYS.hostToken, state.hostToken);
  state.notice = "Presenter unlocked.";
  render();
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

  const response = await postJson("/api/sessions", payload, true);
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
    const response = await postJson(`/api/sessions/${pin}/resume`, { playerId: state.playerId });
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
  const response = await postJson(`/api/sessions/${state.remote.pin}/${action}`, {}, true);
  state.remote = response.session;
  render();
}

async function submitAnswer(optionId) {
  if (!state.remote?.pin || !state.playerId) {
    throw new Error("Join a session before answering.");
  }
  const response = await postJson(`/api/sessions/${state.remote.pin}/answer`, {
    playerId: state.playerId,
    optionId
  });
  state.remote = response.session;
  render();
}

async function postJson(url, payload, includeHostToken = false) {
  const headers = { "Content-Type": "application/json" };
  if (includeHostToken) {
    headers["X-Host-Token"] = state.hostToken;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error ?? "Request failed.");
  }

  return body;
}

function connectEvents(pin, role, playerId) {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const params = new URLSearchParams({ pin, role });
  if (playerId) {
    params.set("playerId", playerId);
  }

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
    render();
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
  state.notice = "Join link copied.";
  render();
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
}

function showError(error) {
  state.error = error instanceof Error ? error.message : "Something went wrong.";
  render();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
