import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, posix } from "node:path";

import { expect, request as apiRequest, test, type Locator, type Page } from "@playwright/test";
import { hash } from "bcryptjs";
import { strFromU8, unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { PrismaClient } from "@prisma/client";
import sharp from "sharp";

import { getMediaRoot, resolveMediaPath } from "../lib/article-images";
import { identityThrottleKey } from "../lib/auth-throttle";
import { generateTotp } from "../lib/two-factor";
import { signIn } from "./helpers";

async function followMobileUtilityLink(page: Page, name: string) {
  await page.locator('summary[aria-label="More navigation"]').click();
  const menu = page.getByRole("navigation", { name: "More", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("link", { name, exact: true }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("reader can save extracted content, organize it, annotate it, and share it", async ({ page }) => {
  await signIn(page);
  const unique = Date.now();
  const title = `A durable reading workflow ${unique}`;
  const response = await page.request.post("/api/entries", {
    data: {
      url: `https://example.com/wallaby-e2e-${unique}`,
      title,
      tags: ["research"],
      content: `<html lang="en"><body><article><h1>${title}</h1><p>${"A thoughtful article about keeping knowledge available for later reading. ".repeat(50)}</p></article></body></html>`,
    },
  });
  expect(response.status()).toBe(201);
  const entry = (await response.json()) as { id: string };

  await page.goto("/entries?view=all");
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("link", { name: `Read ${title}` }).click();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(page.locator(".article-content")).toContainText("keeping knowledge available");

  await page.getByPlaceholder("Optional quote from the article").fill("keeping knowledge available");
  await page.getByPlaceholder("Capture a thought…").fill("This is the core idea to revisit.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: "This is the core idea to revisit." })).toBeVisible();

  await page.getByTitle("Public sharing").click();
  const shareLink = page.locator(".share-notice a");
  await expect(shareLink).toBeVisible();
  const href = await shareLink.getAttribute("href");
  expect(href).toMatch(/^\/share\//);

  const publicPage = await page.context().newPage();
  await publicPage.goto(href!);
  await expect(publicPage.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(publicPage.locator(".article-content")).toContainText("keeping knowledge available");
  await publicPage.close();

  const deleteResponse = await page.request.delete(`/api/entries/${entry.id}`);
  expect(deleteResponse.status()).toBe(204);
});

test("API saves and updates preserve supplementary prefetched content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Prefetched API content needs one browser profile");
  await signIn(page);
  const url = `https://prefetched-api.example/${randomUUID()}`;
  const article = (note: string) => `<article><p>${"The main article is already extracted. ".repeat(80)}</p><aside><p>${note}</p></aside><script>unsafe()</script></article>`;
  const created = await page.request.post("/api/entries", { data: {
    url,
    title: "Saved article with supporting information",
    content: article("The original supplementary note."),
  } });
  expect(created.status()).toBe(201);
  const entry = await created.json() as { id: string; content: string };
  try {
    expect(entry.content).toContain("The original supplementary note.");
    expect(entry.content).not.toContain("<script");

    const repeated = await page.request.post("/api/entries", { data: {
      url,
      content: article("A replacement supplementary note."),
    } });
    expect(repeated.status()).toBe(201);
    const replacement = await repeated.json() as { id: string; content: string };
    expect(replacement.id).toBe(entry.id);
    expect(replacement.content).toContain("A replacement supplementary note.");
    expect(replacement.content).not.toContain("The original supplementary note.");
    expect(replacement.content).not.toContain("<script");

    const patched = await page.request.patch(`/api/entries/${entry.id}`, { data: {
      content: article("A patched supplementary note."),
    } });
    expect(patched.status()).toBe(200);
    const persisted = await page.request.get(`/api/entries/${entry.id}`);
    const updated = await persisted.json() as { content: string };
    expect(updated.content).toContain("A patched supplementary note.");
    expect(updated.content).not.toContain("A replacement supplementary note.");
    expect(updated.content).not.toContain("<script");
  } finally {
    await page.request.delete(`/api/entries/${entry.id}`);
  }
});

test("reading progress stays monotonic and can archive an already-finished entry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Progress persistence needs one browser profile");
  await signIn(page);
  const created = await page.request.post("/api/entries", { data: {
    url: `https://progress.example/${randomUUID()}`,
    content: `<article><p>${"Reading progress should survive repeated and concurrent saves. ".repeat(35)}</p></article>`,
  } });
  expect(created.status()).toBe(201);
  const entry = await created.json() as { id: string };
  const path = `/api/entries/${entry.id}/progress`;
  try {
    for (const [progress, archive, expectedProgress, expectedArchive] of [
      [0.4, false, 0.4, 0],
      [0.8, false, 0.8, 0],
      [0.3, false, 0.8, 0],
      [0.97, false, 0.97, 0],
      [0.97, true, 0.97, 1],
      [0, false, 0, 1],
    ] as const) {
      const response = await page.request.post(path, { data: { progress, archive } });
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ reading_progress: expectedProgress, is_archived: expectedArchive });
    }
    const concurrent = await Promise.all([0.3, 0.9, 0.4, 0.6].map((progress) => page.request.post(path, { data: { progress } })));
    for (const response of concurrent) expect(response.status()).toBe(200);
    const persisted = await page.request.get(`/api/entries/${entry.id}`);
    expect(await persisted.json()).toMatchObject({ reading_progress: 0.9 });
  } finally {
    await page.request.delete(`/api/entries/${entry.id}`);
  }
});

test("reader retries failed progress saves and stops rewriting a finished position", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Progress transport coverage needs one browser profile");
  await signIn(page);
  const created = await page.request.post("/api/entries", { data: {
    url: `https://progress-retry.example/${randomUUID()}`,
    title: "A reading position worth keeping",
    content: `<article>${Array.from({ length: 60 }, () => `<p>${"Saved reading should remain available after a temporary connection failure. ".repeat(8)}</p>`).join("")}</article>`,
  } });
  expect(created.status()).toBe(201);
  const entry = await created.json() as { id: string };
  const progressPath = `/api/entries/${entry.id}/progress`;
  let requests = 0;
  await page.route(`**${progressPath}`, async (route) => {
    requests += 1;
    if (requests === 1) await route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
    else await route.continue();
  });
  try {
    await page.clock.install();
    await page.goto(`/entries/${entry.id}`);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
    const bar = page.getByRole("progressbar", { name: "Reading progress" });
    await expect.poll(async () => Number(await bar.getAttribute("aria-valuenow"))).toBeGreaterThan(10);
    const failed = page.waitForResponse((response) => response.url().endsWith(progressPath) && response.status() === 503);
    await page.clock.fastForward(4_100);
    await failed;
    await expect(page.locator(".toast")).toContainText("Reading progress could not be saved");

    const retried = page.waitForResponse((response) => response.url().endsWith(progressPath) && response.status() === 200);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await retried;
    const restored = await (await page.request.get(`/api/entries/${entry.id}`)).json() as { reading_progress: number };
    expect(restored.reading_progress).toBeGreaterThan(0.1);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(bar).toHaveAttribute("aria-valuenow", "100");
    const finished = page.waitForResponse((response) => response.url().endsWith(progressPath) && response.status() === 200);
    await page.clock.fastForward(4_100);
    await finished;
    const saved = await page.request.get(`/api/entries/${entry.id}`);
    expect(await saved.json()).toMatchObject({ reading_progress: 1 });
    const requestsAtCompletion = requests;
    for (let index = 0; index < 3; index++) {
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      await page.clock.fastForward(4_100);
    }
    await page.request.get(`/api/entries/${entry.id}`);
    expect(requests).toBe(requestsAtCompletion);
  } finally {
    await page.unroute(`**${progressPath}`);
    await page.request.delete(`/api/entries/${entry.id}`);
  }
});

test("protected routes redirect to a usable responsive sign-in page", async ({ page }) => {
  await page.goto("/entries");
  await expect(page).toHaveURL(/\/auth\/signin/);
  await expect(page.getByRole("heading", { name: /Keep the web worth keeping/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("pagination handles invalid and oversized page numbers across library, API, and feeds", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Pagination input coverage needs one browser profile");
  const prisma = new PrismaClient();
  const username = `pagination-${randomUUID()}`;
  const password = `Pagination-${randomUUID()}!`;
  const feedToken = randomUUID();
  const user = await prisma.user.create({ data: {
    username,
    passwordHash: await hash(password, 12),
    preference: { create: { itemsPerPage: 1, feedLimit: 1, feedToken } },
  } });
  try {
    await signIn(page, username, password);
    const title = "A page that remains reachable";
    const created = await page.request.post("/api/entries", { data: {
      url: `https://pagination.example/${username}`,
      title,
      content: `<article><p>${"Pagination must not break the reading library. ".repeat(35)}</p></article>`,
    } });
    expect(created.status()).toBe(201);
    const entry = await created.json() as { id: string };
    for (const value of ["Infinity", "1.5", "-1", "not-a-page", "1e40", "9007199254740991"]) {
      await page.goto(`/entries?view=all&page=${value}`);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      for (const endpoint of ["/api/entries", "/api/search"]) {
        const response = await page.request.get(`${endpoint}?page=${value}&perPage=1`);
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({ page: 1, _embedded: { items: [{ id: entry.id }] } });
      }
      const feed = await page.request.get(`/feed/${username}/${feedToken}/all/${value}`);
      expect(feed.status()).toBe(200);
      const feedBody = await feed.text();
      expect(feedBody).toContain(title);
      expect(feedBody).toContain(`/feed/${username}/${feedToken}/all" rel="first" />`);
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});

test("production health probes and browser security headers are active", async ({ page }) => {
  const [live, ready, signInResponse, apiInfo] = await Promise.all([
    page.request.get("/api/health/live"),
    page.request.get("/api/health/ready"),
    page.request.get("/auth/signin"),
    page.request.get("/api/info"),
  ]);
  expect(live.status()).toBe(200);
  expect(await live.json()).toMatchObject({ status: "ok", service: "wallaby" });
  expect(live.headers()["set-cookie"]).toBeUndefined();
  expect(ready.status()).toBe(200);
  expect(await ready.json()).toMatchObject({ status: "ready", checks: { database: "ok" } });
  expect(ready.headers()["set-cookie"]).toBeUndefined();
  expect(signInResponse.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(signInResponse.headers()["x-frame-options"]).toBe("DENY");
  expect(signInResponse.headers()["x-content-type-options"]).toBe("nosniff");
  expect(signInResponse.headers()["x-powered-by"]).toBeUndefined();
  expect(apiInfo.headers()["cache-control"]).toContain("no-store");
});

test("core surfaces stay accessible, named, and free of browser diagnostics", async ({ page }) => {
  const browserDiagnostics: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") browserDiagnostics.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
  await signIn(page);
  for (const path of ["/entries?view=all", "/entries/help", "/entries/import", "/entries/settings", "/entries/developer", "/entries/admin"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await expect(page).not.toHaveTitle("");
    await expectNoHorizontalOverflow(page);
    const audit = await page.evaluate(() => {
      const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      const unnamedControls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([type=hidden]), select, textarea")]
        .filter((control) => !control.name)
        .map((control) => control.outerHTML.slice(0, 120));
      const imagesWithoutAlt = [...document.querySelectorAll("img:not([alt])")].map((image) => image.outerHTML.slice(0, 120));
      return { duplicates, unnamedControls, imagesWithoutAlt };
    });
    expect(audit).toEqual({ duplicates: [], unnamedControls: [], imagesWithoutAlt: [] });
  }
  expect(browserDiagnostics).toEqual([]);
  await page.goto("/this-route-does-not-exist");
  await expect(page.getByRole("heading", { name: "This page is no longer on the shelf." })).toBeVisible();
});

test("repeated password failures persistently throttle sign-in", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Persistent throttle coverage only needs one browser profile");
  const prisma = new PrismaClient();
  const unique = Date.now();
  const username = `throttle-${unique}`;
  const password = `Throttle-${unique}!`;
  const user = await prisma.user.create({ data: {
    username,
    name: "Throttle Test",
    email: `${username}@example.test`,
    passwordHash: await hash(password, 12),
    preference: { create: {} },
  } });
  try {
    await prisma.authThrottle.create({ data: {
      key: identityThrottleKey(username),
      failures: 7,
      windowStartedAt: new Date(),
    } });
    await page.goto("/auth/signin");
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password").fill("incorrect-password");
    let completed = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/auth/signin");
    await page.getByRole("button", { name: "Sign in" }).click();
    await completed;
    await expect(page.locator(".form-error[role=alert]")).toContainText("Too many sign-in attempts");
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password").fill(password);
    completed = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/auth/signin");
    await page.getByRole("button", { name: "Sign in" }).click();
    await completed;
    await expect(page.locator(".form-error[role=alert]")).toContainText("Too many sign-in attempts");
    await expect(page).toHaveURL(/\/auth\/signin/);
  } finally {
    await prisma.authThrottle.deleteMany();
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});

test("quick-start help is reachable and responsive", async ({ page }) => {
  await signIn(page);
  const mobileMenu = page.locator('summary[aria-label="More navigation"]');
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page.getByRole("link", { name: "Help & quick start" }).click();
  await expect(page.getByRole("heading", { name: "Help & quick start" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Quick start" })).toContainText("Save");
  await expect(page.getByRole("main").getByRole("link", { name: "Import & export" })).toHaveAttribute("href", "/entries/import");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("sidebar search focuses the library field after client-side navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Sidebar keyboard focus needs one desktop profile");
  await signIn(page);
  for (const path of ["/entries?view=all", "/entries/help"]) {
    await page.goto(path);
    await page.getByRole("navigation", { name: "Library", exact: true }).getByRole("link", { name: "Search", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Search your library" });
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(search).not.toBeFocused();
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
  }
});

test("mobile utility navigation reaches account, portability, and administration", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "Mobile navigation coverage only");
  const prisma = new PrismaClient();
  const unique = Date.now();
  const username = `mobile-admin-${unique}`;
  const password = `Mobile-admin-${unique}!`;
  const admin = await prisma.user.create({ data: {
    username,
    name: "Mobile Administrator",
    email: `${username}@example.test`,
    passwordHash: await hash(password, 12),
    role: "ADMIN",
    preference: { create: {} },
  } });

  try {
    await signIn(page, username, password);
    await followMobileUtilityLink(page, "Settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save profile" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await followMobileUtilityLink(page, "Import & export");
    await expect(page.getByRole("heading", { name: "Import & export", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import entries" })).toBeVisible();
    await expect(page.getByLabel("Source").getByRole("option", { name: "Readability JSON" })).toHaveCount(1);
    await expect(page.getByLabel("Source").getByRole("option", { name: "Shaarli bookmarks HTML" })).toHaveCount(1);
    await expect(page.getByLabel("Source").getByRole("option", { name: "Elcurator JSON" })).toHaveCount(1);
    await expectNoHorizontalOverflow(page);

    await followMobileUtilityLink(page, "Administration");
    await expect(page.getByRole("heading", { name: "Administration", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create user" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    await prisma.user.deleteMany({ where: { id: admin.id } });
    await prisma.$disconnect();
  }
});

test("an account can update its profile and password, reset data, and delete itself", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Account lifecycle needs one browser profile");
  const prisma = new PrismaClient();
  const unique = Date.now();
  const originalUsername = `account-${unique}`;
  const updatedUsername = `reader-${unique}`;
  const oldPassword = `Old-password-${unique}!`;
  const newPassword = `New-password-${unique}!`;
  const createdUser = await prisma.user.create({ data: {
    username: originalUsername,
    name: "Temporary Reader",
    email: `${originalUsername}@example.test`,
    passwordHash: await hash(oldPassword, 12),
    preference: { create: {} },
  } });
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();

  try {
    await signIn(page, originalUsername, oldPassword);
    await signIn(secondPage, originalUsername, oldPassword);
    await page.goto("/entries/settings");
    const profileForm = page.locator(".account-form").first();
    await profileForm.getByLabel("Display name").fill("Updated Reader");
    await profileForm.getByLabel("Username").fill(updatedUsername);
    await profileForm.getByLabel("Email").fill(`${updatedUsername}@example.test`);
    await profileForm.getByLabel("Current password").fill(oldPassword);
    await profileForm.getByRole("button", { name: "Save profile" }).click();
    await expect(profileForm.getByRole("status")).toHaveText("Profile updated.");
    await expect(page.locator(".profile-chip strong")).toHaveText("Updated Reader");

    const passwordForm = page.locator(".account-form").nth(1);
    await passwordForm.getByLabel("Current password").fill(oldPassword);
    await passwordForm.getByLabel("New password", { exact: true }).fill(newPassword);
    await passwordForm.getByLabel("Confirm new password").fill(newPassword);
    await passwordForm.getByRole("button", { name: "Change password" }).click();
    await expect(page).toHaveURL(/\/auth\/signin/);
    await secondPage.goto("/entries");
    await expect(secondPage).toHaveURL(/\/auth\/signin/);

    await signIn(page, updatedUsername, newPassword);
    const createResponse = await page.request.post("/api/entries", { data: {
      url: `https://account-${unique}.example/story`,
      title: `Account reset entry ${unique}`,
      tags: [`account-${unique}`],
      content: `<article><p>${"Account lifecycle content. ".repeat(30)}</p></article>`,
    } });
    expect(createResponse.status()).toBe(201);
    const entry = await createResponse.json() as { id: string };
    await page.goto("/entries/settings");
    const resetForm = page.locator(".danger-form").first();
    await resetForm.getByLabel("Reset scope").selectOption("entries");
    await resetForm.getByLabel("Current password").fill(newPassword);
    await resetForm.getByRole("button", { name: "Reset selected data" }).click();
    await expect(resetForm.getByRole("status")).toHaveText("entries reset completed.");
    expect((await page.request.get(`/api/entries/${entry.id}`)).status()).toBe(404);

    const deleteForm = page.locator(".delete-account-form");
    await deleteForm.getByLabel("Type username to confirm").fill(updatedUsername);
    await deleteForm.getByLabel("Current password").fill(newPassword);
    await deleteForm.getByRole("button", { name: "Delete account" }).click();
    await expect(page).toHaveURL(/\/auth\/signin/);
    expect(await prisma.user.findUnique({ where: { id: createdUser.id } })).toBeNull();
  } finally {
    await secondContext.close();
    await prisma.user.deleteMany({ where: { id: createdUser.id } });
    await prisma.$disconnect();
  }
});

test("administrators manage users, roles, passwords, and instance origin rules", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Administration needs one browser profile");
  const prisma = new PrismaClient();
  const unique = Date.now();
  const adminUsername = `admin-${unique}`;
  const adminPassword = `Admin-password-${unique}!`;
  const managedUsername = `managed-${unique}`;
  const managedPassword = `Managed-password-${unique}!`;
  const resetPassword = `Reset-password-${unique}!`;
  const admin = await prisma.user.create({ data: {
    username: adminUsername,
    name: "Temporary Admin",
    email: `${adminUsername}@example.test`,
    passwordHash: await hash(adminPassword, 12),
    role: "ADMIN",
    preference: { create: {} },
  } });
  const originalImageConfiguration = await prisma.instanceConfiguration.findUnique({ where: { id: "default" } });
  const managedContext = await browser.newContext();
  const managedPage = await managedContext.newPage();
  const submitAdminForm = async (button: Locator) => {
    const completed = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/entries/admin");
    await button.click();
    const response = await completed;
    expect(response.status()).toBeLessThan(400);
  };

  try {
    await signIn(page, adminUsername, adminPassword);
    await expect(page.getByRole("link", { name: "Administration" })).toBeVisible();
    await page.getByRole("link", { name: "Administration" }).click();
    await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
    const imageForm = page.locator(".image-settings-form");
    await imageForm.getByLabel("Download images when entries are saved or reloaded").check();
    await imageForm.getByLabel("Images per entry").fill("7");
    await imageForm.getByLabel("Maximum image size (MB)").fill("1.5");
    await imageForm.getByLabel("Maximum per entry (MB)").fill("25");
    await imageForm.getByLabel("Maximum per user (MB)").fill("100");
    await submitAdminForm(imageForm.getByRole("button", { name: "Save image policy" }));
    await page.reload();
    await expect(imageForm.getByLabel("Download images when entries are saved or reloaded")).toBeChecked();
    await expect(imageForm.getByLabel("Images per entry")).toHaveValue("7");
    await expect(imageForm.getByLabel("Maximum image size (MB)")).toHaveValue("1.5");
    await expect(imageForm.getByLabel("Maximum per entry (MB)")).toHaveValue("25");
    await expect(imageForm.getByLabel("Maximum per user (MB)")).toHaveValue("100");
    const createForm = page.locator(".admin-create-form");
    await createForm.getByLabel("New user display name").fill("Managed Reader");
    await createForm.getByLabel("New user username").fill(managedUsername);
    await createForm.getByLabel("New user email").fill(`${managedUsername}@example.test`);
    await createForm.getByLabel("New user password").fill(managedPassword);
    await createForm.getByRole("button", { name: "Create user" }).click();
    let managedRow = page.locator(".admin-user-list article", { has: page.getByLabel(`Username for ${managedUsername}`) });
    await expect(managedRow).toBeVisible();

    await signIn(managedPage, managedUsername, managedPassword);
    const forbidden = await managedPage.goto("/entries/admin");
    expect(forbidden?.status()).toBe(404);

    await managedRow.getByLabel(`Role for ${managedUsername}`).selectOption("ADMIN");
    await submitAdminForm(managedRow.getByRole("button", { name: "Save" }));
    managedRow = page.locator(".admin-user-list article", { has: page.getByLabel(`Username for ${managedUsername}`) });
    await expect(managedRow.getByLabel(`Role for ${managedUsername}`)).toHaveValue("ADMIN");
    expect((await prisma.user.findUniqueOrThrow({ where: { username: managedUsername } })).role).toBe("ADMIN");
    await managedRow.locator(".admin-user-form").evaluate((form: HTMLFormElement) => form.reset());
    await expect(managedRow.getByLabel(`Role for ${managedUsername}`)).toHaveValue("ADMIN");
    await managedPage.goto("/entries/admin");
    await expect(managedPage.getByRole("heading", { name: "Administration" })).toBeVisible();

    await managedRow.getByText("Reset password", { exact: true }).click();
    await managedRow.getByLabel(`New password for ${managedUsername}`).fill(resetPassword);
    // Expose navigation that races a still-pending administrative mutation.
    await page.route("**/entries/admin", async (route) => {
      if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await submitAdminForm(managedRow.getByRole("button", { name: "Reset", exact: true }));
    await page.unroute("**/entries/admin");
    await managedPage.goto("/entries");
    await expect(managedPage).toHaveURL(/\/auth\/signin/);
    await signIn(managedPage, managedUsername, resetPassword);

    const originalRule = `host = "instance-${unique}.example"`;
    const editedRule = `_all ~ "https?://instance-${unique}\\.example/.*"`;
    await page.getByLabel("Instance ignore-origin rule").fill(originalRule);
    await page.getByRole("button", { name: "Add instance rule" }).click();
    let instanceRow = page.locator(".admin-origin-rule-list article", { has: page.getByRole("textbox", { name: `Instance rule ${originalRule}`, exact: true }) });
    await expect(instanceRow).toBeVisible();
    await instanceRow.getByRole("textbox", { name: `Instance rule ${originalRule}`, exact: true }).fill(editedRule);
    await instanceRow.getByRole("button", { name: "Save" }).click();
    instanceRow = page.locator(".admin-origin-rule-list article", { has: page.getByRole("textbox", { name: `Instance rule ${editedRule}`, exact: true }) });
    await expect(instanceRow).toBeVisible();
    await instanceRow.getByRole("button", { name: `Delete instance rule ${editedRule}` }).click();
    await expect(instanceRow).toHaveCount(0);

    managedRow = page.locator(".admin-user-list article", { has: page.getByLabel(`Username for ${managedUsername}`) });
    await managedRow.getByRole("button", { name: `Delete user ${managedUsername}` }).click();
    await expect(managedRow).toHaveCount(0);
  } finally {
    await managedContext.close();
    await prisma.user.deleteMany({ where: { OR: [{ id: admin.id }, { username: managedUsername }] } });
    await prisma.ignoreOriginInstanceRule.deleteMany({ where: { rule: { contains: `instance-${unique}` } } });
    if (originalImageConfiguration) {
      await prisma.instanceConfiguration.update({
        where: { id: "default" },
        data: {
          downloadImagesEnabled: originalImageConfiguration.downloadImagesEnabled,
          imageMaxCount: originalImageConfiguration.imageMaxCount,
          imageMaxBytes: originalImageConfiguration.imageMaxBytes,
          imageEntryMaxBytes: originalImageConfiguration.imageEntryMaxBytes,
          imageUserMaxBytes: originalImageConfiguration.imageUserMaxBytes,
        },
      });
    } else {
      await prisma.instanceConfiguration.deleteMany({ where: { id: "default" } });
    }
    await prisma.$disconnect();
  }
});

test("downloaded article media is public, cacheable, and deleted with its entry", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Media lifecycle needs one browser profile");
  const prisma = new PrismaClient();
  const anonymousApi = await apiRequest.newContext({ baseURL: "http://127.0.0.1:3100" });
  const unique = Date.now();
  let entryId: string | null = null;
  let entryDirectory: string | null = null;

  try {
    await signIn(page);
    const user = await prisma.user.findUniqueOrThrow({ where: { username: "demo" } });
    const creation = await page.request.post("/api/entries", { data: {
      url: `https://media-${unique}.example/article`,
      title: `Downloaded media lifecycle ${unique}`,
      content: `<article><p>${"Media lifecycle article. ".repeat(35)}</p></article>`,
    } });
    expect(creation.status()).toBe(201);
    entryId = (await creation.json() as { id: string }).id;

    const imageId = randomUUID();
    const imageBytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#3c66d1" } }).png().toBuffer();
    const sha256 = createHash("sha256").update(imageBytes).digest("hex");
    const relativePath = posix.join(user.id, entryId, `${imageId}.png`);
    const imagePath = resolveMediaPath(relativePath, getMediaRoot());
    entryDirectory = dirname(imagePath);
    await mkdir(entryDirectory, { recursive: true });
    await writeFile(imagePath, imageBytes, { flag: "wx" });
    await prisma.entryImage.create({ data: {
      id: imageId,
      userId: user.id,
      entryId,
      originalUrl: `https://media-${unique}.example/cover.png`,
      contentType: "image/png",
      byteSize: imageBytes.length,
      sha256,
      relativePath,
    } });

    const media = await anonymousApi.get(`/media/${imageId}`);
    expect(media.status()).toBe(200);
    expect(media.headers()["content-type"]).toBe("image/png");
    expect(media.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(media.headers()["etag"]).toBe(`"${sha256}"`);
    expect(media.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await media.body()).toEqual(imageBytes);

    const conditional = await anonymousApi.get(`/media/${imageId}`, { headers: { "if-none-match": `"${sha256}"` } });
    expect(conditional.status()).toBe(304);
    const head = await anonymousApi.head(`/media/${imageId}`);
    expect(head.status()).toBe(200);
    expect(head.headers()["content-length"]).toBe(String(imageBytes.length));
    expect(await head.body()).toHaveLength(0);

    expect((await page.request.delete(`/api/entries/${entryId}`)).status()).toBe(204);
    expect(await prisma.entryImage.findUnique({ where: { id: imageId } })).toBeNull();
    await expect(stat(imagePath)).rejects.toThrow();
    expect((await anonymousApi.get(`/media/${imageId}`)).status()).toBe(404);
    entryId = null;
  } finally {
    if (entryId) await prisma.entry.deleteMany({ where: { id: entryId } });
    if (entryDirectory) await rm(entryDirectory, { recursive: true, force: true });
    await anonymousApi.dispose();
    await prisma.$disconnect();
  }
});

test("two-factor authentication supports TOTP, trusted devices, recovery, and disable", async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Two-factor lifecycle needs one browser profile");
  test.slow();
  const prisma = new PrismaClient();
  const unique = Date.now();
  const username = `two-factor-${unique}`;
  const password = `Two-factor-password-${unique}!`;
  const account = await prisma.user.create({ data: {
    username,
    name: "Two Factor Reader",
    email: `${username}@example.test`,
    passwordHash: await hash(password, 12),
    preference: { create: {} },
  } });
  const bypassContext = await browser.newContext();
  const bypassPage = await bypassContext.newPage();

  try {
    await signIn(page, username, password);
    await page.goto("/entries/settings");
    const section = page.locator(".two-factor-section");
    await expect(section.getByText("Two-factor authentication is disabled.")).toBeVisible();
    await section.getByLabel("Current password").first().fill(password);
    await section.getByRole("button", { name: "Start authenticator setup" }).click();
    const secret = (await section.locator(".totp-secret").textContent())!.trim();
    const recoveryCodes = (await section.locator(".recovery-code-panel pre").textContent())!.trim().split(/\s+/);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(recoveryCodes).toHaveLength(10);
    await section.getByLabel("Current six-digit code").fill(generateTotp(secret));
    await section.getByRole("button", { name: "Enable authenticator codes" }).click();
    await expect(page).toHaveURL(/\/auth\/signin/);

    const csrf = await bypassPage.request.get("/api/auth/csrf");
    const csrfToken = (await csrf.json() as { csrfToken: string }).csrfToken;
    await bypassPage.request.post("/api/auth/callback/credentials", { form: {
      csrfToken,
      username,
      password,
      callbackUrl: "http://127.0.0.1:3100/entries",
    } });
    await bypassPage.goto("/entries");
    await expect(bypassPage).toHaveURL(/\/auth\/signin/);

    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/auth\/two-factor/);
    await page.getByLabel("Authenticator or recovery code").fill(generateTotp(secret));
    await page.getByLabel("Trust this device for 15 days").check();
    await page.getByRole("button", { name: "Complete sign in" }).click();
    await expect(page).toHaveURL(/\/entries/);
    expect(await prisma.trustedDevice.count({ where: { userId: account.id } })).toBe(1);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/auth\/signin/);
    await signIn(page, username, password);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/auth\/signin/);
    await page.context().clearCookies({ name: "wallaby.trusted-device" });
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/auth\/two-factor/);
    await page.getByLabel("Authenticator or recovery code").fill(recoveryCodes[0]);
    await page.getByRole("button", { name: "Complete sign in" }).click();
    await expect(page).toHaveURL(/\/entries/);
    expect(await prisma.recoveryCode.count({ where: { userId: account.id } })).toBe(9);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/auth\/signin/);
    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("Authenticator or recovery code").fill(recoveryCodes[0]);
    await page.getByRole("button", { name: "Complete sign in" }).click();
    await expect(page.locator(".two-factor-challenge-form .form-error")).toHaveText("That authentication code is invalid.");
    await page.getByLabel("Authenticator or recovery code").fill(generateTotp(secret));
    await page.getByRole("button", { name: "Complete sign in" }).click();
    await expect(page).toHaveURL(/\/entries/);

    await page.goto("/entries/settings");
    const disableForm = section.locator(".disable-two-factor-form");
    await disableForm.getByLabel("Current password").fill(password);
    await disableForm.getByRole("button", { name: "Disable two-factor authentication" }).click();
    await expect(page).toHaveURL(/\/auth\/signin/);
    await signIn(page, username, password);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).twoFactorMethod).toBe("NONE");
    expect(await prisma.recoveryCode.count({ where: { userId: account.id } })).toBe(0);
  } finally {
    await bypassContext.close();
    await prisma.user.deleteMany({ where: { id: account.id } });
    await prisma.$disconnect();
  }
});

test("a one-time bearer token authenticates without a browser session", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "API authentication needs one browser profile");
  await signIn(page);
  await page.goto("/entries/settings");
  const suffix = Date.now();
  const tokenName = `E2E client ${suffix}`;
  await page.getByLabel("Token name").fill(tokenName);
  await page.locator(".token-creator").getByRole("button", { name: "Create token" }).click();
  const token = await page.locator(".token-secret code").textContent();
  expect(token).toMatch(/^wby_/);

  const anonymousApi = await apiRequest.newContext({ baseURL: "http://127.0.0.1:3100" });
  const response = await anonymousApi.get("/api/config", { headers: { authorization: `Bearer ${token}` } });
  expect(response.status()).toBe(200);
  await expect.poll(async () => (await response.json()).language).toBe("en");
  await anonymousApi.dispose();

  const host = `publication-${suffix}.example`;
  await page.getByLabel("Site hostname").fill(host);
  await page.getByLabel("Site username").fill("private-reader");
  await page.getByLabel("Site password").fill("not-stored-in-plain-text");
  await page.getByRole("button", { name: "Save encrypted login" }).click();
  const credentialRow = page.locator(".credential-list > div", { hasText: host });
  await expect(credentialRow).toContainText("Encrypted with AES-256-GCM");
  await credentialRow.getByRole("button", { name: `Delete login for ${host}` }).click();
  await expect(credentialRow).toHaveCount(0);

  const tokenRow = page.locator(".token-list > div", { hasText: tokenName });
  await tokenRow.getByRole("button", { name: `Revoke ${tokenName}` }).click();
  await expect(tokenRow).toHaveCount(0);
});

test("a wallabag JSON library round trips through import and export", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Data portability needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const title = `Imported library entry ${unique}`;
  await page.goto("/entries/import");
  await page.getByLabel("Source").selectOption("wallabag");
  await page.getByLabel("Export file").setInputFiles({
    name: "wallabag.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([{
      url: `https://example.com/import-${unique}`,
      title,
      content: `<p>${"Portable article content. ".repeat(30)}</p>`,
      tags: [{ label: "portable" }],
      is_starred: 1,
      origin_url: `https://source.example/roundup-${unique}`,
      annotations: [{ text: "Imported note", quote: "Portable article content.", ranges: [] }],
    }])),
  });
  await page.getByRole("button", { name: "Import entries" }).click();
  await expect(page.locator(".job-list article").first()).toContainText("pending · 0/1 imported");
  await page.reload();
  await expect(page.locator(".job-list article").first()).toContainText("pending · 0/1 imported");
  await page.locator(".job-list article").first().getByRole("button", { name: "Run now" }).click();
  await expect(page.locator(".job-list article").first()).toContainText("completed · 1/1 imported");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: /JSON Best for round trips/ }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; title: string; origin_url: string | null; annotations: { text: string; quote: string }[] }[];
  const imported = exported.find((entry) => entry.title === title);
  expect(imported).toBeTruthy();
  expect(imported!.origin_url).toBe(`https://source.example/roundup-${unique}`);
  expect(imported!.annotations).toMatchObject([{ text: "Imported note", quote: "Portable article content." }]);
  const deletion = await page.request.delete(`/api/entries/${imported!.id}`);
  expect(deletion.status()).toBe(204);
});

test("an OAuth client completes authorization-code, API, refresh, and revocation flows", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Developer OAuth lifecycle needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const clientName = `Browser OAuth ${unique}`;
  const redirectUri = `http://127.0.0.1:3100/oauth-callback-${unique}`;
  await page.goto("/entries/developer");
  await page.getByLabel("Application name").fill(clientName);
  await page.getByLabel("Exact redirect URLs, one per line").fill(redirectUri);
  await page.getByRole("button", { name: "Create OAuth client" }).click();
  const secretPanel = page.locator(".oauth-client-secret");
  await expect(secretPanel).toContainText("Only its hash is stored");
  const secrets = await secretPanel.locator("code").allTextContents();
  const [clientId, clientSecret] = secrets;
  expect(clientId).toMatch(/^wby_client_/);
  expect(clientSecret.length).toBeGreaterThan(32);
  const clientRow = page.locator(".oauth-client-list article", { hasText: clientName });
  await expect(clientRow).toContainText("authorization_code, refresh_token");

  const authorization = new URL("http://127.0.0.1:3100/oauth/v2/auth");
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("state", `state-${unique}`);
  authorization.searchParams.set("scope", "read write");
  await page.goto(authorization.toString());
  await expect(page.getByRole("heading", { name: `Allow ${clientName}?` })).toBeVisible();
  await expect(page.locator(".oauth-redirect")).toContainText(redirectUri);
  await page.getByRole("button", { name: "Authorize application" }).click();
  await expect(page).toHaveURL(new RegExp(`oauth-callback-${unique}\\?`));
  const callback = new URL(page.url());
  expect(callback.searchParams.get("state")).toBe(`state-${unique}`);
  const code = callback.searchParams.get("code");
  expect(code).toMatch(/^wby_code_/);

  const exchange = await page.request.post("/oauth/v2/token", { form: {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code: code!,
    redirect_uri: redirectUri,
  } });
  expect(exchange.status()).toBe(200);
  expect(exchange.headers()["cache-control"]).toBe("no-store");
  const tokens = await exchange.json() as { access_token: string; refresh_token: string; token_type: string };
  expect(tokens).toMatchObject({ token_type: "bearer" });
  const api = await page.request.get("/api/config", { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(api.status()).toBe(200);

  const refresh = await page.request.post("/oauth/v2/token", { form: {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  } });
  expect(refresh.status()).toBe(200);
  const replay = await page.request.post("/oauth/v2/token", { form: {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  } });
  expect(replay.status()).toBe(400);
  expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

  await page.goto("/entries/developer");
  await page.locator(".oauth-client-list article", { hasText: clientName }).getByRole("button", { name: `Delete OAuth client ${clientName}` }).click();
  await expect(page.locator(".oauth-client-list article", { hasText: clientName })).toHaveCount(0);
});

test("wallabag JSON aliases, filters, XML, search, and errors honor the compatibility contract", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "API contract matrix needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const url = `https://example.com/api-contract-${unique}`;
  const createdResponse = await page.request.post("/api/entries.json", { form: {
    url,
    title: `Contract entry ${unique}`,
    content: "<p>Offline contract content.</p>",
    tags: "api-contract,portable",
    archive: "1",
    starred: "1",
    public: "1",
    language: "en",
    authors: "Ada Reader,Sam Reader",
    origin_url: `https://source.example/contract-${unique}`,
  } });
  expect(createdResponse.status()).toBe(200);
  const created = await createdResponse.json() as { id: string; content: string; user_name: string; is_public: boolean; tags: { id: string; label: string }[] };
  expect(created).toMatchObject({ user_name: "demo", is_public: true });
  expect(created.content).toContain("<p>Offline contract content.</p>");
  expect(created.tags.map((tag) => tag.label).sort()).toEqual(["api-contract", "portable"]);

  const metadata = await page.request.get(`/api/entries/${created.id}.json?detail=metadata`);
  expect(metadata.status()).toBe(200);
  expect(await metadata.json()).toMatchObject({ id: created.id, content: null, user_name: "demo", user_email: "demo@wallaby.local" });
  const wrongDetail = await page.request.get(`/api/entries/${created.id}.json?detail=unknown`);
  expect(wrongDetail.status()).toBe(400);
  expect(await wrongDetail.json()).toMatchObject({ error: "invalid_parameter", "@type": "hydra:Error" });

  const listing = await page.request.get("/api/entries.json?archive=1&starred=1&tags=api-contract&order=asc&detail=metadata&perPage=1");
  expect(listing.status()).toBe(200);
  const envelope = await listing.json() as { total: number; limit: number; _embedded: { items: { id: string; content: null }[] }; _links: { self: { href: string }; first: { href: string } } };
  expect(envelope).toMatchObject({ limit: 1 });
  expect(envelope.total).toBeGreaterThanOrEqual(1);
  expect(envelope._embedded.items.find((entry) => entry.id === created.id)?.content).toBeNull();
  expect(envelope._links.self.href).toContain("tags=api-contract");
  expect(envelope._links.first.href).toContain("order=asc");
  const badOrder = await page.request.get("/api/entries?order=sideways");
  expect(badOrder.status()).toBe(400);

  const search = await page.request.get(`/api/search.json?term=${unique}&per_page=2`);
  const searchEnvelope = await search.json() as { page: number; limit: number; total: number; _embedded: { items: { id: string }[] }; _links: { self: { href: string } } };
  expect(searchEnvelope).toMatchObject({ page: 1, limit: 2, total: 1 });
  expect(searchEnvelope._embedded.items[0].id).toBe(created.id);
  expect(searchEnvelope._links.self.href).toContain(`term=${unique}`);

  const hashedUrl = createHash("sha1").update(url).digest("hex");
  const exists = await page.request.get(`/api/entries/exists.json?hashed_url=${hashedUrl}&return_id=1`);
  expect(await exists.json()).toEqual({ exists: created.id });
  const tags = await page.request.get("/api/tags.json");
  expect((await tags.json() as { label: string; nbEntries: number }[]).find((tag) => tag.label === "api-contract")?.nbEntries).toBe(1);

  const xml = await page.request.get(`/api/entries/${created.id}.xml?detail=metadata`);
  expect(xml.headers()["content-type"]).toContain("application/xml");
  expect(await xml.text()).toContain(`<id>${created.id}</id>`);
  const info = await page.request.get("/api/info.json");
  expect(await info.json()).toEqual({ appname: "wallabag", version: "0.1.0", allowed_registration: false });
  expect(await (await page.request.get("/api/version.json")).json()).toBe("0.1.0");

  const anonymousApi = await apiRequest.newContext({ baseURL: "http://127.0.0.1:3100" });
  const denied = await anonymousApi.get("/api/config.json");
  expect(denied.status()).toBe(401);
  expect(await denied.json()).toMatchObject({ error: "access_denied", error_description: "OAuth2 authentication required", "hydra:title": "Authentication required" });
  await anonymousApi.dispose();

  const deleted = await page.request.delete(`/api/entries/${created.id}.json?expect=id`);
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toEqual({ id: created.id });
});

test("EPUB and PDF exports download as valid multilingual documents", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Binary portability needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const title = `Portable 中文 library ${unique}`;
  const response = await page.request.post("/api/entries", { data: {
    url: `https://example.com/binary-export-${unique}`,
    title,
    tags: ["portable-binary"],
    content: `<article lang="zh-CN"><p>${"Readable 中文 العربية русский article. ".repeat(70)}</p></article>`,
  } });
  expect(response.status()).toBe(201);
  const entry = await response.json() as { id: string };

  try {
    await page.goto("/entries/import");
    await expect(page.getByRole("link", { name: /EPUB Offline e-book/ })).toHaveAttribute("href", "/export/epub?scope=all");
    await expect(page.getByRole("link", { name: /PDF Printable collection/ })).toHaveAttribute("href", "/export/pdf?scope=all");

    const epubResponse = await page.request.get(`/export/epub?id=${entry.id}`);
    expect(epubResponse.status()).toBe(200);
    expect(epubResponse.headers()["content-type"]).toBe("application/epub+zip");
    expect(epubResponse.headers()["content-disposition"]).toMatch(/attachment; filename="wallaby-all-\d{4}-\d{2}-\d{2}\.epub"/);
    const epub = await epubResponse.body();
    expect(epub.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
    const epubFiles = unzipSync(epub);
    expect(strFromU8(epubFiles.mimetype)).toBe("application/epub+zip");
    expect(strFromU8(epubFiles["OEBPS/chapter-1.xhtml"])).toContain(title);

    const pdfResponse = await page.request.get(`/export/pdf?id=${entry.id}`);
    expect(pdfResponse.status()).toBe(200);
    expect(pdfResponse.headers()["content-type"]).toBe("application/pdf");
    expect(pdfResponse.headers()["content-disposition"]).toMatch(/attachment; filename="wallaby-all-\d{4}-\d{2}-\d{2}\.pdf"/);
    const pdfBytes = await pdfResponse.body();
    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getTitle()).toBe(title);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  } finally {
    expect((await page.request.delete(`/api/entries/${entry.id}`)).status()).toBe(204);
  }
});

test("wallabag-style rules tag new and existing entries", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Rule integration needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const rule = `title matches "taxonomy-${unique}"`;
  const existingResponse = await page.request.post("/api/entries", { data: {
    url: `https://example.com/existing-rule-${unique}`,
    title: `An existing taxonomy-${unique} entry`,
    content: `<article><p>${"Existing rule matching article. ".repeat(40)}</p></article>`,
  } });
  expect(existingResponse.status()).toBe(201);
  const existingEntry = await existingResponse.json() as { id: string; tags: { label: string }[] };
  expect(existingEntry.tags.map((tag) => tag.label)).not.toContain("automatic-e2e");

  await page.goto("/entries/settings");
  const taggingForm = page.locator("form.rule-form", { has: page.getByLabel("Tagging rule", { exact: true }) });
  await taggingForm.getByLabel("Tagging rule", { exact: true }).fill(rule);
  await taggingForm.getByLabel("Tags to apply").fill("automatic-e2e");
  await taggingForm.getByRole("button", { name: "Add rule" }).click();
  await expect(page.locator(".rule-list article", { hasText: rule })).toBeVisible();

  const applyRulesResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/entries/settings",
  );
  await page.getByRole("button", { name: "Apply all rules to existing entries" }).click();
  const applyRulesResponse = await applyRulesResponsePromise;
  expect(applyRulesResponse.ok()).toBe(true);
  await expect(page.getByRole("navigation", { name: "Tags" }).getByRole("link", { name: /automatic-e2e/ })).toContainText("1");
  const existingAfterApply = await page.request.get(`/api/entries/${existingEntry.id}`);
  expect(existingAfterApply.status()).toBe(200);
  const retaggedEntry = await existingAfterApply.json() as { tags: { label: string }[] };
  expect(retaggedEntry.tags.map((tag) => tag.label)).toContain("automatic-e2e");

  const response = await page.request.post("/api/entries", { data: {
    url: `https://example.com/rule-${unique}`,
    title: `A taxonomy-${unique} entry`,
    content: `<article><p>${"Rule matching article. ".repeat(40)}</p></article>`,
  } });
  expect(response.status()).toBe(201);
  const entry = await response.json() as { id: string; tags: { label: string }[] };
  expect(entry.tags.map((tag) => tag.label)).toContain("automatic-e2e");
  expect((await page.request.delete(`/api/entries/${entry.id}`)).status()).toBe(204);
  expect((await page.request.delete(`/api/entries/${existingEntry.id}`)).status()).toBe(204);

  await page.getByRole("button", { name: `Delete rule ${rule}` }).click();
  await expect(page.locator(".rule-list article", { hasText: rule })).toHaveCount(0);
});

