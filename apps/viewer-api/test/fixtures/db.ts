import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prisma/migrations");

/**
 * Builds a throwaway test database from the real prisma/migrations, in order, so
 * its tables can never drift from what production runs. Replaces hand-copied DDL.
 */
export async function applyMigrations(prisma: PrismaClient): Promise<void> {
  const folders = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    const sql = readFileSync(path.join(migrationsDir, folder, "migration.sql"), "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*(?:\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);
  }
}
