const { test, expect } = require("@playwright/test");

test("main screen opens with the AI office visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("SLAV AI · ОФИС РАЗРАБОТКИ")).toBeVisible();
  await expect(page.getByText("Диспетчер", { exact: true })).toBeVisible();
  await expect(page.getByText("Developer", { exact: true })).toBeVisible();
  await expect(page.getByText("UI Designer", { exact: true })).toBeVisible();
  await expect(page.getByText("Browser Tester", { exact: true })).toBeVisible();
  await expect(page.locator("#agentTask")).toBeVisible();
  await expect(page.locator("#agentRun")).toBeEnabled();
});

test("office task input accepts a task", async ({ page }) => {
  await page.goto("/");
  await page.locator("#agentTask").fill("Проверь интерфейс офиса");
  await expect(page.locator("#agentTask")).toHaveValue("Проверь интерфейс офиса");
});

test("chat composer and send button are present", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#prompt")).toBeVisible();
  await expect(page.locator("#sendBtn")).toBeVisible();
});

test("orange theme stylesheet is loaded", async ({ page }) => {
  await page.goto("/");
  const accent = await page.locator("body").evaluate(el => getComputedStyle(el).getPropertyValue("--accent").trim());
  expect(accent).toBe("#ff861f");
});


test("workspace navigation opens Projects and Artifacts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await expect(page.locator("#projectsView")).toBeVisible();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect(page.locator("#artifactsView")).toBeVisible();
  await expect(page.locator("#artifactPrompt")).toBeVisible();
  await expect(page.locator("#artifactPreview")).toBeVisible();
});

test("workspace can return to chat and keeps office entry", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await page.getByRole("button", { name: "Чат и офис", exact: true }).click();
  await expect(page.locator("#messages")).toBeVisible();
  await expect(page.locator(".office")).toBeVisible();
});


test("chat history controls are available", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#chatHistory")).toBeVisible();
  await expect(page.locator("#chatSearch")).toBeVisible();
  await expect(page.locator("#refreshChats")).toBeVisible();
});

test("chat supports attaching text and source files", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#attachBtn")).toBeVisible();
  await expect(page.locator("#fileInput")).toHaveAttribute("multiple", "");
  await expect(page.locator("#attachmentList")).toBeAttached();
});
