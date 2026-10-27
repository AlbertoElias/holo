import { z } from "zod";

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === "boolean" ? value : value.toLowerCase() === "true" || value === "1"))
  .default(true);

const boolFromEnvFalse = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === "boolean" ? value : value.toLowerCase() === "true" || value === "1"))
  .default(false);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("file:./prisma/dev.db"),
  PORT: z.coerce.number().int().positive().default(3001),
  WEB_ORIGIN: z.string().url().default("https://localhost:3174"),
  // Comma-separated additional allowed origins. An entry may contain one
  // `*.` wildcard for subdomains, e.g. https://*.holoim.pages.dev
  WEB_ORIGINS: z.string().default(""),
  UPLOADS_ROOT: z.string().min(1).optional(),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  PUBLIC_MEDIA_BASE_URL: z.string().url().optional(),
  USDZ_WORKER_ENABLED: boolFromEnv,
  UPLOAD_INTENT_CLEANUP_ENABLED: boolFromEnv,
  UPLOAD_INTENT_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  UPLOAD_INTENT_GRACE_MS: z.coerce.number().int().nonnegative().default(900_000),
  UPLOAD_INTENT_COMPLETED_RETENTION_MS: z.coerce.number().int().positive().default(86_400_000),
  USDZ_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  USDZ_STALE_CLAIM_MS: z.coerce.number().int().positive().default(600_000),
  AUTH_MAGIC_LINK_TTL_MS: z.coerce.number().int().positive().default(900_000),
  AUTH_SESSION_TTL_MS: z.coerce.number().int().positive().default(2_592_000_000),
  AUTH_DEV_EXPOSE_MAGIC_LINK: boolFromEnvFalse
});

const parsed = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: process.env.PORT,
  WEB_ORIGIN: process.env.WEB_ORIGIN,
  WEB_ORIGINS: process.env.WEB_ORIGINS,
  UPLOADS_ROOT: process.env.UPLOADS_ROOT,
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  PUBLIC_MEDIA_BASE_URL: process.env.PUBLIC_MEDIA_BASE_URL,
  USDZ_WORKER_ENABLED: process.env.USDZ_WORKER_ENABLED,
  UPLOAD_INTENT_CLEANUP_ENABLED: process.env.UPLOAD_INTENT_CLEANUP_ENABLED,
  UPLOAD_INTENT_CLEANUP_INTERVAL_MS: process.env.UPLOAD_INTENT_CLEANUP_INTERVAL_MS,
  UPLOAD_INTENT_GRACE_MS: process.env.UPLOAD_INTENT_GRACE_MS,
  UPLOAD_INTENT_COMPLETED_RETENTION_MS: process.env.UPLOAD_INTENT_COMPLETED_RETENTION_MS,
  USDZ_POLL_INTERVAL_MS: process.env.USDZ_POLL_INTERVAL_MS,
  USDZ_STALE_CLAIM_MS: process.env.USDZ_STALE_CLAIM_MS,
  AUTH_MAGIC_LINK_TTL_MS: process.env.AUTH_MAGIC_LINK_TTL_MS,
  AUTH_SESSION_TTL_MS: process.env.AUTH_SESSION_TTL_MS,
  AUTH_DEV_EXPOSE_MAGIC_LINK: process.env.AUTH_DEV_EXPOSE_MAGIC_LINK
});

if (parsed.STORAGE_DRIVER === "s3") {
  const missing = [
    ["S3_ENDPOINT", parsed.S3_ENDPOINT],
    ["S3_BUCKET", parsed.S3_BUCKET],
    ["S3_ACCESS_KEY_ID", parsed.S3_ACCESS_KEY_ID],
    ["S3_SECRET_ACCESS_KEY", parsed.S3_SECRET_ACCESS_KEY],
    ["PUBLIC_MEDIA_BASE_URL", parsed.PUBLIC_MEDIA_BASE_URL]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`STORAGE_DRIVER=s3 requires: ${missing.join(", ")}`);
  }
}

export const env = {
  ...parsed,
  WEB_ORIGIN_LIST: parsed.WEB_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
};
