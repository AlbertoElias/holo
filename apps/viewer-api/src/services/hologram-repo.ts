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

/** Where a row sits in the newest-first order, against a cursor row. */
function isOlder(row: { createdAt: Date; id: string }, cursor: { createdAt: Date; id: string }): boolean {
  const delta = row.createdAt.getTime() - cursor.createdAt.getTime();
  return delta < 0 || (delta === 0 && row.id < cursor.id);
}

export async function listHolograms(args: ListHologramsArgs) {
  const cursorItem = args.cursor ? await prisma.hologram.findUnique({ where: { id: args.cursor } }) : null;
  // A cursor that no longer exists (deleted since the last page) ends the list rather than restarting it.
  if (args.cursor && !cursorItem) return { items: [], nextCursor: null };

  const scope: Prisma.HologramWhereInput[] = [excludeTestArtifacts()];
  if (args.ownerId) scope.push({ ownerId: args.ownerId });

  let rows;
  if (args.q) {
    // Matching happens in code, not SQL, so a typed % or _ is literal and case and accents fold for every
    // script. The matches are cut to the page here too, rather than passed back to SQL as a long id list.
    const needle = foldForSearch(args.q);
    const candidates = await prisma.hologram.findMany({
      where: { AND: scope },
      include: { owner: { select: { displayName: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    rows = candidates
      .filter((row) => matchesSearch(row, needle) && (!cursorItem || isOlder(row, cursorItem)))
      .slice(0, args.limit + 1);
  } else {
    if (cursorItem) {
      scope.push({
        OR: [{ createdAt: { lt: cursorItem.createdAt } }, { createdAt: cursorItem.createdAt, id: { lt: cursorItem.id } }]
      });
    }
    rows = await prisma.hologram.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: args.limit + 1,
      where: { AND: scope }
    });
  }

  const hasNext = rows.length > args.limit;
  const items = hasNext ? rows.slice(0, args.limit) : rows;
  const nextCursor = hasNext ? items[items.length - 1]?.id ?? null : null;

  return { items, nextCursor };
}
