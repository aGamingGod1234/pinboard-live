import { detectOverlaps, filterEvents, groupEventsByDate, sortEvents, } from "../domain/events.js";
import { DEFAULT_FIT_PROFILE, scoreEvent, } from "../domain/scoring.js";
import { validateDataset, } from "../domain/schema.js";
import { icon } from "./icons.js";
import { computeDashboardMetrics, DEFAULT_FILTERS, filtersFromSearchParams, filtersToSearchParams, isDatasetStale, parseStoredUserState, resolveAppPath, STALE_AFTER_MS, } from "./state.js";
const STORAGE_KEY = "ai-events-sg:user-state:v1";
const CACHE_KEY = "ai-events-sg:last-data:v1";
const REFRESH_COMMAND = "npm run refresh";
const APP_BASE_PATH = document.documentElement.dataset.basePath ?? "";
const PUBLIC_MODE = document.documentElement.dataset.publicMode === "true";
const DESK_LABEL = PUBLIC_MODE
    ? "Singapore / public desk"
    : "Singapore / local desk";
const SOON_START_MS = 72 * 60 * 60 * 1000;
const SOON_DEADLINE_MS = 48 * 60 * 60 * 1000;
const app = requiredElement("#app");
const announcer = requiredElement("#announcer");
let filters;
let sort;
let userState;
let data = null;
let receipts = [];
let selectedId = null;
let loadWarning = null;
function requiredElement(selector) {
    const element = document.querySelector(selector);
    if (!element) {
        throw new Error(`Required element not found: ${selector}`);
    }
    return element;
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
function safeText(value) {
    return value === null
        ? '<span class="unknown">Unknown</span>'
        : escapeHtml(value);
}
function parseEventDate(value) {
    return new Date(value.includes("T") ? value : `${value}T12:00:00+08:00`);
}
function formatDate(value) {
    return new Intl.DateTimeFormat("en-SG", {
        day: "numeric",
        month: "short",
        timeZone: "Asia/Singapore",
        year: "numeric",
    }).format(parseEventDate(value));
}
function formatDateHeading(value) {
    const date = parseEventDate(value);
    return {
        title: new Intl.DateTimeFormat("en-SG", {
            day: "numeric",
            month: "long",
            timeZone: "Asia/Singapore",
            weekday: "long",
        }).format(date),
        year: new Intl.DateTimeFormat("en-SG", {
            timeZone: "Asia/Singapore",
            year: "numeric",
        }).format(date),
    };
}
function formatTime(value) {
    if (!value.includes("T")) {
        return "Time TBC";
    }
    return new Intl.DateTimeFormat("en-SG", {
        hour: "2-digit",
        hour12: false,
        minute: "2-digit",
        timeZone: "Asia/Singapore",
    }).format(new Date(value));
}
function formatDateTimeRange(event) {
    if (!event.start.includes("T") || !event.end.includes("T")) {
        return `${formatDate(event.start)} to ${formatDate(event.end)}; daily times unknown`;
    }
    const sameDate = event.start.slice(0, 10) === event.end.slice(0, 10);
    return sameDate
        ? `${formatDate(event.start)}, ${formatTime(event.start)} to ${formatTime(event.end)}`
        : `${formatDate(event.start)}, ${formatTime(event.start)} to ${formatDate(event.end)}, ${formatTime(event.end)}`;
}
function formatPrice(event) {
    if (event.price === null) {
        return "Price unknown";
    }
    if (event.price === 0) {
        return "Free";
    }
    return new Intl.NumberFormat("en-SG", {
        currency: event.currency ?? "SGD",
        currencyDisplay: "code",
        style: "currency",
    }).format(event.price);
}
function normalizeLabel(value) {
    return value
        .split("-")
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" ");
}
function freshness(event) {
    const age = Date.now() - Date.parse(event.lastSeenAt);
    return {
        label: age > STALE_AFTER_MS ? "Stale" : "Verified",
        stale: age > STALE_AFTER_MS,
    };
}
function isSoon(event) {
    const now = Date.now();
    const startDistance = Date.parse(event.start) - now;
    const deadlineDistance = event.registrationDeadline
        ? Date.parse(event.registrationDeadline) - now
        : Number.POSITIVE_INFINITY;
    return ((startDistance >= 0 && startDistance <= SOON_START_MS) ||
        (deadlineDistance >= 0 && deadlineDistance <= SOON_DEADLINE_MS));
}
function registrationToken(event) {
    const presentations = {
        open: ["Open", "open", "check"],
        "closing-soon": ["Closing soon", "soon", "clock"],
        closed: ["Closed", "closed", "alert"],
        "not-required": ["No registration", "unknown", "check"],
        unknown: ["Unknown", "unknown", "alert"],
    };
    const [label, tone, iconName] = presentations[event.registrationStatus];
    return `<span class="status-token status-token--${tone}">${icon(iconName, "icon icon--small")}<span>${label}</span></span>`;
}
function currentFitProfile(name) {
    if (name === "broad") {
        return {
            ...DEFAULT_FIT_PROFILE,
            preferredLevels: ["intermediate", "advanced", "mixed"],
        };
    }
    if (name === "technical") {
        return {
            ...DEFAULT_FIT_PROFILE,
            preferredCategories: [
                "agents",
                "production-systems",
                "data",
                "security",
                "applied-ai",
            ],
            preferredTopics: [
                "agentic systems",
                "deployment",
                "agents",
                "production",
                "data",
                "security",
            ],
        };
    }
    return DEFAULT_FIT_PROFILE;
}
function rescoredEvents() {
    if (!data) {
        return [];
    }
    const profile = currentFitProfile(userState.fitProfile);
    return data.dataset.events.map((event) => {
        const fit = scoreEvent(event, profile);
        return { ...event, fitScore: fit.score, fitReasons: fit.reasons };
    });
}
function optionMarkup(values, selected, emptyLabel) {
    return [
        `<option value="">${escapeHtml(emptyLabel)}</option>`,
        ...values.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(normalizeLabel(value))}</option>`),
    ].join("");
}
function renderLoading() {
    app.setAttribute("aria-busy", "true");
    app.innerHTML = `
    <header class="command-header">
      <div class="brand"><p class="brand__eyebrow">${DESK_LABEL}</p><h1 class="brand__title">AI Events SG</h1></div>
      <div class="search-control">${icon("search")}<input aria-label="Search events" placeholder="Loading verified events…" disabled /></div>
    </header>
    <main class="skeleton-stack" aria-label="Loading events">
      ${Array.from({ length: 8 }, () => '<div class="skeleton-row"></div>').join("")}
    </main>`;
}
function renderShell() {
    app.innerHTML = `
    <header class="command-header">
      <div class="brand">
        <p class="brand__eyebrow">${DESK_LABEL}</p>
        <h1 class="brand__title">AI Events SG</h1>
      </div>
      <label class="search-control">
        ${icon("search")}
        <span class="sr-only">Search events</span>
        <input id="event-search" type="search" autocomplete="off" placeholder="Search titles, topics, venues, organizers…" value="${escapeHtml(filters.query)}" />
      </label>
      <div class="header-actions">
        <div id="health-summary" class="health-summary"></div>
        <button class="secondary-button mobile-filter-trigger" type="button" data-action="open-filters">${icon("filter")}<span>Filters</span></button>
        ${PUBLIC_MODE ? "" : `<button class="secondary-button" type="button" data-action="copy-refresh" title="Copy the local refresh command">${icon("copy")}<span class="copy-label">Copy refresh command</span></button>`}
      </div>
    </header>
    <div id="status-slot"></div>
    <section id="metrics-slot" aria-label="At a glance"></section>
    <main id="workspace" class="workspace">
      <aside id="filter-slot" class="filter-rail" aria-label="Event filters"></aside>
      <section id="agenda" class="agenda-panel" tabindex="-1" aria-labelledby="agenda-title">
        <div id="agenda-slot"></div>
        <div id="refresh-slot"></div>
      </section>
      <div id="detail-backdrop-slot"></div>
      <div id="detail-slot"></div>
    </main>
    <dialog id="filter-dialog" class="filter-dialog" aria-labelledby="filter-dialog-title">
      <div class="filter-dialog__header">
        <h2 id="filter-dialog-title">Filter events</h2>
        <button class="icon-button" type="button" data-action="close-filters" aria-label="Close filters">${icon("close")}</button>
      </div>
      <div id="filter-dialog-body" class="filter-dialog__body"></div>
    </dialog>`;
    app.setAttribute("aria-busy", "false");
}
function renderStatus() {
    const slot = requiredElement("#status-slot");
    if (!data) {
        slot.innerHTML = "";
        return;
    }
    if (loadWarning) {
        slot.innerHTML = `<div class="status-banner status-banner--error">${icon("alert")}<span>${escapeHtml(loadWarning)}</span></div>`;
        return;
    }
    if (isDatasetStale(data.dataset)) {
        slot.innerHTML = `<div class="status-banner status-banner--stale">${icon("clock")}<span><strong>Stale data.</strong> The latest event verification is more than seven days old. The last-known-good dataset remains available.</span></div>`;
        return;
    }
    slot.innerHTML = "";
}
function renderMetrics(events) {
    const metrics = computeDashboardMetrics(events);
    requiredElement("#metrics-slot").innerHTML = `
    <div class="at-a-glance">
      <div class="stat"><span class="stat__value">${metrics.upcoming}</span><span class="stat__label">Upcoming signals</span></div>
      <div class="stat"><span class="stat__value">${metrics.highFit}</span><span class="stat__label">High fit (70+)</span></div>
      <div class="stat"><span class="stat__value">${metrics.free}</span><span class="stat__label">Confirmed free</span></div>
      <div class="stat"><span class="stat__value">${metrics.nextEvent ? escapeHtml(formatDate(metrics.nextEvent.start)) : "None"}</span><span class="stat__label">${metrics.nextEvent ? escapeHtml(metrics.nextEvent.title) : "Next event"}</span></div>
    </div>`;
}
function renderFilterForm(events, idPrefix) {
    const categories = [...new Set(events.flatMap((event) => event.categories))].sort();
    const sources = [
        ...new Set(events
            .map((event) => event.organizer)
            .filter((value) => value !== null)),
    ].sort();
    return `
    <div class="rail-heading"><h2>Refine desk</h2><button class="text-button" type="button" data-action="clear-filters">Clear all</button></div>
    <form class="filter-form" data-filter-form>
      <div class="control-group">
        <label>Date window</label>
        <div class="date-pair">
          <input aria-label="Events from date" type="date" data-filter-key="dateFrom" value="${escapeHtml(filters.dateFrom ?? "")}" />
          <input aria-label="Events through date" type="date" data-filter-key="dateTo" value="${escapeHtml(filters.dateTo ?? "")}" />
        </div>
      </div>
      <div class="control-group"><label for="${idPrefix}-level-filter">Level</label><select id="${idPrefix}-level-filter" data-filter-key="level">${optionMarkup(["beginner", "intermediate", "advanced", "mixed", "unknown"], filters.level, "All levels")}</select></div>
      <div class="control-group"><label for="${idPrefix}-format-filter">Format</label><select id="${idPrefix}-format-filter" data-filter-key="format">${optionMarkup(["in-person", "online", "hybrid", "unknown"], filters.format, "All formats")}</select></div>
      <div class="control-group"><label for="${idPrefix}-category-filter">Category</label><select id="${idPrefix}-category-filter" data-filter-key="category">${optionMarkup(categories, filters.category, "All categories")}</select></div>
      <div class="control-group"><label for="${idPrefix}-cost-filter">Cost</label><select id="${idPrefix}-cost-filter" data-filter-key="cost">${optionMarkup(["free", "paid", "unknown"], filters.cost, "Any cost")}</select></div>
      <div class="control-group"><label for="${idPrefix}-registration-filter">Registration</label><select id="${idPrefix}-registration-filter" data-filter-key="registration">${optionMarkup(["open", "closing-soon", "closed", "not-required", "unknown"], filters.registration, "Any state")}</select></div>
      <div class="control-group"><label for="${idPrefix}-source-filter">Organizer / source</label><select id="${idPrefix}-source-filter" data-filter-key="source">${optionMarkup(sources, filters.source, "All sources")}</select></div>
      <div class="control-group">
        <label for="${idPrefix}-fit-profile">Fit profile</label>
        <select id="${idPrefix}-fit-profile" data-fit-profile>
          <option value="focused"${userState.fitProfile === "focused" ? " selected" : ""}>Focused: intermediate + advanced</option>
          <option value="broad"${userState.fitProfile === "broad" ? " selected" : ""}>Broad: include mixed-level</option>
          <option value="technical"${userState.fitProfile === "technical" ? " selected" : ""}>Technical systems</option>
        </select>
        <p class="fit-profile-note">Scores are recalculated locally from visible profile rules.</p>
      </div>
      <label class="check-control"><input type="checkbox" data-filter-key="includeHidden"${filters.includeHidden ? " checked" : ""} /> Show hidden events</label>
    </form>`;
}
function activeFilterEntries() {
    const entries = [];
    for (const [key, value] of Object.entries(filters)) {
        if (key !== "query" &&
            value !== null &&
            value !== false &&
            value !== "") {
            entries.push([
                key,
                key === "includeHidden"
                    ? "Showing hidden"
                    : `${normalizeLabel(key)}: ${normalizeLabel(String(value))}`,
            ]);
        }
    }
    return entries;
}
function renderActiveFilters() {
    const entries = activeFilterEntries();
    if (entries.length === 0) {
        return '<div class="active-filters"><span class="agenda-meta">No active filters</span></div>';
    }
    return `<div class="active-filters" aria-label="Active filters">${entries
        .map(([key, label]) => `<button class="filter-chip" type="button" data-clear-filter="${key}" aria-label="Remove ${escapeHtml(label)}">${escapeHtml(label)} ${icon("close", "icon icon--small")}</button>`)
        .join("")}</div>`;
}
function eventRow(event, overlaps) {
    const eventFreshness = freshness(event);
    const tags = event.categories.slice(0, 2);
    const extraTags = Math.max(0, event.categories.length - tags.length);
    const favorite = userState.favorites.includes(event.id);
    const soon = isSoon(event);
    return `
    <li>
      <button class="event-row" type="button" data-action="open-event" data-event-id="${escapeHtml(event.id)}" aria-expanded="${selectedId === event.id}" aria-controls="detail-panel">
        <span class="event-time">${escapeHtml(formatTime(event.start))}${soon ? '<br><span class="status-token status-token--soon">Soon</span>' : ""}</span>
        <span class="event-title-cell">
          <span class="event-title-line">${favorite ? `<span class="favorite-mark">${icon("favorite", "icon icon--small")}</span>` : ""}<span class="event-title">${escapeHtml(event.title)}</span>${overlaps[event.id]?.length ? `<span title="Schedule overlap">${icon("alert", "icon icon--small")}</span>` : ""}</span>
          <span class="event-tags">${tags.map((tag) => `<span class="tag">${escapeHtml(normalizeLabel(tag))}</span>`).join("")}${extraTags ? `<span class="tag">+${extraTags}</span>` : ""}</span>
        </span>
        <span class="venue-cell">${escapeHtml(event.venueName ?? event.address ?? "Location unknown")}</span>
        <span class="fit-score" aria-label="Fit score ${event.fitScore}">${event.fitScore} fit</span>
        ${registrationToken(event)}
        <span class="price">${escapeHtml(formatPrice(event))}</span>
        <span class="freshness status-token status-token--${eventFreshness.stale ? "stale" : "verified"}">${escapeHtml(eventFreshness.label)}</span>
      </button>
    </li>`;
}
function renderAgenda(events) {
    const hiddenIds = new Set(userState.hidden);
    const visible = sortEvents(filterEvents(events, filters, hiddenIds), sort);
    const slot = requiredElement("#agenda-slot");
    if (visible.length === 0) {
        slot.innerHTML = `
      <div class="agenda-heading"><div><p class="section-label">Chronological desk</p><h2 id="agenda-title">No matching events</h2></div></div>
      ${renderActiveFilters()}
      <div class="empty-state"><div class="empty-state__content">${icon("search")}<h2>Your filters are too narrow</h2><p>Clear the current filters or include hidden events to restore the agenda.</p><button class="secondary-button" type="button" data-action="clear-filters">Clear filters</button></div></div>`;
        return;
    }
    const groups = groupEventsByDate(visible);
    slot.innerHTML = `
    <div class="agenda-heading">
      <div><p class="section-label">Chronological desk</p><h2 id="agenda-title">${visible.length} events in view</h2></div>
      <div class="sort-control"><label for="event-sort">Sort</label><select id="event-sort" data-sort>
        <option value="fit-desc"${sort === "fit-desc" ? " selected" : ""}>Fit: high first</option>
        <option value="date-asc"${sort === "date-asc" ? " selected" : ""}>Date: soonest</option>
        <option value="freshness-desc"${sort === "freshness-desc" ? " selected" : ""}>Freshness</option>
        <option value="price-asc"${sort === "price-asc" ? " selected" : ""}>Price: low first</option>
        <option value="price-desc"${sort === "price-desc" ? " selected" : ""}>Price: high first</option>
      </select></div>
    </div>
    ${renderActiveFilters()}
    ${groups
        .map((group) => {
        const heading = formatDateHeading(group.date);
        return `<section class="date-group" aria-labelledby="date-${group.date}"><div class="date-heading"><h3 id="date-${group.date}">${escapeHtml(heading.title)}</h3><span>${heading.year} / ${group.events.length} ${group.events.length === 1 ? "event" : "events"}</span></div><ul class="event-list">${group.events.map((event) => eventRow(event, data?.overlaps ?? {})).join("")}</ul></section>`;
    })
        .join("")}`;
}
function detailField(label, value, wide = false) {
    return `<div class="detail-field${wide ? " detail-field--wide" : ""}"><span class="field-label">${escapeHtml(label)}</span><span class="field-value">${value}</span></div>`;
}
function listValue(values) {
    return values === null
        ? '<span class="unknown">Unknown</span>'
        : `<ul class="detail-list">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}
