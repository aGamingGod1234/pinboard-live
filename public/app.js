const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const DEFAULT_POINTS = 1000;
const DEFAULT_OPTIONS = ["Red", "Blue", "Gold", "Green"];
const OPTION_TONES = ["0", "1", "2", "3", "4", "5"];
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
  playerPin: localStorage.getItem(STORAGE_KEYS.playerPin) ?? getHashParam("pin") ?? "",
  presenterEmail: "",
  presenterPassword: "",
  nickname: "",
  session: null,
  remote: null,
  restoreKey: "",
  draft: createDraft(),
  eventSource: null,
  error: "",
  notice: ""
};

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
  if (!button || button.tagName !== "BUTTON") {
    return;
  }

  const action = button.dataset.action;
  try {
    clearMessages();

    if (action === "go-home") setMode("home");
    if (action === "go-presenter") setMode("presenter");
    if (action === "go-player") setMode("player");
    if (action === "add-question") addQuestion();
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
  app.innerHTML = `
    ${renderTopbar()}
    <main class="view">
      ${renderMessages()}
      ${state.mode === "presenter" ? renderPresenter() : ""}
      ${state.mode === "player" ? renderPlayer() : ""}
      ${state.mode === "home" ? renderHome() : ""}
    </main>
  `;
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
  return `
    <section class="hero-grid">
      <div class="hero-panel">
        <div>
          <h1 class="hero-title">Live quizzes without the maze.</h1>
          <p class="hero-copy">Create a tiny deck, share a PIN, collect answers, reveal the board, move on.</p>
          <div class="mode-grid">
            <div class="mode-tile"><strong>Slides</strong><span>Content-only moments between questions.</span></div>
            <div class="mode-tile"><strong>Quiz</strong><span>Correct answer plus configurable points.</span></div>
            <div class="mode-tile"><strong>Poll</strong><span>Free selections without scoring.</span></div>
          </div>
        </div>
      </div>
      <form class="join-panel panel" data-action="join">
        <h2 class="panel-title">Join a session</h2>
        <label>PIN <input name="pin" inputmode="numeric" maxlength="6" value="${escapeHtml(state.playerPin)}" data-field="playerPin" /></label>
        <label>Name <input name="nickname" maxlength="32" value="${escapeHtml(state.nickname)}" data-field="nickname" /></label>
        <button type="submit">Join</button>
      </form>
    </section>
  `;
}

function renderPresenter() {
  if (!state.hostToken) {
    return `
      <section class="panel">
        <form class="stack" data-action="auth">
          <h1 class="panel-title">Presenter access</h1>
          <label>Email <input type="email" autocomplete="username" data-field="presenterEmail" value="${escapeHtml(state.presenterEmail)}" /></label>
          <label>Password <input type="password" autocomplete="current-password" data-field="presenterPassword" value="${escapeHtml(state.presenterPassword)}" /></label>
          <button type="submit">Unlock</button>
        </form>
      </section>
    `;
  }

  if (state.session) {
    return renderHostConsole();
  }

  return `
    <section class="layout">
      <form class="stack" data-action="create-session">
        <div class="panel">
          <div class="panel-header">
            <h1 class="panel-title">Build deck</h1>
            <button type="button" class="secondary" data-action="add-question">Add item</button>
          </div>
          <label>Deck title <input data-field="deckTitle" maxlength="120" value="${escapeHtml(state.draft.title)}" /></label>
        </div>
        ${state.draft.questions.map(renderQuestionEditor).join("")}
        <div class="panel">
          <button type="submit">Host live</button>
        </div>
      </form>
      <aside class="panel stack">
        <h2 class="panel-title">Limits</h2>
        <p class="muted">Media is checked at 100 MB per item. Player joins have no app-level cap in this prototype.</p>
        <button type="button" class="secondary" data-action="reset-deck">Reset draft</button>
      </aside>
    </section>
  `;
}

