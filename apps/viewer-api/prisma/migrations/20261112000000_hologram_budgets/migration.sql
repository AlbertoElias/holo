-- AlterTable
ALTER TABLE "Hologram" ADD COLUMN "placeDetailKey" TEXT;
ALTER TABLE "Hologram" ADD COLUMN "textureDetailKey" TEXT;
ALTER TABLE "Hologram" ADD COLUMN "servedKey" TEXT;
ALTER TABLE "Hologram" ADD COLUMN "processStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "Hologram" ADD COLUMN "processClaimedAt" DATETIME;
ALTER TABLE "Hologram" ADD COLUMN "processClaimToken" TEXT;
ALTER TABLE "Hologram" ADD COLUMN "processAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Hologram" ADD COLUMN "processError" TEXT;

-- CreateIndex
CREATE INDEX "Hologram_processStatus_idx" ON "Hologram"("processStatus");
