import type { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma.js";

const TEST_ONLY_HOLOGRAM_NAME_PREFIXES = ["viewer-smoke-", "pipeline-smoke-"] as const;
const TEST_ONLY_SUBMITTER_PREFIXES = ["agent-"] as const;

export type CreateHologramInput = {
  filenameOriginal: string;
  hologramName: string;
  submittedBy: string;
  filenameStored: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  quickLookEnabled: boolean;
  /** hologram-budgets: the place's detail level, stored as its own object. */
  placeDetailKey?: string | null;
  /** "pending" queues the background processing (KTX2, reduced animation). */
  processStatus?: "pending" | "none";
  ownerId?: string | null;
};

export async function createHologram(input: CreateHologramInput) {
  return prisma.hologram.create({
    data: {
      filenameOriginal: input.filenameOriginal,
      hologramName: input.hologramName,
      submittedBy: input.submittedBy,
      filenameStored: input.filenameStored,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storagePath: input.storagePath,
      quickLookEnabled: input.quickLookEnabled,
      placeDetailKey: input.placeDetailKey ?? null,
      processStatus: input.processStatus ?? "none",
      ownerId: input.ownerId ?? null,
      usdzStatus: input.quickLookEnabled ? "pending" : "none"
    }
  });
}

export async function getHologramById(id: string) {
  return prisma.hologram.findUnique({ where: { id } });
}

export async function updateHologramUsdzPath(id: string, usdzPath: string) {
  return prisma.hologram.update({
    where: { id },
    data: { usdzPath }
  });
}

export async function deleteHologramById(id: string) {
  return prisma.hologram.delete({
    where: { id }
  });
}

export type CreateUploadIntentInput = {
  storageKey: string;
  quickLookEnabled: boolean;
  filenameOriginal: string;
  hologramName: string;
  submittedBy: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: Date;
  ownerId?: string | null;
};

export async function createUploadIntent(input: CreateUploadIntentInput) {
  return prisma.uploadIntent.create({ data: input });
}

export async function getUploadIntentById(id: string) {
  return prisma.uploadIntent.findUnique({ where: { id } });
}

export async function getUploadIntentByStorageKey(storageKey: string) {
  return prisma.uploadIntent.findUnique({ where: { storageKey } });
}

export async function listExpiredUploadIntents(expiredBefore: Date, limit: number) {
  return prisma.uploadIntent.findMany({
    where: { completedHologramId: null, expiresAt: { lt: expiredBefore } },
    orderBy: [{ expiresAt: "asc" }],
    take: limit
  });
}

export async function listOldCompletedUploadIntents(createdBefore: Date, limit: number) {
  return prisma.uploadIntent.findMany({
    where: { completedHologramId: { not: null }, createdAt: { lt: createdBefore } },
    orderBy: [{ createdAt: "asc" }],
    take: limit
  });
}

/** Conditional delete; returns true when this caller removed the row. */
export async function deleteUncompletedUploadIntent(id: string): Promise<boolean> {
  const result = await prisma.uploadIntent.deleteMany({ where: { id, completedHologramId: null } });
  return result.count === 1;
}

/** Conditional delete; returns true when this caller removed the row. */
export async function deleteCompletedUploadIntent(id: string, createdBefore: Date): Promise<boolean> {
  const result = await prisma.uploadIntent.deleteMany({
    where: { id, completedHologramId: { not: null }, createdAt: { lt: createdBefore } }
  });
  return result.count === 1;
}

export async function completeUploadIntent(intentId: string, hologramId: string) {
  return prisma.uploadIntent.update({
    where: { id: intentId },
    data: { completedHologramId: hologramId }
  });
}

/** Conditional status transition; returns true when this caller won it. */
export async function transitionUsdzStatus(
  id: string,
  from: string[],
  data: Prisma.HologramUpdateManyMutationInput
): Promise<boolean> {
  const result = await prisma.hologram.updateMany({
    where: { id, usdzStatus: { in: from } },
    data
  });
  return result.count === 1;
}

export type ListHologramsArgs = {
  cursor?: string;
  limit: number;
  /** Only this creator's holograms. */
  ownerId?: string;
  /** Case-insensitive substring of the title or the creator's name. */
  q?: string;
};

function excludeTestArtifacts(): Prisma.HologramWhereInput {
  return {
    NOT: {
      OR: [
        ...TEST_ONLY_HOLOGRAM_NAME_PREFIXES.map((prefix) => ({ hologramName: { startsWith: prefix } })),
        ...TEST_ONLY_SUBMITTER_PREFIXES.map((prefix) => ({ submittedBy: { startsWith: prefix } }))
      ]
    }
  };
}

/** How many of a creator's holograms the feed shows (the same test-artifact exclusion as the list). */
export async function countHologramsByOwner(ownerId: string): Promise<number> {
  return prisma.hologram.count({ where: { AND: [excludeTestArtifacts(), { ownerId }] } });
}

export async function getUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

/** Lower case with accents dropped, so "elodie" finds "Élodie". */
function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** True when the hologram's title or creator name (as typed at upload, or the account's name now) contains the text. */
function matchesSearch(row: { hologramName: string; submittedBy: string; owner?: { displayName: string } | null }, needle: string): boolean {
  return [row.hologramName, row.submittedBy, row.owner?.displayName ?? ""].some((field) => foldForSearch(field).includes(needle));
}

