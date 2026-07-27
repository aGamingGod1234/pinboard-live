import { scoreEvent, DEFAULT_FIT_PROFILE } from "./scoring.js";
export const REGISTRATION_STATUSES = [
    "open",
    "closing-soon",
    "closed",
    "not-required",
    "unknown",
];
export const EVENT_LEVELS = [
    "beginner",
    "intermediate",
    "advanced",
    "mixed",
    "unknown",
];
export const EVENT_FORMATS = [
    "in-person",
    "online",
    "hybrid",
    "unknown",
];
export const LOCATION_STATUSES = [
    "confirmed",
    "after-approval",
    "tentative",
    "online",
    "unknown",
];
export const CONFIDENCE_LEVELS = ["high", "medium", "low"];
export const EVENT_STATUSES = [
    "upcoming",
    "ongoing",
    "tentative",
    "watch-only",
    "cancelled",
];
const REQUIRED_EVENT_KEYS = [
    "id",
    "title",
    "start",
    "end",
    "timezone",
    "venueName",
    "address",
    "locationStatus",
    "format",
    "organizer",
    "organizerUrl",
    "sourceUrl",
    "registrationUrl",
    "registrationStatus",
    "registrationDeadline",
    "price",
    "currency",
    "priceNotes",
    "level",
    "categories",
    "topics",
    "description",
    "whyRelevant",
    "fitScore",
    "fitReasons",
    "agenda",
    "speakers",
    "prerequisites",
    "confidence",
    "verifiedAt",
    "lastSeenAt",
    "status",
    "caveats",
    "latitude",
    "longitude",
    "mapUrl",
];
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function isNullableString(value) {
    return value === null || isNonEmptyString(value);
}
function isStringArray(value) {
    return (Array.isArray(value) &&
        value.every((item) => isNonEmptyString(item)));
}
function isNullableStringArray(value) {
    return value === null || isStringArray(value);
}
function isEnumValue(value, options) {
    return typeof value === "string" && options.includes(value);
}
function isHttpUrl(value) {
    if (!isNonEmptyString(value)) {
        return false;
    }
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
    }
    catch {
        return false;
    }
}
function isNullableHttpUrl(value) {
    return value === null || isHttpUrl(value);
}
function isDateValue(value) {
    if (typeof value !== "string" ||
        (!DATE_ONLY_PATTERN.test(value) && !DATE_TIME_WITH_ZONE_PATTERN.test(value))) {
        return false;
    }
    return Number.isFinite(Date.parse(value));
}
function hasUnknownValues(event) {
    return REQUIRED_EVENT_KEYS.some((key) => event[key] === null);
}
function validateEventShape(value, index, errors) {
    const prefix = `events[${index}]`;
    if (!isRecord(value)) {
        errors.push(`${prefix} must be an object.`);
        return false;
    }
    for (const key of REQUIRED_EVENT_KEYS) {
        if (!(key in value)) {
            errors.push(`${prefix}.${key} is required; use null plus a caveat when unknown.`);
        }
    }
    if (!isNonEmptyString(value.id) || !/^[a-z0-9][a-z0-9-]*$/.test(value.id)) {
        errors.push(`${prefix}.id must be a stable lowercase slug.`);
    }
    if (!isNonEmptyString(value.title)) {
        errors.push(`${prefix}.title must be a non-empty string.`);
    }
    if (!isDateValue(value.start) || !isDateValue(value.end)) {
        errors.push(`${prefix}.start and .end must be ISO dates or zoned date-times.`);
    }
    else if (Date.parse(value.end) < Date.parse(value.start)) {
        errors.push(`${prefix}.end must not precede .start.`);
    }
    if (value.timezone !== "Asia/Singapore") {
        errors.push(`${prefix}.timezone must be Asia/Singapore.`);
    }
    if (!isNullableString(value.venueName) || !isNullableString(value.address)) {
        errors.push(`${prefix} venue and address values must be strings or null.`);
    }
    if (!isEnumValue(value.locationStatus, LOCATION_STATUSES)) {
        errors.push(`${prefix}.locationStatus is invalid.`);
    }
    if (!isEnumValue(value.format, EVENT_FORMATS)) {
        errors.push(`${prefix}.format is invalid.`);
    }
    if (!isNullableString(value.organizer)) {
        errors.push(`${prefix}.organizer must be a string or null.`);
    }
    if (!isNullableHttpUrl(value.organizerUrl)) {
        errors.push(`${prefix}.organizerUrl must be an HTTP URL or null.`);
    }
    if (!isHttpUrl(value.sourceUrl)) {
        errors.push(`${prefix}.sourceUrl must be an official/organizer HTTP URL.`);
    }
    if (!isNullableHttpUrl(value.registrationUrl)) {
        errors.push(`${prefix}.registrationUrl must be an HTTP URL or null.`);
    }
    if (!isEnumValue(value.registrationStatus, REGISTRATION_STATUSES)) {
        errors.push(`${prefix}.registrationStatus is invalid.`);
    }
    if (value.registrationDeadline !== null && !isDateValue(value.registrationDeadline)) {
        errors.push(`${prefix}.registrationDeadline must be an ISO value or null.`);
    }
    if (value.price !== null &&
        (typeof value.price !== "number" || !Number.isFinite(value.price) || value.price < 0)) {
        errors.push(`${prefix}.price must be a non-negative number or null.`);
    }
    if (value.currency !== null && value.currency !== "SGD") {
        errors.push(`${prefix}.currency must be SGD or null.`);
    }
    if (value.price !== null && value.currency === null) {
        errors.push(`${prefix}.currency is required when price is known.`);
    }
    if (!isNullableString(value.priceNotes)) {
        errors.push(`${prefix}.priceNotes must be a string or null.`);
    }
    if (!isEnumValue(value.level, EVENT_LEVELS)) {
        errors.push(`${prefix}.level is invalid.`);
    }
    if (!isStringArray(value.categories) || !isStringArray(value.topics)) {
        errors.push(`${prefix}.categories and .topics must be string arrays.`);
    }
    if (!isNullableString(value.description) || !isNullableString(value.whyRelevant)) {
        errors.push(`${prefix} description and relevance values must be strings or null.`);
    }
    if (typeof value.fitScore !== "number" ||
        !Number.isInteger(value.fitScore) ||
        value.fitScore < 0 ||
        value.fitScore > 100) {
        errors.push(`${prefix}.fitScore must be an integer from 0 to 100.`);
    }
    if (!isStringArray(value.fitReasons)) {
        errors.push(`${prefix}.fitReasons must be a string array.`);
    }
    if (!isNullableStringArray(value.agenda) ||
        !isNullableStringArray(value.speakers) ||
        !isNullableStringArray(value.prerequisites)) {
        errors.push(`${prefix} agenda, speakers, and prerequisites must be arrays or null.`);
    }
    if (!isEnumValue(value.confidence, CONFIDENCE_LEVELS)) {
        errors.push(`${prefix}.confidence is invalid.`);
    }
    if (!isDateValue(value.verifiedAt) || !isDateValue(value.lastSeenAt)) {
        errors.push(`${prefix}.verifiedAt and .lastSeenAt must be ISO values.`);
    }
    if (!isEnumValue(value.status, EVENT_STATUSES)) {
        errors.push(`${prefix}.status is invalid.`);
    }
    if (!isStringArray(value.caveats)) {
        errors.push(`${prefix}.caveats must be a string array.`);
    }
    else if (hasUnknownValues(value) && value.caveats.length === 0) {
        errors.push(`${prefix} contains unknown values and requires at least one caveat.`);
    }
    if (value.latitude !== null &&
        (typeof value.latitude !== "number" || value.latitude < -90 || value.latitude > 90)) {
        errors.push(`${prefix}.latitude must be between -90 and 90 or null.`);
    }
    if (value.longitude !== null &&
        (typeof value.longitude !== "number" || value.longitude < -180 || value.longitude > 180)) {
        errors.push(`${prefix}.longitude must be between -180 and 180 or null.`);
    }
    if (!isNullableHttpUrl(value.mapUrl)) {
        errors.push(`${prefix}.mapUrl must be an HTTP URL or null.`);
    }
    return errors.every((error) => !error.startsWith(prefix));
}
function validateUniqueness(events, errors) {
    const ids = new Set();
    const identities = new Set();
    for (const event of events) {
        const identity = [
            event.sourceUrl.toLowerCase(),
            event.title.trim().toLowerCase(),
            event.start,
        ].join("|");
        if (ids.has(event.id)) {
            errors.push(`Duplicate event id: ${event.id}.`);
        }
        if (identities.has(identity)) {
            errors.push(`Duplicate event source/title/start identity: ${event.id}.`);
        }
        ids.add(event.id);
        identities.add(identity);
    }
}
function validateFitScores(events, errors) {
    for (const event of events) {
        const expected = scoreEvent(event, DEFAULT_FIT_PROFILE);
        if (event.fitScore !== expected.score) {
            errors.push(`${event.id}.fitScore is ${event.fitScore}; deterministic score is ${expected.score}.`);
        }
    }
}
function validatePastEvents(events, now, errors) {
    for (const event of events) {
        const end = Date.parse(event.end);
        if (Number.isFinite(end) &&
            end < now.getTime() &&
            event.status !== "ongoing" &&
            event.status !== "cancelled") {
            errors.push(`${event.id} is past and cannot be promoted.`);
        }
    }
}
export function validateDataset(value, options = {}) {
    const errors = [];
    if (!isRecord(value)) {
        return { ok: false, errors: ["Dataset must be an object."] };
    }
    if (value.schemaVersion !== 1) {
        errors.push("schemaVersion must be 1.");
    }
    if (!isDateValue(value.generatedAt)) {
        errors.push("generatedAt must be an ISO date or zoned date-time.");
    }
    if (value.timezone !== "Asia/Singapore") {
        errors.push("timezone must be Asia/Singapore.");
    }
    if (typeof value.sourceCount !== "number" ||
        !Number.isInteger(value.sourceCount) ||
        value.sourceCount < 0) {
        errors.push("sourceCount must be a non-negative integer.");
    }
    if (!Array.isArray(value.events)) {
        errors.push("events must be an array.");
        return { ok: false, errors };
    }
    const events = [];
    value.events.forEach((event, index) => {
        const eventErrorsBefore = errors.length;
        if (validateEventShape(event, index, errors) && errors.length === eventErrorsBefore) {
            events.push(event);
        }
    });
    if (events.length === value.events.length) {
        validateUniqueness(events, errors);
        validateFitScores(events, errors);
        if (options.rejectPast) {
            validatePastEvents(events, options.now ?? new Date(), errors);
        }
    }
    return { ok: errors.length === 0, errors };
}
export function assertValidDataset(value, options = {}) {
    const result = validateDataset(value, options);
    if (!result.ok) {
        throw new Error(`Invalid event dataset:\n${result.errors.join("\n")}`);
    }
}
//# sourceMappingURL=schema.js.map