function renderQuestionEditor(question, index) {
  const isSlide = question.kind === "slide";
  const isPoll = question.kind === "poll";

  return `
    <article class="question-card">
      <div class="question-head">
        <label>Type
          <select data-field="questionKind" data-question-id="${question.id}">
            ${renderSelectOption("quiz", "Quiz", question.kind)}
            ${renderSelectOption("poll", "Poll", question.kind)}
            ${renderSelectOption("slide", "Slide", question.kind)}
          </select>
        </label>
        <label>Text
          <textarea data-field="questionText" data-question-id="${question.id}" maxlength="500">${escapeHtml(question.text)}</textarea>
        </label>
        <label>Points
          <input type="number" min="0" max="1000000" step="100" ${isSlide || isPoll ? "disabled" : ""} data-field="points" data-question-id="${question.id}" value="${question.points}" />
        </label>
        <button type="button" class="ghost" data-action="remove-question" data-question-id="${question.id}" ${state.draft.questions.length === 1 ? "disabled" : ""}>Remove</button>
      </div>
      <label>Media
        <input type="file" accept="image/*,video/*" data-field="media" data-question-id="${question.id}" />
      </label>
      ${question.media ? `<p class="muted">${escapeHtml(question.media.name)} · ${formatBytes(question.media.size)}</p>` : ""}
      ${isSlide ? "" : renderOptionEditor(question, isPoll)}
      <p class="muted">Item ${index + 1} of ${state.draft.questions.length}</p>
    </article>
  `;
}

function renderOptionEditor(question, isPoll) {
  return `
    <div class="option-list">
      ${question.options.map((option) => `
        <div class="option-row">
          <input type="radio" name="correct-${question.id}" data-field="correctOption" data-question-id="${question.id}" value="${option.id}" ${option.id === question.correctOptionId ? "checked" : ""} ${isPoll ? "disabled" : ""} aria-label="Correct answer" />
          <input data-field="optionText" data-question-id="${question.id}" data-option-id="${option.id}" maxlength="140" value="${escapeHtml(option.text)}" />
        </div>
      `).join("")}
    </div>
  `;
}

function renderHostConsole() {
  const remote = state.remote ?? state.session;
  const question = remote.currentQuestion;
  const joinLink = getJoinLink(remote.pin);

  return `
    <section class="layout">
      <div class="stack">
        <div class="panel">
          <div class="panel-header">
            <div>
              <p class="muted">PIN</p>
              <div class="pin">${remote.pin}</div>
            </div>
            <div class="nav-actions">
              <button type="button" class="secondary" data-action="copy-link">Copy join link</button>
              <button type="button" class="ghost" data-action="host-end" ${remote.phase === "ended" ? "disabled" : ""}>End</button>
            </div>
          </div>
          <p class="muted">${escapeHtml(joinLink)}</p>
        </div>
        <div class="status-grid">
          <div class="stat"><span>Players</span><strong>${remote.playerCount}</strong></div>
          <div class="stat"><span>Answers</span><strong>${remote.answerCount}</strong></div>
          <div class="stat"><span>Phase</span><strong>${formatPhase(remote.phase)}</strong></div>
          <div class="stat"><span>Item</span><strong>${formatProgress(remote)}</strong></div>
        </div>
        ${question ? renderLiveQuestion(remote, true) : renderLobby(remote)}
        ${renderHostControls(remote)}
      </div>
      <aside class="stack">
        <section class="panel">
          <h2 class="panel-title">Leaderboard</h2>
          ${renderLeaderboard(remote.leaderboard)}
        </section>
        <section class="panel">
          <h2 class="panel-title">Recent players</h2>
          <div class="leaderboard">
            ${remote.recentPlayers.map((player) => `<div class="leader-row"><span></span><strong>${escapeHtml(player.nickname)}</strong><span>${player.score}</span></div>`).join("") || `<p class="muted">Waiting for players.</p>`}
          </div>
        </section>
      </aside>
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
    <div class="panel nav-actions">
      <button type="button" data-action="host-start" ${remote.phase !== "lobby" ? "disabled" : ""}>Start</button>
      <button type="button" data-action="host-open" ${remote.phase !== "question" || isSlide ? "disabled" : ""}>Open answers</button>
      <button type="button" data-action="host-reveal" ${remote.phase !== "answering" ? "disabled" : ""}>Reveal</button>
      <button type="button" data-action="host-next" ${remote.phase !== "results" && !(remote.phase === "question" && isSlide) ? "disabled" : ""}>Next</button>
    </div>
  `;
}