test("tagging rules can be edited and round trip through wallabag JSON", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Rule portability needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const originalRule = `domainName = "portable-${unique}.example"`;
  const editedRule = `domainName = "edited-${unique}.example"`;
  const createdResponse = await page.request.post("/api/tagging-rules", { data: { rule: originalRule, tags: ["portable-rule"] } });
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json() as { id: string };

  await page.goto("/entries/settings");
  const originalRow = page.locator(".rule-list article", { hasText: originalRule });
  await originalRow.getByText("Edit", { exact: true }).click();
  await originalRow.getByLabel(`Rule expression ${originalRule}`).fill(editedRule);
  await originalRow.getByLabel(`Rule tags ${originalRule}`).fill("portable-rule, edited-rule");
  await originalRow.getByRole("button", { name: "Update" }).click();
  await expect(page.locator(".rule-list article", { hasText: editedRule })).toContainText("#edited-rule");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export rules" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rule: string; tags: string[]; id?: string }[];
  expect(exported).toContainEqual({ rule: editedRule, tags: ["portable-rule", "edited-rule"] });
  expect(exported.every((rule) => rule.id === undefined)).toBe(true);

  expect((await page.request.delete(`/api/tagging-rules?id=${encodeURIComponent(created.id)}`)).status()).toBe(204);
  await page.reload();
  await expect(page.locator(".rule-list article", { hasText: editedRule })).toHaveCount(0);
  await page.getByLabel("Import JSON").setInputFiles({
    name: "tagging_rules.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([{ rule: editedRule, tags: ["portable-rule", "edited-rule"] }])),
  });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.locator(".rule-list article", { hasText: editedRule })).toContainText("#edited-rule");

  const listing = await page.request.get("/api/tagging-rules");
  expect(listing.status()).toBe(200);
  const importedRules = await listing.json() as { id: string; rule: string }[];
  const imported = importedRules.find((rule) => rule.rule === editedRule);
  expect(imported).toBeTruthy();
  expect((await page.request.delete(`/api/tagging-rules?id=${encodeURIComponent(imported!.id)}`)).status()).toBe(204);
});

