import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test("the library can be reordered, and the order survives paging, searching, and export", async ({ page }) => {
  await signIn(page);
  const tag = `order-${randomUUID().slice(0, 8)}`;
  const words = (count: number) => `<article><p>${"word ".repeat(count)}</p></article>`;
  const ids: string[] = [];
  // Saved in this order, so newest-first is Bravo, Alpha, Charlie.
  for (const [title, length] of [["Charlie", 1_400], ["Alpha", 200], ["Bravo", 700]] as const) {
    const response = await page.request.post("/api/entries", { data: { url: `https://order.example/${tag}/${title}`, title: `${title} ${tag}`, tags: [tag], content: words(length) } });
    expect(response.status()).toBe(201);
    ids.push((await response.json() as { id: string }).id);
  }
  const titles = () => page.locator(".entry-list .entry-title h2").allTextContents().then((all) => all.map((text) => text.split(" ")[0]));
  try {
    await page.goto(`/entries?view=all&tag=${tag}`);
    const sort = page.getByLabel("Sort entries");
    await expect(sort).toHaveValue("newest");
    expect(await titles()).toEqual(["Bravo", "Alpha", "Charlie"]);

    await sort.selectOption("title");
    await expect(page).toHaveURL(/sort=title/);
    await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
    await expect.poll(titles).toEqual(["Alpha", "Bravo", "Charlie"]);

    await sort.selectOption("longest");
    await expect.poll(titles).toEqual(["Charlie", "Bravo", "Alpha"]);
    await expect(sort).toHaveValue("longest");

    // A search keeps the chosen order instead of switching to relevance.
    const search = page.getByRole("textbox", { name: "Search your library" });
    await search.fill(tag);
    await search.press("Enter");
    await expect(page).toHaveURL(/sort=longest/);
    await expect(sort).toHaveValue("longest");
    expect(await titles()).toEqual(["Charlie", "Bravo", "Alpha"]);

    const exportHref = await page.getByRole("link", { name: "Export results" }).getAttribute("href");
    expect(exportHref).toContain("sort=longest");
    const exported = await (await page.request.get(exportHref!)).json() as { title: string }[];
    expect(exported.map((entry) => entry.title.split(" ")[0])).toEqual(["Charlie", "Bravo", "Alpha"]);

    await page.goto(`/entries?view=all&tag=${tag}&sort=oldest&page=1`);
    expect(await titles()).toEqual(["Charlie", "Alpha", "Bravo"]);
    await page.goto(`/entries?view=all&tag=${tag}&sort=bogus`);
    await expect(page.getByLabel("Sort entries")).toHaveValue("newest");
  } finally {
    for (const id of ids) await page.request.delete(`/api/entries/${id}`);
  }
});

