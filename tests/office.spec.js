const { test, expect } = require("@playwright/test");

test("main screen opens as a clean AI chat without development office", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#modeTitle")).toHaveText("SLAV AI");
  await expect(page.locator("#prompt")).toBeVisible();
  await expect(page.locator("#sendBtn")).toBeVisible();
  await expect(page.locator(".office")).toHaveCount(0);
  await expect(page.locator("#agentTask")).toHaveCount(0);
  await expect(page.locator("#ciStatus")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "К офису" })).toHaveCount(0);
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

test("workspace can return to the clean chat view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Проекты", exact: true }).click();
  await page.getByRole("button", { name: "Чат", exact: true }).click();
  await expect(page.locator("#messages")).toBeVisible();
  await expect(page.locator(".office")).toHaveCount(0);
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


test("assistant messages render Markdown and copyable fenced code safely", async ({ page }) => {
  await page.route("**/api/chat", async route => route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: [
      'event: delta\ndata: {"text":"## Готово\\n\\n**Важное** описание.\\n\\n```js\\nconst answer = 42;\\n```"}',
      'event: done\ndata: {"conversationId":"test-chat","model":"test"}',
      ""
    ].join("\n\n")
  }));
  await page.goto("/");
  await page.locator("#prompt").fill("Покажи пример");
  await page.locator("#sendBtn").click();
  await expect(page.locator("#messages h2")).toHaveText("Готово");
  await expect(page.locator("#messages strong")).toHaveText("Важное");
  await expect(page.locator("#messages .code-block code")).toContainText("const answer = 42;");
  await expect(page.locator("#messages .copy-code")).toBeVisible();
});


test("chat streams incremental assistant text from the server", async ({ page }) => {
  await page.route("**/api/chat", async route => {
    const body = [
      'event: delta\ndata: {"text":"Первая часть "}',
      'event: delta\ndata: {"text":"и вторая часть."}',
      'event: done\ndata: {"conversationId":"stream-test","model":"test"}',
      ""
    ].join("\n\n");
    await route.fulfill({status:200,contentType:"text/event-stream",body});
  });
  await page.goto("/");
  await page.locator("#prompt").fill("Потоковый тест");
  await page.locator("#sendBtn").click();
  await expect(page.locator("#messages .message.assistant .content")).toContainText("Первая часть и вторая часть.");
});


test("stop generation control is available and hidden before sending", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#stopBtn")).toBeAttached();
  await expect(page.locator("#stopBtn")).toBeHidden();
  await expect(page.locator("#stopBtn")).toHaveAttribute("aria-label", "Остановить генерацию");
});
