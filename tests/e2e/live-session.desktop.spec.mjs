import { expect, test } from "@playwright/test";
import {
  BASE_URL,
  captureRuntimeErrors,
  expectNoRuntimeErrors,
  joinAsPlayer,
  loginPresenter
} from "./support.mjs";

const GOOGLE_BUTTON_HEIGHT = 48;
const GOOGLE_ICON_SIZE = 18;
const VISUALLY_HIDDEN_SIZE = 1;
const QUESTION_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("Google presenter button stays compact when provider inline styles are unavailable", async ({ page }) => {
  await page.goto("/presentation/login");
  await page.waitForSelector(".presenter-login-card");

  const metrics = await page.evaluate(() => {
    const slot = document.createElement("div");
    slot.className = "google-signin-slot";
    slot.dataset.googleSignin = "";
    slot.innerHTML = `
      <div class="S9gUrf-YoZ4jf">
        <div role="button">
          <div class="nsm7Bb-HzV7m-LgbsSe-bN97Pc-sM5MNb">
            <div><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M0 0h48v48H0z"></path></svg></div>
            <span class="nsm7Bb-HzV7m-LgbsSe-BPrWId">Continue with Google</span>
            <span class="L6cTce">Continue with Google. Opens in new tab</span>
          </div>
        </div>
      </div>
    `;
    const card = document.querySelector(".presenter-login-card");
    if (!card) {
      throw new Error("Presenter login card not found");
    }
    card.append(slot);

    const button = slot.querySelector("[role='button']");
    const icon = slot.querySelector("svg");
    const assistiveLabel = slot.querySelector(".L6cTce");
    return {
      slotHeight: slot.getBoundingClientRect().height,
      buttonHeight: button?.getBoundingClientRect().height ?? 0,
      iconWidth: icon?.getBoundingClientRect().width ?? 0,
      iconHeight: icon?.getBoundingClientRect().height ?? 0,
      assistiveLabelWidth: assistiveLabel?.getBoundingClientRect().width ?? 0,
      assistiveLabelHeight: assistiveLabel?.getBoundingClientRect().height ?? 0
    };
  });

  expect(metrics.slotHeight).toBe(GOOGLE_BUTTON_HEIGHT);
  expect(metrics.buttonHeight).toBe(GOOGLE_BUTTON_HEIGHT);
  expect(metrics.iconWidth).toBe(GOOGLE_ICON_SIZE);
  expect(metrics.iconHeight).toBe(GOOGLE_ICON_SIZE);
  expect(metrics.assistiveLabelWidth).toBe(VISUALLY_HIDDEN_SIZE);
  expect(metrics.assistiveLabelHeight).toBe(VISUALLY_HIDDEN_SIZE);
});

