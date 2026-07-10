import { expect, test } from "@playwright/test";
import {
  BASE_URL,
  captureRuntimeErrors,
  expectNoRuntimeErrors,
  joinAsPlayer,
  loginPresenter
} from "./support.mjs";

test("presenter creates a quiz and completes a resumable two-context live session", async ({ browser, page }) => {
  let presenterErrors;
  const playerContext = await browser.newContext({ baseURL: BASE_URL });
  const playerPage = await playerContext.newPage();
  const playerErrors = captureRuntimeErrors(playerPage);

  try {
    await page.goto("/presentation/login");
    await expect(page.getByText("Sign in again to load your presentations.", { exact: true })).toHaveCount(0);
    await page.getByLabel("Email", { exact: true }).fill("e2e@example.test");
    await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
    await page.getByRole("button", { name: /^Sign in(?: with email)?$/i }).click();
    const loginError = page.getByRole("alert");
    await expect(loginError).toBeVisible();
    await expect(loginError.getByRole("button", { name: "Dismiss error" })).toBeVisible();
    await page.waitForTimeout(4_300);
    await expect(loginError).toBeVisible();
    await loginError.getByRole("button", { name: "Dismiss error" }).click();
    await expect(loginError).toBeHidden();

    presenterErrors = captureRuntimeErrors(page);
    await loginPresenter(page);

    await page.getByRole("button", { name: /new presentation/i }).click();
    await expect(page.getByRole("heading", { name: "Untitled presentation", exact: true })).toBeVisible();

    await page.getByLabel("Deck title", { exact: true }).fill("E2E live quiz");
    const questionText = page.getByRole("textbox", { name: "Text", exact: true });
    await expect(questionText).toBeVisible();
    await questionText.fill("Which answer is first?");
    await page.getByLabel("Option 1 text", { exact: true }).fill("First choice");
    await expect(page.getByLabel("Mark option 1 as correct: First choice", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/^Saved (?!draft$).+/)).toBeVisible();

    await page.getByRole("button", { name: "Host live", exact: true }).first().click();
    const pinBlock = page.getByText(/Game PIN:\s*\d{3}\s*\d{3}/).first();
    await expect(pinBlock).toBeVisible();
    const pin = (await pinBlock.textContent()).replace(/\D/g, "");
    expect(pin).toMatch(/^\d{6}$/);
    const qrImage = page.locator(".qr-image");
    await expect(qrImage).toBeVisible();
    await expect.poll(() => qrImage.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);

    await joinAsPlayer(playerPage, pin, "Reloading player");
    await expect(page.getByText("1 participant joined", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".answer-progress").first()).toHaveAttribute("aria-label", "0 of 0 answers");

    const firstAnswer = playerPage.getByRole("button", {
      name: "Option 1, red triangle: First choice",
      exact: true
    });
    await expect(firstAnswer).toBeEnabled();
    await firstAnswer.click();
    await expect(firstAnswer).toHaveAttribute("aria-pressed", "true");

    await playerPage.reload();
    const resumedAnswer = playerPage.getByRole("button", {
      name: "Option 1, red triangle: First choice",
      exact: true
    });
    await expect(resumedAnswer).toHaveAttribute("aria-pressed", "true");
    await expect(playerPage.getByText("Reloading player", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^(?:Skip timer|Reveal)$/ }).click();
    await expect(playerPage.getByRole("status")).toContainText("Correct. You earned 1000 points.");
    await expect(playerPage.getByRole("button", {
      name: "Option 1, red triangle: First choice. Correct answer",
      exact: true
    })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    page.once("dialog", async (dialog) => dialog.accept());
    await page.getByRole("button", { name: "End", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Final podium" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Play again", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Return to projects", exact: true })).toBeVisible();
    await expect(playerPage.getByRole("button", { name: "Leave", exact: true })).toBeVisible();

    await playerPage.route(`**/api/sessions/${pin}/leave`, (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Temporary server failure" })
    }));
    await playerContext.clearCookies();
    await playerPage.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(playerPage.getByRole("button", { name: "Enter", exact: true })).toBeVisible();
    const expectedFailedLeaveRequest = playerErrors.findIndex((error) => error.includes("status of 503"));
    expect(expectedFailedLeaveRequest).toBeGreaterThanOrEqual(0);
    playerErrors.splice(expectedFailedLeaveRequest, 1);

    await page.getByRole("button", { name: "Play again", exact: true }).click();
    const replayPinBlock = page.getByText(/Game PIN:\s*\d{3}\s*\d{3}/).first();
    await expect(replayPinBlock).toBeVisible();
    const replayPin = (await replayPinBlock.textContent()).replace(/\D/g, "");
    expect(replayPin).not.toBe(pin);

    page.once("dialog", async (dialog) => dialog.accept());
    await page.getByRole("button", { name: "End", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Final podium" })).toBeVisible();
    await page.getByRole("button", { name: "Return to projects", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();

    const actionsButton = page.getByRole("button", { name: "Presentation actions" }).first();
    await actionsButton.click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeFocused();
    const actionsMenu = page.getByRole("menu", { name: "Presentation actions" });
    await actionsMenu.evaluate((menu) => {
      menu.tabIndex = -1;
      menu.focus();
    });
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(actionsButton).toBeFocused();

    expectNoRuntimeErrors(presenterErrors);
    expectNoRuntimeErrors(playerErrors);
  } finally {
    await playerContext.close();
  }
});

test("presenter can explicitly resolve a stale editor save", async ({ page }) => {
  await loginPresenter(page);
  await page.getByRole("button", { name: /new presentation/i }).click();
  await page.getByLabel("Deck title", { exact: true }).fill("Initial local draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Saved (?!draft$).+/)).toBeVisible();

  const presentationId = page.url().split("/").at(-1);
  const meResponse = await page.request.get("/api/me");
  const me = await meResponse.json();
  const currentResponse = await page.request.get(`/api/presentations/${presentationId}`);
  const current = (await currentResponse.json()).presentation;
  const externalSave = await page.request.put(`/api/presentations/${presentationId}`, {
    headers: {
      Origin: BASE_URL,
      "X-CSRF-Token": me.csrfToken
    },
    data: {
      snapshot: { ...current.snapshot, title: "Newer server version" },
      expectedVersion: current.version
    }
  });
  expect(externalSave.status()).toBe(200);

  await page.getByLabel("Deck title", { exact: true }).fill("Keep my local draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const conflict = page.getByRole("alert");
  await expect(conflict).toContainText("changed in another tab");
  await expect(conflict.getByRole("button", { name: "Reload latest" })).toBeVisible();
  await conflict.getByRole("button", { name: "Save my draft" }).click();
  await expect(page.getByRole("heading", { name: "Keep my local draft", exact: true })).toBeVisible();
  await expect(conflict).toBeHidden();
  await expect(page.getByText("Saved this draft over the newer version.", { exact: true })).toBeVisible();
});
