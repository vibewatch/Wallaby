-- CreateTable
CREATE TABLE "IgnoreOriginInstanceRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rule" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "IgnoreOriginInstanceRule_rule_key" ON "IgnoreOriginInstanceRule"("rule");

-- Seed wallabag's default instance rules
INSERT INTO "IgnoreOriginInstanceRule" ("id", "rule", "updatedAt") VALUES
  ('default-feedproxy-google', 'host = "feedproxy.google.com"', CURRENT_TIMESTAMP),
  ('default-feeds-reuters', 'host = "feeds.reuters.com"', CURRENT_TIMESTAMP),
  ('default-lemonde-tiny', '_all ~ "https?://www\.lemonde\.fr/tiny.*"', CURRENT_TIMESTAMP);
