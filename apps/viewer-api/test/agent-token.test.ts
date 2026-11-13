import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bearer, exposeMagicLinksForTests, signIn } from "./fixtures/auth.js";

// Standing agent tokens (docs/features/agent-upload-token.md), driven through
// the real migrations, the real CLI and the real routes. Cases come from the
// brief's failure list: a token may upload and read /auth/me only; unknown,
// revoked and expired tokens are anonymous; the prefix keeps the token table
// and sessions apart; logout leaves a token alone; the CLI stores a hash only.

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name: string) => path.join(apiRoot, "node_modules", ".bin", name);

const AGENT_EMAIL = "agent+test@example.com";
const AGENT_NAME = "Claude (agent-authored)";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newAgentToken(): string {
  return `holoim_at_${randomBytes(32).toString("base64url")}`;
}

describe("agent upload tokens", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let testRoot: string;
  let databaseUrl: string;
  let previousDatabaseUrl: string | undefined;
  let restoreExpose: () => void;

  function cli(...args: string[]): { status: number; out: string } {
    try {
      const out = execFileSync(bin("tsx"), ["src/agent-token.ts", ...args], {
        cwd: apiRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      return { status: 0, out };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { status: failed.status, out: `${failed.stdout}${failed.stderr}` };
    }
  }

  function register(token: string): void {
    const result = cli("register", "--email", AGENT_EMAIL, "--name", AGENT_NAME, "--hash", sha256(token));
    expect(result.status, result.out).toBe(0);
  }

  async function upload(authorization: string | null, submittedBy = "Spoofed Name") {
    const boundary = `agent-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="hologramName"\r\n\r\nThe way down\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="submittedBy"\r\n\r\n${submittedBy}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="piece.glb"\r\n` +
          "Content-Type: model/gltf-binary\r\n\r\n"
      ),
      Buffer.from("agent-test-glb"),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    return app.inject({
      method: "POST",
      url: "/api/holograms",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        ...(authorization ? { authorization } : {})
      },
      payload
    });
  }

  const me = (authorization: string) => app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization } });

  beforeAll(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "holoim-agent-token-"));
    const uploadsRoot = path.join(testRoot, "uploads");
    await mkdir(uploadsRoot, { recursive: true });
    databaseUrl = `file:${path.join(testRoot, "agent.db")}`;
    execFileSync(bin("prisma"), ["migrate", "deploy"], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore"
    });
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    restoreExpose = exposeMagicLinksForTests();

    vi.resetModules();
    prisma = (await import("../src/lib/prisma.js")).prisma;
    const { buildApp } = await import("../src/app.js");
    app = buildApp({ logger: false, uploadsRoot, searchLimit: 10_000, magicLinkLimit: 10_000 });
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    await prisma.hologram.deleteMany();
    await prisma.apiToken.deleteMany();
    await prisma.session.deleteMany();
    await prisma.magicLinkToken.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await rm(testRoot, { recursive: true, force: true });
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    restoreExpose();
  });

  it("uploads as the agent account and reads /auth/me, with only a hash stored", async () => {
    const token = newAgentToken();
    register(token);

    const row = await prisma.apiToken.findFirstOrThrow({ include: { user: true } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.user).toMatchObject({ email: AGENT_EMAIL, displayName: AGENT_NAME });
    expect(row.lastUsedAt).toBeNull();

    const whoami = await me(`Bearer ${token}`);
    expect(whoami.statusCode).toBe(200);
    expect(whoami.json()).toMatchObject({ email: AGENT_EMAIL, displayName: AGENT_NAME });

    const created = await upload(`Bearer ${token}`);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ submittedBy: AGENT_NAME, submittedByVerified: true, ownerId: row.userId });

    const touched = await prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } });
    expect(touched.lastUsedAt).not.toBeNull();
  }, 30_000);

  it("refuses to rename the account or delete with a token, and logout leaves the token valid", async () => {
    const token = newAgentToken();
    register(token);
    const piece = (await upload(`Bearer ${token}`)).json<{ id: string }>();

    const rename = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Someone else" }
    });
    expect(rename.statusCode).toBe(403);

    const remove = await app.inject({ method: "DELETE", url: `/api/holograms/${piece.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(remove.statusCode).toBe(403);
    expect(await prisma.hologram.count({ where: { id: piece.id } })).toBe(1);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(204);
    expect((await me(`Bearer ${token}`)).statusCode).toBe(200);
    expect((await prisma.user.findFirstOrThrow({ where: { email: AGENT_EMAIL } })).displayName).toBe(AGENT_NAME);
  }, 30_000);

  it("treats unknown, revoked and expired tokens as anonymous", async () => {
    const unknown = newAgentToken();
    expect((await me(`Bearer ${unknown}`)).statusCode).toBe(401);
    expect((await upload(`Bearer ${unknown}`)).statusCode).toBe(401);

    const token = newAgentToken();
    register(token);
    expect((await me(`Bearer ${token}`)).statusCode).toBe(200);
    const revoked = cli("revoke", "--hash", sha256(token));
    expect(revoked.out).toContain("Revoked 1 token.");
    expect((await upload(`Bearer ${token}`)).statusCode).toBe(401);

    const expiring = newAgentToken();
    register(expiring);
    await prisma.apiToken.updateMany({ where: { tokenHash: sha256(expiring) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await me(`Bearer ${expiring}`)).statusCode).toBe(401);
  }, 30_000);

  it("keeps tokens and sessions apart by prefix", async () => {
    // A session token's hash in the token table does not make it an agent token,
    const session = await signIn(app, "ada@example.com", "Ada");
    const ada = await prisma.user.findUniqueOrThrow({ where: { email: "ada@example.com" } });
    await prisma.apiToken.create({ data: { tokenHash: sha256(session.token), userId: ada.id, label: "planted" } });
    await prisma.session.deleteMany();
    expect((await me(bearer(session).authorization)).statusCode).toBe(401);

    // and a prefixed value never matches a session.
    const prefixed = newAgentToken();
    await prisma.session.create({ data: { tokenHash: sha256(prefixed), userId: ada.id, expiresAt: new Date(Date.now() + 60_000) } });
    expect((await me(`Bearer ${prefixed}`)).statusCode).toBe(401);
  }, 30_000);

  it("register refuses a raw token, is idempotent, and will not rebind a hash", async () => {
    const token = newAgentToken();
    const raw = cli("register", "--email", AGENT_EMAIL, "--name", AGENT_NAME, "--hash", token);
    expect(raw.status).toBe(1);
    expect(raw.out).not.toContain(token);
    expect(await prisma.apiToken.count()).toBe(0);

    register(token);
    const again = cli("register", "--email", AGENT_EMAIL, "--name", AGENT_NAME, "--hash", sha256(token));
    expect(again.out).toContain("Already registered");
    expect(await prisma.apiToken.count()).toBe(1);

    const other = cli("register", "--email", "other@example.com", "--name", "Other", "--hash", sha256(token));
    expect(other.status).toBe(1);
    expect(await prisma.apiToken.count()).toBe(1);

    const listed = cli("list");
    expect(listed.out).toContain(AGENT_NAME);
    expect(listed.out).not.toContain(sha256(token));
  }, 60_000);

  it("moves only the named holograms, after a dry run, and sets their byline", async () => {
    const owner = await signIn(app, "me@example.com", "alberto");
    const keep = (await upload(bearer(owner).authorization)).json<{ id: string }>();
    const give = (await upload(bearer(owner).authorization)).json<{ id: string }>();
    register(newAgentToken());

    const dry = cli("move", "--from", "me@example.com", "--to", AGENT_EMAIL, "--id", give.id);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toContain("Dry run");
    expect((await prisma.hologram.findUniqueOrThrow({ where: { id: give.id } })).submittedBy).toBe("alberto");

    const stray = cli("move", "--from", "me@example.com", "--to", AGENT_EMAIL, "--id", "not-a-real-id", "--apply");
    expect(stray.status).toBe(1);

    const applied = cli("move", "--from", "me@example.com", "--to", AGENT_EMAIL, "--id", give.id, "--apply");
    expect(applied.out).toContain("Moved 1 hologram(s)");
    const agent = await prisma.user.findUniqueOrThrow({ where: { email: AGENT_EMAIL } });
    expect(await prisma.hologram.findUniqueOrThrow({ where: { id: give.id } })).toMatchObject({ ownerId: agent.id, submittedBy: AGENT_NAME });
    expect(await prisma.hologram.findUniqueOrThrow({ where: { id: keep.id } })).toMatchObject({ submittedBy: "alberto" });
  }, 60_000);
});
