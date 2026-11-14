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
  publicUserSchema,
  usdzStatusResponseSchema,
  type UsdzStatus
} from "@holoim/contracts";

import { MAX_GLB_BYTES, MAX_GLB_MEGABYTES } from "../lib/constants.js";
import { clientKey, createRateLimit } from "../lib/rate-limit.js";
import {
  completeUploadIntent,
  countHologramsByOwner,
  createHologram,
  createUploadIntent,
  deleteHologramById,
  getHologramById,
  getUploadIntentById,
  getUploadIntentByStorageKey,
  getUserById,
  listHolograms,
  transitionUsdzStatus
} from "../services/hologram-repo.js";
import { env } from "../lib/env.js";
import { optionalAuthUser, resolveAuth } from "../services/auth.js";
import { createFeedSnapshotWriter } from "../services/feed-snapshot.js";
import {
  capMessage,
  GLB_CONTENT_TYPE,
  placeDetailKeyFor,
  servedKeyFor,
  storeUpload,
  textureDetailKeyFor,
  type StoredUpload
} from "../services/hologram-ingest.js";
import { saveUploadedGlb, UploadValidationError, validateGlbMeta } from "../services/hologram-storage.js";
import type { MediaStorage } from "../services/media-storage.js";
import { claimPostGrant, completePostGrant, findPostGrant, postGrantBearer, releasePostGrant, type PostGrantRow } from "../services/post-grant.js";
import { usdzFilenameFor, usdzFilenamesFor, withHologramLock } from "../services/usdz-converter.js";

const SIGN_IN_TO_UPLOAD = "Sign in to upload a hologram.";

/** An upload needs an account, except in the test-only open-uploads mode (TEST_OPEN_UPLOADS, never on in production). */
async function mayUpload(headers: { authorization?: string | string[] | undefined }): Promise<boolean> {
  return env.TEST_OPEN_UPLOADS || (await optionalAuthUser(headers)) != null;
}

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  ownerId: z.string().min(1).max(64).optional(),
  // Search by title or creator; a blank query is the plain feed.
  q: z.string().trim().max(100).optional()
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
  placeDetailKey?: string | null;
  textureDetailKey?: string | null;
  servedKey?: string | null;
  ownerId?: string | null;
  createdAt: Date;
};

function toDto(record: HologramRecord, storage: MediaStorage, viewerId?: string | null) {
  const status: UsdzStatus = USDZ_STATUSES.has(record.usdzStatus)
    ? (record.usdzStatus as UsdzStatus)
    : "none";
  const usdzKey = record.usdzPath ? path.posix.basename(record.usdzPath) : null;
  return {
    id: record.id,
    url: storage.publicUrl(record.servedKey ?? record.filenameStored),
    placeDetailUrl: record.placeDetailKey ? storage.publicUrl(record.placeDetailKey) : null,
    textureDetailUrl: record.textureDetailKey ? storage.publicUrl(record.textureDetailKey) : null,
    usdzUrl: record.quickLookEnabled && status === "ready" && usdzKey ? storage.publicUrl(usdzKey) : null,
    usdzStatus: status,
    quickLookEnabled: record.quickLookEnabled,
    createdAt: record.createdAt.toISOString(),
    sizeBytes: record.sizeBytes,
    filenameOriginal: record.filenameOriginal,
    hologramName: record.hologramName,
    submittedBy: record.submittedBy,
    submittedByVerified: record.ownerId != null,
    ownedByViewer: viewerId != null && record.ownerId === viewerId,
    ownerId: record.ownerId ?? null
  };
}

/**
 * The anonymous first page, kept beside the media for the viewer's edge;
 * rewritten after every upload and delete, at boot, and when the worker
 * publishes a processed GLB (its URL changes).
 */
export function createHologramFeedSnapshotWriter(storage: MediaStorage, log: { error: (obj: unknown, msg: string) => void }) {
  return createFeedSnapshotWriter(storage, async () => {
    const result = await listHolograms({ limit: listQuerySchema.parse({}).limit });
    return paginatedHologramsSchema.parse({ items: result.items.map((item) => toDto(item, storage)), nextCursor: result.nextCursor });
  }, log);
}

