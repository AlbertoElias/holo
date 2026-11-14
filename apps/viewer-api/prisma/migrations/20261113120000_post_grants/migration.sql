-- CreateTable
CREATE TABLE "PostGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "returnOrigin" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "hologramId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PostGrant_tokenHash_key" ON "PostGrant"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PostGrant_hologramId_key" ON "PostGrant"("hologramId");

-- CreateIndex
CREATE INDEX "PostGrant_userId_idx" ON "PostGrant"("userId");

-- CreateIndex
CREATE INDEX "PostGrant_expiresAt_idx" ON "PostGrant"("expiresAt");