test("minor interface chrome stays clear, contextual, and keyboard visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Join page" })).toHaveCount(0);
  await expect(page.getByText("Terms | Privacy | Cookie notice", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Game PIN", { exact: true })).toHaveAttribute("required", "");
  await expect(page.getByLabel("Game PIN", { exact: true })).toHaveAttribute("autocomplete", "one-time-code");
  await expect(page.getByLabel("Nickname", { exact: true })).toHaveAttribute("required", "");
  await expect(page.getByLabel("Nickname", { exact: true })).toHaveAttribute("autocomplete", "nickname");
  await expect(page.getByRole("button", { name: "Join game", exact: true })).toBeVisible();

  await page.getByLabel("Game PIN", { exact: true }).focus();
  const joinFocus = await page.getByLabel("Game PIN", { exact: true }).evaluate((input) => {
    const style = getComputedStyle(input);
    return { boxShadow: style.boxShadow, outlineStyle: style.outlineStyle };
  });
  expect(joinFocus.boxShadow).not.toBe("none");
  expect(joinFocus.outlineStyle).toBe("solid");

  await page.goto("/presentation/login");
  await expect(page.getByRole("link", { name: "Presenter login" })).toHaveCount(0);
  await loginPresenter(page);
  await expect(page.getByRole("heading", { name: "Your presentations", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /New presentation/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Presentation home" })).toHaveCount(0);

  const dashboardMetrics = await page.evaluate(() => {
    const notice = document.querySelector(".message-layer > .notice");
    return {
      noticeBackground: notice ? getComputedStyle(notice).backgroundColor : ""
    };
  });
  await expect.poll(() => page.locator('[data-action="sign-out-presenter"]').evaluate((button) => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(dashboardMetrics.noticeBackground).toBe("rgb(21, 108, 52)");
});

test("quiz editor supports two to six answers, multiple correct toggles, and one removable image", async ({ page }) => {
  await loginPresenter(page);
  await page.getByRole("button", { name: /new presentation/i }).click();

  await expect(page.getByRole("link", { name: "Presentation link" })).toHaveCount(0);
  await expect(page.locator(".creator-inspector")).toHaveCount(0);
  await expect(page.locator(".creator-launch")).toHaveCount(0);
  await expect(page.getByText("Ready for live play", { exact: true })).toHaveCount(0);
  const editorMetrics = await page.evaluate(() => {
    const topbar = document.querySelector(".editor-topbar");
    const controls = [
      document.querySelector(".question-field-type select"),
      document.querySelector(".question-field-text textarea"),
      document.querySelector(".question-field-points input"),
      document.querySelector(".question-field-timer input")
    ];
    return {
      topbarHeight: topbar?.getBoundingClientRect().height ?? 0,
      controlTops: controls.map((control) => control?.getBoundingClientRect().top ?? 0)
    };
  });
  expect(editorMetrics.topbarHeight).toBeLessThanOrEqual(112);
  expect(Math.max(...editorMetrics.controlTops) - Math.min(...editorMetrics.controlTops)).toBeLessThanOrEqual(2);
  await expect(page.getByLabel("Option 1 text", { exact: true })).toHaveValue("Red");
  await expect(page.getByLabel("Option 2 text", { exact: true })).toHaveValue("Blue");
  await expect(page.getByLabel("Option 3 text", { exact: true })).toHaveValue("Gold");
  await expect(page.getByLabel("Option 4 text", { exact: true })).toHaveValue("Green");

  const firstCorrect = page.getByLabel(/^Toggle option 1 as correct:/);
  await expect(firstCorrect).toBeChecked();
  await page.getByRole("button", { name: "Remove option 1", exact: true }).click();
  await expect(page.getByLabel(/^Toggle option 1 as correct:/)).toBeChecked();
  await page.getByRole("button", { name: "Remove option 3", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Remove option/ })).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Remove option/ }).first()).toBeDisabled();

  const addAnswer = page.getByRole("button", { name: "Add answer", exact: true });
  const scrollBeforeAdd = await page.locator("[data-creator-main]").evaluate((editor) => {
    editor.scrollTop = Math.min(180, editor.scrollHeight - editor.clientHeight);
    return editor.scrollTop;
  });
  await addAnswer.click();
  await expect.poll(() => page.locator("[data-creator-main]").evaluate((editor) => editor.scrollTop)).toBe(scrollBeforeAdd);
  for (let index = 0; index < 3; index += 1) await addAnswer.click();
  await expect(page.getByRole("button", { name: /^Remove option/ })).toHaveCount(6);
  await expect(addAnswer).toBeDisabled();
  await expect(page.getByLabel("Option 5 text", { exact: true })).toHaveValue("Purple");
  await expect(page.getByLabel("Option 6 text", { exact: true })).toHaveValue("Teal");
  await expect(page.locator('.option-row[data-tone="purple"]')).toHaveCount(1);
  await expect(page.locator('.option-row[data-tone="teal"]')).toHaveCount(1);

  await page.getByLabel(/^Toggle option 2 as correct:/).check();
  await expect(page.getByText("2 correct answers", { exact: true })).toBeVisible();
  await expect(page.getByText("Players select 2", { exact: true })).toBeVisible();

  await page.getByLabel("Question image", { exact: true }).setInputFiles({
    name: "question.png",
    mimeType: "image/png",
    buffer: QUESTION_IMAGE
  });
  await expect(page.getByRole("img", { name: "Question image preview" })).toBeVisible();
  await expect(page.getByLabel("Question image", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Remove question image", exact: true }).click();
  await expect(page.getByLabel("Question image", { exact: true })).toBeAttached();
});

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
    await expect(page.getByLabel(/^Toggle option 1 as correct:/)).toBeVisible();
    await page.getByLabel("Question image", { exact: true }).setInputFiles({
      name: "question.png",
      mimeType: "image/png",
      buffer: QUESTION_IMAGE
    });
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/^Saved (?!draft$).+/)).toBeVisible();

    await page.getByRole("button", { name: "Host live", exact: true }).first().click();
    await expect(page.locator(".participant-dock")).toHaveCount(0);
    await expect(page.getByText("or scan the QR code.", { exact: true })).toBeVisible();
    const pinBlock = page.getByText(/Game PIN:\s*\d{3}\s*\d{3}/).first();
    await expect(pinBlock).toBeVisible();
    const pin = (await pinBlock.textContent()).replace(/\D/g, "");
    expect(pin).toMatch(/^\d{6}$/);
    const qrImage = page.locator(".qr-image");
    await expect(qrImage).toBeVisible();
    await expect.poll(() => qrImage.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);

    await joinAsPlayer(playerPage, pin, "Reloading player");
    await expect(page.getByText("1 participant joined", { exact: true })).toBeVisible();
    await expect(page.locator(".participant-dock")).toBeVisible();

    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.locator(".answer-progress").first()).toHaveAttribute("aria-label", "0 of 0 answers");
    const presenterImage = page.locator(".presenter-media-display .media-preview");
    await expect(presenterImage).toBeVisible();
    const imageOffset = await presenterImage.evaluate((image) => {
      const imageRect = image.getBoundingClientRect();
      const frameRect = image.parentElement.getBoundingClientRect();
      return Math.abs((imageRect.left + imageRect.width / 2) - (frameRect.left + frameRect.width / 2));
    });
    expect(imageOffset).toBeLessThanOrEqual(1);

    const firstAnswer = playerPage.getByRole("button", {
      name: "Option 1, red triangle: First choice",
      exact: true
    });
    await expect(firstAnswer).toBeEnabled();
    await firstAnswer.click();
    await expect(playerPage.getByRole("heading", { name: "Lightning fast", exact: true })).toBeVisible();

    await playerPage.reload();
    await expect(playerPage.getByRole("heading", { name: "Lightning fast", exact: true })).toBeVisible();
    await expect(playerPage.getByText("But did you get it right?", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /^(?:Skip timer|Reveal)$/ }).click();
    await expect(page.locator(".answer-distribution-chart")).toBeVisible();
    await expect(page.locator(".presenter-result-media")).toHaveCount(0);
    await expect(page.locator(".answer-distribution-panel")).toBeVisible();
    await expect(page.locator(".answer-result-bar")).toHaveCount(4);
    await expect(page.locator(".answer-result-bar.is-correct")).toContainText("Correct");
    const chartOffset = await page.locator(".answer-distribution-panel").evaluate((chart) => {
      const rect = chart.getBoundingClientRect();
      return Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2);
    });
    expect(chartOffset).toBeLessThanOrEqual(2);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileResultMetrics = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stageToolsRight: document.querySelector(".stage-tools")?.getBoundingClientRect().right ?? 0,
      tallestResultBar: Math.max(...Array.from(document.querySelectorAll(".answer-result-bar"), (bar) => bar.getBoundingClientRect().height))
    }));
    expect(mobileResultMetrics.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(mobileResultMetrics.stageToolsRight).toBeLessThanOrEqual(390);
    expect(mobileResultMetrics.tallestResultBar).toBeLessThanOrEqual(240);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator(".leaderboard")).toHaveCount(0);
    await expect(playerPage.getByRole("heading", { name: "Correct", exact: true })).toBeVisible();
    await expect(playerPage.locator(".points-awarded")).toContainText(/^\+[\d,]+ points$/);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Current scores", exact: true })).toBeVisible();
    await expect(playerPage.getByRole("heading", { name: "Current scores", exact: true })).toBeVisible();

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
    await expect(playerPage.getByRole("button", { name: "Join game", exact: true })).toBeVisible();
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
