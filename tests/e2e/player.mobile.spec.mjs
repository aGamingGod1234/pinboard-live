import { expect, test } from "@playwright/test";
import {
  apiHostAction,
  captureRuntimeErrors,
  createApiHostedQuiz,
  expectNoRuntimeErrors,
  joinAsPlayer
} from "./support.mjs";

test("mobile player can join and use named answer controls without horizontal overflow", async ({ page, request }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  const host = await createApiHostedQuiz(request);

  try {
    await joinAsPlayer(page, host.pin, "Mobile player");
    const waitingPinColor = await page.locator(".player-ready-card .eyebrow").evaluate((pin) => getComputedStyle(pin).color);
    expect(waitingPinColor).toBe("rgb(255, 255, 255)");
    await apiHostAction(request, host, "start");
    await expect(page.locator(".player-score-dock").getByText("Score", { exact: true })).toBeVisible();

    const answers = [
      "Option 1, red triangle: Red",
      "Option 2, blue diamond: Blue",
      "Option 3, gold circle: Gold",
      "Option 4, green square: Green"
    ];
    for (const accessibleName of answers) {
      await expect(page.getByRole("button", { name: accessibleName, exact: true })).toBeEnabled();
    }

    const overflowPixels = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    expect(overflowPixels).toBeLessThanOrEqual(1);

    const firstAnswer = page.getByRole("button", { name: answers[0], exact: true });
    await firstAnswer.click();
    await expect(page.getByRole("heading", { name: "Lightning fast", exact: true })).toBeVisible();
    await expect(page.getByText("But did you get it right?", { exact: true })).toBeVisible();

    expectNoRuntimeErrors(runtimeErrors);
  } finally {
    await apiHostAction(request, host, "end", { discardActiveRound: true }).catch(() => {});
  }
});

test("mobile multi-answer questions enforce the selection limit and submit explicitly", async ({ page, request }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  const host = await createApiHostedQuiz(request, { correctOptionIndexes: [0, 1], optionCount: 6 });

  try {
    await joinAsPlayer(page, host.pin, "Multi player");
    await apiHostAction(request, host, "start");

    const red = page.getByRole("button", { name: "Option 1, red triangle: Red", exact: true });
    const blue = page.getByRole("button", { name: "Option 2, blue diamond: Blue", exact: true });
    const gold = page.getByRole("button", { name: "Option 3, gold circle: Gold", exact: true });
    const submit = page.getByRole("button", { name: "Submit answers", exact: true });

    await expect(page.getByRole("status")).toContainText("Select 2 answers · 0 of 2 selected");
    await expect(submit).toBeDisabled();
    await red.click();
    await expect(page.getByRole("status")).toContainText("1 of 2 selected");
    await expect(submit).toBeDisabled();
    await gold.click();
    await expect(submit).toBeEnabled();
    await expect(blue).toBeDisabled();
    await submit.click();

    await expect(page.getByRole("heading", { name: "Lightning fast", exact: true })).toBeVisible();
    await apiHostAction(request, host, "reveal");
    await expect(page.getByRole("heading", { name: "Partially correct", exact: true })).toBeVisible();
    await expect(page.locator(".points-awarded")).toContainText(/^\+[1-9][\d,]* points$/);
    const overflowPixels = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    expect(overflowPixels).toBeLessThanOrEqual(1);
    expectNoRuntimeErrors(runtimeErrors);
  } finally {
    await apiHostAction(request, host, "end", { discardActiveRound: true }).catch(() => {});
  }
});

test("mobile player sees a clear timeout result when no answer was submitted", async ({ page, request }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  const host = await createApiHostedQuiz(request);

  try {
    await joinAsPlayer(page, host.pin, "Timeout player");
    await apiHostAction(request, host, "start");
    await apiHostAction(request, host, "reveal");

    await expect(page.getByRole("heading", { name: "Time's up", exact: true })).toBeVisible();
    await expect(page.getByText("You did not answer in time.", { exact: true })).toBeVisible();
    await expect(page.locator(".points-awarded")).toHaveText("+0 points");
    expectNoRuntimeErrors(runtimeErrors);
  } finally {
    await apiHostAction(request, host, "end", { discardActiveRound: true }).catch(() => {});
  }
});
