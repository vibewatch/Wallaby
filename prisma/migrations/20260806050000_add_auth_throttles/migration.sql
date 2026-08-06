-- CreateTable
CREATE TABLE "AuthThrottle" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" DATETIME NOT NULL,
    "blockedUntil" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "AuthThrottle_updatedAt_idx" ON "AuthThrottle"("updatedAt");
