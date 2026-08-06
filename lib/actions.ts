"use server";

import { createHash, randomBytes } from "node:crypto";

import { compare, hash } from "bcryptjs";
import { AuthError } from "next-auth";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { deleteEntriesWithMedia, removeUserMediaDirectory } from "@/lib/article-images";
import { signIn, signOut } from "@/auth";
import { requireAdmin, requireUser } from "@/lib/auth-user";
import { applyBulkEntryAction, bulkEntryActions } from "@/lib/bulk";
import { db } from "@/lib/db";
import { createEntry, hashUrl, parseTags, reloadEntry, slugify } from "@/lib/entries";
import { validateIgnoreOriginRule } from "@/lib/ignore-origin";
import { enqueueImportFile, processImportJob } from "@/lib/import-queue";
import type { ImportSource } from "@/lib/importers";
import { encryptPocketToken, isPocketEncryptionConfigured, PocketClient } from "@/lib/pocket";
import { completeOAuthAuthorization, createOAuthClient, oauthGrantTypes } from "@/lib/oauth";
import { sanitizeReaderCss } from "@/lib/preferences";
import { applyTaggingRulesToAll, parseTaggingRuleImport, validateTaggingRule } from "@/lib/rules";
import { isCredentialEncryptionConfigured } from "@/lib/secret-box";
import { upsertSiteCredential } from "@/lib/site-credentials";
import { cancelLoginChallenge, confirmEmailSetup, confirmTotpSetup, createEmailSetup, createLoginChallenge, createTotpSetup, disableTwoFactor as disableTwoFactorForUser, isTrustedDevice, issueSignInGrant, isTwoFactorEmailConfigured, isTwoFactorEncryptionConfigured, registerTrustedDevice, regenerateRecoveryCodes, revokeTrustedDevices, TRUSTED_DEVICE_COOKIE, TWO_FACTOR_CHALLENGE_COOKIE, verifyLoginChallenge } from "@/lib/two-factor";

export type SignInState = { error?: string };
export type AccountActionState = { error?: string; message?: string };
export type TwoFactorActionState = {
  error?: string;
  message?: string;
  secret?: string;
  provisioningUri?: string;
  qrCodeDataUrl?: string;
  recoveryCodes?: string[];
  awaitingEmailCode?: boolean;
};