test("ignore-origin rules can be created, edited, and deleted", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Redirect-rule management needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const originalRule = `host = "ignore-${unique}.example"`;
  const editedRule = `_all ~ "https?://ignore-${unique}\\.example/.*"`;
  await page.goto("/entries/settings");
  await page.getByLabel("Ignore-origin rule").fill(originalRule);
  await page.locator(".origin-rule-form").getByRole("button", { name: "Add rule" }).click();
  const originalRow = page.locator(".origin-rule-list article", { hasText: originalRule });
  await expect(originalRow).toBeVisible();

  await originalRow.getByText("Edit", { exact: true }).click();
  await originalRow.getByLabel(`Ignore-origin expression ${originalRule}`).fill(editedRule);
  await originalRow.getByRole("button", { name: "Update" }).click();
  const editedRow = page.locator(".origin-rule-list article", { hasText: editedRule });
  await expect(editedRow).toBeVisible();
  await editedRow.getByRole("button", { name: `Delete ignore-origin rule ${editedRule}` }).click();
  await expect(editedRow).toHaveCount(0);
});

test("untagged, same-domain, and random library views are reachable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Library view matrix needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const domain = `views-${unique}.example`;
  const firstTitle = `First untagged view ${unique}`;
  const secondTitle = `Second untagged view ${unique}`;
  const randomTitle = `Random tagged view ${unique}`;
  const create = async (path: string, title: string, tags?: string[]) => {
    const response = await page.request.post("/api/entries", { data: {
      url: `https://${domain}/${path}`,
      title,
      tags,
      content: `<article><p>${"Library view article. ".repeat(35)}</p></article>`,
    } });
    expect(response.status()).toBe(201);
    return response.json() as Promise<{ id: string }>;
  };
  const first = await create("first", firstTitle);
  const second = await create("second", secondTitle);
  const random = await create("random", randomTitle, [`random-${unique}`]);

  await page.goto(`/entries?view=untagged&q=${unique}`);
  await expect(page.getByRole("heading", { name: "Untagged", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: firstTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: secondTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: randomTitle })).toHaveCount(0);

  const firstCard = page.locator(".entry-card", { has: page.getByRole("heading", { name: firstTitle }) });
  await firstCard.getByRole("link", { name: `More from ${domain}` }).click();
  await expect(page.getByRole("heading", { name: domain })).toBeVisible();
  await expect(page.getByRole("heading", { name: firstTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: secondTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: randomTitle })).toBeVisible();

  await page.goto(`/entries/random?view=all&tag=random-${unique}`);
  await expect(page).toHaveURL(new RegExp(`/entries/${random.id}$`));
  await expect(page.getByRole("heading", { name: randomTitle, level: 1 })).toBeVisible();

  const filteredQuery = new URLSearchParams({ view: "all", q: randomTitle, domain });
  await page.goto(`/entries?${filteredQuery}`);
  const randomLink = page.getByRole("link", { name: "Read a random entry" });
  const randomHref = await randomLink.getAttribute("href");
  const randomParams = new URL(randomHref!, page.url()).searchParams;
  expect(randomParams.get("q")).toBe(randomTitle);
  expect(randomParams.get("domain")).toBe(domain);
  await randomLink.click();
  await expect(page).toHaveURL(new RegExp(`/entries/${random.id}$`));

  filteredQuery.set("domain", "no-matching-publication.example");
  const empty = await page.request.get(`/entries/random?${filteredQuery}`, { maxRedirects: 0 });
  expect(empty.status()).toBe(307);
  expect(empty.headers().location).toBe(`/entries?${filteredQuery}`);

  for (const entry of [first, second, random]) expect((await page.request.delete(`/api/entries/${entry.id}`)).status()).toBe(204);
});

