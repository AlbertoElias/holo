import { createId } from "@paralleldrive/cuid2";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  completeUploadRequestSchema,
  deleteHologramResponseSchema,
  hologramDtoSchema,
  initiateUploadRequestSchema,
  initiateUploadResponseSchema,
  paginatedHologramsSchema,
  usdzStatusResponseSchema,
  type UsdzStatus
} from "@holoim/contracts";

import { MAX_GLB_BYTES } from "../lib/constants.js";
import {
  completeUploadIntent,
  createHologram,
  createUploadIntent,
  deleteHologramById,
  getHologramById,
  getUploadIntentById,
  getUploadIntentByStorageKey,
  listHolograms,
  transitionUsdzStatus
} from "../services/hologram-repo.js";
import { saveUploadedGlb, UploadValidationError, validateGlbMeta } from "../services/hologram-storage.js";
import type { MediaStorage } from "../services/media-storage.js";
import { usdzFilenameFor, usdzFilenamesFor, withHologramLock } from "../services/usdz-converter.js";

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

const USDZ_STATUSES: ReadonlySet<string> = new Set(["none", "pending", "processing", "ready", "failed"]);

type HologramRecord = {
  id: string;
  filenameOriginal: string;
  hologramName: string;
  submittedBy: string;
  filenameStored: string;
  sizeBytes: number;
  usdzPath: string | null;
  usdzStatus: string;
  quickLookEnabled: boolean;
  createdAt: Date;
};

