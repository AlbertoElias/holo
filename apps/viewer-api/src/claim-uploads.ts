import "dotenv/config";

import { parseArgs } from "node:util";

import { prisma } from "./lib/prisma.js";

// One-off: give holograms that were uploaded by hand-typed name, with no
// account, to the creator account they belong to.
//
//   pnpm --filter @holoim/api claim:uploads -- --name alberto --email me@example.com            (dry run)
//   pnpm --filter @holoim/api claim:uploads -- --name alberto --email me@example.com --apply
//   node apps/viewer-api/dist/apps/viewer-api/src/claim-uploads.js ...                          (production image)
//
// Only holograms with no owner and a matching submittedBy (ignoring ASCII
// case) change; anything already owned, by anyone, is left alone, so a second
// run changes nothing. The account is found by its email (any case). The new owner
// shows on the creator page; submittedBy keeps its text.

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      email: { type: "string" },
      apply: { type: "boolean", default: false }
    }
  });
  const name = values.name?.trim();
  const email = values.email?.trim().toLowerCase(); // accounts store emails lowercased
  if (!name || !email) {
    throw new Error("Usage: --name <submittedBy> --email <account email> [--apply]");
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error("No account has that email. Sign in once on the site first, so the account exists.");
  }

  const matches = (
    await prisma.hologram.findMany({
      where: { ownerId: null },
      select: { id: true, hologramName: true, submittedBy: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    })
  ).filter((row) => row.submittedBy.trim().toLowerCase() === name.toLowerCase());

  console.log(`Account: ${user.displayName} (${user.id})`);
  console.log(`${matches.length} unowned hologram(s) submitted by "${name}":`);
  for (const row of matches) {
    console.log(`  ${row.id}  ${row.createdAt.toISOString()}  ${row.hologramName}`);
  }
  if (!values.apply) {
    console.log("Dry run. Nothing changed; add --apply to assign them.");
    return;
  }
  // The ownerId: null guard keeps a hologram that was claimed since the listing.
  const result = await prisma.hologram.updateMany({
    where: { id: { in: matches.map((row) => row.id) }, ownerId: null },
    data: { ownerId: user.id }
  });
  console.log(`Assigned ${result.count} hologram(s) to ${user.displayName}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
