import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "pinboard-events-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const source = join(root, "dashboard");
  const output = join(project, "public", "events");
  await mkdir(join(project, "scripts"), { recursive: true });
  await cp(new URL("../../scripts/sync-events-dashboard.mjs", import.meta.url), join(project, "scripts", "sync-events-dashboard.mjs"));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "index.html"), "previous dashboard");
  await mkdir(join(source, "data", "receipts"), { recursive: true });
  await mkdir(join(source, "dist", "client"), { recursive: true });
  await mkdir(join(source, "dist", "domain"), { recursive: true });
  const dataset = {
    schemaVersion: 1, generatedAt: "2026-10-25T00:00:00Z", sourceCount: 1,
    events: [{ id: "example", start: "2026-10-25T09:00:00Z", end: "2026-10-25T10:00:00Z" }]
  };
  await writeFile(join(source, "data", "events.json"), JSON.stringify(dataset));
  await writeFile(join(source, "dist", "client", "index.html"), '<html data-base-path="" data-public-mode="false"><link href="/client/styles.css"><script src="/client/main.js"></script></html>');
  await writeFile(join(source, "dist", "client", "main.js"), "export const ready = true;");
  await writeFile(join(source, "data", "receipts", "latest.json"), JSON.stringify({
    runId: "example", status: "success", counts: { events: 1 },
    threadId: "private-thread", candidatePath: "/private/candidate", canonicalPath: "/private/canonical",
    receiptPath: "/private/receipt", error: "private-error", validation: { ok: true, errors: ["private-detail"] }
  }));
  return {
    project, source, output, dataset,
    run: () => spawnSync(process.execPath, ["scripts/sync-events-dashboard.mjs"], {
      cwd: project, env: { ...process.env, EVENTS_DASHBOARD_ROOT: source }, encoding: "utf8", timeout: 10_000
    })
  };
}

for (const failure of ["missing build", "invalid index", "invalid receipt"]) {
  test(`events packaging preserves the previous snapshot after ${failure}`, async (context) => {
    const f = await fixture(context);
    if (failure === "missing build") await rm(join(f.source, "dist", "domain"), { recursive: true });
    if (failure === "invalid index") await writeFile(join(f.source, "dist", "client", "index.html"), "invalid index");
    if (failure === "invalid receipt") await writeFile(join(f.source, "data", "receipts", "latest.json"), "not json");
    const result = f.run();
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(await readFile(join(f.output, "index.html"), "utf8"), "previous dashboard");
    assert.deepEqual(await readdir(join(f.project, "public")), ["events"]);
  });
}

test("events packaging replaces a complete snapshot and redacts private receipts", async (context) => {
  const f = await fixture(context);
  await writeFile(join(f.output, "obsolete.txt"), "old asset");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const index = await readFile(join(f.output, "index.html"), "utf8");
  assert.match(index, /data-base-path="\/events"/);
  assert.match(index, /data-public-mode="true"/);
  assert.match(index, /src="\/events\/client\/main.js"/);
  assert.deepEqual(JSON.parse(await readFile(join(f.output, "api", "data.json"))).dataset, f.dataset);
  assert.equal(await readFile(join(f.output, "client", "main.js"), "utf8"), "export const ready = true;");
  const receiptText = await readFile(join(f.output, "api", "receipts.json"), "utf8");
  assert.doesNotMatch(receiptText, /private/);
  assert.equal(JSON.parse(receiptText).receipts[0].threadId, "withheld");
  assert.equal((await readdir(f.output)).includes("obsolete.txt"), false);
  assert.deepEqual(await readdir(join(f.project, "public")), ["events"]);
});
