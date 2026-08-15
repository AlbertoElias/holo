import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { findAvailablePort, waitForServer } from "@holoim/tooling-testing/dev-server";

import { launchTestApi, type TestApi } from "./test-api.js";

function findWorkspaceRoot(startDir: string): string {
  let currentDir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) return currentDir;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find pnpm-workspace.yaml from ${startDir}.`);
    }
    currentDir = parentDir;
  }
}

const rootDir = findWorkspaceRoot(process.cwd());
const fixturePath = path.join(rootDir, "apps", "capture", "public", "gltf", "models", "avatar.glb");
const host = process.env.SMOKE_API_HOST ?? "127.0.0.1";
const configuredPort = Number(process.env.SMOKE_API_PORT ?? "3001");
const configuredBaseUrl = process.env.BASE_URL;
const startupTimeoutMs = Number(process.env.STARTUP_TIMEOUT_MS ?? "30000");
const reuseDevServer = process.env.REUSE_DEV_SERVER === "1";

type UploadedHologram = {
  id: string;
  url: string;
};

async function expectOk(response: Response, label: string): Promise<Response> {
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`${label} failed (${response.status}): ${bodyText}`);
  }
  return response;
}

async function main(): Promise<void> {
  let testApi: TestApi | undefined;
  let uploadedId: string | undefined;

  try {
    if (!configuredBaseUrl && !reuseDevServer) {
      const port = await findAvailablePort(host, configuredPort, 20);
      testApi = await launchTestApi({ host, port, startupTimeoutMs });
    }

    const apiBase = configuredBaseUrl ?? testApi?.baseUrl ?? `http://${host}:${configuredPort}`;
    const listUrl = `${apiBase}/api/holograms?limit=1`;
    if (!testApi) await waitForServer(listUrl, startupTimeoutMs);

    const fixtureBytes = await readFile(fixturePath);
    const formData = new FormData();
    formData.set("file", new Blob([fixtureBytes], { type: "model/gltf-binary" }), "avatar.glb");
    formData.set("hologramName", "pipeline-smoke-avatar");
    formData.set("submittedBy", "agent-smoke");

    const uploadResponse = await expectOk(
      await fetch(`${apiBase}/api/holograms`, { method: "POST", body: formData }),
      "Upload"
    );
    const uploaded = (await uploadResponse.json()) as Partial<UploadedHologram>;
    if (typeof uploaded.id !== "string" || typeof uploaded.url !== "string") {
      throw new Error("Upload response did not include expected id/url fields.");
    }
    uploadedId = uploaded.id;

    await expectOk(await fetch(`${apiBase}/api/holograms/${uploaded.id}`), "Detail endpoint");
    await expectOk(await fetch(listUrl), "List endpoint");
    await expectOk(await fetch(`${apiBase}${uploaded.url}`), "Uploaded media URL");

    console.log("[smoke] Export -> upload -> fetch pipeline succeeded.");
  } finally {
    if (!testApi && uploadedId) {
      const apiBase = configuredBaseUrl ?? `http://${host}:${configuredPort}`;
      await fetch(`${apiBase}/api/holograms/${uploadedId}`, { method: "DELETE" }).catch(() => undefined);
    }
    await testApi?.stop();
  }
}

main().catch((error: unknown) => {
  console.error("[smoke]", error);
  process.exitCode = 1;
});
