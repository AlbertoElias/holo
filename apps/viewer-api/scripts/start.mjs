// The API image's entry point. The machine scales to zero, so this runs on
// every cold start, which a person waits through (Record on a phone, the feed).
// `prisma migrate deploy` costs about 8 s there even with nothing to apply, so
// it runs only when the database lacks a migration that ships in this image.
// Any doubt (no table, a failed migration, an unreadable database) runs it.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function shippedMigrations() {
  return readdirSync(path.join(apiRoot, "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function databaseIsCurrent() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations"
    );
    // A started-but-unfinished migration is for the CLI to report.
    if (rows.some((row) => row.finished_at === null && row.rolled_back_at === null)) return false;
    const applied = new Set(rows.filter((row) => row.finished_at !== null && row.rolled_back_at === null).map((row) => row.migration_name));
    return shippedMigrations().every((name) => applied.has(name));
  } catch {
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

const started = Date.now();
if (await databaseIsCurrent()) {
  console.info(`[start] database current; migrate skipped (${Date.now() - started} ms)`);
} else {
  const cli = path.join(apiRoot, "node_modules", ".bin", "prisma");
  const result = spawnSync(cli, ["migrate", "deploy"], { cwd: apiRoot, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.info(`[start] migrate deploy done (${Date.now() - started} ms)`);
}

await import(path.join(apiRoot, "dist", "apps", "viewer-api", "src", "server.js"));