export async function authenticate(_state: SignInState, formData: FormData): Promise<SignInState> {
  const parsed = z.object({ username: z.string().trim().min(1), password: z.string().min(1).max(200), callbackUrl: z.string().optional() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "The username or password is incorrect." };
  const redirectTo = safeSignInRedirect(parsed.data.callbackUrl);
  const account = await db.user.findFirst({ where: { OR: [{ username: parsed.data.username }, { email: parsed.data.username.toLowerCase() }] } });
  if (!account?.passwordHash || !(await compare(parsed.data.password, account.passwordHash))) return { error: "The username or password is incorrect." };
  const cookieStore = await cookies();
  if (account.twoFactorMethod === "TOTP" || account.twoFactorMethod === "EMAIL") {
    const trustedToken = cookieStore.get(TRUSTED_DEVICE_COOKIE)?.value;
    if (await isTrustedDevice(account.id, trustedToken)) {
      const grant = await issueSignInGrant(account.id);
      try {
        await signIn("credentials", { grant, redirectTo });
        return {};
      } catch (error) {
        if (error instanceof AuthError) return { error: "The trusted-device sign-in expired. Try again." };
        throw error;
      }
    }
    if (trustedToken) cookieStore.delete(TRUSTED_DEVICE_COOKIE);
    try {
      const challenge = await createLoginChallenge(account.id, account.twoFactorMethod);
      cookieStore.set(TWO_FACTOR_CHALLENGE_COOKIE, challenge, secureCookie({ maxAge: 10 * 60 }));
      cookieStore.set("wallaby.after-sign-in", redirectTo, secureCookie({ maxAge: 10 * 60 }));
    } catch {
      return { error: account.twoFactorMethod === "EMAIL" ? "The sign-in code could not be delivered. Contact the instance administrator." : "Two-factor sign-in could not be started." };
    }
    redirect("/auth/two-factor");
  }
  try {
    await signIn("credentials", {
      username: parsed.data.username,
      password: parsed.data.password,
      redirectTo,
    });
    return {};
  } catch (error) {
    if (error instanceof AuthError) return { error: "The username or password is incorrect." };
    throw error;
  }
}

export async function completeTwoFactorAuthentication(_state: SignInState, formData: FormData): Promise<SignInState> {
  const code = z.string().trim().min(1).max(64).safeParse(formData.get("code"));
  if (!code.success) return { error: "Enter the code from your authenticator, email, or recovery list." };
  const cookieStore = await cookies();
  const token = cookieStore.get(TWO_FACTOR_CHALLENGE_COOKIE)?.value;
  if (!token) return { error: "This sign-in challenge expired. Start again." };
  const verification = await verifyLoginChallenge(token, code.data);
  if (!verification.ok) return { error: verification.error };
  if (formData.get("trusted") === "1") {
    const device = await registerTrustedDevice(verification.userId);
    cookieStore.set(TRUSTED_DEVICE_COOKIE, device.token, secureCookie({ expires: device.expiresAt }));
  }
  cookieStore.delete(TWO_FACTOR_CHALLENGE_COOKIE);
  const redirectTo = safeSignInRedirect(cookieStore.get("wallaby.after-sign-in")?.value);
  cookieStore.delete("wallaby.after-sign-in");
  try {
    await signIn("credentials", { grant: verification.grant, redirectTo });
    return {};
  } catch (error) {
    if (error instanceof AuthError) return { error: "The completed challenge expired. Start sign-in again." };
    throw error;
  }
}

export async function cancelTwoFactorAuthentication() {
  const cookieStore = await cookies();
  await cancelLoginChallenge(cookieStore.get(TWO_FACTOR_CHALLENGE_COOKIE)?.value);
  cookieStore.delete(TWO_FACTOR_CHALLENGE_COOKIE);
  cookieStore.delete("wallaby.after-sign-in");
  redirect("/auth/signin");
}

export async function logout() {
  await signOut({ redirectTo: "/auth/signin" });
}

export async function addEntry(formData: FormData) {
  const user = await requireUser();
  const parsed = z.object({ url: z.string().trim().min(1), tags: z.string().optional() }).parse({
    url: formData.get("url"),
    tags: formData.get("tags"),
  });
  const entry = await createEntry(user.id, { url: parsed.url, tags: parseTags(parsed.tags) });
  revalidatePath("/entries");
  redirect(`/entries/${entry.id}`);
}

export async function toggleArchived(entryId: string) {
  const user = await requireUser();
  const entry = await db.entry.findFirst({ where: { id: entryId, userId: user.id }, select: { archived: true } });
  if (!entry) return;
  await db.entry.update({
    where: { id: entryId },
    data: { archived: !entry.archived, archivedAt: entry.archived ? null : new Date() },
  });
  revalidatePath("/entries");
  revalidatePath(`/entries/${entryId}`);
}

export async function toggleStarred(entryId: string) {
  const user = await requireUser();
  const entry = await db.entry.findFirst({ where: { id: entryId, userId: user.id }, select: { starred: true } });
  if (!entry) return;
  await db.entry.update({
    where: { id: entryId },
    data: { starred: !entry.starred, starredAt: entry.starred ? null : new Date() },
  });
  revalidatePath("/entries");
  revalidatePath(`/entries/${entryId}`);
}

export async function updateEntryTitle(entryId: string, formData: FormData) {
  const user = await requireUser();
  const title = z.string().trim().min(1).max(1_000).parse(formData.get("title"));
  const result = await db.entry.updateMany({ where: { id: entryId, userId: user.id }, data: { title } });
  if (!result.count) throw new Error("Entry not found");
  revalidatePath("/entries");
  revalidatePath(`/entries/${entryId}`);
}

export async function bulkUpdateEntries(formData: FormData) {
  const user = await requireUser();
  const action = z.enum(bulkEntryActions).parse(formData.get("action"));
  const ids = formData.getAll("ids").map(String);
  const tags = String(formData.get("tags") ?? "");
  await applyBulkEntryAction(user.id, ids, action, tags);
  revalidatePath("/entries");
}

export async function deleteEntry(entryId: string) {
  const user = await requireUser();
  await deleteEntriesWithMedia(user.id, { id: entryId });
  revalidatePath("/entries");
  redirect("/entries");
}

export async function refetchEntry(entryId: string) {
  const user = await requireUser();
  await reloadEntry(user.id, entryId);
  revalidatePath(`/entries/${entryId}`);
}

export async function addTag(entryId: string, formData: FormData) {
  const user = await requireUser();
  const labels = parseTags(String(formData.get("tags") ?? ""));
  const entry = await db.entry.findFirst({ where: { id: entryId, userId: user.id }, select: { id: true } });
  if (!entry || !labels.length) return;
  await db.entry.update({
    where: { id: entryId },
    data: {
      tags: {
        connectOrCreate: labels.map((label) => ({
          where: { userId_slug: { userId: user.id, slug: slugify(label) } },
          create: { userId: user.id, label, slug: slugify(label) },
        })),
      },
    },
  });
  revalidatePath(`/entries/${entryId}`);
}

export async function removeTag(entryId: string, tagId: string) {
  const user = await requireUser();
  const entry = await db.entry.findFirst({ where: { id: entryId, userId: user.id }, select: { id: true } });
  if (!entry) return;
  await db.entry.update({ where: { id: entryId }, data: { tags: { disconnect: { id: tagId } } } });
  revalidatePath(`/entries/${entryId}`);
}

export async function renameTag(tagId: string, formData: FormData) {
  const user = await requireUser();
  const label = z.string().trim().min(1).max(120).parse(formData.get("label"));
  const slug = slugify(label) || hashUrl(label).slice(0, 12);
  const current = await db.tag.findFirst({ where: { id: tagId, userId: user.id }, include: { entries: { select: { id: true } } } });
  if (!current) throw new Error("Tag not found");
  if (current.slug === slug && current.label === label) return;
  const target = await db.tag.findUnique({ where: { userId_slug: { userId: user.id, slug } } });
  if (target && target.id !== current.id) {
    await db.$transaction([
      ...current.entries.map((entry) => db.entry.update({ where: { id: entry.id }, data: { tags: { connect: { id: target.id }, disconnect: { id: current.id } } } })),
      db.tag.delete({ where: { id: current.id } }),
    ]);
  } else {
    await db.tag.update({ where: { id: current.id }, data: { label, slug } });
  }
  revalidatePath("/entries");
  revalidatePath("/entries/settings");
}

export async function deleteTag(tagId: string) {
  const user = await requireUser();
  await db.tag.deleteMany({ where: { id: tagId, userId: user.id } });
  revalidatePath("/entries");
  revalidatePath("/entries/settings");
}

export async function addAnnotation(entryId: string, formData: FormData) {
  const user = await requireUser();
  const input = z.object({ text: z.string().trim().min(1).max(10_000), quote: z.string().trim().max(10_000) }).parse({
    text: formData.get("text"),
    quote: formData.get("quote") ?? "",
  });
  const entry = await db.entry.findFirst({ where: { id: entryId, userId: user.id }, select: { id: true } });
  if (!entry) return;
  await db.annotation.create({ data: { userId: user.id, entryId, text: input.text, quote: input.quote, ranges: [] } });
  revalidatePath(`/entries/${entryId}`);
}

export async function deleteAnnotation(entryId: string, annotationId: string) {
  const user = await requireUser();
  await db.annotation.deleteMany({ where: { id: annotationId, entryId, userId: user.id } });
  revalidatePath(`/entries/${entryId}`);
}

export async function toggleShare(entryId: string) {
  const user = await requireUser();
  const entry = await db.entry.findFirst({ where: { id: entryId, userId: user.id }, select: { shareToken: true } });
  if (!entry) return;
  await db.entry.update({
    where: { id: entryId },
    data: entry.shareToken
      ? { shareToken: null, sharedAt: null }
      : { shareToken: randomBytes(24).toString("base64url"), sharedAt: new Date() },
  });
  revalidatePath(`/entries/${entryId}`);
}

export async function updatePreferences(formData: FormData) {
  const user = await requireUser();
  const values = Object.fromEntries(formData);
  const parsed = z.object({
    itemsPerPage: z.coerce.number().int().min(5).max(100),
    readingSpeed: z.coerce.number().min(50).max(1_000),
    language: z.string().trim().min(2).max(20),
    font: z.enum(["sans", "serif"]),
    fontSize: z.coerce.number().min(0.75).max(2),
    lineHeight: z.coerce.number().min(1.2).max(2.5),
    maxWidth: z.coerce.number().int().min(480).max(1_400),
  }).parse(values);
  const presentation = {
    listMode: formData.get("listMode") === "1",
    displayThumbnails: formData.get("displayThumbnails") === "1",
    customCss: sanitizeReaderCss(String(formData.get("customCss") ?? "")),
  };
  await db.userPreference.upsert({ where: { userId: user.id }, create: { userId: user.id, ...parsed, ...presentation }, update: { ...parsed, ...presentation } });
  revalidatePath("/entries/settings");
}

export async function rotateFeedToken() {
  const user = await requireUser();
  await db.userPreference.upsert({
    where: { userId: user.id },
    create: { userId: user.id, feedToken: randomBytes(24).toString("base64url") },
    update: { feedToken: randomBytes(24).toString("base64url") },
  });
  revalidatePath("/entries/settings");
}

export async function revokeFeedToken() {
  const user = await requireUser();
  await db.userPreference.updateMany({ where: { userId: user.id }, data: { feedToken: null } });
  revalidatePath("/entries/settings");
}

export async function updateFeedLimit(formData: FormData) {
  const user = await requireUser();
  const feedLimit = z.coerce.number().int().min(1).max(1_000).parse(formData.get("feedLimit"));
  await db.userPreference.upsert({ where: { userId: user.id }, create: { userId: user.id, feedLimit }, update: { feedLimit } });
  revalidatePath("/entries/settings");
}

export type TokenState = { token?: string; error?: string };

export async function createApiToken(_state: TokenState, formData: FormData): Promise<TokenState> {
  const user = await requireUser();
  const name = z.string().trim().min(1).max(100).safeParse(formData.get("name"));
  if (!name.success) return { error: "Give this token a short name." };
  const token = `wby_${randomBytes(32).toString("base64url")}`;
  await db.apiToken.create({
    data: { userId: user.id, name: name.data, tokenHash: createHash("sha256").update(token).digest("hex") },
  });
  revalidatePath("/entries/settings");
  return { token };
}

export async function revokeApiToken(tokenId: string) {
  const user = await requireUser();
  await db.apiToken.deleteMany({ where: { id: tokenId, userId: user.id } });
  revalidatePath("/entries/settings");
}

export type OAuthClientState = { clientId?: string; clientSecret?: string; error?: string };

export async function createDeveloperClient(_state: OAuthClientState, formData: FormData): Promise<OAuthClientState> {
  const user = await requireUser();
  const parsed = z.object({
    name: z.string().trim().min(1).max(100),
    redirectUris: z.string().trim().min(1).max(20_000),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Give the client a name and at least one redirect URL." };
  const grants = formData.getAll("grantTypes").map(String).filter((value) => oauthGrantTypes.includes(value as typeof oauthGrantTypes[number]));
  try {
    const created = await createOAuthClient({ userId: user.id, name: parsed.data.name, redirectUris: parsed.data.redirectUris.split(/[\r\n]+/), allowedGrantTypes: grants });
    revalidatePath("/entries/developer");
    return { clientId: created.clientId, clientSecret: created.clientSecret };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The OAuth client could not be created." };
  }
}

export async function revokeDeveloperClient(clientId: string) {
  const user = await requireUser();
  await db.oAuthClient.deleteMany({ where: { id: clientId, userId: user.id } });
  revalidatePath("/entries/developer");
}

export async function authorizeDeveloperClient(formData: FormData) {
  const user = await requireUser();
  const responseType = z.enum(["code", "token"]).parse(formData.get("response_type"));
  const codeChallengeMethodValue = String(formData.get("code_challenge_method") ?? "");
  const destination = await completeOAuthAuthorization(user.id, {
    clientId: z.string().min(1).max(200).parse(formData.get("client_id")),
    redirectUri: z.string().min(1).max(2_000).parse(formData.get("redirect_uri")),
    responseType,
    state: optionalFormString(formData, "state"),
    scope: optionalFormString(formData, "scope"),
    codeChallenge: optionalFormString(formData, "code_challenge"),
    codeChallengeMethod: codeChallengeMethodValue === "S256" || codeChallengeMethodValue === "plain" ? codeChallengeMethodValue : undefined,
    approved: formData.get("decision") === "approve",
  });
  redirect(destination);
}

export async function saveSiteCredential(formData: FormData) {
  const user = await requireUser();
  if (!isCredentialEncryptionConfigured()) throw new Error("Site credential encryption is not configured");
  const parsed = z.object({
    host: z.string().trim().min(3).max(255),
    username: z.string().min(1).max(1_000),
    password: z.string().min(1).max(10_000),
  }).parse(Object.fromEntries(formData));
  await upsertSiteCredential(user.id, parsed.host, parsed.username, parsed.password);
  revalidatePath("/entries/settings");
}

export async function deleteSiteCredential(credentialId: string) {
  const user = await requireUser();
  await db.siteCredential.deleteMany({ where: { id: credentialId, userId: user.id } });
  revalidatePath("/entries/settings");
}

export async function runImport(formData: FormData) {
  const user = await requireUser();
  const source = z.enum(["auto", "wallabag", "pocket", "instapaper", "readability", "shaarli", "browser", "pinboard", "omnivore", "elcurator"]).parse(formData.get("source")) as ImportSource;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a non-empty import file");
  if (file.size > 20 * 1024 * 1024) throw new Error("Import files are limited to 20 MB");
  await enqueueImportFile(user.id, source, file.name, await file.text());
  revalidatePath("/entries");
  revalidatePath("/entries/import");
}

export async function processQueuedImport(jobId: string) {
  const user = await requireUser();
  const job = await db.importJob.findFirst({ where: { id: jobId, userId: user.id }, select: { id: true } });
  if (!job) throw new Error("Import job not found");
  await processImportJob(job.id);
  revalidatePath("/entries");
  revalidatePath("/entries/import");
}

export async function beginPocketAuthorization(formData: FormData) {
  const user = await requireUser();
  const parsed = z.object({
    consumerKey: z.string().trim().min(8).max(200),
    markAsRead: z.string().optional(),
  }).parse(Object.fromEntries(formData));
  if (!isPocketEncryptionConfigured()) throw new Error("Pocket token encryption is not configured on this instance");
  const callbackUrl = new URL("/entries/import/pocket/callback", await requestOrigin()).toString();
  const requestToken = await new PocketClient({ consumerKey: parsed.consumerKey }).requestToken(callbackUrl);
  await db.$transaction([
    db.userPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, pocketConsumerKey: parsed.consumerKey },
      update: { pocketConsumerKey: parsed.consumerKey },
    }),
    db.pocketAuthorization.upsert({
      where: { userId: user.id },
      create: { userId: user.id, encryptedRequestToken: encryptPocketToken(requestToken), markAsRead: parsed.markAsRead === "1", expiresAt: new Date(Date.now() + 15 * 60 * 1_000) },
      update: { encryptedRequestToken: encryptPocketToken(requestToken), markAsRead: parsed.markAsRead === "1", expiresAt: new Date(Date.now() + 15 * 60 * 1_000), createdAt: new Date() },
    }),
  ]);
  const authorizationUrl = new URL("https://getpocket.com/auth/authorize");
  authorizationUrl.searchParams.set("request_token", requestToken);
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
  redirect(authorizationUrl.toString());
}

