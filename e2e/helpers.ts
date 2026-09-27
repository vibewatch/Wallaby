import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page, username = "demo", password = "wallaby-demo") {
  await page.goto("/auth/signin");
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/entries/);
}
