import { createId } from "@paralleldrive/cuid2";
import type { MultipartFile } from "@fastify/multipart";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

import { MAX_GLB_BYTES } from "../lib/constants.js";

const allowedMimeTypes = new Set(["model/gltf-binary", "application/octet-stream"]);

const fileMetaSchema = z.object({
  filename: z.string().min(1),
  mimetype: z.string().min(1)
});

export class UploadValidationError extends Error {
  public readonly statusCode: number;

  public constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.statusCode = statusCode;
  }
}

export function validateGlbMeta(input: { filename: string; mimetype: string }): void {
  const parsed = fileMetaSchema.parse(input);
  const ext = path.extname(parsed.filename).toLowerCase();

  if (ext !== ".glb") {
    throw new UploadValidationError("Only .glb files are allowed.");
  }

  if (!allowedMimeTypes.has(parsed.mimetype)) {
    throw new UploadValidationError("Invalid file MIME type for .glb upload.");
  }
}

export async function saveUploadedGlb(file: MultipartFile, absoluteUploadDir: string): Promise<{
  storedFilename: string;
  absolutePath: string;
  relativeStoragePath: string;
  sizeBytes: number;
}> {
  validateGlbMeta({ filename: file.filename, mimetype: file.mimetype });

  await mkdir(absoluteUploadDir, { recursive: true });

  const storedFilename = `${createId()}.glb`;
  const absolutePath = path.join(absoluteUploadDir, storedFilename);
  const relativeStoragePath = path.posix.join("uploads", storedFilename);

  let sizeBytes = 0;
  file.file.on("data", (chunk: Buffer) => {
    sizeBytes += chunk.length;
  });

  await pipeline(file.file, createWriteStream(absolutePath));

  if (file.file.truncated || sizeBytes > MAX_GLB_BYTES) {
    throw new UploadValidationError("File exceeds 25MB limit.", 413);
  }

  return { storedFilename, absolutePath, relativeStoragePath, sizeBytes };
}