async function requestOrigin(): Promise<string> {
  const configured = process.env.AUTH_URL?.trim();
  if (configured) return new URL(configured).origin;
  const incoming = await headers();
  const origin = incoming.get("origin");
  if (origin) return new URL(origin).origin;
  const host = incoming.get("x-forwarded-host") || incoming.get("host");
  if (!host) throw new Error("The public Wallaby URL could not be determined");
  const protocol = incoming.get("x-forwarded-proto")?.split(",")[0].trim() || "https";
  return new URL(`${protocol}://${host}`).origin;
}

export async function saveTaggingRule(formData: FormData) {
  const user = await requireUser();
  const parsed = z.object({ rule: z.string().trim().min(1).max(2_000), tags: z.string().trim().min(1).max(2_000) }).parse(Object.fromEntries(formData));
  validateTaggingRule(parsed.rule);
  const tags = parseTags(parsed.tags).map((tag) => tag.toLowerCase());
  if (!tags.length) throw new Error("Add at least one tag");
  await db.taggingRule.create({ data: { userId: user.id, rule: parsed.rule, tags } });
  revalidatePath("/entries/settings");
}

export async function updateTaggingRule(ruleId: string, formData: FormData) {
  const user = await requireUser();
  const parsed = z.object({ rule: z.string().trim().min(1).max(2_000), tags: z.string().trim().min(1).max(2_000) }).parse(Object.fromEntries(formData));
  validateTaggingRule(parsed.rule);
  const tags = parseTags(parsed.tags).map((tag) => tag.toLowerCase());
  if (!tags.length) throw new Error("Add at least one tag");
  const result = await db.taggingRule.updateMany({ where: { id: ruleId, userId: user.id }, data: { rule: parsed.rule, tags } });
  if (!result.count) throw new Error("Tagging rule not found");
  revalidatePath("/entries/settings");
}

