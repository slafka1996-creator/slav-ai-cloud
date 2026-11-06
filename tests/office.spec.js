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
