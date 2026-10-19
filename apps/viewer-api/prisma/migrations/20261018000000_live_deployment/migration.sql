-- Async USDZ conversion state (see docs/features/live-deployment.md, B4).
ALTER TABLE "Hologram" ADD COLUMN "usdzStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "Hologram" ADD COLUMN "usdzClaimedAt" DATETIME;
ALTER TABLE "Hologram" ADD COLUMN "usdzClaimToken" TEXT;
ALTER TABLE "Hologram" ADD COLUMN "usdzAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Hologram" ADD COLUMN "usdzError" TEXT;

-- Existing previews are already converted.
UPDATE "Hologram" SET "usdzStatus" = 'ready' WHERE "usdzPath" IS NOT NULL;

CREATE INDEX "Hologram_usdzStatus_idx" ON "Hologram"("usdzStatus");

-- Direct-upload intents (B5).
CREATE TABLE "UploadIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storageKey" TEXT NOT NULL,
    "quickLookEnabled" BOOLEAN NOT NULL DEFAULT false,
    "filenameOriginal" TEXT NOT NULL,
    "hologramName" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "completedHologramId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "UploadIntent_storageKey_key" ON "UploadIntent"("storageKey");
CREATE UNIQUE INDEX "UploadIntent_completedHologramId_key" ON "UploadIntent"("completedHologramId");
