import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardRoot = resolve(
  process.env.EVENTS_DASHBOARD_ROOT ??
    join(projectRoot, "..", "singapore-ai-events-dashboard"),
);
const publicRoot = join(projectRoot, "public", "events");
const sourceDist = join(dashboardRoot, "dist");
const datasetPath = join(dashboardRoot, "data", "events.json");
const receiptsPath = join(dashboardRoot, "data", "receipts");

const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
if (
  dataset?.schemaVersion !== 1 ||
  !Array.isArray(dataset.events) ||
  dataset.events.length === 0 ||
  typeof dataset.generatedAt !== "string"
) {
  throw new Error("Refusing to package an invalid or empty events dataset.");
}

await rm(publicRoot, { recursive: true, force: true });
await mkdir(join(publicRoot, "api"), { recursive: true });
await cp(join(sourceDist, "client"), join(publicRoot, "client"), {
  recursive: true,
});
await cp(join(sourceDist, "domain"), join(publicRoot, "domain"), {
  recursive: true,
});

const sourceIndex = await readFile(
  join(sourceDist, "client", "index.html"),
  "utf8",
);
const publicIndex = sourceIndex
  .replace('data-base-path=""', 'data-base-path="/events"')
  .replace('data-public-mode="false"', 'data-public-mode="true"')
  .replace('href="/client/styles.css"', 'href="/events/client/styles.css"')
  .replace('src="/client/main.js"', 'src="/events/client/main.js"');
if (
  !publicIndex.includes('data-base-path="/events"') ||
  !publicIndex.includes('data-public-mode="true"')
) {
  throw new Error("Public dashboard index transformation did not apply.");
}
await writeFile(join(publicRoot, "index.html"), publicIndex, "utf8");

const servedAt = new Date().toISOString();
await writeJson(join(publicRoot, "api", "data.json"), {
  dataset,
  overlaps: detectOverlaps(dataset.events),
  servedAt,
});
await writeJson(join(publicRoot, "api", "health.json"), {
  ok: true,
  eventCount: dataset.events.length,
  sourceCount: dataset.sourceCount,
  generatedAt: dataset.generatedAt,
});

const receiptFiles = (await readdir(receiptsPath))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .reverse();
const latestReceipt = receiptFiles[0]
  ? JSON.parse(await readFile(join(receiptsPath, receiptFiles[0]), "utf8"))
  : null;
const publicReceipts = latestReceipt
  ? [
      {
        schemaVersion: 1,
        runId: `public-${latestReceipt.runId}`,
        startedAt: latestReceipt.startedAt,
        finishedAt: latestReceipt.finishedAt,
        status: latestReceipt.status,
        mode: latestReceipt.mode,
        threadId: "withheld",
        candidatePath: "withheld",
        canonicalPath: "withheld",
        receiptPath: "withheld",
        counts: latestReceipt.counts,
        validation: {
          ok: latestReceipt.validation?.ok === true,
          errors: [],
        },
        sourcePolicy: "public-official-or-organizer-only",
        error: null,
      },
    ]
  : [];
await writeJson(join(publicRoot, "api", "receipts.json"), {
  receipts: publicReceipts,
});

process.stdout.write(
  `Packaged AI Events SG with ${dataset.events.length} events for /events/.\n`,
);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function detectOverlaps(events) {
  const overlaps = {};
  const timed = events.filter(
    (event) =>
      event.start.includes("T") &&
      event.end.includes("T") &&
      Number.isFinite(Date.parse(event.start)) &&
      Number.isFinite(Date.parse(event.end)),
  );
  for (let leftIndex = 0; leftIndex < timed.length; leftIndex += 1) {
    const left = timed[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < timed.length; rightIndex += 1) {
      const right = timed[rightIndex];
      if (
        Date.parse(left.start) < Date.parse(right.end) &&
        Date.parse(right.start) < Date.parse(left.end)
      ) {
        (overlaps[left.id] ??= []).push(right.id);
        (overlaps[right.id] ??= []).push(left.id);
      }
    }
  }
  return overlaps;
}
