-- CreateTable
CREATE TABLE "Hologram" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filenameOriginal" TEXT NOT NULL,
    "filenameStored" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "durationSec" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Hologram_createdAt_idx" ON "Hologram"("createdAt" DESC);
