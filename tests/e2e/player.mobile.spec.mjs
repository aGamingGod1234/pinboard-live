import { expect, test } from "@playwright/test";
import {
  apiHostAction,
  captureRuntimeErrors,
  createApiHostedQuiz,
  expectNoRuntimeErrors,
  joinAsPlayer
} from "./support.mjs";

const ANSWER_LOCKED_MESSAGE = "Your answer is locked in.";
const ANSWER_SUBMITTED_LABEL = "Answer submitted";
const LEGACY_ANSWER_ACKNOWLEDGEMENT = "Lightning fast";

function requestWithConfiguredOrigin(request, baseURL) {
  if (!baseURL) {
    throw new Error("The mobile live-flow tests require Playwright to provide a baseURL.");
  }

  const origin = new URL(baseURL).origin;
  return {
    post(url, options = {}) {
      return request.post(url, {
        ...options,
        headers: {
          ...options.headers,
          Origin: origin
        }
      });
    }
  };
}

async function expectSubmittedAcknowledgement(page, expectedText = null) {
  const submittedStage = page.locator(".player-submitted-stage");
  const acknowledgement = submittedStage.getByRole("heading");

  await expect(submittedStage.getByText(ANSWER_SUBMITTED_LABEL, { exact: true })).toBeVisible();
  await expect(acknowledgement).toBeVisible();
  await expect(acknowledgement).not.toHaveText(LEGACY_ANSWER_ACKNOWLEDGEMENT);
  await expect(submittedStage.getByText(ANSWER_LOCKED_MESSAGE, { exact: true })).toBeVisible();

  const text = (await acknowledgement.textContent())?.trim() ?? "";
  expect(text).not.toBe("");
  if (expectedText !== null) {
    await expect(acknowledgement).toHaveText(expectedText);
  }
  return text;
}

test("@live mobile player can join and use named answer controls without horizontal overflow", async ({ baseURL, page, request }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  const apiRequest = requestWithConfiguredOrigin(request, baseURL);
  const host = await createApiHostedQuiz(apiRequest);

  try {
    await joinAsPlayer(page, host.pin, "Mobile player");
    const waitingPinColor = await page.locator(".player-ready-card .eyebrow").evaluate((pin) => getComputedStyle(pin).color);
    expect(waitingPinColor).toBe("rgb(255, 255, 255)");
    await apiHostAction(apiRequest, host, "start");
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
    const acknowledgement = await expectSubmittedAcknowledgement(page);

    await page.reload();
    await expectSubmittedAcknowledgement(page, acknowledgement);

    expectNoRuntimeErrors(runtimeErrors);
  } finally {
    await apiHostAction(apiRequest, host, "end", { discardActiveRound: true }).catch(() => {});
  }
});

test("@live mobile multi-answer questions enforce the selection limit and submit explicitly", async ({ baseURL, page, request }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  const apiRequest = requestWithConfiguredOrigin(request, baseURL);
  const host = await createApiHostedQuiz(apiRequest, { correctOptionIndexes: [0, 1], optionCount: 6 });

  try {
    await joinAsPlayer(page, host.pin, "Multi player");
    await apiHostAction(apiRequest, host, "start");

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

    const acknowledgement = await expectSubmittedAcknowledgement(page);
    await page.reload();
    await expectSubmittedAcknowledgement(page, acknowledgement);

    await apiHostAction(apiRequest, host, "reveal");
    await expect(page.getByRole("heading", { name: "Partially correct", exact: true })).toBeVisible();
    await expect(page.locator(".points-awarded")).toContainText(/^\+[1-9][\d,]* points$/);
    const overflowPixels = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    expect(overflowPixels).toBeLessThanOrEqual(1);
    expectNoRuntimeErrors(runtimeErrors);
  } finally {
    await apiHostAction(apiRequest, host, "end", { discardActiveRound: true }).catch(() => {});
  }
});

test("@live mobile player sees a clear timeout result when no answer was submitted", async ({ baseURL, page, request }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  const apiRequest = requestWithConfiguredOrigin(request, baseURL);
  const host = await createApiHostedQuiz(apiRequest);

  try {
    await joinAsPlayer(page, host.pin, "Timeout player");
    await apiHostAction(apiRequest, host, "start");
    await apiHostAction(apiRequest, host, "reveal");

    await expect(page.getByRole("heading", { name: "Time's up", exact: true })).toBeVisible();
    await expect(page.getByText("You did not answer in time.", { exact: true })).toBeVisible();
    await expect(page.locator(".points-awarded")).toHaveText("+0 points");
    expectNoRuntimeErrors(runtimeErrors);
  } finally {
    await apiHostAction(apiRequest, host, "end", { discardActiveRound: true }).catch(() => {});
  }
});