type Position = { createdAt: Date; id: string };

/** Rows strictly after `position` in the newest-first order (createdAt, then id, both descending). */
const olderThan = (position: Position): Prisma.HologramWhereInput => ({
  OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lt: position.id } }]
});

/** How many rows a search reads from the database at a time. */
const SEARCH_BATCH = 200;

/**
 * The most rows one search request reads. A search that has not filled its page by then returns what it
 * found with a cursor at the last row read, and the next request carries on from there, so no single
 * request can hold the database for long however rare the word is.
 */
const SEARCH_SCAN_BUDGET = 2000;

export async function listHolograms(args: ListHologramsArgs) {
  const cursorItem = args.cursor ? await prisma.hologram.findUnique({ where: { id: args.cursor } }) : null;
  // A cursor that no longer exists (deleted since the last page) ends the list rather than restarting it.
  if (args.cursor && !cursorItem) return { items: [], nextCursor: null };

  const scope: Prisma.HologramWhereInput[] = [excludeTestArtifacts()];
  if (args.ownerId) scope.push({ ownerId: args.ownerId });

  const order: Prisma.HologramOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
  let rows;
  let resumeCursor: string | null = null;
  if (args.q) {
    // Matching happens in code, not SQL, so a typed % or _ is literal and case and accents fold for every
    // script. The database is read newest first in batches, from the cursor, and the scan stops as soon as
    // the page is full: a common word costs a batch or two, and memory never holds more than a batch.
    // A word that matches nothing reads rows until the scan budget runs out, then hands back a cursor.
    const needle = foldForSearch(args.q);
    rows = [];
    let after: Position | null = cursorItem;
    let scanned = 0;
    while (rows.length <= args.limit && scanned < SEARCH_SCAN_BUDGET) {
      const batch: Array<Prisma.HologramGetPayload<{ include: { owner: { select: { displayName: true } } } }>> =
        await prisma.hologram.findMany({
          where: { AND: after ? [...scope, olderThan(after)] : scope },
          include: { owner: { select: { displayName: true } } },
          orderBy: order,
          take: SEARCH_BATCH
        });
      for (const row of batch) {
        if (!matchesSearch(row, needle)) continue;
        rows.push(row);
        if (rows.length > args.limit) break;
      }
      scanned += batch.length;
      if (batch.length < SEARCH_BATCH) break;
      after = batch[batch.length - 1]!;
      if (rows.length <= args.limit && scanned >= SEARCH_SCAN_BUDGET) resumeCursor = after.id;
    }
  } else {
    if (cursorItem) scope.push(olderThan(cursorItem));
    rows = await prisma.hologram.findMany({ orderBy: order, take: args.limit + 1, where: { AND: scope } });
  }

  const hasNext = rows.length > args.limit;
  const items = hasNext ? rows.slice(0, args.limit) : rows;
  const nextCursor = hasNext ? items[items.length - 1]?.id ?? null : resumeCursor;

  return { items, nextCursor };
}
