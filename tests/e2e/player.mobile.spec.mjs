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
    await apiHostAction(request, host, "start");

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
    await expect(firstAnswer).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status")).toContainText("Answer submitted");

    expectNoRuntimeErrors(runtimeErrors);
  } finally {
    await apiHostAction(request, host, "end", { discardActiveRound: true }).catch(() => {});
  }
});
