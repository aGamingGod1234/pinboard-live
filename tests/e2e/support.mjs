import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

export const BASE_URL = "http://127.0.0.1:4173";
export const PRESENTER_EMAIL = "e2e@example.test";
export const PRESENTER_PASSWORD = "e2e-strong-password-4f2c8d1a";

export function captureRuntimeErrors(page) {
  const errors = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`page: ${error.message}`);
  });

  return errors;
}

export function expectNoRuntimeErrors(errors) {
  expect(errors, errors.join("\n")).toEqual([]);
}

export async function loginPresenter(page) {
  await page.goto("/presentation/login");
  await expect(page.getByRole("heading", { name: "Sign in to Pinboard" })).toBeVisible();
  await expect(page.locator(".page-link-pill code")).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill(PRESENTER_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PRESENTER_PASSWORD);
  await page.getByRole("button", { name: /^Sign in(?: with email)?$/i }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
}

export async function createApiHostedQuiz(request, title = "Mobile verification quiz") {
  const originHeaders = { Origin: BASE_URL };
  const authentication = await request.post("/api/auth", {
    headers: originHeaders,
    data: {
      email: PRESENTER_EMAIL,
      password: PRESENTER_PASSWORD,
      keepSignedIn: false
    }
  });
  const authBody = await responseJson(authentication);
  expect(authentication.status(), JSON.stringify(authBody)).toBe(200);

  const optionIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const questionId = randomUUID();
  const sessionResponse = await request.post("/api/sessions", {
    headers: {
      ...originHeaders,
      "X-CSRF-Token": authBody.csrfToken
    },
    data: {
      title,
      questions: [
        {
          id: questionId,
          kind: "quiz",
          text: "Which answer is red?",
          points: 1000,
          timerSeconds: 60,
          options: [
            { id: optionIds[0], text: "Red" },
            { id: optionIds[1], text: "Blue" },
            { id: optionIds[2], text: "Gold" },
            { id: optionIds[3], text: "Green" }
          ],
          correctOptionId: optionIds[0],
          media: null
        }
      ]
    }
  });
  const sessionBody = await responseJson(sessionResponse);
  expect(sessionResponse.status(), JSON.stringify(sessionBody)).toBe(201);

  return {
    csrfToken: authBody.csrfToken,
    pin: sessionBody.pin
  };
}

export async function apiHostAction(request, host, action, data = {}) {
  const response = await request.post(`/api/sessions/${host.pin}/${action}`, {
    headers: {
      Origin: BASE_URL,
      "X-CSRF-Token": host.csrfToken
    },
    data
  });
  const body = await responseJson(response);
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

export async function joinAsPlayer(page, pin, nickname) {
  await page.goto("/");
  await page.getByLabel("Game PIN", { exact: true }).fill(pin);
  await page.getByLabel("Nickname", { exact: true }).fill(nickname);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.getByRole("heading", { name: "You're in" })).toBeVisible();
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return { rawBody: await response.text() };
  }
}
