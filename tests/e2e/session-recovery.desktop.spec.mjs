import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { captureRuntimeErrors, expectNoRuntimeErrors, joinAsPlayer, PRESENTER_EMAIL, PRESENTER_PASSWORD } from "./support.mjs";

for (const destination of ["next question", "leave"]) {
  test(`a delayed compact answer cannot overwrite the ${destination} screen`, async ({ baseURL, page, request }) => {
    const errors = captureRuntimeErrors(page);
    const origin = new URL(baseURL).origin;
    const auth = await request.post("/api/auth", {
      headers: { Origin: origin }, data: { email: PRESENTER_EMAIL, password: PRESENTER_PASSWORD }
    });
    expect(auth.status()).toBe(200);
    const headers = { Origin: origin, "X-CSRF-Token": (await auth.json()).csrfToken };
    const questions = [0, 1].map((index) => {
      const options = ["Red", "Blue", "Gold"].map((text) => ({ id: randomUUID(), text }));
      return { id: randomUUID(), kind: "quiz", text: `Round ${index + 1}`, points: 1000, timerSeconds: 60,
        options, correctOptionIds: options.slice(0, index + 1).map((option) => option.id), media: null };
    });
    const created = await request.post("/api/sessions", { headers, data: { title: "Delayed answer", questions } });
    expect(created.status()).toBe(201);
    const { pin } = await created.json();
    const action = async (name, data = {}) => {
      const response = await request.post(`/api/sessions/${pin}/${name}`, { headers, data });
      expect(response.status()).toBe(200);
      return response.json();
    };
    let release;
    let captured;
    const held = new Promise((resolve) => { release = resolve; });
    const responseCaptured = new Promise((resolve) => { captured = resolve; });
    try {
      await joinAsPlayer(page, pin, "Delayed player");
      await action("start");
      await page.route(`**/api/sessions/${pin}/answer`, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        captured();
        await held;
        // The memory test server sends full state; exercise PostgreSQL's compact wire format.
        await route.fulfill({ response, json: {
          pin, questionIndex: 0, version: body.session.version, accepted: true, duplicate: false,
          selectedOptionIds: body.session.selectedOptionIds, selectedOptionId: body.session.selectedOptionId
        } });
      });
      await page.getByRole("button", { name: "Option 1, red triangle: Red", exact: true }).click();
      await responseCaptured;
      if (destination === "next question") {
        await action("reveal");
        await action("next");
        await action("next");
        await page.getByRole("button", { name: "Option 2, blue diamond: Blue", exact: true }).click();
        await expect(page.getByRole("status")).toContainText("1 of 2 selected");
      } else {
        await action("end", { discardActiveRound: true });
        await page.getByRole("button", { name: "Leave", exact: true }).click();
        await expect(page.getByRole("button", { name: "Join game", exact: true })).toBeVisible();
      }
      const completed = page.waitForResponse((response) => response.url().endsWith(`/api/sessions/${pin}/answer`));
      release();
      await completed;
      // A following same-origin round trip lets the answer continuation settle.
      await page.evaluate(() => fetch("/health").then((response) => response.json()));
      if (destination === "next question") {
        await expect(page.getByRole("status")).toContainText("1 of 2 selected");
        await expect(page.getByRole("button", { name: "Submit answers", exact: true })).toBeDisabled();
        const active = await request.get("/api/sessions/active");
        const playerId = (await active.json()).session.recentPlayers[0].id;
        await action("kick", { playerId });
        await expect(page.getByRole("button", { name: "Join game", exact: true })).toBeVisible();
        await expect(page.getByText("You are no longer in this game.", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("pinboard.playerPin"))).toBeNull();
      } else {
        await expect(page.getByRole("button", { name: "Join game", exact: true })).toBeVisible();
      }
      await expect(page.getByRole("alert")).toHaveCount(0);
      expectNoRuntimeErrors(errors);
    } finally {
      release();
      await action("end", { discardActiveRound: true });
    }
  });
}
