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
      storagePath: input.storagePath
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
