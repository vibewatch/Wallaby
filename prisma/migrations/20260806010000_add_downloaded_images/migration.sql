-- CreateTable
CREATE TABLE "InstanceConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "downloadImagesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "imageMaxCount" INTEGER NOT NULL DEFAULT 30,
    "imageMaxBytes" INTEGER NOT NULL DEFAULT 5000000,
    "imageEntryMaxBytes" INTEGER NOT NULL DEFAULT 30000000,
    "imageUserMaxBytes" INTEGER NOT NULL DEFAULT 1000000000,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EntryImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntryImage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EntryImage_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "EntryImage_relativePath_key" ON "EntryImage"("relativePath");

-- CreateIndex
CREATE INDEX "EntryImage_userId_idx" ON "EntryImage"("userId");

-- CreateIndex
CREATE INDEX "EntryImage_entryId_idx" ON "EntryImage"("entryId");

-- CreateIndex
CREATE INDEX "EntryImage_entryId_sha256_idx" ON "EntryImage"("entryId", "sha256");

-- Seed the singleton with wallabag-compatible opt-in behavior.
INSERT INTO "InstanceConfiguration" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP);
