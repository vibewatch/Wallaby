-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "emailVerified" DATETIME,
    "image" TEXT,
    "passwordHash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Entry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "uid" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "givenUrl" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "originUrl" TEXT,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "starredAt" DATETIME,
    "publishedAt" DATETIME,
    "publishedBy" JSONB,
    "mimeType" TEXT,
    "language" TEXT,
    "readingTime" INTEGER NOT NULL DEFAULT 0,
    "domainName" TEXT,
    "previewPicture" TEXT,
    "httpStatus" INTEGER,
    "headers" JSONB,
    "isNotParsed" BOOLEAN NOT NULL DEFAULT false,
    "extractionError" TEXT,
    "shareToken" TEXT,
    "sharedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Annotation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "ranges" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Annotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Annotation_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "itemsPerPage" INTEGER NOT NULL DEFAULT 20,
    "language" TEXT NOT NULL DEFAULT 'en',
    "feedToken" TEXT,
    "feedLimit" INTEGER NOT NULL DEFAULT 50,
    "readingSpeed" REAL NOT NULL DEFAULT 200,
    "actionMarkAsRead" BOOLEAN NOT NULL DEFAULT false,
    "listMode" BOOLEAN NOT NULL DEFAULT false,
    "displayThumbnails" BOOLEAN NOT NULL DEFAULT true,
    "font" TEXT NOT NULL DEFAULT 'sans',
    "fontSize" REAL NOT NULL DEFAULT 1,
    "lineHeight" REAL NOT NULL DEFAULT 1.75,
    "maxWidth" INTEGER NOT NULL DEFAULT 760,
    "customCss" TEXT,
    CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "encryptedUsername" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SiteCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaggingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "tags" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaggingRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IgnoreOriginRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IgnoreOriginRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "total" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_EntryToTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_EntryToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Entry" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_EntryToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Entry_uid_key" ON "Entry"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "Entry_shareToken_key" ON "Entry"("shareToken");

-- CreateIndex
CREATE INDEX "Entry_userId_archived_createdAt_idx" ON "Entry"("userId", "archived", "createdAt");

-- CreateIndex
CREATE INDEX "Entry_userId_starred_starredAt_idx" ON "Entry"("userId", "starred", "starredAt");

-- CreateIndex
CREATE INDEX "Entry_userId_domainName_idx" ON "Entry"("userId", "domainName");

-- CreateIndex
CREATE INDEX "Entry_userId_language_idx" ON "Entry"("userId", "language");

-- CreateIndex
CREATE UNIQUE INDEX "Entry_userId_urlHash_key" ON "Entry"("userId", "urlHash");

-- CreateIndex
CREATE INDEX "Tag_userId_label_idx" ON "Tag"("userId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_userId_slug_key" ON "Tag"("userId", "slug");

-- CreateIndex
CREATE INDEX "Annotation_entryId_idx" ON "Annotation"("entryId");

-- CreateIndex
CREATE INDEX "Annotation_userId_idx" ON "Annotation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPreference_userId_key" ON "UserPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPreference_feedToken_key" ON "UserPreference"("feedToken");

-- CreateIndex
CREATE UNIQUE INDEX "SiteCredential_userId_host_key" ON "SiteCredential"("userId", "host");

-- CreateIndex
CREATE INDEX "TaggingRule_userId_idx" ON "TaggingRule"("userId");

-- CreateIndex
CREATE INDEX "IgnoreOriginRule_userId_idx" ON "IgnoreOriginRule"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- CreateIndex
CREATE INDEX "ImportJob_userId_createdAt_idx" ON "ImportJob"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "_EntryToTag_AB_unique" ON "_EntryToTag"("A", "B");

-- CreateIndex
CREATE INDEX "_EntryToTag_B_index" ON "_EntryToTag"("B");