function toDto(record: HologramRecord, storage: MediaStorage) {
  const status: UsdzStatus = USDZ_STATUSES.has(record.usdzStatus)
    ? (record.usdzStatus as UsdzStatus)
    : "none";
  const usdzKey = record.usdzPath ? path.posix.basename(record.usdzPath) : null;
  return {
    id: record.id,
    url: storage.publicUrl(record.filenameStored),
    usdzUrl: record.quickLookEnabled && status === "ready" && usdzKey ? storage.publicUrl(usdzKey) : null,
    usdzStatus: status,
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
  options: { uploadsRoot: string; storage: MediaStorage }
): Promise<void> {
  const { uploadsRoot, storage } = options;

  app.post("/holograms/uploads/initiate", async (request, reply) => {
    const parsed = initiateUploadRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid upload request." });
    }
    if (parsed.data.sizeBytes > MAX_GLB_BYTES) {
      return reply.status(413).send({ error: "File exceeds 25MB limit." });
    }
    try {
      validateGlbMeta({ filename: parsed.data.filenameOriginal, mimetype: parsed.data.mimeType });
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }

    if (storage.kind !== "s3") {
      return reply.send(initiateUploadResponseSchema.parse({ mode: "multipart" }));
    }

    const intentId = createId();
    const storageKey = `incoming/${intentId}.glb`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const presigned = await storage.createPresignedPost(storageKey, "model/gltf-binary", MAX_GLB_BYTES, 600);
    if (!presigned) {
      return reply.send(initiateUploadResponseSchema.parse({ mode: "multipart" }));
    }

    await createUploadIntent({
      quickLookEnabled: parsed.data.quickLookEnabled ?? false,
      storageKey,
      filenameOriginal: parsed.data.filenameOriginal,
      hologramName: parsed.data.hologramName,
      submittedBy: parsed.data.submittedBy,
      mimeType: "model/gltf-binary",
      sizeBytes: parsed.data.sizeBytes,
      expiresAt
    });
    const intent = await getUploadIntentByStorageKey(storageKey);
    if (!intent) {
      return reply.status(500).send({ error: "Could not create upload intent." });
    }

    return reply.send(
      initiateUploadResponseSchema.parse({
        mode: "direct",
        intentId: intent.id,
        uploadUrl: presigned.url,
        formFields: presigned.fields,
        storageKey,
        expiresAt: expiresAt.toISOString()
      })
    );
  });

  app.post("/holograms/uploads/complete", async (request, reply) => {
    const parsed = completeUploadRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid complete request." });
    }

    const intent = await getUploadIntentById(parsed.data.intentId);
    if (!intent) {
      return reply.status(404).send({ error: "Upload intent not found." });
    }
    if (intent.completedHologramId) {
      const existing = await getHologramById(intent.completedHologramId);
      if (existing) {
        return reply.send(hologramDtoSchema.parse(toDto(existing, storage)));
      }
    }
    if (intent.expiresAt.getTime() < Date.now()) {
      return reply.status(410).send({ error: "Upload intent expired." });
    }

    const head = await storage.head(intent.storageKey);
    if (!head) {
      return reply.status(409).send({ error: "Uploaded object not available yet. Retry complete." });
    }
    if (head.sizeBytes > MAX_GLB_BYTES || head.sizeBytes !== intent.sizeBytes) {
      await storage.delete(intent.storageKey).catch(() => undefined);
      return reply.status(422).send({ error: "Uploaded object size does not match the declared size." });
    }
    const prefix = await storage.readPrefix(intent.storageKey, 4);
    if (!prefix || prefix.toString("ascii") !== "glTF") {
      await storage.delete(intent.storageKey).catch(() => undefined);
      return reply.status(422).send({ error: "Uploaded object is not a GLB file." });
    }

    const filenameStored = `${createId()}.glb`;
    await storage.copy(intent.storageKey, filenameStored, "model/gltf-binary");
    await storage.delete(intent.storageKey).catch(() => undefined);

    const created = await createHologram({
      filenameOriginal: intent.filenameOriginal,
      hologramName: intent.hologramName,
      submittedBy: intent.submittedBy,
      quickLookEnabled: intent.quickLookEnabled,
      filenameStored,
      mimeType: intent.mimeType,
      sizeBytes: head.sizeBytes,
      storagePath: `uploads/${filenameStored}`
    });
    await completeUploadIntent(intent.id, created.id);

    return reply.status(201).send(hologramDtoSchema.parse(toDto(created, storage)));
  });

  app.post("/holograms", async (request, reply) => {
    let tempRoot: string | undefined;
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

      // Local driver writes straight into the uploads root. Other drivers
      // stage to a temp file that is then put to object storage.
      const stagingRoot =
        storage.kind === "local" ? uploadsRoot : (tempRoot = await mkdtemp(path.join(tmpdir(), "holoim-upload-")));

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
          storedUpload = await saveUploadedGlb(part, stagingRoot);
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

      if (storage.kind !== "local") {
        await storage.putFile(storedUpload.storedFilename, storedUpload.absolutePath, "model/gltf-binary");
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

      const dto = hologramDtoSchema.parse(toDto(created, storage));
      return reply.status(201).send(dto);
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }

      request.log.error({ error }, "Failed to upload hologram");
      return reply.status(500).send({ error: "Unexpected upload error." });
    } finally {
      if (tempRoot) {
        await rm(tempRoot, { recursive: true, force: true });
      }
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
      items: result.items.map((item) => toDto(item, storage)),
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

    return reply.send(hologramDtoSchema.parse(toDto(item, storage)));
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

    const usdzKey = usdzFilenameFor(item.filenameStored);
    const expectedUsdzPath = `uploads/${usdzKey}`;

    if (item.usdzStatus === "ready" && item.usdzPath === expectedUsdzPath) {
      const head = await storage.head(usdzKey);
      if (head) {
        return reply.redirect(storage.publicUrl(usdzKey));
      }
      // Object vanished externally: fall through and re-enqueue.
    }

    if (item.usdzStatus === "none" || item.usdzStatus === "failed" || item.usdzStatus === "ready") {
      await transitionUsdzStatus(item.id, ["none", "failed", "ready"], {
        usdzStatus: "pending",
        usdzClaimedAt: null,
        usdzClaimToken: null
      });
    }

    const current = await getHologramById(item.id);
    reply.header("Retry-After", "5");
    return reply.status(202).send(
      usdzStatusResponseSchema.parse({
        id: item.id,
        usdzStatus: current?.usdzStatus === "processing" ? "processing" : "pending",
        usdzUrl: null
      })
    );

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

      const usdzKeys = new Set([
        ...usdzFilenamesFor(item.filenameStored),
        ...(item.usdzPath ? [path.posix.basename(item.usdzPath)] : [])
      ]);

      let deletedFile = false;
      let deletedUsdz = false;
      try {
        deletedFile = await storage.delete(item.filenameStored);
      } catch (error) {
        request.log.warn({ error }, "Could not delete GLB object");
      }
      for (const usdzKey of usdzKeys) {
        try {
          deletedUsdz = (await storage.delete(usdzKey)) || deletedUsdz;
        } catch (error) {
          request.log.warn({ error }, "Could not delete USDZ object");
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
