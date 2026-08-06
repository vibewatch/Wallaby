-- AlterTable
ALTER TABLE "UserPreference" ADD COLUMN "pocketConsumerKey" TEXT;

-- AlterTable
ALTER TABLE "ImportJob" ADD COLUMN "skipped" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportJob" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ImportJob" ADD COLUMN "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "ImportJob" ADD COLUMN "lockedAt" DATETIME;
ALTER TABLE "ImportJob" ADD COLUMN "heartbeatAt" DATETIME;
ALTER TABLE "ImportJob" ADD COLUMN "workerId" TEXT;
ALTER TABLE "ImportJob" ADD COLUMN "startedAt" DATETIME;
ALTER TABLE "ImportJob" ADD COLUMN "completedAt" DATETIME;
ALTER TABLE "ImportJob" ADD COLUMN "remoteCredential" TEXT;
ALTER TABLE "ImportJob" ADD COLUMN "options" JSONB;

-- Existing versions completed imports synchronously and have no durable items.
UPDATE "ImportJob" SET "completedAt" = "updatedAt" WHERE "status" IN ('completed', 'failed');

-- CreateTable
CREATE TABLE "ImportJobItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" DATETIME,
    "workerId" TEXT,
    "entryId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PocketAuthorization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "encryptedRequestToken" TEXT NOT NULL,
    "markAsRead" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PocketAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ImportJob_status_availableAt_idx" ON "ImportJob"("status", "availableAt");
CREATE UNIQUE INDEX "ImportJobItem_jobId_position_key" ON "ImportJobItem"("jobId", "position");
CREATE INDEX "ImportJobItem_jobId_status_availableAt_idx" ON "ImportJobItem"("jobId", "status", "availableAt");
CREATE UNIQUE INDEX "PocketAuthorization_userId_key" ON "PocketAuthorization"("userId");