test("the reader steps through the list it was opened from and can move on after archiving", async ({ page }) => {
  await signIn(page);
  const tag = `steps-${randomUUID().slice(0, 8)}`;
  const ids: Record<string, string> = {};
  for (const title of ["Charlie", "Alpha", "Bravo"]) {
    const response = await page.request.post("/api/entries", { data: { url: `https://steps.example/${tag}/${title}`, title: `${title} ${tag}`, tags: [tag], content: `<article><p>${"A steady paragraph. ".repeat(30)}</p></article>` } });
    expect(response.status()).toBe(201);
    ids[title] = (await response.json() as { id: string }).id;
  }
  const listPath = `/entries?view=unread&tag=${tag}&sort=title`;
  const prisma = new PrismaClient();
  const demo = await prisma.user.findUniqueOrThrow({ where: { username: "demo" }, select: { id: true } });
  try {
    await page.goto(listPath);
    await page.getByRole("link", { name: `Alpha ${tag}` }).first().click();
    await expect(page).toHaveURL(new RegExp(`/entries/${ids.Alpha}\\?list=`));
    const pager = page.getByRole("navigation", { name: "More in this list" });
    await expect(pager.getByRole("link", { name: /Next/ })).toContainText(`Bravo ${tag}`);
    await expect(pager.getByRole("link", { name: /Previous/ })).toHaveCount(0);

    await page.keyboard.press("n");
    await expect(page).toHaveURL(new RegExp(`/entries/${ids.Bravo}\\?list=`));
    await expect(pager.getByRole("link", { name: /Previous/ })).toContainText(`Alpha ${tag}`);
    await expect(pager.getByRole("link", { name: /Next/ })).toContainText(`Charlie ${tag}`);

    await page.getByRole("link", { name: "Library" }).click();
    await expect(page).toHaveURL(new RegExp(`${listPath.replace(/[?]/g, "\\?")}$`));

    // The preference lives in Settings; choosing "next" there makes archiving move on.
    await page.goto("/entries/settings");
    await page.getByLabel("After archiving an entry").selectOption("next");
    await page.getByRole("button", { name: "Save preferences" }).click();
    await page.reload();
    await expect(page.getByLabel("After archiving an entry")).toHaveValue("next");

    await page.goto(listPath);
    await page.getByRole("link", { name: `Alpha ${tag}` }).first().click();
    await expect(page.getByRole("navigation", { name: "More in this list" })).toBeVisible();
    await page.keyboard.press("e");
    await expect(page).toHaveURL(new RegExp(`/entries/${ids.Bravo}\\?list=`));
    await expect(page.locator(".toast")).toContainText("Archived");
    // Alpha has left Unread, so Bravo is now the first entry of the list.
    await expect(pager.getByRole("link", { name: /Previous/ })).toHaveCount(0);

    await prisma.userPreference.update({ where: { userId: demo.id }, data: { afterArchive: "list" } });
    await page.keyboard.press("e");
    await expect(page).toHaveURL(new RegExp(`${listPath.replace(/[?]/g, "\\?")}$`));
    await expect(page.locator(".entry-list .entry-title")).toHaveCount(1);
    await expect(page.locator(".entry-list")).toContainText(`Charlie ${tag}`);
  } finally {
    await prisma.userPreference.update({ where: { userId: demo.id }, data: { afterArchive: "stay" } });
    await prisma.$disconnect();
    for (const id of Object.values(ids)) await page.request.delete(`/api/entries/${id}`);
  }
});

test("notes can be edited in place and tag fields suggest existing tags", async ({ page }) => {
  await signIn(page);
  const unique = randomUUID().slice(0, 8);
  const existingTag = `suggested-${unique}`;
  const seed = await page.request.post("/api/entries", { data: { url: `https://notes.example/${unique}/seed`, title: `Seed ${unique}`, tags: [existingTag], content: "<article><p>Seed.</p></article>" } });
  const target = await page.request.post("/api/entries", { data: { url: `https://notes.example/${unique}/target`, title: `Target ${unique}`, content: `<article><p>${"Notes worth revising. ".repeat(30)}</p></article>` } });
  const ids = [(await seed.json() as { id: string }).id, (await target.json() as { id: string }).id];
  try {
    await page.goto(`/entries/${ids[1]}`);
    const panel = page.locator(".annotations-panel");
    await panel.getByPlaceholder("Capture a thought…").fill("First draft of a thought");
    await panel.getByRole("button", { name: "Add note" }).click();
    const note = panel.locator(".annotation-list article").filter({ hasText: "First draft of a thought" });
    await expect(note).toBeVisible();

    await note.getByText("Edit note").click();
    await note.getByLabel("Note text").fill("A revised, better thought");
    await note.getByRole("button", { name: "Save note" }).click();
    const revised = panel.locator(".annotation-list article").filter({ hasText: "A revised, better thought" });
    await expect(revised.locator("p")).toHaveText("A revised, better thought");
    await expect(revised.getByLabel("Note text")).toBeHidden();
    await page.reload();
    await expect(panel.locator(".annotation-list p")).toHaveText(["A revised, better thought"]);

    await page.locator(".reader-tags summary").click();
    const tagField = page.getByRole("combobox", { name: "Add tags" });
    await tagField.fill(`first-${unique}, suggested-${unique.slice(0, 4)}`);
    const option = page.getByRole("option", { name: existingTag });
    await expect(option).toBeVisible();
    await tagField.press("ArrowDown");
    await expect(option).toHaveAttribute("aria-selected", "true");
    await tagField.press("Enter");
    await expect(tagField).toHaveValue(`first-${unique}, ${existingTag}, `);
    await expect(option).toBeHidden();
    await page.locator(".reader-tags details").getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".reader-tags")).toContainText(`#${existingTag}`);
    await expect(page.locator(".reader-tags")).toContainText(`#first-${unique}`);
  } finally {
    for (const id of ids) await page.request.delete(`/api/entries/${id}`);
    for (const label of [existingTag, `first-${unique}`]) await page.request.delete(`/api/tags?label=${encodeURIComponent(label)}`);
  }
});

