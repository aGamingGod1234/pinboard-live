const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
function normalize(value) {
    return value.trim().toLocaleLowerCase("en-SG");
}
function includesText(event, query) {
    const haystack = [
        event.title,
        event.venueName,
        event.address,
        event.organizer,
        event.description,
        event.whyRelevant,
        ...event.categories,
        ...event.topics,
        ...(event.agenda ?? []),
        ...(event.speakers ?? []),
    ]
        .filter((value) => value !== null)
        .join(" ")
        .toLocaleLowerCase("en-SG");
    return haystack.includes(normalize(query));
}
function matchesCost(event, cost) {
    if (cost === "unknown") {
        return event.price === null;
    }
    if (cost === "free") {
        return event.price === 0;
    }
    return event.price !== null && event.price > 0;
}
function singaporeDate(value) {
    return value.slice(0, 10);
}
export function filterEvents(events, filters, hiddenIds) {
    return events.filter((event) => {
        if (!filters.includeHidden && hiddenIds.has(event.id)) {
            return false;
        }
        if (filters.query && !includesText(event, filters.query)) {
            return false;
        }
        const eventDate = singaporeDate(event.start);
        if (filters.dateFrom && eventDate < filters.dateFrom) {
            return false;
        }
        if (filters.dateTo && eventDate > filters.dateTo) {
            return false;
        }
        if (filters.level && event.level !== filters.level) {
            return false;
        }
        if (filters.format && event.format !== filters.format) {
            return false;
        }
        if (filters.category && !event.categories.includes(filters.category)) {
            return false;
        }
        if (filters.cost && !matchesCost(event, filters.cost)) {
            return false;
        }
        if (filters.registration &&
            event.registrationStatus !== filters.registration) {
            return false;
        }
        if (filters.source &&
            !normalize(event.organizer ?? "").includes(normalize(filters.source))) {
            return false;
        }
        return true;
    });
}
function compareNullable(left, right, direction) {
    if (left === null && right === null) {
        return 0;
    }
    if (left === null) {
        return 1;
    }
    if (right === null) {
        return -1;
    }
    return direction === "asc" ? left - right : right - left;
}
function compareStringDates(left, right, direction) {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    return direction === "asc" ? leftTime - rightTime : rightTime - leftTime;
}
export function sortEvents(events, sort) {
    const [field, direction] = sort.split("-");
    return [...events].sort((left, right) => {
        let result = 0;
        if (field === "fit") {
            result = compareNullable(left.fitScore, right.fitScore, direction);
        }
        else if (field === "date") {
            result = compareStringDates(left.start, right.start, direction);
        }
        else if (field === "freshness") {
            result = compareStringDates(left.verifiedAt, right.verifiedAt, direction);
        }
        else {
            result = compareNullable(left.price, right.price, direction);
        }
        return result || left.id.localeCompare(right.id, "en-SG");
    });
}
export function groupEventsByDate(events) {
    const groups = new Map();
    const chronologicallySorted = sortEvents(events, "date-asc");
    for (const event of chronologicallySorted) {
        const date = singaporeDate(event.start);
        const group = groups.get(date) ?? [];
        group.push(event);
        groups.set(date, group);
    }
    return [...groups.entries()].map(([date, groupedEvents]) => ({
        date,
        events: groupedEvents,
    }));
}
export function detectOverlaps(events) {
    const overlaps = {};
    const timedEvents = events.filter((event) => DATE_TIME_PATTERN.test(event.start) &&
        DATE_TIME_PATTERN.test(event.end) &&
        Number.isFinite(Date.parse(event.start)) &&
        Number.isFinite(Date.parse(event.end)));
    for (let leftIndex = 0; leftIndex < timedEvents.length; leftIndex += 1) {
        const left = timedEvents[leftIndex];
        if (!left) {
            continue;
        }
        for (let rightIndex = leftIndex + 1; rightIndex < timedEvents.length; rightIndex += 1) {
            const right = timedEvents[rightIndex];
            if (!right) {
                continue;
            }
            const overlapsInTime = Date.parse(left.start) < Date.parse(right.end) &&
                Date.parse(right.start) < Date.parse(left.end);
            if (!overlapsInTime) {
                continue;
            }
            (overlaps[left.id] ??= []).push(right.id);
            (overlaps[right.id] ??= []).push(left.id);
        }
    }
    return overlaps;
}
//# sourceMappingURL=events.js.map