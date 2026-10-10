import assert from "node:assert/strict";

import { db } from "../lib/db";
import { checkAuthThrottle, identityThrottleKey, recordAuthFailure } from "../lib/auth-throttle";
import { enqueueNormalizedImport, processImportJob } from "../lib/import-queue";
import { ftsMatchExpression, postgresMatchExpression, rankedEntryIds, searchEngine, tokenizeSearch } from "../lib/search";
import { confirmEmailSetup, consumeSignInGrant, createEmailSetup, createLoginChallenge, verifyLoginChallenge } from "../lib/two-factor";

async function main() {
  const user = await db.user.findUniqueOrThrow({ where: { username: "transfer-reader" }, include: { preference: true, entries: { include: { tags: true, annotations: true } } } });
  assert.equal(user.role, "ADMIN");
  assert.equal(user.sessionVersion, 7);
  assert.equal(user.preference?.theme, "dark");
  assert.equal(user.entries.length, 1);
  const entry = user.entries[0];
  assert.equal(entry.id, "transfer-entry");
  assert.equal(entry.readingProgress, 0.75);
  assert.deepEqual(entry.publishedBy, ["Transferred Author"]);
  assert.equal(entry.createdAt.toISOString(), "2026-01-01T12:34:56.789Z");
  assert.equal(entry.tags[0].slug, "migration");
  assert.equal(entry.annotations[0].quote, "Portable reading");
  assert.equal((await db.siteCredential.findFirstOrThrow()).encryptedPassword, "preserved-ciphertext");
  assert.equal((await db.apiToken.findFirstOrThrow()).tokenHash, "preserved-token-hash");
  assert.equal((await db.importJobItem.findFirstOrThrow()).entryId, entry.id);
  assert.equal(await searchEngine(), "index");
  assert.deepEqual(await rankedEntryIds(user.id, "PORTAB"), [entry.id]);
  assert.deepEqual(await rankedEntryIds(user.id, '"portable reading"'), [entry.id]);
  assert.deepEqual(await rankedEntryIds(user.id, "migration"), [entry.id]);
  assert.deepEqual(await rankedEntryIds("different-reader", "portable"), []);
  assert.deepEqual(await rankedEntryIds(user.id, "portable", { archived: true }), []);
  assert.ok(postgresMatchExpression(tokenizeSearch("portable")));
  assert.ok(ftsMatchExpression(tokenizeSearch("portable")));
  const body = await db.entry.create({ data: { userId: user.id, title: "Café", url: "https://body.example", givenUrl: "https://body.example", urlHash: "body", content: "<p>Portable reading body</p>" } });
  assert.deepEqual(await rankedEntryIds(user.id, "portable"), [entry.id, body.id]);
  assert.deepEqual(await rankedEntryIds(user.id, "cafe"), [body.id]);
  assert.deepEqual(await rankedEntryIds(user.id, "café"), [body.id]);
  await db.entry.update({ where: { id: body.id }, data: { content: "<p>No matching word</p>" } });
  assert.deepEqual(await rankedEntryIds(user.id, "portable"), [entry.id]);
  await db.entry.delete({ where: { id: body.id } });
  assert.equal(await db.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM "EntrySearch"`.then((rows) => rows[0].count), 1n);

  let setupCode = "";
  await createEmailSetup(user.id, async ({ code }) => { setupCode = code; });
  assert.equal((await confirmEmailSetup(user.id, setupCode)).ok, true);
  let code = "";
  const challenge = await createLoginChallenge(user.id, "EMAIL", async (message) => { code = message.code; });
  const verified = await verifyLoginChallenge(challenge, code);
  assert.equal(verified.ok, true);
  if (!verified.ok) throw new Error("No sign-in grant");
  assert.equal((await consumeSignInGrant(verified.grant))?.id, user.id);
  assert.equal(await consumeSignInGrant(verified.grant), null);
  await db.user.update({ where: { id: user.id }, data: { twoFactorMethod: "NONE" } });
  const job = await enqueueNormalizedImport(user.id, "wallabag", [{
    url: "https://worker.example/article", title: "Worker article",
    content: `<article><p>${"A durable PostgreSQL import. ".repeat(40)}</p></article>`,
    tags: ["worker"], archived: false, starred: true, publishedBy: [], annotations: [],
  }]);
  const results = await Promise.all([processImportJob(job.id, { workerId: "first-worker" }), processImportJob(job.id, { workerId: "second-worker" })]);
  assert.equal(results.filter(Boolean).length, 1, "Only one worker may claim a job");
  assert.equal(results.find(Boolean)?.status, "completed");
  assert.equal(results.find(Boolean)?.imported, 1);
  const imported = await db.entry.findFirstOrThrow({ where: { url: "https://worker.example/article" }, include: { tags: true } });
  assert.ok(imported.content.includes("durable PostgreSQL import"));
  assert.equal(imported.starred, true);
  assert.equal(imported.tags[0].slug, "worker");
  assert.equal(await processImportJob(job.id), null);
  const identifier = "parallel-throttle";
  await Promise.all(Array.from({ length: 8 }, () => recordAuthFailure(identifier)));
  assert.equal((await db.authThrottle.findUniqueOrThrow({ where: { key: identityThrottleKey(identifier) } })).failures, 8);
  assert.equal((await checkAuthThrottle(identifier)).limited, true);
  console.log("PostgreSQL transfer fidelity, indexed ranking, ownership/filters, search triggers and one-use authentication passed; concurrent import claims completed once.");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "PostgreSQL smoke failed");
  process.exitCode = 1;
}).finally(() => db.$disconnect());
