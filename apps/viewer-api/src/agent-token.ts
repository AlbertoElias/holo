import "dotenv/config";

import { parseArgs } from "node:util";

import { prisma } from "./lib/prisma.js";

// Standing upload tokens for an agent account (docs/features/agent-upload-token.md).
// Run on the API host, never over HTTP; the user's setup script
// (scripts/agent-upload-token.sh) calls it through `fly ssh console`:
//
//   node /app/apps/viewer-api/dist/apps/viewer-api/src/agent-token.js register --email <e> --name <n> --hash <sha256> [--label <l>]
//   ... list
//   ... revoke --hash <sha256> | --id <id>
//   ... move --from <email> --to <email> [--id <hologram id> ...] [--apply]
//
// `register` takes only the SHA-256 hex of the token: the token is made and
// kept on the user's Mac, so it never reaches this host. A second `register`
// of the same hash changes nothing. `move` without --apply only lists.

const HASH = /^[0-9a-f]{64}$/;

function requireHash(value: string | undefined): string {
  const hash = value?.trim().toLowerCase();
  if (!hash || !HASH.test(hash)) {
    // A raw token pasted here would land in this host's shell history; refuse it without echoing it.
    throw new Error("--hash must be the 64-character SHA-256 hex of the token, never the token itself.");
  }
  return hash;
}

function requireEmail(value: string | undefined, flag: string): string {
  const email = value?.trim().toLowerCase(); // accounts store emails lowercased
  if (!email || !email.includes("@")) {
    throw new Error(`${flag} <email> is required.`);
  }
  return email;
}

async function register(values: Record<string, unknown>): Promise<void> {
  const email = requireEmail(values.email as string | undefined, "--email");
  const name = (values.name as string | undefined)?.trim();
  const hash = requireHash(values.hash as string | undefined);
  const label = (values.label as string | undefined)?.trim() || "agent uploads";

  const existingToken = await prisma.apiToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
  if (existingToken) {
    if (existingToken.user.email !== email) {
      throw new Error("That token is already registered to a different account.");
    }
    console.log(`Already registered: token ${existingToken.id} for ${existingToken.user.displayName}. Nothing changed.`);
    return;
  }

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    if (!name) {
      throw new Error("No account has that email yet; pass --name <display name> to create it.");
    }
    user = await prisma.user.create({ data: { email, displayName: name } });
    console.log(`Created account ${user.displayName} (${user.id}).`);
  } else if (name && name !== user.displayName) {
    console.log(`Account exists as "${user.displayName}"; its display name is left as is.`);
  }
  const token = await prisma.apiToken.create({ data: { tokenHash: hash, userId: user.id, label } });
  console.log(`Registered token ${token.id} ("${label}") for ${user.displayName} (${user.id}).`);
}

async function list(): Promise<void> {
  const tokens = await prisma.apiToken.findMany({ include: { user: true }, orderBy: { createdAt: "asc" } });
  if (tokens.length === 0) {
    console.log("No agent tokens.");
    return;
  }
  for (const token of tokens) {
    const lastUsed = token.lastUsedAt?.toISOString() ?? "never";
    console.log(`${token.id}  "${token.label}"  ${token.user.displayName} <${token.user.email}>  created ${token.createdAt.toISOString()}  last used ${lastUsed}`);
  }
}

async function revoke(values: Record<string, unknown>): Promise<void> {
  const id = (values.id as string[] | undefined)?.[0]?.trim();
  const where = id ? { id } : { tokenHash: requireHash(values.hash as string | undefined) };
  const result = await prisma.apiToken.deleteMany({ where });
  console.log(result.count === 1 ? "Revoked 1 token." : "No such token; nothing changed.");
}

async function move(values: Record<string, unknown>): Promise<void> {
  const from = await prisma.user.findUnique({ where: { email: requireEmail(values.from as string | undefined, "--from") } });
  const to = await prisma.user.findUnique({ where: { email: requireEmail(values.to as string | undefined, "--to") } });
  if (!from || !to) {
    throw new Error(`No account has the ${from ? "--to" : "--from"} email.`);
  }
  const ids = (values.id as string[] | undefined) ?? [];
  const owned = await prisma.hologram.findMany({
    where: { ownerId: from.id, ...(ids.length > 0 ? { id: { in: ids } } : {}) },
    select: { id: true, hologramName: true, submittedBy: true, createdAt: true },
    orderBy: { createdAt: "asc" }
  });
  const missing = ids.filter((id) => !owned.some((row) => row.id === id));
  if (missing.length > 0) {
    throw new Error(`Not owned by ${from.displayName}: ${missing.join(", ")}. Nothing changed.`);
  }

  console.log(`${owned.length} hologram(s) owned by ${from.displayName}${ids.length > 0 ? " among the given ids" : ""}:`);
  for (const row of owned) {
    console.log(`  ${row.id}  ${row.createdAt.toISOString()}  ${row.hologramName}  (by "${row.submittedBy}")`);
  }
  if (!values.apply || ids.length === 0) {
    console.log(ids.length === 0
      ? `Dry run. Name the ones to move with --id <id> (repeatable), then add --apply to give them to ${to.displayName}.`
      : `Dry run. Nothing changed; add --apply to give these to ${to.displayName}.`);
    return;
  }
  // The ownerId guard keeps a hologram that changed hands since the listing.
  const result = await prisma.hologram.updateMany({
    where: { id: { in: ids }, ownerId: from.id },
    data: { ownerId: to.id, submittedBy: to.displayName }
  });
  console.log(`Moved ${result.count} hologram(s) to ${to.displayName}. The feed snapshot catches up on the next upload; the live feed shows it now.`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set; run this on the API host (fly ssh console) or with the API's .env.");
  }
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      hash: { type: "string" },
      label: { type: "string" },
      id: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      apply: { type: "boolean", default: false }
    }
  });
  switch (command) {
    case "register":
      return register(values);
    case "list":
      return list();
    case "revoke":
      return revoke(values);
    case "move":
      return move(values);
    default:
      throw new Error("Usage: agent-token.js register|list|revoke|move [options] (see the comment at the top of src/agent-token.ts)");
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
