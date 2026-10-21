import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hash } from "bcryptjs";

import { signIn } from "./helpers";

test("sign-in uses self-hosted reference typography without demo credentials", async ({ page }) => {
  const fontRequests: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "font") fontRequests.push(request.url()); });
  await page.goto("/auth/signin");
  await expect(page.getByRole("heading", { name: "Your library awaits." })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("wallaby-demo");
  await expect(page.getByLabel("Username or email")).toHaveAttribute("placeholder", "Your username or email");
  await page.evaluate(() => document.fonts.ready);
  const family = await page.locator("body").evaluate((element) => getComputedStyle(element).fontFamily);
  expect(family.toLowerCase()).toContain("mona");
  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) expect(new URL(url).origin).toBe(new URL(page.url()).origin);
  await expect(page.locator(".access-note")).toContainText("instance administrator");
});

test("a real empty account can start a library, resume reading, and navigate clearly", async ({ page }, testInfo) => {
  const prisma = new PrismaClient();
  const username = `reader-${randomUUID().slice(0, 8)}`;
  const password = "isolated-reader-test-password";
  const reader = await prisma.user.create({
    data: { username, name: "A New Reader", passwordHash: await hash(password, 12), preference: { create: {} } },
  });
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  try {
    await signIn(page, username, password);
    await expect(page.getByRole("heading", { name: "Room for your next idea." })).toBeVisible();
    await expect(page.locator(".entry-card")).toHaveCount(0);
    await expect(page.locator('.sidebar-nav a[aria-current="page"]')).toHaveAttribute("aria-label", "Unread");
    await noOverflow();
    await page.screenshot({ path: testInfo.outputPath("library-empty.png"), fullPage: true });
    await page.locator(".empty-actions").getByRole("link", { name: "Save your first article" }).click();
    await expect(page.getByLabel("Article URL")).toBeVisible();

    const response = await page.request.post("/api/entries", { data: {
      url: `https://product-ui.example/${username}`,
      title: "A real idea, saved for later",
      content: `<article><p>${"An article worth keeping and returning to. ".repeat(120)}</p></article>`,
    } });
    expect(response.status()).toBe(201);
    const entry = await response.json() as { id: string };
    const progress = await page.request.post(`/api/entries/${entry.id}/progress`, { data: { progress: 0.42 } });
    expect(progress.status()).toBe(200);
    await page.goto("/entries");
    const resume = page.getByRole("link", { name: "Continue reading A real idea, saved for later" });
    await expect(resume).toContainText("42% read");
    await expect(page.locator(".bulk-toolbar")).toBeHidden();
    await page.getByLabel("Select A real idea, saved for later").check();
    await expect(page.locator(".bulk-toolbar")).toBeVisible();
    await page.getByLabel("Select A real idea, saved for later").uncheck();
    await expect(page.locator(".bulk-toolbar")).toBeHidden();
    await noOverflow();
    await page.screenshot({ path: testInfo.outputPath("library-populated.png"), fullPage: true });

    await page.goto("/entries?view=starred");
    await expect(page.locator('.sidebar-nav a[aria-current="page"]')).toHaveAttribute("aria-label", "Starred");
    await expect(page.getByRole("heading", { name: "Keep the standouts close." })).toBeVisible();
    await expect(page.locator(".continue-reading")).toHaveCount(0);
    await page.goto("/entries?q=no-match");
    await expect(page.getByRole("heading", { name: "No matching entries" })).toBeVisible();
    await page.getByRole("link", { name: "View all entries", exact: true }).click();
    await expect(page.locator(".entry-list")).toContainText("A real idea, saved for later");

    await page.goto("/entries/settings");
    await noOverflow();
    await page.getByRole("combobox", { name: "Colour theme" }).selectOption("dark");
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.goto("/entries");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await noOverflow();
    await page.screenshot({ path: testInfo.outputPath("library-dark.png"), fullPage: true });
    await page.getByRole("link", { name: "Continue reading A real idea, saved for later" }).click();
    await expect(page.locator(".article-header h1")).toHaveText("A real idea, saved for later");
    await noOverflow();
    await page.screenshot({ path: testInfo.outputPath("reader.png"), fullPage: true });
  } finally {
    await prisma.user.delete({ where: { id: reader.id } });
    await prisma.$disconnect();
  }
});