test("bulk entry and tag actions share one ownership-checked workflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Bulk selection needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const titles = [`First bulk entry ${unique}`, `Second bulk entry ${unique}`];
  const entries: { id: string; url: string }[] = [];
  for (const [index, title] of titles.entries()) {
    const url = `https://bulk-${unique}.example/${index}`;
    const response = await page.request.post("/api/entries", { data: {
      url,
      title,
      content: `<article><p>${"Bulk workflow article. ".repeat(35)}</p></article>`,
    } });
    expect(response.status()).toBe(201);
    entries.push({ ...(await response.json() as { id: string }), url });
  }

  await page.goto(`/entries?view=all&q=${unique}`);
  for (const title of titles) await page.getByLabel(`Select ${title}`).check();
  await page.getByLabel("Bulk action").selectOption("toggle-read");
  const toggleReadResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/entries",
  );
  await page.locator(".bulk-toolbar").getByRole("button", { name: "Apply" }).click();
  const toggleReadResponse = await toggleReadResponsePromise;
  expect(toggleReadResponse.ok()).toBe(true);
  await expect(page.locator(".entry-list").getByRole("button", { name: "Mark unread" })).toHaveCount(entries.length);
  for (const entry of entries) {
    const response = await page.request.get(`/api/entries/${entry.id}`);
    expect((await response.json() as { is_archived: number }).is_archived).toBe(1);
  }

  for (const title of titles) await page.getByLabel(`Select ${title}`).check();
  await page.getByLabel("Bulk action").selectOption("tag");
  await page.getByRole("combobox", { name: "Bulk tags" }).fill(`bulk-${unique}, -not-present`);
  const tagResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/entries",
  );
  await page.locator(".bulk-toolbar").getByRole("button", { name: "Apply" }).click();
  const tagResponse = await tagResponsePromise;
  expect(tagResponse.ok()).toBe(true);
  await expect(page.locator(".entry-list").getByRole("link", { name: `#bulk-${unique}`, exact: true })).toHaveCount(entries.length);
  for (const entry of entries) {
    const response = await page.request.get(`/api/entries/${entry.id}`);
    const body = await response.json() as { tags: { label: string }[] };
    expect(body.tags.map((tag) => tag.label)).toContain(`bulk-${unique}`);
  }

  const compatibilityList = entries.map((entry) => ({ url: entry.url, tags: `compat-${unique}` }));
  const compatibilityAdd = await page.request.post(`/api/entries/tags/lists.json?list=${encodeURIComponent(JSON.stringify(compatibilityList))}`);
  expect(compatibilityAdd.status()).toBe(200);
  expect(await compatibilityAdd.json()).toHaveLength(2);
  const compatibilityRemove = await page.request.delete(`/api/entries/tags/list.json?list=${encodeURIComponent(JSON.stringify(compatibilityList))}`);
  expect(compatibilityRemove.status()).toBe(200);

  const starResponse = await page.request.post("/api/entries/bulk", { data: { ids: entries.map((entry) => entry.id), action: "toggle-star" } });
  expect(starResponse.status()).toBe(200);
  expect(await starResponse.json()).toMatchObject({ action: "toggle-star", processed: 2 });
  const removeResponse = await page.request.post("/api/entries/bulk", { data: { ids: entries.map((entry) => entry.id), action: "remove-tags", tags: [`bulk-${unique}`] } });
  expect(removeResponse.status()).toBe(200);
  const deleteResponse = await page.request.post("/api/entries/bulk", { data: { ids: [entries[0].id], action: "delete" } });
  expect(deleteResponse.status()).toBe(200);
  expect(await deleteResponse.json()).toMatchObject({ action: "delete", processed: 1 });
  const compatibilityDelete = await page.request.delete(`/api/entries/list.json?urls=${encodeURIComponent(JSON.stringify([{ url: entries[1].url }, { url: "https://missing.example/not-saved" }]))}`);
  expect(compatibilityDelete.status()).toBe(200);
  expect(await compatibilityDelete.json()).toEqual([
    { url: entries[1].url, entry: true },
    { url: "https://missing.example/not-saved", entry: false },
  ]);
});

