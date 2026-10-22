import { expect, chromium, test, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { e2eBaseUrl, e2eEnvironment } from "../e2e/environment";
import type { extensionManifest } from "../extensions/manifest";
import { signIn } from "../e2e/helpers";

test("connect, capture, deduplicate, edit, read, delete, revoke and disconnect", async ({}, testInfo) => {
  const prisma = new PrismaClient({ datasources: { db: { url: e2eEnvironment.DATABASE_URL } } });
  const token = randomUUID();
  const directory = testInfo.outputPath("extension");
  await cp(path.resolve(".tmp/extensions/chrome"), directory, { recursive: true });
  const manifest: ReturnType<typeof extensionManifest> & { host_permissions?: string[] } = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  // Pregrant the test instance in this disposable copy; native permission dialogs
  // are not exposed to Playwright. Shipped manifests have no granted host access.
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  let context: BrowserContext | undefined;
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "test-reader" } });
    const tokenRecord = await prisma.apiToken.create({
      data: { userId: user.id, name: "Browser acceptance", tokenHash: createHash("sha256").update(token).digest("hex") },
    });
    context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`, "--enable-unsafe-extension-debugging"],
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).hostname;
    const extensionRoot = `chrome-extension://${extensionId}`;
    const options = await context.newPage();
    await options.goto(`${extensionRoot}/options.html`);
    await options.getByLabel("Your Wallaby instance").fill(e2eBaseUrl);
    await options.getByLabel("API token", { exact: true }).fill("invalid-test-token");
    await options.getByRole("button", { name: "Connect your library" }).click();
    await expect(options.getByRole("alert")).toContainText("rejected or revoked");
    await options.getByLabel("API token", { exact: true }).fill(token);
    await options.getByRole("button", { name: "Connect your library" }).click();
    await expect(options.locator("#account")).toHaveText(`Connected to ${e2eBaseUrl}`);
    await expect(options.getByLabel("API token", { exact: true })).toHaveValue("");
    await expect(await options.evaluate(() => chrome.runtime.sendMessage({ type: "connection" }))).toEqual({ ok: true, result: { baseUrl: e2eBaseUrl } });
    await options.screenshot({ path: testInfo.outputPath("connected.png"), fullPage: true });

    const article = await context.newPage();
    const articleAddress = "https://journal.example.test/a-good-read";
    const paragraph = "Reading thoughtfully is a way of returning to the ideas that matter. A personal library should help us keep what is useful without losing the pleasure of discovery. This article is private to the browser and cannot be fetched by the server.";
    await article.route(articleAddress, (route) => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><title>A good read</title></head><body><main><article><h1>A good read</h1><form><textarea>DO-NOT-CAPTURE-PRIVATE-DRAFT</textarea><input type="password" value="DO-NOT-CAPTURE-PASSWORD"></form>${Array.from({ length: 8 }, () => `<p>${paragraph}</p>`).join("")}</article></main></body></html>`,
    }));
    await article.goto(articleAddress);
    const popupFor = async (page: Page) => {
      await page.bringToFront();
      const browser = context!.browser();
      if (!browser) throw new Error("The extension test requires a Chromium browser connection.");
      const browserCdp = await browser.newBrowserCDPSession();
      const { targetInfos } = await browserCdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
      const target = targetInfos.find((candidate) => candidate.url === page.url());
      if (!target) throw new Error(`Could not find the Chrome tab target for ${page.url()}`);
      await browserCdp.send("Extensions.triggerAction", { id: extensionId, targetId: target.targetId });
      const activeTab = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
      const popup = await context!.newPage();
      // Chromium exposes toolbar popups as uninspectable "other" targets.
      // Load the same UI in a tab, retaining the real action's activeTab grant.
      await popup.addInitScript((originalTab) => { chrome.tabs.query = async () => [originalTab]; }, activeTab);
      await popup.goto(`${extensionRoot}/popup.html`);
      await browserCdp.detach();
      return popup;
    };
    let popup = await popupFor(article);
    await expect(popup.getByRole("button", { name: "Save article", exact: true })).toBeVisible();
    await popup.getByLabel("Tags", { exact: false }).fill("Ideas, Reading");
    await popup.getByLabel("Favorite", { exact: true }).check();
    await popup.getByLabel("Save content from this page").check();
    await popup.locator("body").screenshot({ path: testInfo.outputPath("before-save.png") });
    await popup.getByRole("button", { name: "Save article", exact: true }).click();
    await expect(popup.locator("#status")).toContainText("On your shelf");
    let saved = await prisma.entry.findFirstOrThrow({ where: { userId: user.id, givenUrl: articleAddress }, include: { tags: true } });
    expect(saved.content).toContain("Reading thoughtfully");
    expect(saved.content).not.toContain("DO-NOT-CAPTURE");
    expect(saved.starred).toBe(true);
    expect(saved.tags.map((tag) => tag.label).sort()).toEqual(["Ideas", "Reading"]);
    await popup.locator("body").screenshot({ path: testInfo.outputPath("saved.png") });
    await popup.emulateMedia({ colorScheme: "dark" });
    await popup.locator("body").screenshot({ path: testInfo.outputPath("saved-dark.png") });
    await popup.close();

    popup = await popupFor(article);
    await expect(popup.getByRole("button", { name: "Update article" })).toBeVisible();
    expect(await prisma.entry.count({ where: { userId: user.id, givenUrl: articleAddress } })).toBe(1);
    await popup.getByLabel("Article title").fill("A better reading habit");
    await popup.getByLabel("Tags", { exact: false }).fill("Research");
    await popup.getByLabel("Favorite", { exact: true }).uncheck();
    await popup.getByLabel("Already read", { exact: true }).check();
    await popup.getByRole("button", { name: "Update article" }).click();
    await expect(popup.locator("#status")).toContainText("On your shelf");
    saved = await prisma.entry.findUniqueOrThrow({ where: { id: saved.id }, include: { tags: true } });
    expect(saved.title).toBe("A better reading habit");
    expect(saved.starred).toBe(false);
    expect(saved.archived).toBe(true);
    expect(saved.tags.map((tag) => tag.label)).toEqual(["Research"]);
    const newTab = context.waitForEvent("page", (candidate) => !candidate.url().includes("/popup.html"));
    await popup.getByRole("button", { name: "Open reader" }).click();
    const reader = await newTab;
    await reader.waitForURL(`${e2eBaseUrl}/**`);
    // Reader links do not bypass the instance's normal login.
    if (!reader.url().includes("/auth/signin")) await reader.waitForURL(/\/auth\/signin/);
    await signIn(reader);
    await reader.goto(`${e2eBaseUrl}/entries/${saved.id}`);
    await expect(reader.getByRole("heading", { name: "A better reading habit" })).toBeVisible();
    await reader.goto(`${e2eBaseUrl}/entries/help`);
    await expect(reader.getByRole("link", { name: "Install the extension" })).toHaveAttribute("href", "https://github.com/vibewatch/Wallaby/tree/main/extensions");
    await reader.goto(`${e2eBaseUrl}/entries/settings`);
    await expect(reader.getByRole("link", { name: "Install the Wallaby browser companion" })).toBeVisible();
    await reader.close();
    if (!popup.isClosed()) await popup.close();

    popup = await popupFor(article);
    await expect(popup.getByRole("button", { name: "Update article" })).toBeVisible();
    await popup.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(popup.getByRole("button", { name: "Remove permanently" })).toBeVisible();
    expect(await prisma.entry.count({ where: { id: saved.id } })).toBe(1);
    await popup.getByRole("button", { name: "Keep article" }).click();
    await popup.getByRole("button", { name: "Remove", exact: true }).click();
    await popup.getByRole("button", { name: "Remove permanently" }).click();
    await expect(popup.locator("#status")).toContainText("Removed from your library");
    expect(await prisma.entry.count({ where: { id: saved.id } })).toBe(0);
    await popup.close();

    await prisma.apiToken.delete({ where: { id: tokenRecord.id } });
    popup = await popupFor(article);
    await expect(popup.getByRole("alert")).toContainText("rejected or revoked");
    await popup.close();
    await options.bringToFront();
    await options.getByRole("button", { name: "Disconnect this browser" }).click();
    await expect(options.locator("#status")).toContainText("Disconnected");
    expect(await options.evaluate(() => chrome.storage.local.get())).toEqual({});
    expect(await options.evaluate(() => chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] }))).toBe(true);
    // The pregranted fixture permission is required and cannot be revoked.
  } finally {
    await context?.close();
    await prisma.$disconnect();
  }
});
