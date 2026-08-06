-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "redirectUris" JSONB NOT NULL,
    "allowedGrantTypes" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OAuthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthAccessToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scope" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthRefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scope" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthAuthorizationCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scope" TEXT,
    "codeChallenge" TEXT,
    "codeChallengeMethod" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthAuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthAuthorizationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthClient_publicId_key" ON "OAuthClient"("publicId");
CREATE INDEX "OAuthClient_userId_createdAt_idx" ON "OAuthClient"("userId", "createdAt");
CREATE UNIQUE INDEX "OAuthAccessToken_tokenHash_key" ON "OAuthAccessToken"("tokenHash");
CREATE INDEX "OAuthAccessToken_clientId_idx" ON "OAuthAccessToken"("clientId");
CREATE INDEX "OAuthAccessToken_userId_idx" ON "OAuthAccessToken"("userId");
CREATE INDEX "OAuthAccessToken_expiresAt_idx" ON "OAuthAccessToken"("expiresAt");
CREATE UNIQUE INDEX "OAuthRefreshToken_tokenHash_key" ON "OAuthRefreshToken"("tokenHash");
CREATE INDEX "OAuthRefreshToken_clientId_idx" ON "OAuthRefreshToken"("clientId");
CREATE INDEX "OAuthRefreshToken_userId_idx" ON "OAuthRefreshToken"("userId");
CREATE INDEX "OAuthRefreshToken_expiresAt_idx" ON "OAuthRefreshToken"("expiresAt");
CREATE UNIQUE INDEX "OAuthAuthorizationCode_codeHash_key" ON "OAuthAuthorizationCode"("codeHash");
CREATE INDEX "OAuthAuthorizationCode_clientId_idx" ON "OAuthAuthorizationCode"("clientId");
CREATE INDEX "OAuthAuthorizationCode_userId_idx" ON "OAuthAuthorizationCode"("userId");
CREATE INDEX "OAuthAuthorizationCode_expiresAt_idx" ON "OAuthAuthorizationCode"("expiresAt");