export async function deleteTaggingRule(ruleId: string) {
  const user = await requireUser();
  await db.taggingRule.deleteMany({ where: { id: ruleId, userId: user.id } });
  revalidatePath("/entries/settings");
}

export async function resetTaggingRules() {
  const user = await requireUser();
  await db.taggingRule.deleteMany({ where: { userId: user.id } });
  revalidatePath("/entries/settings");
}

export async function importTaggingRules(formData: FormData) {
  const user = await requireUser();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a non-empty tagging-rule JSON file");
  if (file.size > 1_000_000) throw new Error("Tagging-rule imports are limited to 1 MB");
  let decoded: unknown;
  try { decoded = JSON.parse(await file.text()); }
  catch { throw new Error("The tagging-rule file is not valid JSON"); }
  const rules = parseTaggingRuleImport(decoded);
  await db.$transaction(rules.map((rule) => db.taggingRule.create({ data: { userId: user.id, ...rule } })));
  revalidatePath("/entries/settings");
}

export async function runTaggingRules() {
  const user = await requireUser();
  await applyTaggingRulesToAll(user.id);
  revalidatePath("/entries");
  revalidatePath("/entries/settings");
}

export async function saveIgnoreOriginRule(formData: FormData) {
  const user = await requireUser();
  const rule = z.string().trim().min(1).max(255).parse(formData.get("rule"));
  validateIgnoreOriginRule(rule);
  await db.ignoreOriginRule.create({ data: { userId: user.id, rule } });
  revalidatePath("/entries/settings");
}

