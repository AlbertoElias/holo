import { randomBytes } from "node:crypto";

import { prisma } from "../lib/prisma.js";
import { bearerToken, hashToken, type AuthUser } from "./auth.js";

/**
 * Post grants (docs/features/phone-capture.md): the viewer mints one from a
 * session and hands it to capture in a URL fragment, so a phone take posts
 * without a second sign-in. A grant may only create one hologram, through
 * `POST /holograms`; `resolveAuth` never accepts it, so it cannot read or
 * change the account or delete anything.
 */
export const POST_GRANT_PREFIX = "holoim_pg_";
export const POST_GRANT_TTL_MS = 15 * 60_000;

export type PostGrantRow = {
  id: string;
  user: AuthUser;
  returnOrigin: string;
  expiresAt: Date;
  usedAt: Date | null;
  hologramId: string | null;
};

export async function mintPostGrant(userId: string, returnOrigin: string): Promise<{ grant: string; expiresAt: Date }> {
  const grant = `${POST_GRANT_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + POST_GRANT_TTL_MS);
  await prisma.postGrant.create({ data: { tokenHash: hashToken(grant), userId, returnOrigin, expiresAt } });
  return { grant, expiresAt };
}

/** The bearer, when it is a post grant (whatever its state). */
export function postGrantBearer(headers: { authorization?: string | string[] | undefined }): string | null {
  const token = bearerToken(headers);
  return token?.startsWith(POST_GRANT_PREFIX) ? token : null;
}

/**
 * The grant, or null when unknown or expired. A grant that already posted
 * stays readable after expiry, so a retry whose first answer was lost still
 * learns its hologram.
 */
export async function findPostGrant(grant: string): Promise<PostGrantRow | null> {
  const row = await prisma.postGrant.findUnique({ where: { tokenHash: hashToken(grant) }, include: { user: true } });
  if (!row) return null;
  if (!row.hologramId && row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

/** Claims the grant for one upload; false when another upload holds it. */
export async function claimPostGrant(id: string): Promise<boolean> {
  const claimed = await prisma.postGrant.updateMany({ where: { id, usedAt: null, hologramId: null }, data: { usedAt: new Date() } });
  return claimed.count === 1;
}

/** Gives the claim back after a failed upload, so the same take can retry. */
export async function releasePostGrant(id: string): Promise<void> {
  await prisma.postGrant.updateMany({ where: { id, hologramId: null }, data: { usedAt: null } });
}

export async function completePostGrant(id: string, hologramId: string): Promise<void> {
  await prisma.postGrant.update({ where: { id }, data: { hologramId } });
}

/** Expired grants that never posted are useless; posted ones are kept a day for late retries. */
export async function cleanupExpiredPostGrants(now = new Date()): Promise<number> {
  const result = await prisma.postGrant.deleteMany({
    where: {
      OR: [
        { hologramId: null, expiresAt: { lt: now } },
        { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) } }
      ]
    }
  });
  return result.count;
}
