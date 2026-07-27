export const DEFAULT_FIT_PROFILE = {
    preferredLevels: ["intermediate", "advanced"],
    preferredCategories: [
        "agents",
        "production-systems",
        "enterprise-ai",
        "data",
        "safety",
        "security",
        "business-strategy",
        "founders",
        "applied-ai",
        "governance",
    ],
    preferredTopics: [
        "agentic systems",
        "deployment",
        "agents",
        "production",
        "enterprise",
        "governance",
        "security",
        "safety",
        "data",
        "strategy",
        "business outcomes",
    ],
    preferredFormats: ["in-person", "hybrid"],
    demotedCategories: ["networking"],
};
const BASE_SCORE = 30;
const CATEGORY_POINTS = 10;
const TOPIC_POINTS = 7;
const FORMAT_POINTS = 4;
const BEGINNER_DEMOTION = 15;
const NETWORKING_DEMOTION = 10;
const MAX_CATEGORY_MATCHES = 2;
const MAX_TOPIC_MATCHES = 2;
const LEVEL_POINTS = {
    beginner: -BEGINNER_DEMOTION,
    intermediate: 20,
    advanced: 25,
    mixed: 12,
    unknown: 0,
};
function normalize(value) {
    return value.trim().toLowerCase().replaceAll("-", " ");
}
function matchingValues(values, preferred) {
    const normalizedPreferred = new Set(preferred.map(normalize));
    return values.filter((value) => normalizedPreferred.has(normalize(value)));
}
export function scoreEvent(event, profile) {
    const levelPoints = event.level === "beginner"
        ? LEVEL_POINTS.beginner
        : profile.preferredLevels.includes(event.level)
            ? LEVEL_POINTS[event.level]
            : 0;
    let score = BASE_SCORE + levelPoints;
    const reasons = [];
    if (event.level === "beginner") {
        reasons.push("Beginner level demoted");
    }
    else if (event.level === "intermediate") {
        reasons.push("Intermediate level");
    }
    else if (event.level === "advanced") {
        reasons.push("Advanced level");
    }
    else if (event.level === "mixed") {
        reasons.push("Mixed level");
    }
    const categoryMatches = matchingValues(event.categories, profile.preferredCategories).slice(0, MAX_CATEGORY_MATCHES);
    for (const category of categoryMatches) {
        score += CATEGORY_POINTS;
        reasons.push(`Preferred category: ${normalize(category)}`);
    }
    const topicMatches = matchingValues(event.topics, profile.preferredTopics).slice(0, MAX_TOPIC_MATCHES);
    for (const topic of topicMatches) {
        score += TOPIC_POINTS;
        reasons.push(`Preferred topic: ${normalize(topic)}`);
    }
    const isDemoted = matchingValues(event.categories, profile.demotedCategories).length > 0;
    if (isDemoted) {
        score -= NETWORKING_DEMOTION;
        reasons.push("Generic networking demoted");
    }
    if (profile.preferredFormats.includes(event.format)) {
        score += FORMAT_POINTS;
        const formatLabel = event.format === "in-person"
            ? "In-person"
            : `${event.format.charAt(0).toUpperCase()}${event.format.slice(1)}`;
        reasons.push(`${formatLabel} format`);
    }
    return {
        score: Math.max(0, Math.min(100, score)),
        reasons,
    };
}
//# sourceMappingURL=scoring.js.map