export async function updateIgnoreOriginRule(ruleId: string, formData: FormData) {
  const user = await requireUser();
  const rule = z.string().trim().min(1).max(255).parse(formData.get("rule"));
  validateIgnoreOriginRule(rule);
  const result = await db.ignoreOriginRule.updateMany({ where: { id: ruleId, userId: user.id }, data: { rule } });
  if (!result.count) throw new Error("Ignore-origin rule not found");
  revalidatePath("/entries/settings");
}

export async function deleteIgnoreOriginRule(ruleId: string) {
  const user = await requireUser();
  await db.ignoreOriginRule.deleteMany({ where: { id: ruleId, userId: user.id } });
  revalidatePath("/entries/settings");
}

export async function updateProfile(_state: AccountActionState, formData: FormData): Promise<AccountActionState> {
  const user = await requireUser();
  const parsed = z.object({
    name: z.string().trim().min(1).max(100),
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,49}$/),
    email: z.string().trim().toLowerCase().email().max(320),
    currentPassword: z.string().min(1).max(200),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Use a valid name, email, and 3–50 character username." };
  const account = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!account?.passwordHash || !(await compare(parsed.data.currentPassword, account.passwordHash))) return { error: "The current password is incorrect." };
  const conflict = await db.user.findFirst({
    where: { id: { not: user.id }, OR: [{ username: parsed.data.username }, { email: parsed.data.email }] },
    select: { username: true, email: true },
  });
  if (conflict) return { error: conflict.username === parsed.data.username ? "That username is already in use." : "That email is already in use." };
  await db.user.update({ where: { id: user.id }, data: { name: parsed.data.name, username: parsed.data.username, email: parsed.data.email } });
  revalidatePath("/entries", "layout");
  revalidatePath("/entries/settings");
  return { message: "Profile updated." };
}

