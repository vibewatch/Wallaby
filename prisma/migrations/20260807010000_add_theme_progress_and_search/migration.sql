-- AlterTable
ALTER TABLE "UserPreference" ADD COLUMN "theme" TEXT NOT NULL DEFAULT 'auto';

-- AlterTable
ALTER TABLE "Entry" ADD COLUMN "readingProgress" REAL NOT NULL DEFAULT 0;
ALTER TABLE "Entry" ADD COLUMN "readingProgressAt" DATETIME;

-- CreateIndex
CREATE INDEX "Entry_userId_readingProgressAt_idx" ON "Entry"("userId", "readingProgressAt");

-- Full-text search index. This is a SQLite-only accelerator: `lib/search.ts`
-- probes for it at runtime and falls back to portable LIKE matching when the
-- datasource is not SQLite or the virtual table is unavailable.
CREATE VIRTUAL TABLE "EntrySearch" USING fts5(
    entryId UNINDEXED,
    userId UNINDEXED,
    title,
    content,
    domainName,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Backfill existing entries.
INSERT INTO "EntrySearch" (entryId, userId, title, content, domainName)
SELECT "id", "userId", "title", "content", COALESCE("domainName", '') FROM "Entry";

-- Keep the index in step with the source table.
CREATE TRIGGER "EntrySearch_ai" AFTER INSERT ON "Entry" BEGIN
    INSERT INTO "EntrySearch" (entryId, userId, title, content, domainName)
    VALUES (new."id", new."userId", new."title", new."content", COALESCE(new."domainName", ''));
END;

CREATE TRIGGER "EntrySearch_ad" AFTER DELETE ON "Entry" BEGIN
    DELETE FROM "EntrySearch" WHERE entryId = old."id";
END;

CREATE TRIGGER "EntrySearch_au" AFTER UPDATE OF "title", "content", "domainName" ON "Entry" BEGIN
    DELETE FROM "EntrySearch" WHERE entryId = old."id";
    INSERT INTO "EntrySearch" (entryId, userId, title, content, domainName)
    VALUES (new."id", new."userId", new."title", new."content", COALESCE(new."domainName", ''));
END;