test("failed extractions can be fetched again in bulk without losing the saved copies", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Bulk selection needs one browser profile");
  await signIn(page);
  const unique = randomUUID().slice(0, 8);
  const titles = [`Refetch one ${unique}`, `Refetch two ${unique}`];
  const ids: string[] = [];
  for (const title of titles) {
    const response = await page.request.post("/api/entries", { data: { url: `https://refetch-${unique}.invalid/${ids.length}`, title, content: `<article><p>${"Kept copy. ".repeat(40)}</p></article>` } });
    expect(response.status()).toBe(201);
    ids.push((await response.json() as { id: string }).id);
  }
  try {
    await page.goto(`/entries?view=all&q=${unique}`);
    for (const title of titles) await page.getByLabel(`Select ${title}`).check();
    await page.getByLabel("Bulk action").selectOption("refetch");
    await page.locator(".bulk-toolbar").getByRole("button", { name: "Apply" }).click();
    await expect(page.locator(".toast")).toContainText("Fetching 2 entries again");

    // The publisher is unreachable, so each entry keeps the copy it had.
    for (const id of ids) {
      await expect.poll(async () => (await (await page.request.get(`/api/entries/${id}`)).json() as { content: string }).content).toContain("Kept copy.");
    }
  } finally {
    for (const id of ids) await page.request.delete(`/api/entries/${id}`);
  }
});

test("every tag is reachable from the tag index, grouped by initial or ordered by use", async ({ page }, testInfo) => {
  await signIn(page);
  const unique = randomUUID().slice(0, 8);
  const ids: string[] = [];
  for (const [index, tags] of [[`alpha ${unique}`, `Beta ${unique}`], [`alpha ${unique}`, `écho ${unique}`], [`7 ${unique}`]].entries()) {
    const response = await page.request.post("/api/entries", { data: { url: `https://tags.example/${unique}/${index}`, title: `Tagged ${index} ${unique}`, tags } });
    expect(response.status()).toBe(201);
    ids.push((await response.json() as { id: string }).id);
  }
  try {
    await page.goto("/entries");
    if (testInfo.project.name === "mobile-chrome") {
      await page.locator('summary[aria-label="More navigation"]').click();
      await page.getByRole("navigation", { name: "More" }).getByRole("link", { name: "Tags" }).click();
    } else {
      await page.getByRole("link", { name: /All tags/ }).click();
    }
    await expect(page).toHaveURL(/\/entries\/tags$/);
    await expect(page.getByRole("heading", { name: "Tags", level: 1 })).toBeVisible();

    const find = page.getByRole("searchbox", { name: "Find a tag" });
    await find.fill(unique.toUpperCase());
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(new RegExp(`q=${unique.toUpperCase()}`));
    // Capitals, accents, and digits sort as a reader expects rather than by byte.
    await expect(page.locator(".tag-index h2")).toHaveText(["A", "B", "E", "#"]);
    await expect(page.getByRole("region", { name: "Tags starting with A" }).getByRole("link")).toHaveText([`alpha ${unique}2`]);

    await page.getByLabel("Order tags").selectOption("count");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page.locator(".tag-index h2")).toHaveCount(0);
    await expect(page.locator(".tag-index li").first()).toHaveText(`alpha ${unique}2`);
    await expect(page.locator(".tag-index li")).toHaveCount(4);

    await page.getByRole("region", { name: "Tags by use" }).getByRole("link", { name: `écho ${unique}` }).click();
    await expect(page).toHaveURL(/view=all&tag=/);
    await expect(page.locator(".entry-list .entry-title h2")).toHaveText([`Tagged 1 ${unique}`]);

    await page.goto(`/entries/tags?q=missing-${unique}`);
    await expect(page.getByText(`No tags match “missing-${unique}”.`)).toBeVisible();
  } finally {
    for (const id of ids) await page.request.delete(`/api/entries/${id}`);
  }
});
