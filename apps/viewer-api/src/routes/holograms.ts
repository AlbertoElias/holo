import type { FastifyInstance } from "fastify";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { deleteHologramResponseSchema, hologramDtoSchema, paginatedHologramsSchema } from "@holoim/contracts";

import { MAX_GLB_BYTES } from "../lib/constants.js";
import {
  createHologram,
  deleteHologramById,
  getHologramById,
  listHolograms,
  updateHologramUsdzPath
} from "../services/hologram-repo.js";
import { saveUploadedGlb, UploadValidationError } from "../services/hologram-storage.js";
import { convertGlbToUsdz, usdzFilenameFor, withHologramLock } from "../services/usdz-converter.js";

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10)
});

const uploadFieldsSchema = z.object({
  hologramName: z.string().trim().min(1).max(120),
  submittedBy: z.string().trim().min(1).max(80),
  // Multipart fields arrive as strings. Only the exact value "true" opts in;
  // a missing or malformed value leaves Quick Look disabled.
  quickLookEnabled: z
    .string()
    .optional()
    .transform((value) => value === "true")
});

function toDto(record: {
  id: string;
  filenameOriginal: string;
  hologramName: string;
  submittedBy: string;
  filenameStored: string;
  sizeBytes: number;
  usdzPath: string | null;
  quickLookEnabled: boolean;
  createdAt: Date;
}) {
  return {
    id: record.id,
    url: `/uploads/${record.filenameStored}`,
    usdzUrl: record.quickLookEnabled && record.usdzPath ? `/${record.usdzPath}` : null,
    quickLookEnabled: record.quickLookEnabled,
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
        storagePath: storedUpload.relativeStoragePath,
        quickLookEnabled: parsedFields.data.quickLookEnabled
      });

      if (!created.quickLookEnabled) {
        return reply.status(201).send(hologramDtoSchema.parse(toDto(created)));
      }

      // Convert once, at upload time, and store the package next to the GLB.
      // Later Quick Look requests reuse this stored file (see GET usdz below).
      const usdzFilename = usdzFilenameFor(created.filenameStored);
      const usdzAbsPath = path.join(uploadsRoot, usdzFilename);
      const relativeUsdzPath = path.posix.join("uploads", usdzFilename);
      try {
        await convertGlbToUsdz(storedUpload.absolutePath, usdzAbsPath);
        const updated = await updateHologramUsdzPath(created.id, relativeUsdzPath);
        return reply.status(201).send(hologramDtoSchema.parse(toDto(updated)));
      } catch (error) {
        // The hologram was promised Quick Look, so a failed conversion fails
        // the upload: remove the record and both files instead of leaving a
        // hologram whose stored USDZ is missing.
        await deleteHologramById(created.id).catch((cleanupError: unknown) => {
          request.log.warn({ error: cleanupError }, "Could not remove hologram after failed USDZ conversion");
        });
        await rm(storedUpload.absolutePath, { force: true }).catch(() => undefined);
        await rm(usdzAbsPath, { force: true }).catch(() => undefined);
        request.log.error({ error }, "USDZ conversion failed during upload");
        return reply.status(503).send({ error: "USDZ conversion temporarily unavailable." });
      }
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

    const item = await getHologramById(params.data.id);
    if (!item) {
      return reply.status(404).send({ error: "Hologram not found." });
    }

    if (!item.quickLookEnabled) {
      return reply.status(404).send({ error: "Quick Look is not enabled for this hologram." });
    }

    // Serve only the package converted and stored at upload time. A missing
    // stored package is not regenerated here.
    if (!item.usdzPath) {
      return reply.status(404).send({ error: "Quick Look preview is not available for this hologram." });
    }

    try {
      await access(path.join(uploadsRoot, path.basename(item.usdzPath)));
    } catch {
      return reply.status(404).send({ error: "Quick Look preview is not available for this hologram." });
    }

    reply.header("Cache-Control", "no-store");
    return reply.redirect(`/${item.usdzPath}`);
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
