const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const DEFAULT_POINTS = 1000;
const DEFAULT_OPTIONS = ["Red", "Blue", "Gold", "Green"];
const TRUE_FALSE_OPTIONS = ["True", "False"];
const QUESTION_KINDS = ["quiz", "true_false", "slide"];
const OPTION_TONES = ["red", "blue", "gold", "green", "purple", "teal"];
const OPTION_SHAPES = ["triangle", "diamond", "circle", "square", "star", "hexagon"];
const GAME_PIN_DIGIT_COUNT = 6;
const FORMATTED_PIN_MAX_LENGTH = 7;
const LIVE_RECONNECT_NOTICE = "Live connection is retrying.";
const MESSAGE_AUTO_DISMISS_MS = 4200;
const MOTION_EXIT_MS = 130;
const MOTION_ENTER_MS = 440;
const COUNT_ANIMATION_MS = 720;
const AUTO_SAVE_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_TITLE_LENGTH = 120;
const PRESENTATION_PATH_PREFIX = "/presentation";
const PRESENTATION_LOGIN_PATH = `${PRESENTATION_PATH_PREFIX}/login`;
const PRESENTATION_HOME_PATH = `${PRESENTATION_PATH_PREFIX}/homepage`;
const PREVIEW_TONE_CLASSES = ["preview-tone-blue", "preview-tone-red", "preview-tone-gold", "preview-tone-green", "preview-tone-purple", "preview-tone-teal"];
const PREVIEW_TONE_RULES = [
  { tone: "preview-tone-teal", words: ["science", "lab", "biology", "chemistry", "physics", "medical", "health"] },
  { tone: "preview-tone-blue", words: ["math", "number", "data", "code", "tech", "software", "screenshot"] },
  { tone: "preview-tone-gold", words: ["history", "geography", "culture", "world", "lesson"] },
  { tone: "preview-tone-green", words: ["business", "product", "prod", "sales", "startup", "market"] },
  { tone: "preview-tone-red", words: ["art", "design", "color", "music", "media"] },
  { tone: "preview-tone-purple", words: ["quiz", "game", "trivia", "challenge"] }
];
const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const STORAGE_KEYS = {
  hostToken: "pinboard.hostToken",
  keepSignedIn: "pinboard.keepSignedIn",
  playerId: "pinboard.playerId",
  playerPin: "pinboard.playerPin",
  pendingPresentationId: "pinboard.pendingPresentationId"
};

const app = document.querySelector("#app");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const motionQueue = {
  busy: false,
  pending: null,
  lastSignature: ""
};
const numberMemory = new Map();
const state = {
  mode: getInitialMode(),
  hostToken: readStoredHostToken(),
  keepSignedIn: localStorage.getItem(STORAGE_KEYS.keepSignedIn) !== "false",
  presenter: null,
  presenterLoading: false,
  presentations: [],
  presentationsLoaded: false,
  presentationsLoading: false,
  activePresentationId: "",
  activePresentationUpdatedAt: "",
  pendingPresentationId: getPresentationRouteId(),
  managementMenuId: "",
  presentationDirty: false,
  savingPresentation: false,
  lastSavedAt: "",
  autosaveTimer: null,
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

if (state.pendingPresentationId && !state.hostToken) {
  sessionStorage.setItem(STORAGE_KEYS.pendingPresentationId, state.pendingPresentationId);
  updateBrowserUrl(PRESENTATION_LOGIN_PATH, { replace: true });
}

state.activeQuestionId = state.draft.questions[0]?.id ?? "";
render();
void loadPublicConfig();
void restorePlayerIfPossible();
void restorePresenterIfPossible();

window.addEventListener("hashchange", syncRouteStateFromLocation);
window.addEventListener("popstate", syncRouteStateFromLocation);

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

    if (action === "go-home") {
      await navigateMode("home");
      return;
    }
    if (action === "go-presenter") {
      await navigateMode("presenter");
      return;
    }
    if (action === "go-player") {
      await navigateMode("player");
      return;
    }
    if (action === "create-presentation") await createPresentation();
    if (action === "open-presentation") await openPresentation(button.dataset.presentationId);
    if (action === "toggle-presentation-menu") {
      togglePresentationMenu(button.dataset.presentationId);
      return;
    }
    if (action === "rename-presentation") {
      await renamePresentation(button.dataset.presentationId);
      return;
    }
    if (action === "duplicate-presentation") {
      await duplicatePresentation(button.dataset.presentationId);
      return;
    }
    if (action === "delete-presentation") {
      await deletePresentation(button.dataset.presentationId);
      return;
    }
    if (action === "save-presentation") await savePresentation();
    if (action === "back-to-projects") await backToProjects();
    if (action === "sign-out-presenter") signOutPresenter();
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

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    void flushAutosave();
  }
});

function render() {
  motionQueue.pending = buildRenderPayload();
  void flushMotionQueue();
}

function buildRenderPayload() {
  const isImmersive = shouldUseImmersiveShell();
  const signature = getMotionSignature(isImmersive);
  return {
    isImmersive,
    signature,
    html: `
    ${isImmersive ? "" : renderTopbar()}
    <main class="${isImmersive ? "stage-view" : "view"}">
      <div class="motion-page" data-motion-page data-motion-key="${escapeHtml(signature)}">
        <div class="message-layer" data-message-layer>${renderMessages()}</div>
        ${state.mode === "presenter" ? renderPresenter() : ""}
        ${state.mode === "player" ? renderPlayer() : ""}
        ${state.mode === "home" ? renderHome() : ""}
      </div>
    </main>
  `
  };
}