function renderDetail(events) {
    const event = events.find((candidate) => candidate.id === selectedId);
    const slot = requiredElement("#detail-slot");
    const backdropSlot = requiredElement("#detail-backdrop-slot");
    const workspace = requiredElement("#workspace");
    if (!event) {
        slot.innerHTML = "";
        backdropSlot.innerHTML = "";
        workspace.classList.remove("has-detail");
        return;
    }
    workspace.classList.add("has-detail");
    backdropSlot.innerHTML =
        '<button class="detail-backdrop" type="button" data-action="close-detail" aria-label="Close event details"></button>';
    const overlapIds = data?.overlaps[event.id] ?? [];
    const overlapNames = overlapIds
        .map((id) => events.find((candidate) => candidate.id === id)?.title)
        .filter((value) => Boolean(value));
    const mapUrl = event.mapUrl ??
        (event.address
            ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.address)}`
            : null);
    const primaryUrl = event.registrationUrl ?? event.sourceUrl;
    const primaryLabel = event.registrationUrl
        ? "Open registration"
        : "Open official source";
    const favorite = userState.favorites.includes(event.id);
    const hidden = userState.hidden.includes(event.id);
    const note = userState.notes[event.id] ?? "";
    const eventFreshness = freshness(event);
    slot.innerHTML = `
    <aside id="detail-panel" class="detail-panel" role="dialog" aria-labelledby="detail-title">
      <div class="detail-panel__inner">
        <header class="detail-header">
          <div><p class="section-label">${escapeHtml(event.organizer ?? "Organizer unknown")}</p><h2 id="detail-title">${escapeHtml(event.title)}</h2></div>
          <button id="detail-close" class="icon-button" type="button" data-action="close-detail" aria-label="Close event details">${icon("close")}</button>
        </header>
        <div class="detail-body">
          <section class="detail-section">
            <h3>When &amp; where</h3>
            <div class="detail-grid">
              ${detailField("Date and time", escapeHtml(formatDateTimeRange(event)), true)}
              ${detailField("Timezone", escapeHtml(event.timezone))}
              ${detailField("Format", escapeHtml(normalizeLabel(event.format)))}
              ${detailField("Venue", safeText(event.venueName))}
              ${detailField("Location status", escapeHtml(normalizeLabel(event.locationStatus)))}
              ${detailField("Address", safeText(event.address), true)}
            </div>
            ${mapUrl ? `<a href="${escapeHtml(mapUrl)}" target="_blank" rel="noreferrer">Open map search ${icon("external", "icon icon--small")}</a>` : ""}
            ${overlapNames.length ? `<div class="overlap-warning">${icon("alert")}<span>Schedule overlap with ${escapeHtml(overlapNames.join(", "))}.</span></div>` : ""}
          </section>
          <section class="detail-section">
            <h3>Cost &amp; registration</h3>
            <div class="detail-grid">
              ${detailField("Registration", registrationToken(event))}
              ${detailField("Price", escapeHtml(formatPrice(event)))}
              ${detailField("Price notes", safeText(event.priceNotes), true)}
              ${detailField("Registration deadline", event.registrationDeadline ? escapeHtml(formatDate(event.registrationDeadline)) : '<span class="unknown">Unknown</span>')}
              ${detailField("Prerequisites", listValue(event.prerequisites), true)}
            </div>
            <a class="primary-action" href="${escapeHtml(primaryUrl)}" target="_blank" rel="noreferrer">${escapeHtml(primaryLabel)} ${icon("external")}</a>
          </section>
          <section class="detail-section">
            <h3>Why it matches</h3>
            <div class="detail-grid">
              ${detailField("Description", safeText(event.description), true)}
              ${detailField("Why relevant", safeText(event.whyRelevant), true)}
              ${detailField("Fit score", `<strong>${event.fitScore} / 100</strong>`)}
              ${detailField("Level", escapeHtml(normalizeLabel(event.level)))}
              ${detailField("Fit reasons", listValue(event.fitReasons), true)}
              ${detailField("Categories", listValue(event.categories), true)}
              ${detailField("Topics", listValue(event.topics), true)}
              ${detailField("Agenda", listValue(event.agenda), true)}
              ${detailField("Speakers", listValue(event.speakers), true)}
            </div>
          </section>
          <section class="detail-section">
            <h3>Source &amp; verification</h3>
            <div class="detail-grid">
              ${detailField("Organizer", safeText(event.organizer))}
              ${detailField("Confidence", escapeHtml(normalizeLabel(event.confidence)))}
              ${detailField("Verification", `<span class="status-token status-token--${eventFreshness.stale ? "stale" : "verified"}">${icon(eventFreshness.stale ? "clock" : "check", "icon icon--small")} ${escapeHtml(eventFreshness.label)}</span>`)}
              ${detailField("Verified at", escapeHtml(formatDate(event.verifiedAt)))}
              ${detailField("Last seen", escapeHtml(formatDate(event.lastSeenAt)))}
              ${detailField("Record status", escapeHtml(normalizeLabel(event.status)))}
              ${detailField("Caveats", listValue(event.caveats), true)}
              ${detailField("Official source", `<a href="${escapeHtml(event.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(new URL(event.sourceUrl).hostname)} ${icon("external", "icon icon--small")}</a>`, true)}
              ${detailField("Organizer URL", event.organizerUrl ? `<a href="${escapeHtml(event.organizerUrl)}" target="_blank" rel="noreferrer">${escapeHtml(new URL(event.organizerUrl).hostname)}</a>` : '<span class="unknown">Unknown</span>', true)}
            </div>
          </section>
          <section class="detail-section">
            <h3>Your controls</h3>
            <div class="drawer-controls">
              <button class="drawer-control" type="button" data-action="toggle-favorite" data-event-id="${escapeHtml(event.id)}" aria-pressed="${favorite}">${icon("favorite")} ${favorite ? "Favorited" : "Favorite"}</button>
              <button class="drawer-control" type="button" data-action="toggle-hidden" data-event-id="${escapeHtml(event.id)}" aria-pressed="${hidden}">${icon("hidden")} ${hidden ? "Hidden" : "Hide event"}</button>
            </div>
            <label class="note-control"><span class="field-label">Private local note</span><textarea data-note-id="${escapeHtml(event.id)}" placeholder="Add preparation notes, questions, or follow-ups…">${escapeHtml(note)}</textarea><span class="note-helper">Saved automatically in this browser only.</span></label>
          </section>
        </div>
      </div>
    </aside>`;
}
function renderRefresh() {
    const latest = receipts[0];
    const slot = requiredElement("#refresh-slot");
    if (!latest) {
        slot.innerHTML = `
      <details class="refresh-panel">
        <summary>${icon("receipt")} Refresh activity <span class="agenda-meta">${PUBLIC_MODE ? "No published receipt" : "No local run receipts yet"}</span></summary>
        <div class="refresh-content">${PUBLIC_MODE ? '<p class="receipt-path">This read-only public snapshot contains no browser-executable refresh command.</p>' : `<div><span class="field-label">Schedule target</span><span class="field-value">08:00 Asia/Singapore</span></div><div><span class="field-label">Command</span><span class="field-value"><code>${REFRESH_COMMAND}</code></span></div><p class="receipt-path">Run the command locally. The browser cannot execute Codex or shell commands.</p>`}</div>
      </details>`;
        return;
    }
    slot.innerHTML = `
    <details class="refresh-panel">
      <summary>${icon("receipt")} Refresh activity <span class="status-token status-token--${latest.status === "failed" ? "error" : "verified"}">${escapeHtml(normalizeLabel(latest.status))}</span></summary>
      <div class="refresh-content">
        <div><span class="field-label">Finished</span><span class="field-value">${escapeHtml(formatDate(latest.finishedAt))}</span></div>
        <div><span class="field-label">Changes</span><span class="field-value">+${latest.counts.added} / ~${latest.counts.updated} / −${latest.counts.removed}</span></div>
        <div><span class="field-label">Validation</span><span class="field-value">${latest.validation.ok ? "Passed" : "Failed"}</span></div>
        ${PUBLIC_MODE ? "" : `<div><span class="field-label">Thread</span><span class="field-value">${escapeHtml(latest.threadId)}</span></div><p class="receipt-path"><strong>Receipt:</strong> ${escapeHtml(latest.receiptPath)}</p>`}
      </div>
    </details>`;
}
function renderHealth() {
    if (!data) {
        return;
    }
    const latest = receipts[0];
    requiredElement("#health-summary").innerHTML = `
    <strong>${data.dataset.sourceCount} sources / ${data.dataset.events.length} events</strong>
    <span>${latest ? `Last refresh ${formatDate(latest.finishedAt)}` : `Seed verified ${formatDate(data.dataset.generatedAt)}`}</span>`;
}
function renderAll() {
    if (!data) {
        return;
    }
    const events = rescoredEvents();
    renderStatus();
    renderHealth();
    renderMetrics(events);
    requiredElement("#filter-slot").innerHTML =
        renderFilterForm(events, "rail");
    requiredElement("#filter-dialog-body").innerHTML =
        renderFilterForm(events, "sheet");
    renderAgenda(events);
    renderDetail(events);
    renderRefresh();
}
function updateUrl() {
    const params = filtersToSearchParams(filters, sort);
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
}
function saveUserState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userState));
}
function announce(message) {
    announcer.textContent = "";
    window.setTimeout(() => {
        announcer.textContent = message;
    }, 0);
}
function clearFilters() {
    const query = filters.query;
    filters = { ...DEFAULT_FILTERS, query };
    updateUrl();
    renderAll();
}
function closeDetail(restoreId = selectedId) {
    selectedId = null;
    renderAll();
    if (restoreId) {
        document
            .querySelector(`[data-event-id="${CSS.escape(restoreId)}"]`)
            ?.focus();
    }
}
async function copyRefreshCommand() {
    try {
        await navigator.clipboard.writeText(REFRESH_COMMAND);
        announce("Refresh command copied.");
    }
    catch {
        announce(`Copy failed. Run ${REFRESH_COMMAND} from the project directory.`);
    }
}
function handleAction(button) {
    const action = button.dataset.action;
    if (action === "open-filters") {
        requiredElement("#filter-dialog").showModal();
    }
    else if (action === "close-filters") {
        requiredElement("#filter-dialog").close();
    }
    else if (action === "copy-refresh") {
        void copyRefreshCommand();
    }
    else if (action === "clear-filters") {
        clearFilters();
    }
    else if (action === "open-event") {
        selectedId = button.dataset.eventId ?? null;
        renderAll();
        requiredElement("#detail-close").focus();
    }
    else if (action === "close-detail") {
        closeDetail();
    }
    else if (action === "toggle-favorite" || action === "toggle-hidden") {
        const id = button.dataset.eventId;
        if (!id) {
            return;
        }
        const key = action === "toggle-favorite" ? "favorites" : "hidden";
        const values = new Set(userState[key]);
        if (values.has(id)) {
            values.delete(id);
        }
        else {
            values.add(id);
        }
        userState = { ...userState, [key]: [...values] };
        saveUserState();
        if (action === "toggle-hidden" && !filters.includeHidden && values.has(id)) {
            closeDetail(id);
        }
        else {
            renderAll();
            document.querySelector(`[data-action="${action}"]`)?.focus();
        }
        announce(action === "toggle-favorite" ? "Favorite updated." : "Hidden state updated.");
    }
    else if (action === "retry-load") {
        void loadApplication();
    }
}
function setFilterValue(key, target) {
    const value = target instanceof HTMLInputElement && target.type === "checkbox"
        ? target.checked
        : target.value || null;
    filters = { ...filters, [key]: value };
    updateUrl();
    renderAll();
}
function bindEvents() {
    app.addEventListener("click", (event) => {
        const target = event.target;
        const actionElement = target.closest("[data-action]");
        if (actionElement) {
            handleAction(actionElement);
            return;
        }
        const clearElement = target.closest("[data-clear-filter]");
        if (clearElement) {
            const key = clearElement.dataset.clearFilter;
            filters = {
                ...filters,
                [key]: key === "includeHidden" ? false : null,
            };
            updateUrl();
            renderAll();
        }
    });
    app.addEventListener("change", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
            return;
        }
        const key = target.dataset.filterKey;
        if (key) {
            setFilterValue(key, target);
        }
        else if (target.matches("[data-sort]")) {
            sort = target.value;
            updateUrl();
            renderAll();
        }
        else if (target.matches("[data-fit-profile]")) {
            userState = {
                ...userState,
                fitProfile: target.value,
            };
            saveUserState();
            renderAll();
        }
    });
    app.addEventListener("input", (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.id === "event-search") {
            filters = { ...filters, query: target.value };
            updateUrl();
            renderAll();
        }
        else if (target instanceof HTMLTextAreaElement && target.dataset.noteId) {
            userState = {
                ...userState,
                notes: { ...userState.notes, [target.dataset.noteId]: target.value },
            };
            saveUserState();
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && selectedId) {
            event.preventDefault();
            closeDetail();
        }
    });
}
function renderFatalError(message) {
    app.setAttribute("aria-busy", "false");
    app.innerHTML = `
    <main class="error-state">
      <div><span class="status-token status-token--error">${icon("alert")} Data unavailable</span><h2>The local dashboard could not load</h2><p>${escapeHtml(message)}</p><button class="secondary-button" type="button" data-action="retry-load">Try again</button></div>
    </main>`;
}
async function fetchJson(path) {
    const response = await fetch(path, {
        headers: { Accept: "application/json" },
    });
    if (!response.ok) {
        throw new Error(`${path} returned ${response.status}.`);
    }
    return (await response.json());
}
async function loadApplication() {
    renderLoading();
    try {
        const [dataResponse, receiptResponse] = await Promise.all([
            fetchJson(resolveAppPath(APP_BASE_PATH, "/api/data")),
            fetchJson(resolveAppPath(APP_BASE_PATH, "/api/receipts")).catch(() => ({
                receipts: [],
            })),
        ]);
        const validation = validateDataset(dataResponse.dataset);
        if (!validation.ok) {
            throw new Error("The server returned invalid canonical data.");
        }
        data = dataResponse;
        receipts = receiptResponse.receipts;
        loadWarning = null;
        localStorage.setItem(CACHE_KEY, JSON.stringify(dataResponse));
    }
    catch (error) {
        const cached = localStorage.getItem(CACHE_KEY);
        if (!cached) {
            renderFatalError(error instanceof Error ? error.message : String(error));
            return;
        }
        try {
            const cachedData = JSON.parse(cached);
            const validation = validateDataset(cachedData.dataset);
            if (!validation.ok) {
                throw new Error("Cached data failed validation.");
            }
            data = {
                ...cachedData,
                overlaps: detectOverlaps(cachedData.dataset.events),
            };
            receipts = [];
            loadWarning =
                "The local service could not be reached. Showing validated cached data; it may be stale.";
        }
        catch (cacheError) {
            renderFatalError(cacheError instanceof Error ? cacheError.message : String(cacheError));
            return;
        }
    }
    renderShell();
    renderAll();
}
const initial = filtersFromSearchParams(new URLSearchParams(location.search));
filters = initial.filters;
sort = initial.sort;
userState = parseStoredUserState(localStorage.getItem(STORAGE_KEY));
bindEvents();
void loadApplication();
//# sourceMappingURL=main.js.map