export async function changePassword(_state: AccountActionState, formData: FormData): Promise<AccountActionState> {
  const user = await requireUser();
  const parsed = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
    confirmPassword: z.string().min(8).max(200),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "The new password must contain at least 8 characters." };
  if (parsed.data.newPassword !== parsed.data.confirmPassword) return { error: "The new passwords do not match." };
  const account = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
  if (!account?.passwordHash || !(await compare(parsed.data.currentPassword, account.passwordHash))) return { error: "The current password is incorrect." };
  if (await compare(parsed.data.newPassword, account.passwordHash)) return { error: "Choose a password different from the current one." };
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { passwordHash: await hash(parsed.data.newPassword, 12), sessionVersion: { increment: 1 } } }),
    db.session.deleteMany({ where: { userId: user.id } }),
    db.trustedDevice.deleteMany({ where: { userId: user.id } }),
    db.twoFactorChallenge.deleteMany({ where: { userId: user.id } }),
    db.signInGrant.deleteMany({ where: { userId: user.id } }),
  ]);
  await signOut({ redirectTo: "/auth/signin" });
  return {};
}

export async function resetAccountData(_state: AccountActionState, formData: FormData): Promise<AccountActionState> {
  const user = await requireUser();
  const parsed = z.object({
    scope: z.enum(["annotations", "tags", "archived", "entries", "tagging-rules"]),
    currentPassword: z.string().min(1).max(200),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Choose a reset scope and enter the current password." };
  if (!(await validCurrentPassword(user.id, parsed.data.currentPassword))) return { error: "The current password is incorrect." };
  if (parsed.data.scope === "annotations") await db.annotation.deleteMany({ where: { userId: user.id } });
  if (parsed.data.scope === "tags") await db.tag.deleteMany({ where: { userId: user.id } });
  if (parsed.data.scope === "tagging-rules") await db.taggingRule.deleteMany({ where: { userId: user.id } });
  if (parsed.data.scope === "archived") {
    await deleteEntriesWithMedia(user.id, { archived: true });
    await db.tag.deleteMany({ where: { userId: user.id, entries: { none: {} } } });
  }
  if (parsed.data.scope === "entries") {
    await deleteEntriesWithMedia(user.id, {});
    await db.tag.deleteMany({ where: { userId: user.id } });
  }
  revalidatePath("/entries", "layout");
  revalidatePath("/entries/settings");
  return { message: `${parsed.data.scope} reset completed.` };
}

export async function deleteAccount(_state: AccountActionState, formData: FormData): Promise<AccountActionState> {
  const user = await requireUser();
  const parsed = z.object({ username: z.string().trim(), currentPassword: z.string().min(1).max(200) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "Enter the username and current password." };
  const account = await db.user.findUnique({ where: { id: user.id }, select: { username: true, passwordHash: true } });
  if (!account || parsed.data.username !== account.username || !account.passwordHash || !(await compare(parsed.data.currentPassword, account.passwordHash))) {
    return { error: "The username or current password is incorrect." };
  }
  await db.user.delete({ where: { id: user.id } });
  await removeUserMediaDirectory(user.id).catch(() => undefined);
  await signOut({ redirectTo: "/auth/signin" });
  return {};
}

async function validCurrentPassword(userId: string, password: string): Promise<boolean> {
  const account = await db.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  return Boolean(account?.passwordHash && await compare(password, account.passwordHash));
}

export async function beginTotpTwoFactorSetup(_state: TwoFactorActionState, formData: FormData): Promise<TwoFactorActionState> {
  const user = await requireUser();
  const password = z.string().min(1).max(200).safeParse(formData.get("currentPassword"));
  if (!password.success || !(await validCurrentPassword(user.id, password.data))) return { error: "The current password is incorrect." };
  if (!isTwoFactorEncryptionConfigured()) return { error: "Two-factor secret encryption is not configured on this instance." };
  try {
    const setup = await createTotpSetup(user.id);
    return { ...setup, message: "Scan the QR code, save every recovery code, then confirm a current six-digit code." };
  } catch {
    return { error: "Authenticator setup could not be started." };
  }
}

export async function confirmTotpTwoFactorSetup(_state: TwoFactorActionState, formData: FormData): Promise<TwoFactorActionState> {
  const user = await requireUser();
  const code = z.string().trim().min(1).max(16).safeParse(formData.get("code"));
  if (!code.success) return { error: "Enter the six-digit code from your authenticator app." };
  const result = await confirmTotpSetup(user.id, code.data);
  if (!result.ok) return { error: result.error };
  const cookieStore = await cookies();
  cookieStore.delete(TRUSTED_DEVICE_COOKIE);
  cookieStore.delete(TWO_FACTOR_CHALLENGE_COOKIE);
  await signOut({ redirectTo: "/auth/signin" });
  return {};
}

export async function beginEmailTwoFactorSetup(_state: TwoFactorActionState, formData: FormData): Promise<TwoFactorActionState> {
  const user = await requireUser();
  const password = z.string().min(1).max(200).safeParse(formData.get("currentPassword"));
  if (!password.success || !(await validCurrentPassword(user.id, password.data))) return { error: "The current password is incorrect." };
  if (!isTwoFactorEmailConfigured()) return { error: "Email code delivery is not configured on this instance." };
  try {
    await createEmailSetup(user.id);
    return { awaitingEmailCode: true, message: "A six-digit verification code was sent to your email address." };
  } catch {
    return { error: "The verification email could not be delivered." };
  }
}

export async function confirmEmailTwoFactorSetup(_state: TwoFactorActionState, formData: FormData): Promise<TwoFactorActionState> {
  const user = await requireUser();
  const code = z.string().trim().regex(/^\d{6}$/).safeParse(formData.get("code"));
  if (!code.success) return { error: "Enter the six-digit code from the verification email." };
  const result = await confirmEmailSetup(user.id, code.data);
  if (!result.ok) return { error: result.error };
  const cookieStore = await cookies();
  cookieStore.delete(TRUSTED_DEVICE_COOKIE);
  cookieStore.delete(TWO_FACTOR_CHALLENGE_COOKIE);
  await signOut({ redirectTo: "/auth/signin" });
  return {};
}

export async function disableTwoFactorAuthentication(_state: TwoFactorActionState, formData: FormData): Promise<TwoFactorActionState> {
  const user = await requireUser();
  const password = z.string().min(1).max(200).safeParse(formData.get("currentPassword"));
  if (!password.success || !(await validCurrentPassword(user.id, password.data))) return { error: "The current password is incorrect." };
  await disableTwoFactorForUser(user.id);
  const cookieStore = await cookies();
  cookieStore.delete(TRUSTED_DEVICE_COOKIE);
  cookieStore.delete(TWO_FACTOR_CHALLENGE_COOKIE);
  await signOut({ redirectTo: "/auth/signin" });
  return {};
}

export async function regenerateTwoFactorRecoveryCodes(_state: TwoFactorActionState, formData: FormData): Promise<TwoFactorActionState> {
  const user = await requireUser();
  const password = z.string().min(1).max(200).safeParse(formData.get("currentPassword"));
  if (!password.success || !(await validCurrentPassword(user.id, password.data))) return { error: "The current password is incorrect." };
  try {
    const recoveryCodes = await regenerateRecoveryCodes(user.id);
    return { recoveryCodes, message: "Previous recovery codes were revoked. Store this replacement list now." };
  } catch {
    return { error: "Recovery codes could not be regenerated." };
  }
}

export async function revokeTwoFactorTrustedDevices(): Promise<void> {
  const user = await requireUser();
  await revokeTrustedDevices(user.id);
  (await cookies()).delete(TRUSTED_DEVICE_COOKIE);
  revalidatePath("/entries/settings");
}

export async function createManagedUser(formData: FormData) {
  await requireAdmin();
  const parsed = managedUserSchema.extend({ password: z.string().min(8).max(200) }).parse(Object.fromEntries(formData));
  await assertAvailableIdentity(parsed.username, parsed.email);
  await db.user.create({ data: {
    name: parsed.name,
    username: parsed.username,
    email: parsed.email,
    role: parsed.role,
    passwordHash: await hash(parsed.password, 12),
    preference: { create: {} },
  } });
  revalidatePath("/entries/admin");
}

export async function updateManagedUser(userId: string, formData: FormData) {
  await requireAdmin();
  const parsed = managedUserSchema.parse(Object.fromEntries(formData));
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target) throw new Error("User not found");
  if (target.role === "ADMIN" && parsed.role !== "ADMIN" && await db.user.count({ where: { role: "ADMIN" } }) <= 1) throw new Error("The final administrator cannot be demoted");
  await assertAvailableIdentity(parsed.username, parsed.email, userId);
  await db.user.update({ where: { id: userId }, data: { name: parsed.name, username: parsed.username, email: parsed.email, role: parsed.role } });
  revalidatePath("/entries", "layout");
  revalidatePath("/entries/admin");
}

export async function resetManagedUserPassword(userId: string, formData: FormData) {
  await requireAdmin();
  const password = z.string().min(8).max(200).parse(formData.get("password"));
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { passwordHash: await hash(password, 12), sessionVersion: { increment: 1 } } }),
    db.session.deleteMany({ where: { userId } }),
    db.trustedDevice.deleteMany({ where: { userId } }),
    db.twoFactorChallenge.deleteMany({ where: { userId } }),
    db.signInGrant.deleteMany({ where: { userId } }),
  ]);
  revalidatePath("/entries/admin");
}