async function flushMotionQueue() {
  if (motionQueue.busy) {
    return;
  }

  motionQueue.busy = true;

  while (motionQueue.pending) {
    const payload = motionQueue.pending;
    motionQueue.pending = null;
    const shouldTransition = shouldTransitionTo(payload.signature);

    if (shouldTransition) {
      app.classList.add("app-shell-exiting");
      await delay(MOTION_EXIT_MS);
      if (motionQueue.pending) {
        continue;
      }
    }

    commitRender(payload, shouldTransition);
  }

  motionQueue.busy = false;
}

function shouldTransitionTo(signature) {
  return Boolean(motionQueue.lastSignature && motionQueue.lastSignature !== signature && !reducedMotionQuery.matches);
}

function commitRender(payload, isTransition) {
  const transitionClass = isTransition ? " app-shell-entering" : "";
  app.className = `app-shell ${payload.isImmersive ? "app-shell-immersive" : ""}${transitionClass}`;
  app.innerHTML = payload.html;
  motionQueue.lastSignature = payload.signature;

  if (isTransition) {
    window.setTimeout(() => {
      app.classList.remove("app-shell-entering");
    }, MOTION_ENTER_MS);
  }

  if (payload.isImmersive) {
    requestAnimationFrame(() => window.scrollTo(0, 0));
    if (state.mode === "presenter" && state.hostToken && state.activePresentationId && !state.session) {
      requestAnimationFrame(syncCreatorScrollTracking);
    }
  } else if (state.mode === "presenter" && state.hostToken && state.activePresentationId && !state.session) {
    requestAnimationFrame(syncCreatorScrollTracking);
  }

  if (state.mode === "presenter" && !state.hostToken) {
    requestAnimationFrame(() => {
      void syncGoogleSignInButton();
    });
  }

  syncAutosaveTimer();
  requestAnimationFrame(animateCountElements);
}