test("destructive entry actions require inline confirmation", async ({ page }, testInfo) => {
  await signIn(page);
  const unique = randomUUID();
  const entries: { id: string; title: string }[] = [];
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  try {
    for (const name of ["Bulk", "Reader"]) {
      const title = `${name} confirmation ${unique}`;
      const response = await page.request.post("/api/entries", { data: {
        url: `https://confirmation.example/${unique}/${name}`,
        title,
        content: `<article><p>${"Deletion should always be an intentional decision. ".repeat(35)}</p></article>`,
      } });
      expect(response.status()).toBe(201);
      entries.push({ ...(await response.json() as { id: string }), title });
    }
    await page.goto(`/entries?view=all&q=${unique}`);
    await page.getByLabel(`Select ${entries[0].title}`).check();
    await page.getByLabel("Bulk action").selectOption("delete");
    const toolbar = page.locator(".bulk-toolbar");
    await toolbar.getByRole("button", { name: "Apply", exact: true }).click();
    const confirmation = toolbar.locator(".inline-confirmation");
    await expect(confirmation).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect((await page.request.get(`/api/entries/${entries[0].id}`)).status()).toBe(200);
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    expect((await page.request.get(`/api/entries/${entries[0].id}`)).status()).toBe(200);
    await toolbar.getByRole("button", { name: "Apply", exact: true }).click();
    await confirmation.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await expect(page.locator(".toast")).toContainText("Deleted 1 entry");
    expect((await page.request.get(`/api/entries/${entries[0].id}`)).status()).toBe(404);

    if (testInfo.project.name === "desktop-chrome") {
      await page.goto(`/entries/${entries[1].id}`);
      await page.getByTitle("Delete", { exact: true }).click();
      const readerConfirmation = page.locator(".reader-actions .inline-confirmation");
      await expect(readerConfirmation).toContainText(entries[1].title);
      await readerConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      expect((await page.request.get(`/api/entries/${entries[1].id}`)).status()).toBe(200);
      await page.getByTitle("Delete", { exact: true }).click();
      await readerConfirmation.getByRole("button", { name: "Confirm delete", exact: true }).click();
      await expect(page).toHaveURL(/\/entries$/);
      expect((await page.request.get(`/api/entries/${entries[1].id}`)).status()).toBe(404);
    }
    expect(dialogs).toEqual([]);
  } finally {
    for (const entry of entries) await page.request.delete(`/api/entries/${entry.id}`);
  }
});