export async function updateImageDownloadSettings(formData: FormData) {
  await requireAdmin();
  const parsed = z.object({
    imageMaxCount: z.coerce.number().int().min(1).max(100),
    imageMaxMb: z.coerce.number().min(0.1).max(20),
    imageEntryMaxMb: z.coerce.number().min(1).max(200),
    imageUserMaxMb: z.coerce.number().min(10).max(2_000),
  }).parse(Object.fromEntries(formData));
  await db.instanceConfiguration.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      downloadImagesEnabled: formData.get("downloadImagesEnabled") === "1",
      imageMaxCount: parsed.imageMaxCount,
      imageMaxBytes: Math.round(parsed.imageMaxMb * 1_000_000),
      imageEntryMaxBytes: Math.round(parsed.imageEntryMaxMb * 1_000_000),
      imageUserMaxBytes: Math.round(parsed.imageUserMaxMb * 1_000_000),
    },
    update: {
      downloadImagesEnabled: formData.get("downloadImagesEnabled") === "1",
      imageMaxCount: parsed.imageMaxCount,
      imageMaxBytes: Math.round(parsed.imageMaxMb * 1_000_000),
      imageEntryMaxBytes: Math.round(parsed.imageEntryMaxMb * 1_000_000),
      imageUserMaxBytes: Math.round(parsed.imageUserMaxMb * 1_000_000),
    },
  });
  revalidatePath("/entries/admin");
}

