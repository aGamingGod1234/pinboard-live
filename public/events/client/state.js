export const DEFAULT_FILTERS = {
    query: "",
    dateFrom: null,
    dateTo: null,
    level: null,
    format: null,
    category: null,
    cost: null,
    registration: null,
    source: null,
    includeHidden: false,
};
export const DEFAULT_USER_STATE = {
    favorites: [],
    hidden: [],
    notes: {},
    fitProfile: "focused",
};
export const DEFAULT_SORT = "fit-desc";
export const HIGH_FIT_THRESHOLD = 70;
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export function resolveAppPath(basePath, path) {
    const normalizedBase = basePath.trim().replace(/^\/+|\/+$/g, "");
    const normalizedPath = path.trim().replace(/^\/+/, "");
    return `/${[normalizedBase, normalizedPath].filter(Boolean).join("/")}`;
}
const VALID_COSTS = new Set(["free", "paid", "unknown"]);
const VALID_SORTS = new Set([
    "fit-desc",
    "fit-asc",
    "date-asc",
    "date-desc",
    "freshness-desc",
    "freshness-asc",
    "price-asc",
    "price-desc",
]);
const VALID_PROFILES = new Set([
    "focused",
    "broad",
    "technical",
]);
function stringOrNull(value) {
    return value && value.trim().length > 0 ? value : null;
}
export function filtersFromSearchParams(params) {
    const cost = params.get("cost");
    const sort = params.get("sort");
    return {
        filters: {
            query: params.get("q") ?? "",
            dateFrom: stringOrNull(params.get("from")),
            dateTo: stringOrNull(params.get("to")),
            level: stringOrNull(params.get("level")),
            format: stringOrNull(params.get("format")),
            category: stringOrNull(params.get("category")),
            cost: cost && VALID_COSTS.has(cost)
                ? cost
                : null,
            registration: stringOrNull(params.get("registration")),
            source: stringOrNull(params.get("source")),
            includeHidden: params.get("hidden") === "1",
        },
        sort: sort && VALID_SORTS.has(sort) ? sort : DEFAULT_SORT,
    };
}
export function filtersToSearchParams(filters, sort) {
    const params = new URLSearchParams();
    const entries = [
        ["q", filters.query || null],
        ["from", filters.dateFrom],
        ["to", filters.dateTo],
        ["level", filters.level],
        ["format", filters.format],
        ["category", filters.category],
        ["cost", filters.cost],
        ["registration", filters.registration],
        ["source", filters.source],
        ["hidden", filters.includeHidden ? "1" : null],
        ["sort", sort === DEFAULT_SORT ? null : sort],
    ];
    for (const [key, value] of entries) {
        if (value) {
            params.set(key, value);
        }
    }
    return params;
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string" && item.trim().length > 0)
        : [];
}
function notesRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === "string"));
}
export function parseStoredUserState(raw) {
    if (!raw) {
        return { ...DEFAULT_USER_STATE };
    }
    try {
        const value = JSON.parse(raw);
        const profile = typeof value.fitProfile === "string" &&
            VALID_PROFILES.has(value.fitProfile)
            ? value.fitProfile
            : DEFAULT_USER_STATE.fitProfile;
        return {
            favorites: stringArray(value.favorites),
            hidden: stringArray(value.hidden),
            notes: notesRecord(value.notes),
            fitProfile: profile,
        };
    }
    catch {
        return { ...DEFAULT_USER_STATE };
    }
}
export function computeDashboardMetrics(events, now = new Date()) {
    const activeEvents = events.filter((event) => event.status !== "cancelled");
    const upcomingEvents = activeEvents
        .filter((event) => Date.parse(event.start) >= now.getTime())
        .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
    return {
        upcoming: activeEvents.length,
        highFit: activeEvents.filter((event) => event.fitScore >= HIGH_FIT_THRESHOLD).length,
        free: activeEvents.filter((event) => event.price === 0).length,
        nextEvent: upcomingEvents[0] ?? null,
    };
}
export function isDatasetStale(dataset, now = new Date()) {
    const latestSeen = Math.max(...dataset.events.map((event) => Date.parse(event.lastSeenAt)));
    return now.getTime() - latestSeen > STALE_AFTER_MS;
}
//# sourceMappingURL=state.js.map