test("advanced library and API filters preserve wallabag semantics", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Filter matrix needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const domain = `filters-${unique}.example`;
  const longTitle = `Long French filter entry ${unique}`;
  const shortTitle = `Short English filter entry ${unique}`;
  const save = async (title: string, language: string, words: number, tags: string[]) => {
    const response = await page.request.post("/api/entries", { data: {
      url: `https://${domain}/${language}`,
      title,
      tags,
      content: `<html lang="${language}"><body><article><h1>${title}</h1><p>${"filterword ".repeat(words)}</p></article></body></html>`,
    } });
    expect(response.status()).toBe(201);
    return response.json() as Promise<{ id: string; language: string | null; reading_time: number }>;
  };
  const longEntry = await save(longTitle, "fr", 650, [`filter-a-${unique}`, `filter-b-${unique}`]);
  const shortEntry = await save(shortTitle, "en", 40, [`filter-a-${unique}`]);
  expect(longEntry.language).toBe("fr");
  expect(longEntry.reading_time).toBeGreaterThanOrEqual(3);

  await page.goto("/entries?view=all");
  await page.getByText("Advanced filters", { exact: false }).click();
  await page.getByLabel("Reading time from").fill("3");
  await page.getByLabel("Domain contains").fill(domain);
  await page.getByLabel("Language").selectOption("fr");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("heading", { name: longTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: shortTitle })).toHaveCount(0);
  await expect(page.getByText("Active", { exact: true })).toBeVisible();

  const exportLink = page.getByRole("link", { name: "Export results" });
  const exportHref = await exportLink.getAttribute("href");
  expect(exportHref).toContain(`domain=${domain}`);
  expect(exportHref).toContain("minRead=3");
  expect(exportHref).toContain("language=fr");
  const filteredExportResponse = await page.request.get(exportHref!);
  expect(filteredExportResponse.status()).toBe(200);
  const filteredExport = await filteredExportResponse.json() as { id: string }[];
  expect(filteredExport.map(({ id }) => id)).toEqual([longEntry.id]);

  const apiResponse = await page.request.get(`/api/entries?domain_name=${domain}&tags=filter-a-${unique},filter-b-${unique}&detail=metadata`);
  expect(apiResponse.status()).toBe(200);
  const apiBody = await apiResponse.json() as { total: number; _embedded: { items: { id: string; content: string | null }[] } };
  expect(apiBody.total).toBe(1);
  expect(apiBody._embedded.items[0].id).toBe(longEntry.id);
  expect(apiBody._embedded.items[0].content).toBeNull();

  for (const entry of [longEntry, shortEntry]) expect((await page.request.delete(`/api/entries/${entry.id}`)).status()).toBe(204);
});

