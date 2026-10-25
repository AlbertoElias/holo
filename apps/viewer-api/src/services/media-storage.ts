import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { env } from "../lib/env.js";

export type ObjectHead = { sizeBytes: number; contentType: string | null };
export type PresignedPost = { url: string; fields: Record<string, string> };

/**
 * Object storage for hologram media. Keys are storage-relative
 * (`<file>.glb`, `<file>-ql3.usdz`, `incoming/<intent>.glb`); the driver
 * owns turning a key into a public URL.
 */
export interface MediaStorage {
  readonly kind: "local" | "s3";
  publicUrl(key: string): string;
  putFile(key: string, absolutePath: string, contentType: string, cacheControl?: string, contentDisposition?: string): Promise<void>;
  putBuffer(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void>;
  head(key: string): Promise<ObjectHead | null>;
  readPrefix(key: string, length: number): Promise<Buffer | null>;
  copy(sourceKey: string, destKey: string, contentType: string): Promise<void>;
  /** Returns true when an object was removed (local) or the delete succeeded (s3). */
  delete(key: string): Promise<boolean>;
  downloadToFile(key: string, absolutePath: string): Promise<void>;
  createPresignedPost(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresSec: number
  ): Promise<PresignedPost | null>;
}

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

export class LocalMediaStorage implements MediaStorage {
  readonly kind = "local" as const;

  public constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const resolved = path.resolve(this.root, key);
    const rootResolved = path.resolve(this.root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`Storage key escapes uploads root: ${key}`);
    }
    return resolved;
  }

  publicUrl(key: string): string {
    return `/uploads/${key.split(path.sep).join("/")}`;
  }

  async putFile(key: string, absolutePath: string): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    if (path.resolve(absolutePath) !== dest) {
      await copyFile(absolutePath, dest);
    }
  }

  async putBuffer(key: string, body: Buffer): Promise<void> {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, body);
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const info = await stat(this.resolve(key));
      return info.isFile() ? { sizeBytes: info.size, contentType: null } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readPrefix(key: string, length: number): Promise<Buffer | null> {
    try {
      const body = await readFile(this.resolve(key));
      return body.subarray(0, length);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async copy(sourceKey: string, destKey: string): Promise<void> {
    await this.putFile(destKey, this.resolve(sourceKey));
  }

  async delete(key: string): Promise<boolean> {
    try {
      await rm(this.resolve(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async downloadToFile(key: string, absolutePath: string): Promise<void> {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await copyFile(this.resolve(key), absolutePath);
  }

  async createPresignedPost(): Promise<PresignedPost | null> {
    return null;
  }
}

export class S3MediaStorage implements MediaStorage {
  readonly kind = "s3" as const;
  private readonly client: S3Client;

  public constructor(
    private readonly bucket: string,
    private readonly publicBaseUrl: string,
    client?: S3Client
  ) {
    this.client =
      client ??
      new S3Client({
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
        region: env.S3_REGION,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
          secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? ""
        }
      });
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  async putFile(
    key: string,
    absolutePath: string,
    contentType: string,
    cacheControl?: string,
    contentDisposition?: string
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(absolutePath),
        ContentType: contentType,
        CacheControl: cacheControl ?? IMMUTABLE_CACHE,
        ...(contentDisposition ? { ContentDisposition: contentDisposition } : {})
      })
    );
  }

  async putBuffer(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl ?? IMMUTABLE_CACHE
      })
    );
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
    } catch (error) {
      if ((error as { name?: string }).name === "NotFound") return null;
      throw error;
    }
  }

  async readPrefix(key: string, length: number): Promise<Buffer | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${Math.max(0, length - 1)}` })
      );
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey") return null;
      throw error;
    }
  }

  async copy(sourceKey: string, destKey: string, contentType: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${sourceKey}`,
        Key: destKey,
        ContentType: contentType,
        CacheControl: IMMUTABLE_CACHE,
        MetadataDirective: "REPLACE"
      })
    );
  }

  async delete(key: string): Promise<boolean> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    return true;
  }

  async downloadToFile(key: string, absolutePath: string): Promise<void> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error(`Object has no body: ${key}`);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const { createWriteStream } = await import("node:fs");
    await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(absolutePath));
  }

  async createPresignedPost(
    key: string,
    contentType: string,
    maxBytes: number,
    expiresSec: number
  ): Promise<PresignedPost> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["eq", "$Content-Type", contentType]
      ],
      Fields: { "Content-Type": contentType },
      Expires: expiresSec
    });
    return { url, fields };
  }
}

export function createMediaStorage(uploadsRoot: string): MediaStorage {
  if (env.STORAGE_DRIVER === "s3") {
    return new S3MediaStorage(env.S3_BUCKET ?? "", env.PUBLIC_MEDIA_BASE_URL ?? "");
  }
  return new LocalMediaStorage(uploadsRoot);
}
