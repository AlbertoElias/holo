-- RedefineTable
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Hologram" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filenameOriginal" TEXT NOT NULL,
    "hologramName" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "filenameStored" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "durationSec" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Hologram" ("id", "filenameOriginal", "hologramName", "submittedBy", "filenameStored", "mimeType", "sizeBytes", "storagePath", "durationSec", "createdAt")
SELECT "id", "filenameOriginal", "filenameOriginal", 'Unknown', "filenameStored", "mimeType", "sizeBytes", "storagePath", "durationSec", "createdAt"
FROM "Hologram";
DROP TABLE "Hologram";
ALTER TABLE "new_Hologram" RENAME TO "Hologram";
CREATE INDEX "Hologram_createdAt_idx" ON "Hologram"("createdAt" DESC);
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