function getMotionSignature(isImmersive) {
  const remote = state.remote;
  const role = state.mode === "presenter"
    ? state.session ? "host" : state.hostToken ? state.activePresentationId ? "creator" : "dashboard" : "login"
    : state.mode === "player" && state.playerId ? "player-live" : state.mode;
  const questionId = remote?.currentQuestion?.id ?? "none";
  const questionIndex = remote?.currentQuestionIndex ?? -1;
  const phase = remote?.phase ?? "none";
  return [isImmersive ? "immersive" : "standard", state.mode, role, state.activePresentationId || "none", remote?.pin ?? "none", phase, questionIndex, questionId].join("|");
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function renderCount(value, key, className = "", tagName = "span") {
  const numberValue = Number(value) || 0;
  const classAttribute = className ? ` class="${escapeHtml(className)}"` : "";
  return `<${tagName}${classAttribute} data-count-key="${escapeHtml(key)}" data-count-value="${numberValue}">${numberValue}</${tagName}>`;
}

function animateCountElements() {
  const countElements = document.querySelectorAll("[data-count-value]");

  for (const element of countElements) {
    const key = element.dataset.countKey ?? "";
    const toValue = Number(element.dataset.countValue ?? "0") || 0;
    const fromValue = numberMemory.has(key) ? Number(numberMemory.get(key)) || 0 : toValue;
    numberMemory.set(key, toValue);

    if (reducedMotionQuery.matches || fromValue === toValue) {
      element.textContent = String(toValue);
      continue;
    }

    animateNumber(element, fromValue, toValue);
  }
}

function animateNumber(element, fromValue, toValue) {
  const start = performance.now();
  element.classList.add("is-counting");

  function step(timestamp) {
    const elapsed = timestamp - start;
    const progress = Math.min(1, elapsed / COUNT_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    const rawValue = fromValue + ((toValue - fromValue) * eased);
    const currentValue = toValue > fromValue ? Math.ceil(rawValue) : Math.floor(rawValue);
    element.textContent = String(currentValue);

    if (progress < 1) {
      requestAnimationFrame(step);
      return;
    }

    element.textContent = String(toValue);
    element.classList.remove("is-counting");
  }

  requestAnimationFrame(step);
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

function renderPageLink(label, path) {
  const normalizedPath = path || "/";
  const shouldShowPath = normalizedPath !== "/";
  const rootClass = normalizedPath === "/" ? " is-root-link" : "";
  return `
    <a class="page-link-pill${rootClass}" href="${escapeHtml(normalizedPath)}" aria-label="${escapeHtml(label)}">
      <span>${escapeHtml(label)}</span>
      ${shouldShowPath ? `<code>${escapeHtml(normalizedPath)}</code>` : ""}
    </a>
  `;
}

function renderPresenter() {
  if (!state.hostToken) {
    return renderPresenterLogin();
  }

  if (state.session) {
    return renderHostConsole();
  }

  if (!state.presenter) {
    return renderPresenterLoading();
  }

  if (!state.activePresentationId) {
    return renderPresenterDashboard();
  }

  return renderCreator();
}

function renderJoinScreen(showPresenterLink = false) {
  return `
    <section class="shader-screen shader-purple join-screen" data-motion-trigger="ambient-drift">
      <div class="screen-action-row">
        ${renderPageLink("Join page", "/")}
        <button class="glass-pill" type="button" data-action="go-presenter">Presenter</button>
      </div>
      <div class="join-center">
        <div class="play-wordmark" aria-label="Pinboard Live">Pinboard<span>!</span></div>
        <form class="join-card" data-action="join">
          <input class="pin-input" name="pin" inputmode="numeric" maxlength="${FORMATTED_PIN_MAX_LENGTH}" placeholder="Game PIN" value="${escapeHtml(state.playerPin)}" data-field="playerPin" aria-label="Game PIN" />
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
      <div class="screen-action-row">
        ${renderPageLink("Presenter login", PRESENTATION_LOGIN_PATH)}
      </div>
      <div class="login-panel presenter-login-card stack">
        <div>
          <p class="eyebrow">Presenter</p>
          <h1 class="panel-title">Sign in to Pinboard</h1>
          <p class="muted">Use Google to create, save, and host your presentations.</p>
        </div>
        <label class="keep-signed-row">
          <input type="checkbox" data-field="keepSignedIn" ${state.keepSignedIn ? "checked" : ""} />
          <span>Keep me signed in</span>
        </label>
        <div class="google-signin-slot" data-google-signin>
          ${state.googleClientId ? `<button class="google-login-button" type="button" disabled>Loading Google sign-in...</button>` : `<button class="google-login-button" type="button" disabled>Google sign-in is not configured</button>`}
        </div>
      </div>
    </section>
  `;
}

function renderPresenterLoading() {
  return `
    <section class="shader-screen shader-management presenter-dashboard" data-motion-trigger="ambient-drift">
      <div class="dashboard-shell">
        <div class="dashboard-header">
          <div>
            <p class="eyebrow">Presenter</p>
            <h1>Loading projects</h1>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderPresenterDashboard() {
  const displayName = state.presenter?.name || state.presenter?.email || "Presenter";
  const presentations = state.presentationsLoaded ? state.presentations : [];

  return `
    <section class="shader-screen shader-management presenter-dashboard" data-motion-trigger="ambient-drift">
      <div class="dashboard-shell">
        <header class="dashboard-header">
          <div>
            <p class="eyebrow">Presenter projects</p>
            <h1>Welcome back, ${escapeHtml(displayName)}</h1>
            ${renderPageLink("Presentation home", PRESENTATION_HOME_PATH)}
          </div>
          <button class="ghost" type="button" data-action="sign-out-presenter">Sign out</button>
        </header>
        <div class="dashboard-grid">
          <button class="presentation-tile create-presentation-tile" type="button" data-action="create-presentation">
            ${renderPresentationTitleCard({ title: "Untitled presentation", text: "Blank draft" })}
            <span class="presentation-tile-text">
              <strong>Creating new presentation</strong>
              <small>Start from a blank draft.</small>
            </span>
          </button>
          <section class="previous-presentations" aria-labelledby="previous-presentations-title">
            <div class="previous-presentations-head">
              <h2 id="previous-presentations-title">View your previous presentations</h2>
              ${state.presentationsLoading ? `<span>Loading</span>` : `<span>${presentations.length}</span>`}
            </div>
            ${presentations.length ? `
              <div class="presentation-grid">
                ${presentations.map(renderPresentationTile).join("")}
              </div>
            ` : `
              <div class="empty-presentations">
                ${state.presentationsLoaded ? "Saved presentations will appear here." : "Loading saved presentations."}
              </div>
            `}
          </section>
        </div>
      </div>
    </section>
  `;
}

function renderPresentationTile(presentation) {
  const menuIsOpen = state.managementMenuId === presentation.id;
  return `
    <article class="presentation-tile presentation-tile-managed">
      <button class="presentation-open" type="button" data-action="open-presentation" data-presentation-id="${escapeHtml(presentation.id)}">
        ${renderPresentationTitleCard(presentation.titleCard ?? { title: presentation.title, text: "" })}
        <span class="presentation-tile-text">
          <strong>${escapeHtml(presentation.title || "Untitled presentation")}</strong>
          <small>${escapeHtml(formatPresentationMeta(presentation))}</small>
        </span>
      </button>
      <div class="presentation-menu-wrap">
        <button class="presentation-menu-button" type="button" data-action="toggle-presentation-menu" data-presentation-id="${escapeHtml(presentation.id)}" aria-label="Presentation actions" aria-expanded="${menuIsOpen ? "true" : "false"}">...</button>
        ${menuIsOpen ? `
          <div class="presentation-menu" role="menu">
            <button type="button" role="menuitem" data-action="rename-presentation" data-presentation-id="${escapeHtml(presentation.id)}">Rename</button>
            <button type="button" role="menuitem" data-action="duplicate-presentation" data-presentation-id="${escapeHtml(presentation.id)}">Duplicate</button>
            <button class="danger-menu-item" type="button" role="menuitem" data-action="delete-presentation" data-presentation-id="${escapeHtml(presentation.id)}">Delete</button>
          </div>
        ` : ""}
      </div>
    </article>
  `;
}

function renderPresentationTitleCard(card) {
  const toneClass = getPreviewToneClass(card);
  return `
    <span class="presentation-title-card ${escapeHtml(toneClass)}" aria-hidden="true">
      <span class="presentation-preview-kicker">${escapeHtml(getPreviewKicker(card))}</span>
      <strong>${escapeHtml(card.title || "Untitled presentation")}</strong>
      <small>${escapeHtml(card.text || "Blank draft")}</small>
    </span>
  `;
}

function getPreviewToneClass(card) {
  const source = `${card?.title ?? ""} ${card?.text ?? ""}`.toLowerCase();
  const matchedRule = PREVIEW_TONE_RULES.find((rule) => rule.words.some((word) => source.includes(word)));
  if (matchedRule) {
    return matchedRule.tone;
  }

  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash + source.charCodeAt(index) * (index + 1)) % PREVIEW_TONE_CLASSES.length;
  }
  return PREVIEW_TONE_CLASSES[hash];
}

function getPreviewKicker(card) {
  const kind = typeof card?.kind === "string" ? card.kind : "";
  if (kind && QUESTION_KINDS.includes(kind)) {
    return getQuestionTypeLabel(kind);
  }
  return "Deck preview";
}

function renderCreator() {
  return `
    <section class="shader-screen shader-management creator-page" data-motion-trigger="ambient-drift">
      <form class="creator-shell" data-action="create-session">
        <div class="editor-topbar panel">
          <button type="button" class="ghost" data-action="back-to-projects">Back to projects</button>
          <div class="editor-title-block">
            <p class="eyebrow">Presentation editor</p>
            <h1>${escapeHtml(state.draft.title || "Untitled presentation")}</h1>
            <p class="save-status">${escapeHtml(getSaveStatusText())}</p>
            ${renderPageLink("Presentation link", getPresentationPath(state.activePresentationId))}
          </div>
          <div class="editor-actions">
            <button type="button" class="secondary" data-action="save-presentation" ${state.savingPresentation ? "disabled" : ""}>Save</button>
            <button type="submit">Host live</button>
          </div>
        </div>
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
            <label>Deck title <input data-field="deckTitle" maxlength="${MAX_TITLE_LENGTH}" value="${escapeHtml(state.draft.title)}" /></label>
          </div>
          ${state.draft.questions.map(renderQuestionEditor).join("")}
          <div class="panel creator-launch">
            <button type="button" class="secondary" data-action="save-presentation" ${state.savingPresentation ? "disabled" : ""}>Save draft</button>
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
  const publicJoinPath = `${location.host}/#player`;
  const hasPlayers = remote.playerCount > 0;
  const participantLabel = `${remote.playerCount} participant${remote.playerCount === 1 ? "" : "s"} joined`;

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
        <div class="waiting-pill" aria-live="polite">
          ${hasPlayers ? escapeHtml(participantLabel) : `Waiting for participants<span class="waiting-dots" aria-hidden="true"></span>`}
        </div>
        ${renderParticipantList(remote)}
      </div>
      <div class="participant-dock">
        <div class="dock-stat"><span>Players</span>${renderCount(remote.playerCount, `host-lobby-players:${remote.pin}`, "", "strong")}</div>
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
    return renderPodium(remote.leaderboard, remote.pin);
  }

  if (remote.phase === "results") {
    return `
      <div class="results-stack">
        ${question ? renderLiveQuestion(remote, true) : renderLobby(remote)}
        ${renderLeaderboardBreak(remote)}
      </div>
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
      ${renderLeaderboard(remote.leaderboard, `leaderboard:${remote.pin}`)}
      <div class="leaderboard-callouts">
        <span>Highest climber: ${escapeHtml(remote.leaderboard[0]?.nickname ?? "Waiting")}</span>
        <span>Best streak: ${escapeHtml(remote.leaderboard[1]?.nickname ?? remote.leaderboard[0]?.nickname ?? "Waiting")}</span>
      </div>
    </section>
  `;
}

function renderPodium(players, pin = "podium") {
  const top = [...players].slice(0, 3);
  const first = top[0];
  const second = top[1];
  const third = top[2];

  return `
    <section class="podium-screen">
      <div class="play-wordmark play-wordmark-small">Pinboard<span>!</span></div>
      <h1>Final podium</h1>
      <div class="podium-steps">
        ${renderPodiumPlace(second, 2, pin)}
        ${renderPodiumPlace(first, 1, pin)}
        ${renderPodiumPlace(third, 3, pin)}
      </div>
    </section>
  `;
}

function renderPodiumPlace(player, place, pin) {
  const playerKey = player?.id ?? player?.nickname ?? `empty-${place}`;
  return `
    <div class="podium-place podium-place-${place}">
      <strong>${place}</strong>
      <span>${escapeHtml(player?.nickname ?? "Empty")}</span>
      ${renderCount(player?.score ?? 0, `podium:${pin}:${place}:${playerKey}`, "", "em")}
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
        <div class="dock-stat"><span>Players</span>${renderCount(remote.playerCount, `player-lobby-players:${remote.pin}`, "", "strong")}</div>
        <div class="dock-stat"><span>Score</span>${renderCount(remote.me?.score ?? 0, `player-lobby-score:${state.playerId ?? "player"}`, "", "strong")}</div>
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
        ${renderCount(remote.me?.score ?? 0, `player-score:${state.playerId ?? "player"}`)}
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
        <strong>${renderCount(remote.answerCount, `answers:${remote.pin}:${question.id}`)} answers</strong>
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
              <button type="button" class="answer-button ${isSelected ? "is-selected" : ""} ${isCorrect ? "is-correct" : ""} ${isWrong ? "is-wrong" : ""}" data-tone="${OPTION_TONES[index] ?? "red"}" data-action="answer" data-option-id="${option.id}" ${canAnswer ? "" : "disabled"}>
                <span class="answer-shape" data-shape="${OPTION_SHAPES[index] ?? "circle"}" aria-hidden="true"></span>
                <strong>${escapeHtml(option.text)}</strong>
                ${isHost || remote.phase === "results" ? `${renderCount(count, `option:${remote.pin}:${question.id}:${option.id}`, "answer-count")}<span class="bar" style="transform: scaleX(${count / answerTotal})"></span>` : ""}
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
        ${renderCount(remote.answerCount, `host-meter:${remote.pin}:${question.id}`, "", "strong")}
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

function renderLeaderboard(players, scope = "leaderboard") {
  if (!players.length) {
    return "";
  }

  return `
    <div class="leaderboard">
      ${players.map((player) => `
        <div class="leader-row">
          <span>${player.rank}</span>
          <strong>${escapeHtml(player.nickname)}</strong>
          ${renderCount(player.score, `${scope}:${player.id ?? player.nickname}`, "", "span")}
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
        ${renderCount(remote.playerCount, `stage-players:${remote.pin}`)}
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
  acceptPresenterSession(response.hostToken, response.presenter);
  await loadPresenterHome();
  if (!(await openPendingPresentationIfNeeded())) {
    updateBrowserUrl(PRESENTATION_HOME_PATH, { replace: true });
  }
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
    acceptPresenterSession(response.hostToken, response.presenter);
    await loadPresenterHome();
    if (!(await openPendingPresentationIfNeeded())) {
      updateBrowserUrl(PRESENTATION_HOME_PATH, { replace: true });
    }
    showNotice(`Welcome back, ${state.presenter?.name || "Presenter"}.`);
    render();
  } catch (error) {
    showError(error);
  }
}

function acceptPresenterSession(hostToken, presenter = null) {
  state.hostToken = hostToken;
  state.presenter = presenter ?? state.presenter;
  localStorage.setItem(STORAGE_KEYS.keepSignedIn, state.keepSignedIn ? "true" : "false");
  if (state.keepSignedIn) {
    localStorage.setItem(STORAGE_KEYS.hostToken, state.hostToken);
    sessionStorage.removeItem(STORAGE_KEYS.hostToken);
    return;
  }
  sessionStorage.setItem(STORAGE_KEYS.hostToken, state.hostToken);
  localStorage.removeItem(STORAGE_KEYS.hostToken);
}

async function restorePresenterIfPossible() {
  if (state.mode !== "presenter" || !state.hostToken || state.presenter || state.presenterLoading) {
    return;
  }

  try {
    state.presenterLoading = true;
    await loadPresenterHome();
    if (!(await openPendingPresentationIfNeeded()) && isPresentationLoginPath()) {
      updateBrowserUrl(PRESENTATION_HOME_PATH, { replace: true });
    }
    render();
  } catch (error) {
    clearPresenterSession();
    state.notice = "Sign in again to load your presentations.";
    updateBrowserUrl(PRESENTATION_LOGIN_PATH, { replace: true });
    render();
  } finally {
    state.presenterLoading = false;
  }
}

async function loadPresenterHome() {
  const me = await getJson("/api/me", true);
  state.presenter = me.presenter;
  await loadPresentations();
}

async function openPendingPresentationIfNeeded() {
  const presentationId = state.pendingPresentationId || sessionStorage.getItem(STORAGE_KEYS.pendingPresentationId) || "";
  if (!presentationId || !state.hostToken) {
    return false;
  }

  state.pendingPresentationId = "";
  sessionStorage.removeItem(STORAGE_KEYS.pendingPresentationId);
  try {
    await openPresentationRecord((await getJson(`/api/presentations/${encodeURIComponent(presentationId)}`, true)).presentation, { updateUrl: false });
    return true;
  } catch (error) {
    state.activePresentationId = "";
    state.activePresentationUpdatedAt = "";
    state.presentationDirty = false;
    state.lastSavedAt = "";
    state.draft = createDraft();
    state.activeQuestionId = state.draft.questions[0]?.id ?? "";
    updateBrowserUrl(PRESENTATION_HOME_PATH, { replace: true });
    showError(error);
    return false;
  }
}

async function loadPresentations() {
  state.presentationsLoading = true;
  try {
    const response = await getJson("/api/presentations", true);
    state.presentations = Array.isArray(response.presentations) ? response.presentations : [];
    state.presentationsLoaded = true;
  } finally {
    state.presentationsLoading = false;
  }
}

async function createPresentation() {
  state.presentationsLoading = true;
  render();
  try {
    const response = await postJson("/api/presentations", {}, true);
    await openPresentationRecord(response.presentation);
  } finally {
    state.presentationsLoading = false;
  }
}

async function openPresentation(presentationId) {
  if (!presentationId) {
    return;
  }

  const response = await getJson(`/api/presentations/${encodeURIComponent(presentationId)}`, true);
  await openPresentationRecord(response.presentation);
}

async function openPresentationRecord(presentation, options = {}) {
  state.session = null;
  state.remote = null;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  state.activePresentationId = presentation.id;
  state.activePresentationUpdatedAt = presentation.updatedAt ?? "";
  state.draft = clonePresentationSnapshot(presentation.snapshot);
  state.activeQuestionId = state.draft.questions[0]?.id ?? "";
  state.presentationDirty = false;
  state.savingPresentation = false;
  state.lastSavedAt = presentation.updatedAt ?? "";
  state.pendingPresentationId = "";
  state.managementMenuId = "";
  upsertPresentationSummary(presentation);
  if (options.updateUrl !== false) {
    updateBrowserUrl(getPresentationPath(presentation.id));
  }
  render();
}

async function savePresentation(options = {}) {
  if (!state.activePresentationId || state.savingPresentation) {
    return;
  }

  const silent = options.silent === true;
  state.savingPresentation = true;
  if (!silent) {
    render();
  }

  try {
    const response = await putJson(`/api/presentations/${encodeURIComponent(state.activePresentationId)}`, serializeDraftForSave(), true);
    if (response.presentation?.id === state.activePresentationId) {
      state.activePresentationUpdatedAt = response.presentation.updatedAt ?? "";
      state.presentationDirty = false;
      state.lastSavedAt = response.presentation.updatedAt ?? new Date().toISOString();
      upsertPresentationSummary(response.presentation);
    }
  } finally {
    state.savingPresentation = false;
    render();
  }
}

async function backToProjects() {
  if (state.presentationDirty) {
    await savePresentation({ silent: true });
  }
  state.activePresentationId = "";
  state.activePresentationUpdatedAt = "";
  state.presentationDirty = false;
  state.lastSavedAt = "";
  state.pendingPresentationId = "";
  state.managementMenuId = "";
  state.draft = createDraft();
  state.activeQuestionId = state.draft.questions[0]?.id ?? "";
  updateBrowserUrl(PRESENTATION_HOME_PATH);
  await loadPresentations();
  render();
}

function togglePresentationMenu(presentationId) {
  state.managementMenuId = state.managementMenuId === presentationId ? "" : presentationId ?? "";
  render();
}

async function renamePresentation(presentationId) {
  const summary = findPresentationSummary(presentationId);
  const currentTitle = summary?.title || "Untitled presentation";
  const nextTitle = window.prompt("Rename presentation", currentTitle)?.trim();
  state.managementMenuId = "";
  if (!nextTitle || nextTitle === currentTitle) {
    render();
    return;
  }

  const response = await getJson(`/api/presentations/${encodeURIComponent(presentationId)}`, true);
  const snapshot = clonePresentationSnapshot(response.presentation?.snapshot);
  snapshot.title = nextTitle.slice(0, MAX_TITLE_LENGTH);
  const updated = await putJson(`/api/presentations/${encodeURIComponent(presentationId)}`, snapshot, true);
  if (updated.presentation) {
    upsertPresentationSummary(updated.presentation);
    if (state.activePresentationId === presentationId) {
      state.draft = clonePresentationSnapshot(updated.presentation.snapshot);
      state.activePresentationUpdatedAt = updated.presentation.updatedAt ?? "";
      state.presentationDirty = false;
      state.lastSavedAt = updated.presentation.updatedAt ?? "";
    }
  }
  showNotice("Presentation renamed.");
  render();
}

async function duplicatePresentation(presentationId) {
  state.managementMenuId = "";
  const response = await postJson(`/api/presentations/${encodeURIComponent(presentationId)}/duplicate`, {}, true);
  if (response.presentation) {
    upsertPresentationSummary(response.presentation);
  }
  showNotice("Presentation duplicated.");
  render();
}

async function deletePresentation(presentationId) {
  const summary = findPresentationSummary(presentationId);
  const title = summary?.title || "Untitled presentation";
  state.managementMenuId = "";
  if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) {
    render();
    return;
  }

  await deleteJson(`/api/presentations/${encodeURIComponent(presentationId)}`, true);
  state.presentations = state.presentations.filter((presentation) => presentation.id !== presentationId);
  if (state.activePresentationId === presentationId) {
    state.activePresentationId = "";
    state.activePresentationUpdatedAt = "";
    state.presentationDirty = false;
    state.lastSavedAt = "";
    state.draft = createDraft();
    state.activeQuestionId = state.draft.questions[0]?.id ?? "";
    updateBrowserUrl(PRESENTATION_HOME_PATH, { replace: true });
  }
  showNotice("Presentation deleted.");
  render();
}

function findPresentationSummary(presentationId) {
  return state.presentations.find((presentation) => presentation.id === presentationId) ?? null;
}

function upsertPresentationSummary(presentation) {
  const summary = {
    id: presentation.id,
    title: presentation.title,
    createdAt: presentation.createdAt,
    updatedAt: presentation.updatedAt,
    questionCount: presentation.questionCount ?? presentation.snapshot?.questions?.length ?? 0,
    titleCard: presentation.titleCard ?? {
      title: presentation.title,
      text: presentation.snapshot?.questions?.[0]?.text ?? "",
      kind: presentation.snapshot?.questions?.[0]?.kind ?? ""
    }
  };
  state.presentations = [
    summary,
    ...state.presentations.filter((item) => item.id !== presentation.id)
  ].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  state.presentationsLoaded = true;
}

function clonePresentationSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.questions)) {
    return createDraft();
  }
  return {
    title: String(snapshot.title ?? "Untitled presentation"),
    questions: snapshot.questions.map((question) => ({
      id: question.id || crypto.randomUUID(),
      kind: QUESTION_KINDS.includes(question.kind) ? question.kind : "quiz",
      text: String(question.text ?? "Untitled question"),
      points: Number.isFinite(Number(question.points)) ? Number(question.points) : DEFAULT_POINTS,
      options: Array.isArray(question.options) ? question.options.map((option) => ({
        id: option.id || crypto.randomUUID(),
        text: String(option.text ?? "")
      })) : createOptions(DEFAULT_OPTIONS),
      correctOptionId: question.correctOptionId ?? question.options?.[0]?.id ?? null,
      media: question.media ?? null
    }))
  };
}

function serializeDraftForSave() {
  return {
    title: state.draft.title,
    questions: state.draft.questions.map((question) => ({
      id: question.id,
      kind: question.kind,
      text: question.text,
      points: question.kind === "slide" ? 0 : Number(question.points),
      options: question.kind === "slide" ? [] : question.options,
      correctOptionId: isScoredQuestionKind(question.kind) ? question.correctOptionId : null,
      media: question.media
    }))
  };
}

function markPresentationDirty() {
  if (!state.activePresentationId) {
    return;
  }
  state.presentationDirty = true;
}

async function createSession() {
  if (state.presentationDirty) {
    await savePresentation({ silent: true });
  }

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
  return requestJson("POST", url, payload, includeHostToken);
}

async function putJson(url, payload, includeHostToken = false) {
  return requestJson("PUT", url, payload, includeHostToken);
}

async function getJson(url, includeHostToken = false) {
  return requestJson("GET", url, null, includeHostToken);
}

async function deleteJson(url, includeHostToken = false) {
  return requestJson("DELETE", url, null, includeHostToken);
}

async function requestJson(method, url, payload, includeHostToken = false) {
  const headers = { "Content-Type": "application/json" };
  if (includeHostToken) {
    headers["X-Host-Token"] = state.hostToken;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload === null ? undefined : JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

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
  if (role === "host") {
    params.set("token", state.hostToken);
  }

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

  if (field === "keepSignedIn" && target instanceof HTMLInputElement) {
    state.keepSignedIn = target.checked;
    localStorage.setItem(STORAGE_KEYS.keepSignedIn, state.keepSignedIn ? "true" : "false");
    if (state.hostToken) {
      acceptPresenterSession(state.hostToken, state.presenter);
    }
    return;
  }

  if (field === "presenterEmail") state.presenterEmail = target.value;
  if (field === "presenterPassword") state.presenterPassword = target.value;
  if (field === "playerPin") state.playerPin = target.value.replace(/\D/g, "").slice(0, GAME_PIN_DIGIT_COUNT);
  if (field === "nickname") state.nickname = target.value;
  if (field === "deckTitle") {
    state.draft.title = target.value;
    markPresentationDirty();
  }

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

  markPresentationDirty();
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
  markPresentationDirty();
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
  markPresentationDirty();
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
  markPresentationDirty();
  render();
}

function resetDeck() {
  state.session = null;
  state.remote = null;
  state.draft = createDraft();
  state.activeQuestionId = state.draft.questions[0]?.id ?? "";
  markPresentationDirty();
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
  await writeClipboardText(getJoinLink(state.remote.pin));
  showNotice("Join link copied.");
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based clipboard path.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Copy failed. Select and copy the join link manually.");
  }
}

function chooseMedia(questionId) {
  document.querySelector(`input[type="file"][data-field="media"][data-question-id="${CSS.escape(questionId ?? "")}"]`)?.click();
}

async function navigateMode(mode) {
  if (state.mode === "presenter" && mode !== "presenter" && state.presentationDirty) {
    await savePresentation({ silent: true });
  }
  setMode(mode);
}

function setMode(mode) {
  state.mode = mode;
  state.managementMenuId = "";
  if (mode === "home") {
    state.activePresentationId = "";
    state.pendingPresentationId = "";
    updateBrowserUrl("/");
  } else if (mode === "player") {
    state.activePresentationId = "";
    state.pendingPresentationId = "";
    updateBrowserUrl("/#player");
  } else if (mode === "presenter") {
    updateBrowserUrl(state.hostToken ? PRESENTATION_HOME_PATH : PRESENTATION_LOGIN_PATH);
  }
  render();
}

function signOutPresenter() {
  clearPresenterSession();
  updateBrowserUrl(PRESENTATION_LOGIN_PATH);
  render();
}

function clearPresenterSession() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  localStorage.removeItem(STORAGE_KEYS.hostToken);
  sessionStorage.removeItem(STORAGE_KEYS.hostToken);
  sessionStorage.removeItem(STORAGE_KEYS.pendingPresentationId);
  state.hostToken = "";
  state.presenter = null;
  state.presenterLoading = false;
  state.presentations = [];
  state.presentationsLoaded = false;
  state.presentationsLoading = false;
  state.activePresentationId = "";
  state.activePresentationUpdatedAt = "";
  state.pendingPresentationId = "";
  state.managementMenuId = "";
  state.presentationDirty = false;
  state.savingPresentation = false;
  state.lastSavedAt = "";
  state.session = null;
  state.remote = null;
  state.draft = createDraft();
  state.activeQuestionId = state.draft.questions[0]?.id ?? "";
}

function syncAutosaveTimer() {
  const shouldAutosave = state.mode === "presenter" && state.hostToken && state.activePresentationId && !state.session;
  if (shouldAutosave && !state.autosaveTimer) {
    state.autosaveTimer = window.setInterval(() => {
      void flushAutosave();
    }, AUTO_SAVE_INTERVAL_MS);
  }

  if (!shouldAutosave && state.autosaveTimer) {
    window.clearInterval(state.autosaveTimer);
    state.autosaveTimer = null;
  }
}

async function flushAutosave() {
  if (!state.presentationDirty || state.savingPresentation) {
    return;
  }

  try {
    await savePresentation({ silent: true });
  } catch (error) {
    showError(error);
  }
}

function readStoredHostToken() {
  return localStorage.getItem(STORAGE_KEYS.hostToken) ?? sessionStorage.getItem(STORAGE_KEYS.hostToken) ?? "";
}

function getSaveStatusText() {
  if (state.savingPresentation) {
    return "Saving...";
  }
  if (state.presentationDirty) {
    return "Autosaves every minute";
  }
  if (state.lastSavedAt) {
    return `Saved ${formatSavedTime(state.lastSavedAt)}`;
  }
  return "Saved draft";
}

function formatSavedTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "just now";
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatPresentationMeta(presentation) {
  const itemCount = Number(presentation.questionCount ?? 0);
  const itemLabel = `${itemCount} item${itemCount === 1 ? "" : "s"}`;
  return `${itemLabel} - updated ${formatSavedTime(presentation.updatedAt)}`;
}

function createDraft() {
  return {
    title: "Untitled presentation",
    questions: [createQuestion()]
  };
}

function createQuestion() {
  const options = createOptions(DEFAULT_OPTIONS);
  return {
    id: crypto.randomUUID(),
    kind: "quiz",
    text: "Untitled question",
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
  updateBrowserUrl("/", { replace: true });
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
  const route = getLocationRoute();
  if (route.mode) {
    return route.mode;
  }

  const mode = location.hash.replace("#", "").split("?")[0];
  if (mode === "presenter" || mode === "player") {
    return mode;
  }
  return "home";
}

function syncRouteStateFromLocation() {
  const route = getLocationRoute();
  const nextMode = route.mode || getInitialMode();
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
  state.pendingPresentationId = route.presentationId || "";
  state.managementMenuId = "";

  if (nextMode === "presenter" && route.presentationId && !state.hostToken) {
    sessionStorage.setItem(STORAGE_KEYS.pendingPresentationId, route.presentationId);
    updateBrowserUrl(PRESENTATION_LOGIN_PATH, { replace: true });
  }

  if (nextMode !== "presenter" || !route.presentationId) {
    state.activePresentationId = nextMode === "presenter" ? state.activePresentationId : "";
  } else if (state.activePresentationId !== route.presentationId) {
    state.activePresentationId = "";
  }
  if (nextMode === "presenter" && !route.presentationId && isPresentationHomePath()) {
    state.activePresentationId = "";
    state.activePresentationUpdatedAt = "";
    state.presentationDirty = false;
    state.lastSavedAt = "";
    state.draft = createDraft();
    state.activeQuestionId = state.draft.questions[0]?.id ?? "";
  }

  render();
  void restorePlayerIfPossible();
  if (nextMode === "presenter" && route.presentationId && state.hostToken && state.presenter) {
    void openPendingPresentationIfNeeded();
  } else {
    void restorePresenterIfPossible();
  }
}

function getLocationRoute() {
  const pathname = normalizePathname(location.pathname);
  if (pathname === PRESENTATION_LOGIN_PATH || pathname === PRESENTATION_HOME_PATH) {
    return { mode: "presenter", presentationId: "" };
  }

  const presentationId = getPresentationRouteId();
  if (presentationId) {
    return { mode: "presenter", presentationId };
  }

  return { mode: "", presentationId: "" };
}

function normalizePathname(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname || "/";
}

function isPresentationLoginPath() {
  return normalizePathname(location.pathname) === PRESENTATION_LOGIN_PATH;
}

function isPresentationHomePath() {
  return normalizePathname(location.pathname) === PRESENTATION_HOME_PATH;
}

function getPresentationRouteId() {
  const match = normalizePathname(location.pathname).match(/^\/presentation\/([0-9a-fA-F-]{36})$/);
  return match?.[1] ?? "";
}

function getPresentationPath(presentationId) {
  return presentationId ? `${PRESENTATION_PATH_PREFIX}/${presentationId}` : PRESENTATION_HOME_PATH;
}

function updateBrowserUrl(path, options = {}) {
  const nextUrl = `${location.origin}${path}`;
  if (nextUrl === location.href) {
    return;
  }

  const method = options.replace === true ? "replaceState" : "pushState";
  history[method]({}, "", path);
}

function getHashParam(name) {
  const query = location.hash.split("?")[1] ?? "";
  return new URLSearchParams(query).get(name);
}

function getJoinLink(pin) {
  return `${location.origin}/#player?pin=${pin}`;
}

function normalizePinInput(pin) {
  const normalized = pin.replace(/\D/g, "");
  if (normalized.length !== GAME_PIN_DIGIT_COUNT || /\D/.test(normalized)) {
    throw new Error(`PIN must be ${GAME_PIN_DIGIT_COUNT} digits.`);
  }
  return normalized;
}

function normalizeStoredPin(pin) {
  const normalized = String(pin ?? "").replace(/\D/g, "");
  return normalized.length === GAME_PIN_DIGIT_COUNT && !/\D/.test(normalized) ? normalized : "";
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