test("reader and list presentation follow persisted preferences", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Computed reader styles need one desktop profile");
  await signIn(page);
  const originalResponse = await page.request.get("/api/config");
  expect(originalResponse.status()).toBe(200);
  const original = await originalResponse.json() as Record<string, unknown>;
  const unique = Date.now();
  const title = `Preference styled entry ${unique}`;
  const createResponse = await page.request.post("/api/entries", { data: {
    url: `https://preferences-${unique}.example/article`,
    title,
    content: `<article><h1>${title}</h1><p>${"Reader preference article. ".repeat(80)}</p></article>`,
  } });
  expect(createResponse.status()).toBe(201);
  const entry = await createResponse.json() as { id: string };

  try {
    await page.goto("/entries/settings");
    await page.getByLabel("Reader typeface").selectOption("serif");
    await page.getByLabel("Text size").fill("1.35");
    await page.getByLabel("Line height").fill("2");
    await page.getByLabel("Reader width (px)").fill("620");
    await page.getByLabel("Use compact list cards").check();
    await page.getByLabel("Display article thumbnails").uncheck();
    await page.getByLabel("Custom article CSS declarations").fill("letter-spacing: 0.03px; text-align: justify;");
    await page.getByRole("button", { name: "Save preferences" }).click();

    await page.goto(`/entries?view=all&q=${unique}`);
    const card = page.locator(".entry-card", { has: page.getByRole("heading", { name: title }) });
    await expect(card).toHaveClass(/compact/);
    await expect(card).toHaveClass(/no-thumbnail/);
    await expect(card.locator(".entry-cover")).toHaveCount(0);
    await page.getByRole("link", { name: title }).click();
    const computed = await page.locator(".article-content").evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, width: element.getBoundingClientRect().width };
    });
    expect(computed.fontFamily).toContain("Iowan Old Style");
    expect(computed.fontSize).toBe("21.6px");
    expect(computed.lineHeight).toBe("43.2px");
    expect(computed.letterSpacing).toBe("0.03px");
    expect(computed.width).toBeLessThanOrEqual(621);
  } finally {
    await page.request.patch("/api/config", { data: {
      items_per_page: original.items_per_page,
      language: original.language,
      reading_speed: original.reading_speed,
      action_mark_as_read: original.action_mark_as_read,
      list_mode: original.list_mode,
      display_thumbnails: original.display_thumbnails,
      font: original.font,
      fontsize: original.fontsize,
      line_height: original.line_height,
      max_width: original.max_width,
      custom_css: original.custom_css,
    } });
    await page.request.delete(`/api/entries/${entry.id}`);
  }
});

test("entry titles and tags can be edited, merged, and managed through nested APIs", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Tag management needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const sourceTag = `rename-a-${unique}`;
  const targetTag = `rename-b-${unique}`;
  const apiTag = `api-tag-${unique}`;
  const originalTitle = `Editable title ${unique}`;
  const editedTitle = `Edited title ${unique}`;
  const entries: { id: string }[] = [];
  try {
    for (const [index, tags] of [[sourceTag], [targetTag]].entries()) {
      const response = await page.request.post("/api/entries", { data: {
        url: `https://tags-${unique}.example/${index}`,
        title: index === 0 ? originalTitle : `Tag merge companion ${unique}`,
        tags,
        content: `<article><p>${"Tag management article. ".repeat(35)}</p></article>`,
      } });
      expect(response.status()).toBe(201);
      entries.push(await response.json() as { id: string });
    }

    await page.goto(`/entries/${entries[0].id}`);
    await page.getByText("Edit title", { exact: true }).click();
    await page.getByLabel("Entry title").fill(editedTitle);
    await page.locator(".article-title-row").getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: editedTitle, level: 1 })).toBeVisible();

    const addTagResponse = await page.request.post(`/api/entries/${entries[0].id}/tags.json`, { form: { tags: apiTag } });
    expect(addTagResponse.status()).toBe(200);
    const added = await addTagResponse.json() as { tags: { id: string; label: string }[] };
    const nestedTag = added.tags.find((tag) => tag.label === apiTag);
    expect(nestedTag).toBeTruthy();
    const listTagResponse = await page.request.get(`/api/entries/${entries[0].id}/tags.json`);
    expect((await listTagResponse.json() as { label: string }[]).map((tag) => tag.label)).toContain(apiTag);
    const removeTagResponse = await page.request.delete(`/api/entries/${entries[0].id}/tags/${nestedTag!.id}.json`);
    expect(removeTagResponse.status()).toBe(200);

    await page.goto("/entries/settings");
    const sourceInput = page.getByLabel(`Rename tag ${sourceTag}`);
    const sourceRow = page.locator(".tag-manager article", { has: sourceInput });
    await sourceInput.fill(targetTag);
    await sourceRow.getByRole("button", { name: "Save" }).click();
    await expect(page.getByLabel(`Rename tag ${sourceTag}`)).toHaveCount(0);
    const mergedInput = page.getByLabel(`Rename tag ${targetTag}`);
    await expect(mergedInput).toBeVisible();
    await expect(page.locator(".tag-manager article", { has: mergedInput })).toContainText("2 entries");
    await page.getByRole("button", { name: `Delete tag ${targetTag}` }).click();
    await expect(page.getByLabel(`Rename tag ${targetTag}`)).toHaveCount(0);
  } finally {
    for (const entry of entries) await page.request.delete(`/api/entries/${entry.id}`);
    for (const label of [sourceTag, targetTag, apiTag]) await page.request.delete(`/api/tags?label=${encodeURIComponent(label)}`);
  }
});

