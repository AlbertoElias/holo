import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "@prisma/client";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prisma/migrations");

/**
 * Builds a throwaway test database from the real prisma/migrations, in order, so
 * its tables can never drift from what production runs. Replaces hand-copied DDL.
 *
 * Every statement runs inside one interactive transaction, which pins a single pooled
 * connection. Prisma's SQLite pool otherwise hands successive statements to different
 * connections, and under load one of them acts on a stale schema (`ALTER TABLE
 * "new_Hologram" RENAME TO "Hologram"` failing with "already another table", `CREATE INDEX`
 * with "already exists") although the previous statement had dropped or created it.
 */
export async function applyMigrations(prisma: PrismaClient): Promise<void> {
  const folders = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrations = folders.map((folder) => {
    const sql = readFileSync(path.join(migrationsDir, folder, "migration.sql"), "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*(?:\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    return statements;
  });
  await prisma.$transaction(
    async (tx) => {
      for (const statement of migrations.flat()) await tx.$executeRawUnsafe(statement);
    },
    { timeout: 60_000 }
  );
}