function renderPlayer() {
  if (!state.playerId || !state.remote) {
    return `
      <section class="panel">
        <form class="stack" data-action="join">
          <h1 class="panel-title">Join</h1>
          <div class="field-grid">
            <label>PIN <input inputmode="numeric" maxlength="6" data-field="playerPin" value="${escapeHtml(state.playerPin)}" /></label>
            <label>Name <input maxlength="32" data-field="nickname" value="${escapeHtml(state.nickname)}" /></label>
          </div>
          <button type="submit">Join</button>
        </form>
      </section>
    `;
  }

  const remote = state.remote;
  return `
    <section class="layout">
      <div class="stack">
        <div class="panel">
          <div class="panel-header">
            <div>
              <h1 class="panel-title">${escapeHtml(remote.title)}</h1>
              <p class="muted">PIN ${remote.pin} · ${escapeHtml(remote.me?.nickname ?? "")} · ${remote.me?.score ?? 0} points</p>
            </div>
          </div>
        </div>
        ${remote.currentQuestion ? renderLiveQuestion(remote, false) : renderLobby(remote)}
      </div>
      <aside class="panel">
        <h2 class="panel-title">Leaderboard</h2>
        ${renderLeaderboard(remote.leaderboard)}
      </aside>
    </section>
  `;
}

function renderLiveQuestion(remote, isHost) {
  const question = remote.currentQuestion;
  const selectedOptionId = remote.selectedOptionId;
  const answerTotal = Math.max(1, Object.values(remote.answerCounts ?? {}).reduce((sum, count) => sum + count, 0));
  const canAnswer = !isHost && remote.phase === "answering" && question.kind !== "slide" && !selectedOptionId;

  return `
    <section class="current-slide">
      <p class="muted">${formatQuestionLabel(question, remote)}</p>
      <h1>${escapeHtml(question.text)}</h1>
      ${renderMedia(question.media)}
      ${question.kind === "slide" ? "" : `
        <div class="answer-grid">
          ${question.options.map((option, index) => {
            const count = remote.answerCounts?.[option.id] ?? 0;
            const isSelected = selectedOptionId === option.id;
            const isCorrect = remote.phase !== "answering" && option.id === question.correctOptionId;
            const isWrong = remote.phase !== "answering" && isSelected && option.id !== question.correctOptionId;
            return `
              <button type="button" class="answer-button ${isSelected ? "is-selected" : ""} ${isCorrect ? "is-correct" : ""} ${isWrong ? "is-wrong" : ""}" data-tone="${OPTION_TONES[index] ?? "0"}" data-action="answer" data-option-id="${option.id}" ${canAnswer ? "" : "disabled"}>
                <strong>${escapeHtml(option.text)}</strong>
                ${isHost || remote.phase === "results" ? `<span class="bar" style="transform: scaleX(${count / answerTotal})"></span>` : ""}
              </button>
            `;
          }).join("")}
        </div>
      `}
    </section>
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
      points: Number(question.points),
      options: question.kind === "slide" ? [] : question.options,
      correctOptionId: question.kind === "quiz" ? question.correctOptionId : null,
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
    state.playerPin = pin;
    state.remote = response.session;
    connectEvents(pin, "player", state.playerId);
    render();
  } catch {
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
    state.remote = JSON.parse(event.data);
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
    question.kind = target.value;
    if (question.kind !== "quiz") question.points = 0;
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
  state.draft.questions.push(createQuestion());
  render();
}

function removeQuestion(questionId) {
  state.draft.questions = state.draft.questions.filter((question) => question.id !== questionId);
  if (state.draft.questions.length === 0) {
    state.draft.questions.push(createQuestion());
  }
  render();
}

function resetDeck() {
  state.session = null;
  state.remote = null;
  state.draft = createDraft();
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
  const options = DEFAULT_OPTIONS.map((text) => ({ id: crypto.randomUUID(), text }));
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

function findQuestion(questionId) {
  return state.draft.questions.find((question) => question.id === questionId);
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
  const type = question.kind === "quiz" ? `${question.points} points` : question.kind;
  return `${formatProgress(remote)} · ${type}`;
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
