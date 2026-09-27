import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test("the save form rejects unsaveable addresses inline and keeps what was typed", async ({ page }) => {
  await signIn(page);
  await page.goto("/entries?view=all");
  await page.getByText("Save an article", { exact: true }).click();
  const url = page.getByLabel("Article URL");
  const tags = page.locator(".add-entry").getByLabel("Tags", { exact: true });

  await url.fill("ftp://files.example/report.pdf");
  await tags.fill("reports");
  await page.getByRole("button", { name: "Save & extract" }).click();
  await expect(page.locator(".add-entry").getByRole("alert")).toHaveText("Only web addresses can be saved, not ftp: links.");
  await expect(url).toHaveValue("ftp://files.example/report.pdf");
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(tags).toHaveValue("reports");
  await expect(page).toHaveURL(/\/entries\?view=all$/);

  await url.fill("https://reader:secret@private.example/story");
  await page.getByRole("button", { name: "Save & extract" }).click();
  await expect(page.locator(".add-entry").getByRole("alert")).toHaveText("Remove the username or password from the address before saving it.");

  const api = await page.request.post("/api/entries", { data: { url: "https://reader:secret@private.example/story" } });
  expect(api.status()).toBe(400);
  expect((await api.json()).error).toBe("invalid_url");
});

test("saving a known URL opens the existing entry and merges new tags", async ({ page }) => {
  await signIn(page);
  const unique = randomUUID();
  const address = `https://already-saved.example/${unique}`;
  const created = await page.request.post("/api/entries", { data: {
    url: address,
    title: `Already saved ${unique}`,
    tags: ["first"],
    content: `<article><p>${"Saved once and only once. ".repeat(40)}</p></article>`,
  } });
  expect(created.status()).toBe(201);
  const entry = await created.json() as { id: string };
  try {
    await page.goto("/entries?view=all");
    await page.getByText("Save an article", { exact: true }).click();
    await page.getByLabel("Article URL").fill(address.replace("https://", ""));
    await page.locator(".add-entry").getByLabel("Tags", { exact: true }).fill(`second-${unique.slice(0, 8)}`);
    await page.getByRole("button", { name: "Save & extract" }).click();

    await expect(page).toHaveURL(new RegExp(`/entries/${entry.id}\\?saved=existing$`));
    await expect(page.getByRole("status").filter({ hasText: "already in your library" })).toBeVisible();
    await expect(page.locator(".reader-tags")).toContainText("#first");
    await expect(page.locator(".reader-tags")).toContainText(`#second-${unique.slice(0, 8)}`);

    const all = await page.request.get(`/api/entries?perPage=100&tags=first`);
    const matches = (await all.json() as { _embedded: { items: { url: string }[] } })._embedded.items.filter((item) => item.url === address);
    expect(matches).toHaveLength(1);
  } finally {
    await page.request.delete(`/api/entries/${entry.id}`);
  }
});

test("an unreachable publisher still saves the entry, and refetching it reports the failure", async ({ page }, testInfo) => {
  await signIn(page);
  const address = `https://unreachable-${randomUUID().slice(0, 8)}.invalid/story`;
  await page.goto("/entries?view=all");
  await page.getByText("Save an article", { exact: true }).click();
  await page.getByLabel("Article URL").fill(address);
  await page.getByRole("button", { name: "Save & extract" }).click();

  await expect(page).toHaveURL(/\/entries\/[^/?]+$/);
  const entryId = new URL(page.url()).pathname.split("/").at(-1)!;
  try {
    await expect(page.getByText("Wallaby could not isolate the full article.")).toBeVisible();
    await expect(page).toHaveTitle(/story/);

    // The compact reader toolbar hides refetch; the keyboard shortcut drives the same control.
    if (testInfo.project.name === "mobile-chrome") await page.keyboard.press("r");
    else await page.getByTitle("Fetch article again").click();
    await expect(page.locator(".toast")).toContainText("The article could not be fetched");
    await expect(page.getByText("Wallaby could not isolate the full article.")).toBeVisible();
  } finally {
    await page.request.delete(`/api/entries/${entryId}`);
  }
});

test("the share page pre-fills the form, and sign-in keeps what was shared", async ({ page }) => {
  const unique = randomUUID().slice(0, 8);
  const address = `https://shared-${unique}.invalid/long-read`;
  const sharePath = `/entries/new?title=${encodeURIComponent(`Shared read ${unique}`)}&text=${encodeURIComponent(`Look at this: ${address}.`)}`;

  await page.goto(sharePath);
  await expect(page).toHaveURL(/\/auth\/signin\?callbackUrl=/);
  await page.getByLabel("Username or email").fill("demo");
  await page.getByLabel("Password").fill("wallaby-demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/entries\/new\?title=/);

  await expect(page.getByRole("heading", { name: `Shared read ${unique}` })).toBeVisible();
  const url = page.locator(".save-entry-form").getByLabel("Article URL");
  await expect(url).toHaveValue(address);
  await page.locator(".save-entry-form").getByRole("button", { name: "Save & extract" }).click();

  // Extraction fails for this host, so the shared title stands in for the missing one.
  await expect(page).toHaveURL(/\/entries\/[^/?]+$/);
  const entryId = new URL(page.url()).pathname.split("/").at(-1)!;
  try {
    await expect(page).toHaveTitle(new RegExp(`Shared read ${unique}`));

    await page.goto(`/entries/new?url=${encodeURIComponent(address)}`);
    await expect(page.getByRole("status")).toContainText("Already in your library");
    await expect(page.getByRole("status").getByRole("link")).toHaveAttribute("href", `/entries/${entryId}`);
  } finally {
    await page.request.delete(`/api/entries/${entryId}`);
  }
});

test("the manifest registers the share target and the help page offers a bookmarklet", async ({ page }) => {
  await signIn(page);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json() as { share_target?: { action: string; params: Record<string, string> } };
  expect(manifest.share_target?.action).toBe("/entries/new");
  expect(manifest.share_target?.params).toMatchObject({ url: "url", text: "text", title: "title" });

  await page.goto("/entries/help");
  const bookmarklet = page.getByRole("link", { name: "Save to Wallaby" });
  await expect(bookmarklet).toHaveAttribute("href", /^javascript:/);
  const href = await bookmarklet.getAttribute("href");
  expect(href).toContain(`${new URL(page.url()).origin}/entries/new`);
  await bookmarklet.click();
  await expect(page).toHaveURL(/\/entries\/help$/);
});
