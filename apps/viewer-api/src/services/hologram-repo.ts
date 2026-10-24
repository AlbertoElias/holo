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

export async function listHolograms(args: { cursor?: string; limit: number }) {
  let paginationWhere: Prisma.HologramWhereInput | undefined;

  if (args.cursor) {
    const cursorItem = await prisma.hologram.findUnique({ where: { id: args.cursor } });

    if (cursorItem) {
      paginationWhere = {
        OR: [
          { createdAt: { lt: cursorItem.createdAt } },
          {
            createdAt: cursorItem.createdAt,
            id: { lt: cursorItem.id }
          }
        ]
      };
    }
  }

  const excludeTestArtifactsWhere: Prisma.HologramWhereInput = {
    NOT: {
      OR: [
        ...TEST_ONLY_HOLOGRAM_NAME_PREFIXES.map((prefix) => ({ hologramName: { startsWith: prefix } })),
        ...TEST_ONLY_SUBMITTER_PREFIXES.map((prefix) => ({ submittedBy: { startsWith: prefix } }))
      ]
    }
  };

  const query: Prisma.HologramFindManyArgs = {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: args.limit + 1,
    where: paginationWhere
      ? {
          AND: [excludeTestArtifactsWhere, paginationWhere]
        }
      : excludeTestArtifactsWhere
  };

  const rows = await prisma.hologram.findMany(query);

  const hasNext = rows.length > args.limit;
  const items = hasNext ? rows.slice(0, args.limit) : rows;
  const nextCursor = hasNext ? items[items.length - 1]?.id ?? null : null;

  return { items, nextCursor };
}
