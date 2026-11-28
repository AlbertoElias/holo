-- CreateTable
CREATE TABLE "PromptJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "parentJobId" TEXT,
    "prompt" TEXT NOT NULL,
    "revisionNote" TEXT,
    "finish" TEXT NOT NULL DEFAULT 'clay',
    "includeVoice" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "title" TEXT,
    "intent" TEXT,
    "sheetJson" TEXT,
    "durationSec" REAL,
    "beatCount" INTEGER,
    "hasVoice" BOOLEAN NOT NULL DEFAULT false,
    "previewKey" TEXT,
    "sizeBytes" INTEGER,
    "error" TEXT,
    "publishedHologramId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PromptJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PromptJob_ownerId_createdAt_idx" ON "PromptJob"("ownerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PromptJob_status_idx" ON "PromptJob"("status");
