import type { FastifyInstance } from "fastify";
import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { deleteHologramResponseSchema, hologramDtoSchema, paginatedHologramsSchema } from "@holoim/contracts";

import { MAX_GLB_BYTES } from "../lib/constants.js";
import { createHologram, deleteHologramById, getHologramById, listHolograms, updateHologramUsdzPath } from "../services/hologram-repo.js";
import { saveUploadedGlb, UploadValidationError } from "../services/hologram-storage.js";
import { convertGlbToUsdz, usdzFilenameFor, withHologramLock } from "../services/usdz-converter.js";

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10)
});

const uploadFieldsSchema = z.object({
  hologramName: z.string().trim().min(1).max(120),
  submittedBy: z.string().trim().min(1).max(80)
});

function toDto(record: {
  id: string;
  filenameOriginal: string;
  hologramName: string;
  submittedBy: string;
  filenameStored: string;
  sizeBytes: number;
  usdzPath: string | null;
  createdAt: Date;
}) {
  return {
    id: record.id,
    url: `/uploads/${record.filenameStored}`,
    usdzUrl: record.usdzPath ? `/${record.usdzPath}` : null,
    createdAt: record.createdAt.toISOString(),
    sizeBytes: record.sizeBytes,
    filenameOriginal: record.filenameOriginal,
    hologramName: record.hologramName,
    submittedBy: record.submittedBy
  };
}

export async function registerHologramRoutes(
  app: FastifyInstance,
  options: { uploadsRoot: string }
): Promise<void> {
  const { uploadsRoot } = options;

  app.post("/holograms", async (request, reply) => {
    try {
      const parts = request.parts({
        limits: {
          fileSize: MAX_GLB_BYTES
        }
      });

      let uploadedFileMeta: { filename: string; mimetype: string } | undefined;
      let storedUpload:
        | {
            storedFilename: string;
            relativeStoragePath: string;
            sizeBytes: number;
            absolutePath: string;
          }
        | undefined;
      const fields: Record<string, string> = {};

      for await (const part of parts) {
        if (part.type === "file") {
          if (part.fieldname !== "file") {
            part.file.resume();
            continue;
          }

          if (storedUpload) {
            part.file.resume();
            return reply.status(400).send({ error: "Only one file upload is allowed." });
          }

          uploadedFileMeta = {
            filename: part.filename,
            mimetype: part.mimetype
          };
          storedUpload = await saveUploadedGlb(part, uploadsRoot);
          continue;
        }

        fields[part.fieldname] = String(part.value ?? "");
      }

      if (!uploadedFileMeta || !storedUpload) {
        return reply.status(400).send({ error: "Missing file upload field 'file'." });
      }

      const parsedFields = uploadFieldsSchema.safeParse(fields);
      if (!parsedFields.success) {
        await rm(storedUpload.absolutePath, { force: true });
        return reply.status(400).send({ error: "Missing or invalid upload fields." });
      }

      const created = await createHologram({
        filenameOriginal: uploadedFileMeta.filename,
        hologramName: parsedFields.data.hologramName,
        submittedBy: parsedFields.data.submittedBy,
        filenameStored: storedUpload.storedFilename,
        mimeType: uploadedFileMeta.mimetype,
        sizeBytes: storedUpload.sizeBytes,
        storagePath: storedUpload.relativeStoragePath
      });

      const dto = hologramDtoSchema.parse(toDto(created));
      return reply.status(201).send(dto);
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }

      request.log.error({ error }, "Failed to upload hologram");
      return reply.status(500).send({ error: "Unexpected upload error." });
    }
  });

  app.get("/holograms", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query params." });
    }

    const result = await listHolograms(
      parsed.data.cursor
        ? {
            cursor: parsed.data.cursor,
            limit: parsed.data.limit
          }
        : {
            limit: parsed.data.limit
          }
    );

    const payload = paginatedHologramsSchema.parse({
      items: result.items.map(toDto),
      nextCursor: result.nextCursor
    });

    return reply.send(payload);
  });

  app.get("/holograms/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid id param." });
    }

    const item = await getHologramById(params.data.id);
    if (!item) {
      return reply.status(404).send({ error: "Hologram not found." });
    }

    return reply.send(hologramDtoSchema.parse(toDto(item)));
  });

  app.get("/holograms/:id/usdz", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid id param." });
    }

    return withHologramLock(params.data.id, async () => {
      const item = await getHologramById(params.data.id);
      if (!item) {
        return reply.status(404).send({ error: "Hologram not found." });
      }

      // Resolve the current converter version on every request. The service reuses
      // an existing package, or regenerates a missing/stale preview under a lock.
      reply.header("Cache-Control", "no-store");
      const glbPath = path.join(uploadsRoot, item.filenameStored);
      const usdzFilename = usdzFilenameFor(item.filenameStored);
      const usdzAbsPath = path.join(uploadsRoot, usdzFilename);
      const relativeUsdzPath = path.posix.join("uploads", usdzFilename);

      try {
        await convertGlbToUsdz(glbPath, usdzAbsPath);
        await updateHologramUsdzPath(item.id, relativeUsdzPath);
        if (item.usdzPath && item.usdzPath !== relativeUsdzPath) {
          await rm(path.join(uploadsRoot, path.basename(item.usdzPath)), { force: true }).catch((error: unknown) => {
            request.log.warn({ error }, "Could not remove superseded USDZ preview");
          });
        }
        return reply.redirect(`/${relativeUsdzPath}`);
      } catch (error) {
        request.log.error({ error }, "USDZ conversion failed");
        return reply.status(503).send({ error: "USDZ conversion temporarily unavailable." });
      }
    });
  });

  app.delete("/holograms/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid id param." });
    }

    return withHologramLock(params.data.id, async () => {
      const item = await getHologramById(params.data.id);
      if (!item) {
        return reply.status(404).send({ error: "Hologram not found." });
      }

      const glbAbsolutePath = path.join(uploadsRoot, item.filenameStored);
      const usdzAbsolutePaths = new Set([
        path.join(uploadsRoot, usdzFilenameFor(item.filenameStored)),
        ...(item.usdzPath ? [path.join(uploadsRoot, path.basename(item.usdzPath))] : [])
      ]);

      let deletedFile = false;
      let deletedUsdz = false;

      try {
        await rm(glbAbsolutePath, { force: true });
        deletedFile = true;
      } catch {
        deletedFile = false;
      }

      for (const usdzAbsolutePath of usdzAbsolutePaths) {
        try {
          // Also remove a published cache whose database update failed.
          await rm(usdzAbsolutePath);
          deletedUsdz = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            request.log.warn({ error }, "Could not remove USDZ preview");
          }
        }
      }

      await deleteHologramById(item.id);

      return reply.send(
        deleteHologramResponseSchema.parse({
          id: item.id,
          deletedFile,
          deletedUsdz
        })
      );
    });
  });
}