export async function deleteManagedUser(userId: string) {
  const admin = await requireAdmin();
  if (admin.id === userId) throw new Error("Delete your own account from personal settings");
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!target) return;
  if (target.role === "ADMIN" && await db.user.count({ where: { role: "ADMIN" } }) <= 1) throw new Error("The final administrator cannot be deleted");
  await db.user.delete({ where: { id: userId } });
  await removeUserMediaDirectory(userId).catch(() => undefined);
  revalidatePath("/entries/admin");
}

export async function createInstanceOriginRule(formData: FormData) {
  await requireAdmin();
  const rule = z.string().trim().min(1).max(255).parse(formData.get("rule"));
  validateIgnoreOriginRule(rule);
  await db.ignoreOriginInstanceRule.create({ data: { rule } });
  revalidatePath("/entries/admin");
}

export async function updateInstanceOriginRule(ruleId: string, formData: FormData) {
  await requireAdmin();
  const rule = z.string().trim().min(1).max(255).parse(formData.get("rule"));
  validateIgnoreOriginRule(rule);
  await db.ignoreOriginInstanceRule.update({ where: { id: ruleId }, data: { rule } });
  revalidatePath("/entries/admin");
}

export async function deleteInstanceOriginRule(ruleId: string) {
  await requireAdmin();
  await db.ignoreOriginInstanceRule.deleteMany({ where: { id: ruleId } });
  revalidatePath("/entries/admin");
}

const managedUserSchema = z.object({
  name: z.string().trim().min(1).max(100),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,49}$/),
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(["USER", "ADMIN"]),
});

async function assertAvailableIdentity(username: string, email: string, excludedId?: string) {
  const conflict = await db.user.findFirst({
    where: { id: excludedId ? { not: excludedId } : undefined, OR: [{ username }, { email }] },
    select: { username: true },
  });
  if (conflict) throw new Error(conflict.username === username ? "That username is already in use" : "That email is already in use");
}

function secureCookie(lifetime: { maxAge?: number; expires?: Date }) {
  return {
    ...lifetime,
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    priority: "high" as const,
  };
}

function safeSignInRedirect(value: string | undefined): string {
  if (!value) return "/entries";
  try {
    const url = new URL(value, "http://wallaby.local");
    if (url.origin !== "http://wallaby.local" || !url.pathname.startsWith("/")) return "/entries";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/entries"; }
}

function optionalFormString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value ? value : undefined;
}
