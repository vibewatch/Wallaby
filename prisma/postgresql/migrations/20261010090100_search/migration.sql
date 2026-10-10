CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE "EntrySearch" (
    "entryId" TEXT PRIMARY KEY REFERENCES "Entry"("id") ON DELETE CASCADE,
    "userId" TEXT NOT NULL,
    "document" TSVECTOR NOT NULL
);
CREATE INDEX "EntrySearch_document_idx" ON "EntrySearch" USING GIN ("document");
CREATE INDEX "EntrySearch_userId_idx" ON "EntrySearch" ("userId");

CREATE FUNCTION wallaby_search_document(title TEXT, content TEXT, domain TEXT)
RETURNS TSVECTOR LANGUAGE SQL STABLE AS $$
    SELECT setweight(to_tsvector('simple', unaccent(coalesce(title, ''))), 'A')
        || setweight(to_tsvector('simple', unaccent(coalesce(domain, ''))), 'B')
        || setweight(to_tsvector('simple', unaccent(regexp_replace(coalesce(content, ''), '<[^>]*>', ' ', 'g'))), 'D')
$$;

INSERT INTO "EntrySearch" ("entryId", "userId", "document")
SELECT "id", "userId", wallaby_search_document("title", "content", "domainName") FROM "Entry";

CREATE FUNCTION wallaby_update_search() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO "EntrySearch" ("entryId", "userId", "document")
    VALUES (NEW."id", NEW."userId", wallaby_search_document(NEW."title", NEW."content", NEW."domainName"))
    ON CONFLICT ("entryId") DO UPDATE
    SET "userId" = EXCLUDED."userId", "document" = EXCLUDED."document";
    RETURN NEW;
END;
$$;
CREATE TRIGGER "EntrySearch_update" AFTER INSERT OR UPDATE OF "title", "content", "domainName", "userId"
ON "Entry" FOR EACH ROW EXECUTE FUNCTION wallaby_update_search();
