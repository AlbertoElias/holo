import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fetchWithRetry, findAvailablePort, runCommand, stopProcess, waitForServer } from '@holoim/tooling-testing/dev-server';

const rootDir = process.cwd();
const apiWorkingDir = path.join(rootDir, 'apps', 'viewer-api');
const fixturePath = path.join(rootDir, 'apps', 'capture', 'public', 'gltf', 'models', 'avatar.glb');
const host = process.env.SMOKE_API_HOST ?? '127.0.0.1';
const configuredPort = Number(process.env.SMOKE_API_PORT ?? '3001');
const configuredBaseUrl = process.env.BASE_URL;
const startupTimeoutMs = Number(process.env.STARTUP_TIMEOUT_MS ?? '30000');
const reuseDevServer = process.env.REUSE_DEV_SERVER === '1';
const cleanupUpload = process.env.SMOKE_CLEANUP_UPLOAD !== '0';

async function main() {
  let port = configuredPort;
  if (!configuredBaseUrl && !reuseDevServer) {
    try {
      port = await findAvailablePort(host, configuredPort, 20);
    } catch {
      port = configuredPort;
    }
  }
  const apiBase = configuredBaseUrl ?? `http://${host}:${port}`;
  const apiUrl = `${apiBase}/api/holograms?limit=1`;

  let apiServer = null;
  let uploadedRelativePath = null;
  let uploadedId = null;

  try {
    if (!reuseDevServer) {
      await runCommand('pnpm', ['--filter', '@holoim/api', 'prisma:generate'], { cwd: rootDir });
      apiServer = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
        cwd: apiWorkingDir,
        stdio: 'inherit',
        env: {
          ...process.env,
          PORT: String(port),
          WEB_ORIGIN: 'https://localhost:3174'
        }
      });
    }

    await waitForServer(apiUrl, startupTimeoutMs, apiServer);

    const fixtureBytes = await readFile(fixturePath);
    const formData = new FormData();
    formData.set('file', new Blob([fixtureBytes], { type: 'model/gltf-binary' }), 'avatar.glb');
    formData.set('hologramName', 'pipeline-smoke-avatar');
    formData.set('submittedBy', 'agent-smoke');

    const uploadResponse = await fetchWithRetry(
      `${apiBase}/api/holograms`,
      {
        method: 'POST',
        body: formData
      },
      { retries: 4, retryDelayMs: 300, processHandle: apiServer }
    );

    if (!uploadResponse.ok) {
      const bodyText = await uploadResponse.text();
      throw new Error(`Upload failed (${uploadResponse.status}): ${bodyText}`);
    }

    const uploaded = await uploadResponse.json();
    if (typeof uploaded.id !== 'string' || typeof uploaded.url !== 'string') {
      throw new Error('Upload response did not include expected id/url fields.');
    }

    uploadedId = uploaded.id;
    uploadedRelativePath = uploaded.url.replace(/^\/+/, '');

    const detailResponse = await fetchWithRetry(
      `${apiBase}/api/holograms/${uploaded.id}`,
      { method: 'GET' },
      { retries: 4, retryDelayMs: 300, processHandle: apiServer }
    );
    if (!detailResponse.ok) {
      throw new Error(`Detail endpoint failed (${detailResponse.status}).`);
    }

    const listResponse = await fetchWithRetry(
      apiUrl,
      { method: 'GET' },
      { retries: 4, retryDelayMs: 300, processHandle: apiServer }
    );
    if (!listResponse.ok) {
      throw new Error(`List endpoint failed (${listResponse.status}).`);
    }

    const mediaResponse = await fetchWithRetry(
      `${apiBase}${uploaded.url}`,
      { method: 'GET' },
      { retries: 4, retryDelayMs: 300, processHandle: apiServer }
    );
    if (!mediaResponse.ok) {
      throw new Error(`Uploaded media URL failed (${mediaResponse.status}).`);
    }

    console.log('[smoke] Export -> upload -> fetch pipeline succeeded.');
  } finally {
    if (uploadedId && cleanupUpload) {
      await fetchWithRetry(
        `${apiBase}/api/holograms/${uploadedId}`,
        { method: 'DELETE' },
        { retries: 2, retryDelayMs: 300, processHandle: apiServer }
      ).catch(async () => {
        if (uploadedRelativePath) {
          const uploadedAbsolutePath = path.join(rootDir, 'apps', 'viewer-api', uploadedRelativePath);
          await rm(uploadedAbsolutePath, { force: true }).catch(() => undefined);
        }
      });
    }
    await stopProcess(apiServer);
  }
}

await main();