test("selected article text becomes a persisted, rendered highlight", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "DOM range selection needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const title = `Highlight workflow ${unique}`;
  const phrase = `selection survives reload ${unique}`;
  const note = `Remember this highlighted idea ${unique}`;
  const response = await page.request.post("/api/entries", { data: {
    url: `https://highlights-${unique}.example/article`,
    title,
    content: `<article><h1>${title}</h1><p>Before the key phrase, ${phrase}, and after the key phrase.</p></article>`,
  } });
  expect(response.status()).toBe(201);
  const entry = await response.json() as { id: string };
  try {
    await page.goto(`/entries/${entry.id}`);
    await expect(page.locator(".article-content")).toHaveAttribute("data-annotator-ready", "true");
    await page.locator(".article-content p").evaluate((element, selectedText) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode && !(textNode.textContent ?? "").includes(selectedText)) textNode = walker.nextNode();
      if (!textNode) throw new Error("Selection fixture text not found");
      const start = textNode.textContent!.indexOf(selectedText);
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + selectedText.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    }, phrase);
    await expect(page.getByRole("dialog", { name: "New highlight" })).toContainText(phrase);
    await page.getByLabel("Highlight note").fill(note);
    await page.getByRole("button", { name: "Save highlight" }).click();
    await expect(page.locator(".annotation-list article", { hasText: note })).toBeVisible();
    await expect(page.locator("mark.annotation-highlight")).toContainText(phrase);

    await page.reload();
    await expect(page.locator("mark.annotation-highlight")).toContainText(phrase);
    const annotation = page.locator(".annotation-list article", { hasText: note });
    await annotation.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("mark.annotation-highlight")).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/entries/${entry.id}`);
  }
});

test("library search ranks matches, highlights them, and agrees with the export", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Ranked search needs one browser profile");
  await signIn(page);
  const unique = Date.now();
  const token = `serendipity${unique}`;
  const titled = `A ${token} headline`;
  const bodied = `An unrelated saved page ${unique}`;
  const phrased = `Quiet notes ${unique}`;
  const tagged = `Nothing relevant ${unique}`;
  const save = async (path: string, title: string, body: string, tags?: string[]) => {
    const response = await page.request.post("/api/entries", { data: {
      url: `https://search-${unique}.example/${path}`,
      title,
      tags,
      content: `<article><p>${body}</p></article>`,
    } });
    expect(response.status()).toBe(201);
    return response.json() as Promise<{ id: string }>;
  };
  const entries = [
    await save("titled", titled, `An essay about durability and calm attention. ${"Padding sentence. ".repeat(20)}`),
    await save("bodied", bodied, `Some filler up front. ${token} copies of the web are worth keeping. ${"More filler. ".repeat(20)}`),
    await save("phrased", phrased, `You can read it later without a network. ${"Padding sentence. ".repeat(20)}`),
    await save("tagged", tagged, `Nothing relevant here either. ${"Padding sentence. ".repeat(20)}`, [token]),
  ];

  try {
    await page.goto(`/entries?view=all&q=${token}`);
    await expect(page.getByLabel("Sort entries")).toHaveValue("relevance");
    // The title match outranks the same word buried in body text.
    await expect(page.locator(".entry-list .entry-title h2")).toHaveText([titled, bodied, tagged]);
    // Only the body match needs a snippet; the others already show their term.
    const bodiedCard = page.locator(".entry-card", { has: page.getByRole("heading", { name: bodied }) });
    await expect(bodiedCard.locator(".entry-summary mark")).toHaveText(token);
    await expect(bodiedCard.locator(".entry-summary")).toContainText("copies of the web");

    // A prefix finds the word before it is finished; a second word narrows.
    await page.goto(`/entries?view=all&q=${token.slice(0, 8)}`);
    await expect(page.locator(".entry-list .entry-card")).toHaveCount(3);
    await page.goto(`/entries?view=all&q=${encodeURIComponent(`${token} headline`)}`);
    await expect(page.locator(".entry-list .entry-title h2")).toHaveText([titled]);

    // A quoted phrase is exact; the same words loose are not.
    await page.goto(`/entries?view=all&q=${encodeURIComponent(`"read it later" ${unique}`)}`);
    await expect(page.locator(".entry-list .entry-title h2")).toHaveText([phrased]);

    // Index syntax in the box is read as words, so it narrows rather than widens.
    await page.goto(`/entries?view=all&q=${encodeURIComponent(`${token} OR unmatchableword`)}`);
    await expect(page.getByRole("heading", { name: "No matching entries" })).toBeVisible();

    await page.goto(`/entries?view=all&q=${token}`);
    const exportHref = await page.getByRole("link", { name: "Export results" }).getAttribute("href");
    const exported = await (await page.request.get(exportHref!)).json() as { title: string }[];
    expect(exported.map(({ title }) => title).sort()).toEqual([bodied, tagged, titled].sort());
  } finally {
    for (const entry of entries) await page.request.delete(`/api/entries/${entry.id}`);
    await page.request.delete(`/api/tags?label=${encodeURIComponent(token)}`);
  }
});

test("ranked search applies library filters before its candidate limit", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Large-library search coverage needs one browser profile");
  const prisma = new PrismaClient();
  const unique = randomUUID();
  const username = `search-limit-${unique}`;
  const password = `Search-limit-${unique}!`;
  const token = `narrowmatch${Date.now()}`;
  const user = await prisma.user.create({ data: { username, passwordHash: await hash(password, 12), preference: { create: {} } } });
  try {
    await prisma.entry.createMany({ data: Array.from({ length: 501 }, (_, index) => ({
      userId: user.id,
      title: `${token} headline ${index}`,
      url: `https://outside-filter.example/${index}`,
      givenUrl: `https://outside-filter.example/${index}`,
      urlHash: String(index),
      domainName: "outside-filter.example",
      content: "<p>A higher-ranked headline outside the selected view.</p>",
      archived: true,
    })) });
    const matching = await prisma.entry.create({ data: {
      userId: user.id,
      title: "The matching unread article",
      url: "https://matching-filter.example/article",
      givenUrl: "https://matching-filter.example/article",
      urlHash: "matching",
      domainName: "matching-filter.example",
      content: `<p>${token} appears in the body rather than the headline.</p>`,
    } });
    await signIn(page, username, password);
    for (const query of [
      new URLSearchParams({ view: "unread", q: token }),
      new URLSearchParams({ view: "all", q: token, domain: "matching-filter.example" }),
    ]) {
      await page.goto(`/entries?${query}`);
      await expect(page.locator(".entry-list .entry-title h2")).toHaveText([matching.title]);
      await expect(page.getByLabel("Sort entries")).toHaveValue("relevance");
      const exportHref = await page.getByRole("link", { name: "Export results" }).getAttribute("href");
      const exported = await page.request.get(exportHref!);
      expect(await exported.json()).toMatchObject([{ id: matching.id }]);
      await page.getByRole("link", { name: "Read a random entry" }).click();
      await expect(page).toHaveURL(new RegExp(`/entries/${matching.id}$`));
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});

test("private feeds support tag pagination, limits, and RSS", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Feed configuration needs one browser profile");
  await signIn(page);
  const configResponse = await page.request.get("/api/config");
  const original = await configResponse.json() as { feed_token: string | null; feed_limit: number };
  let token = original.feed_token;
  let createdToken = false;
  const unique = Date.now();
  const tag = `feed-${unique}`;
  const entries: { id: string; title: string }[] = [];
  try {
    await page.goto("/entries/settings");
    const feedSection = page.locator(".settings-section", { has: page.getByRole("heading", { name: "Private feed" }) });
    if (!token) {
      await feedSection.getByRole("button", { name: "Create token" }).click();
      const path = await page.locator(".feed-code").textContent();
      token = path?.split("/")[3] ?? null;
      createdToken = true;
    }
    expect(token).toBeTruthy();
    await feedSection.getByLabel("Entries per feed page").fill("1");
    await feedSection.getByRole("button", { name: "Save feed limit" }).click();

    for (let index = 0; index < 2; index++) {
      const title = `Feed page ${index + 1} ${unique}`;
      const response = await page.request.post("/api/entries", { data: {
        url: `https://feed-${unique}.example/${index}`,
        title,
        tags: [tag, String(unique)],
        content: `<article><p>${"Feed article. ".repeat(35)}</p></article>`,
      } });
      expect(response.status()).toBe(201);
      entries.push({ ...(await response.json() as { id: string }), title });
    }

    const first = await page.request.get(`/feed/demo/${token}/tags/${tag}`);
    const second = await page.request.get(`/feed/demo/${token}/tags/${tag}/2`);
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);
    expect(first.headers()["content-type"]).toContain("application/atom+xml");
    const combined = `${await first.text()}${await second.text()}`;
    for (const entry of entries) expect(combined).toContain(entry.title);
    const rss = await page.request.get(`/feed/demo/${token}/tags/${tag}?format=rss`);
    expect(rss.status()).toBe(200);
    expect(rss.headers()["content-type"]).toContain("application/rss+xml");
    expect(await rss.text()).toContain("<rss version=\"2.0\">");
    const numericTagPath = `/feed/demo/${token}/tags/${unique}`;
    const numericTag = await page.request.get(numericTagPath);
    expect(numericTag.status()).toBe(200);
    const numericBody = await numericTag.text();
    expect(numericBody).toContain(`${numericTagPath}" rel="first" />`);
    expect(numericBody).toContain(`${numericTagPath}/2" rel="next" />`);
  } finally {
    await page.request.patch("/api/config", { data: { feed_limit: original.feed_limit } });
    for (const entry of entries) await page.request.delete(`/api/entries/${entry.id}`);
    await page.request.delete(`/api/tags?label=${encodeURIComponent(tag)}`);
    await page.request.delete(`/api/tags?label=${unique}`);
    if (createdToken) {
      await page.goto("/entries/settings");
      await page.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(page.getByText("No feed token has been created.")).toBeVisible();
    }
  }
});