const SEARCH_WINDOW_MS = 60_000;
/** Each page of a search, and each "load more" of one, counts as a search. */
const SEARCH_PER_WINDOW = 60;

export async function registerHologramRoutes(
  app: FastifyInstance,
  options: { uploadsRoot: string; storage: MediaStorage; searchLimit?: number }
): Promise<void> {
  const { storage } = options;
  const behindFly = Boolean(process.env.FLY_APP_NAME);
  // A search can read much of the table, so each client gets a few a minute; browsing the feed is not limited.
  const searchLimit = createRateLimit(options.searchLimit ?? SEARCH_PER_WINDOW, SEARCH_WINDOW_MS);
  const refreshFeedSnapshot = createHologramFeedSnapshotWriter(storage, app.log);
  void refreshFeedSnapshot();

  app.post("/holograms/uploads/initiate", async (request, reply) => {
    if (!(await mayUpload(request.headers))) {
      return reply.status(401).send({ error: SIGN_IN_TO_UPLOAD });
    }
    const parsed = initiateUploadRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid upload request." });
    }
    const authUser = await optionalAuthUser(request.headers);
    const submittedBy = authUser?.displayName ?? parsed.data.submittedBy;
    if (parsed.data.sizeBytes > MAX_GLB_BYTES) {
      return reply.status(413).send({ error: `File exceeds ${MAX_GLB_MEGABYTES}MB limit.` });
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
      submittedBy,
      mimeType: "model/gltf-binary",
      sizeBytes: parsed.data.sizeBytes,
      expiresAt,
      ownerId: authUser?.id ?? null
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
    if (!(await mayUpload(request.headers))) {
      return reply.status(401).send({ error: SIGN_IN_TO_UPLOAD });
    }
    const parsed = completeUploadRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid complete request." });
    }

    const authUser = await optionalAuthUser(request.headers);
    const intent = await getUploadIntentById(parsed.data.intentId);
    if (!intent) {
      return reply.status(404).send({ error: "Upload intent not found." });
    }
    if (intent.completedHologramId) {
      const existing = await getHologramById(intent.completedHologramId);
      if (existing) {
        return reply.send(hologramDtoSchema.parse(toDto(existing, storage, authUser?.id)));
      }
    }
    if (intent.expiresAt.getTime() < Date.now()) {
      return reply.status(410).send({ error: "Upload intent expired." });
    }

    const head = await storage.head(intent.storageKey);
    if (!head) {
      return reply.status(409).send({ error: "Uploaded object not available yet. Retry complete." });
    }
    if (head.sizeBytes > MAX_GLB_BYTES) {
      await storage.delete(intent.storageKey).catch(() => undefined);
      return reply.status(413).send({ error: capMessage() });
    }
    if (head.sizeBytes !== intent.sizeBytes) {
      await storage.delete(intent.storageKey).catch(() => undefined);
      return reply.status(422).send({ error: "Uploaded object size does not match the declared size." });
    }
    const prefix = await storage.readPrefix(intent.storageKey, 4);
    if (!prefix || prefix.toString("ascii") !== "glTF") {
      await storage.delete(intent.storageKey).catch(() => undefined);
      return reply.status(422).send({ error: "Uploaded object is not a GLB file." });
    }

    // The object goes to a temporary file, never whole into memory; the split
    // reads the place's views and copies the rest range by range.
    const workDir = await mkdtemp(path.join(tmpdir(), "holoim-complete-"));
    let stored: StoredUpload;
    try {
      const uploadPath = path.join(workDir, "upload.glb");
      await storage.downloadToFile(intent.storageKey, uploadPath);
      stored = await storeUpload(storage, uploadPath, head.sizeBytes, workDir, (filenameStored) =>
        storage.copy(intent.storageKey, filenameStored, GLB_CONTENT_TYPE)
      );
    } catch (error) {
      if (error instanceof UploadValidationError) {
        await storage.delete(intent.storageKey).catch(() => undefined);
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    await storage.delete(intent.storageKey).catch(() => undefined);

    const created = await createHologram({
      filenameOriginal: intent.filenameOriginal,
      hologramName: intent.hologramName,
      submittedBy: intent.submittedBy,
      quickLookEnabled: intent.quickLookEnabled,
      filenameStored: stored.filenameStored,
      mimeType: intent.mimeType,
      sizeBytes: stored.sizeBytes,
      storagePath: `uploads/${stored.filenameStored}`,
      placeDetailKey: stored.placeDetailKey,
      processStatus: stored.processStatus,
      ownerId: intent.ownerId ?? null
    });
    await completeUploadIntent(intent.id, created.id);
    await refreshFeedSnapshot();

    return reply.status(201).send(hologramDtoSchema.parse(toDto(created, storage, authUser?.id)));
  });

  app.post("/holograms", async (request, reply) => {
    // A post grant from capture (docs/features/phone-capture.md) is checked
    // strictly, even in open-uploads mode, and before the body is read.
    const grantBearer = postGrantBearer(request.headers);
    let grant: PostGrantRow | null = null;
    if (grantBearer) {
      grant = await findPostGrant(grantBearer);
      if (!grant) {
        return reply.status(401).send({ error: "This recording link has expired. Start again from HoloIM." });
      }
      if (grant.hologramId) {
        // A retry after a lost answer, or a double tap: the take already posted.
        const existing = await getHologramById(grant.hologramId);
        if (existing) return reply.status(200).send(hologramDtoSchema.parse(toDto(existing, storage, grant.user.id)));
        return reply.status(410).send({ error: "This take was posted and then deleted." });
      }
      if (!(await claimPostGrant(grant.id))) {
        return reply.status(409).send({ error: "This take is already uploading." });
      }
    } else if (!(await mayUpload(request.headers))) {
      // Checked before the body is read, so an anonymous caller streams nothing to disk.
      return reply.status(401).send({ error: SIGN_IN_TO_UPLOAD });
    }
    let posted = false;
    let tempRoot: string | undefined;
    try {
      const parts = request.parts({
        limits: {
          fileSize: MAX_GLB_BYTES
        }
      });

      let uploadedFileMeta: { filename: string; mimetype: string } | undefined;
      let storedUpload: { sizeBytes: number; absolutePath: string } | undefined;
      const fields: Record<string, string> = {};

      // Every driver stages the upload to a temp file; the split writes the
      // light GLB and the detail SPZ beside it, and both are put to storage.
      const stagingRoot = (tempRoot = await mkdtemp(path.join(tmpdir(), "holoim-upload-")));

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
        return reply.status(400).send({ error: "Missing or invalid upload fields." });
      }

      const authUser = grant ? grant.user : await optionalAuthUser(request.headers);
      const stored = await storeUpload(storage, storedUpload.absolutePath, storedUpload.sizeBytes, stagingRoot);

      const created = await createHologram({
        filenameOriginal: uploadedFileMeta.filename,
        hologramName: parsedFields.data.hologramName,
        submittedBy: authUser?.displayName ?? parsedFields.data.submittedBy,
        filenameStored: stored.filenameStored,
        mimeType: uploadedFileMeta.mimetype,
        sizeBytes: stored.sizeBytes,
        storagePath: `uploads/${stored.filenameStored}`,
        quickLookEnabled: parsedFields.data.quickLookEnabled,
        placeDetailKey: stored.placeDetailKey,
        processStatus: stored.processStatus,
        ownerId: authUser?.id ?? null
      });

      if (grant) {
        await completePostGrant(grant.id, created.id);
        posted = true;
      }
      const dto = hologramDtoSchema.parse(toDto(created, storage, authUser?.id));
      await refreshFeedSnapshot();
      return reply.status(201).send(dto);
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }

      request.log.error({ error }, "Failed to upload hologram");
      return reply.status(500).send({ error: "Unexpected upload error." });
    } finally {
      // A failed post gives its grant back, so the same take can try again.
      if (grant && !posted) await releasePostGrant(grant.id);
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

    const { cursor, limit, ownerId, q } = parsed.data;
    if (q) {
      const retryAfter = searchLimit(clientKey(request, behindFly));
      if (retryAfter !== null) {
        return reply.status(429).header("retry-after", String(retryAfter)).send({ error: "Too many searches; try again in a minute." });
      }
    }
    const authUser = await optionalAuthUser(request.headers);
    const result = await listHolograms({
      limit,
      ...(cursor ? { cursor } : {}),
      ...(ownerId ? { ownerId } : {}),
      ...(q ? { q } : {})
    });

    const payload = paginatedHologramsSchema.parse({
      items: result.items.map((item) => toDto(item, storage, authUser?.id)),
      nextCursor: result.nextCursor
    });

    return reply.send(payload);
  });

  // A creator's public page: name and count, never the email.
  app.get("/users/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid id param." });
    }
    const user = await getUserById(params.data.id);
    if (!user) {
      return reply.status(404).send({ error: "Creator not found." });
    }
    return reply.send(
      publicUserSchema.parse({
        id: user.id,
        displayName: user.displayName,
        hologramCount: await countHologramsByOwner(user.id)
      })
    );
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

    const authUser = await optionalAuthUser(request.headers);
    return reply.send(hologramDtoSchema.parse(toDto(item, storage, authUser?.id)));
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

      if (item.ownerId) {
        const auth = await resolveAuth(request.headers);
        if (!auth) {
          return reply.status(401).send({ error: "Sign in required to delete this hologram." });
        }
        // A standing agent token only publishes; deleting takes a sign-in on the site.
        if (auth.via === "apiToken") {
          return reply.status(403).send({ error: "An agent token cannot delete holograms; sign in on the site instead." });
        }
        if (auth.user.id !== item.ownerId) {
          return reply.status(403).send({ error: "Only the creator can delete this hologram." });
        }
      }

      const usdzKeys = new Set([
        ...usdzFilenamesFor(item.filenameStored),
        ...(item.usdzPath ? [path.posix.basename(item.usdzPath)] : [])
      ]);

      let deletedFile = false;
      let deletedUsdz = false;
      let deletedDetail = false;
      try {
        deletedFile = await storage.delete(item.filenameStored);
      } catch (error) {
        request.log.warn({ error }, "Could not delete GLB object");
      }
      // The processed GLB, the place's detail level and the full-size textures
      // (hologram-budgets); the keys derived from the stored name too, in case
      // a crash came between writing an object and recording it.
      const detailKeys = new Set(
        [
          item.servedKey,
          item.placeDetailKey,
          item.textureDetailKey,
          servedKeyFor(item.filenameStored),
          placeDetailKeyFor(item.filenameStored),
          textureDetailKeyFor(item.filenameStored)
        ].filter((key): key is string => Boolean(key))
      );
      for (const key of detailKeys) {
        try {
          const removed = await storage.delete(key);
          const isDetail = key === item.placeDetailKey || key === item.textureDetailKey
            || key === placeDetailKeyFor(item.filenameStored) || key === textureDetailKeyFor(item.filenameStored);
          if (isDetail) deletedDetail = removed || deletedDetail;
        } catch (error) {
          request.log.warn({ error, key }, "Could not delete hologram detail object");
        }
      }
      for (const usdzKey of usdzKeys) {
        try {
          deletedUsdz = (await storage.delete(usdzKey)) || deletedUsdz;
        } catch (error) {
          request.log.warn({ error }, "Could not delete USDZ object");
        }
      }

      await deleteHologramById(item.id);
      await refreshFeedSnapshot();

      return reply.send(
        deleteHologramResponseSchema.parse({
          id: item.id,
          deletedFile,
          deletedUsdz,
          deletedDetail
        })
      );
    });
  });
}
