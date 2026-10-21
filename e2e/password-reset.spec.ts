import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { hash } from "bcryptjs";

import { e2eBaseUrl, e2eMailPort } from "./environment";
import { startMailSink } from "./mail-sink";

let sink: Awaited<ReturnType<typeof startMailSink>>;

test.beforeAll(async () => { sink = await startMailSink(e2eMailPort); });
test.afterAll(async () => { await sink?.close(); });

test("a forgotten password can be reset from an emailed link", async ({ page }, testInfo) => {
  const prisma = new PrismaClient();
  const username = `reset-${testInfo.project.name}-${Date.now()}`;
  const email = `${username}@example.test`;
  const user = await prisma.user.create({ data: { username, name: "Reset Test", email, passwordHash: await hash("old passphrase", 12), preference: { create: {} } } });
  try {
    await page.goto("/auth/signin");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/auth\/forgot$/);

    // An unknown account gets the same answer and no email.
    await page.getByLabel("Username or email").fill(`nobody-${Date.now()}`);
    await page.getByRole("button", { name: "Email me a reset link" }).click();
    await expect(page.getByRole("status")).toContainText("If that account has an email address");

    await page.goto("/auth/forgot");
    await page.getByLabel("Username or email").fill(username);
    await page.getByRole("button", { name: "Email me a reset link" }).click();
    await expect(page.getByRole("status")).toContainText("If that account has an email address");
    const mail = await sink.waitFor(email);
    const link = mail.body.match(/http:\/\/127\.0\.0\.1:\d+\/auth\/reset\/[A-Za-z0-9_-]{43}/)?.[0];
    expect(link, mail.body).toBeTruthy();
    expect(new URL(link!).origin).toBe(e2eBaseUrl);
    expect(sink.messages.filter((message) => message.to.some((to) => to.startsWith("nobody-")))).toHaveLength(0);

    await page.goto(link!);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    await page.getByLabel("New password", { exact: true }).fill("fresh passphrase");
    await page.getByLabel("Confirm new password").fill("different passphrase");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page.locator(".form-error[role=alert]")).toContainText("do not match");
    // Password fields are cleared after a failed submission.
    await page.getByLabel("New password", { exact: true }).fill("fresh passphrase");
    await page.getByLabel("Confirm new password").fill("fresh passphrase");
    await page.getByRole("button", { name: "Set new password" }).click();
    await expect(page).toHaveURL(/\/auth\/signin\?reset=1$/);
    await expect(page.getByRole("status")).toContainText("Your password was changed");

    await page.getByLabel("Username or email").fill(username);
    await page.getByLabel("Password").fill("old passphrase");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator(".form-error[role=alert]")).toContainText("incorrect");
    await expect(page.getByLabel("Username or email")).toHaveValue(username);
    await page.getByLabel("Password").fill("fresh passphrase");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/entries/);

    // The link works once.
    await page.goto(link!);
    await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/auth/forgot");
  } finally {
    await prisma.authThrottle.deleteMany();
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
