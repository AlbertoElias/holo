#!/usr/bin/env node
// Browser checks load a test build served by `vite preview`, not the Vite dev
// server (docs/features/archive/ci-under-5m.md, "Built bundles"). A test build is the
// production build plus HOLOIM_TEST_BUILD=1: IWER injected, test hooks kept,
// the API reached through a relative /api that preview proxies.
//
//   node packages/tooling-testing/src/test-build.mjs build <web|capture>
//   node packages/tooling-testing/src/test-build.mjs serve <web|capture> -- <vite preview args>
//
// `build` rebuilds only when the app's inputs changed: a fingerprint of the
// git index and working tree under the app (not its e2e/scripts) and the
// workspace packages, stored beside the bundle in output/test-builds/. Every
// variant (SEM scene, IWER device) has its own directory, so suites that
// differ only in environment never rebuild each other's bundle.
// `serve` builds when needed and then runs `vite preview` on the bundle.
// HOLOIM_VITE_DEV=1 makes `serve` run the Vite dev server instead (debugging);
// HOLOIM_TEST_BUILD_FORCE=1 rebuilds even when the fingerprint matches.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STAMP = '.holoim-test-build.json';
// Bump when the build recipe changes so every stored bundle is rebuilt.
const RECIPE = 2;

/** Per app: its directory, package, and the environment that selects a bundle variant. */
export const TEST_BUILD_APPS = {
  web: { dir: 'apps/viewer-web', pkg: '@holoim/web', variantEnv: ['VITE_IWER_SEM_SCENE'] },
  capture: { dir: 'apps/capture', pkg: '@holoim/capture', variantEnv: ['CAPTURE_IWER_DEVICE'] }
};

function appConfig(app) {
  const config = TEST_BUILD_APPS[app];
  if (!config) throw new Error(`Unknown test-build app "${app}" (expected ${Object.keys(TEST_BUILD_APPS).join(' or ')})`);
  return config;
}

function variantOf(app, env) {
  const { variantEnv } = appConfig(app);
  const values = variantEnv.filter((key) => env[key]).map((key) => `${key}=${env[key]}`);
  return { values, name: values.length ? values.map((value) => value.split('=')[1].replace(/[^a-zA-Z0-9_-]+/g, '-')).join('-') : 'default' };
}

/** Where the app's test bundle for this environment lives. */
export function testBuildDir(app, env = process.env) {
  return path.join(repoRoot, 'output/test-builds', app, variantOf(app, env).name);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout;
}

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'output', 'test-results', 'playwright-report', '.iwsdk', '.wrangler', 'coverage']);

/** Without git (the CI emulation copies the tree without .git): hash the same inputs by walking them. */
function walkFingerprint(app, env) {
  const { dir } = appConfig(app);
  const excluded = [`${dir}/scripts`, `${dir}/fixtures`, 'packages/tooling-testing', 'packages/tooling-scripts', 'packages/config-eslint'];
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ RECIPE, app, variant: variantOf(app, env).values, walked: true }));
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !excluded.includes(child)) walk(child);
      } else if (entry.isFile() && !child.endsWith('.tsbuildinfo') && !(child.startsWith(`${dir}/e2e/`) && child.endsWith('.ts'))) {
        // (tsbuildinfo: written by the package builds this build runs.)
        hash.update(child);
        hash.update(readFileSync(path.join(repoRoot, child)));
      }
    }
  };
  walk(dir);
  walk('packages');
  hash.update(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml')));
  return hash.digest('hex');
}

/** Hash of every build input as it stands on disk. */
function fingerprint(app, env) {
  const { dir } = appConfig(app);
  const pathspecs = [
    dir,
    // Specs never reach the bundle; e2e pages it builds (.html/.tsx) do.
    `:(exclude,glob)${dir}/e2e/**/*.ts`,
    `:(exclude)${dir}/scripts`,
    `:(exclude)${dir}/fixtures`,
    'packages',
    ':(exclude)packages/tooling-testing',
    ':(exclude)packages/tooling-scripts',
    ':(exclude)packages/config-eslint',
    'pnpm-lock.yaml'
  ];
  const index = git(['ls-files', '-s', '-z', '--', ...pathspecs]);
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs]);
  if (index === null || status === null) return walkFingerprint(app, env);
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ RECIPE, app, variant: variantOf(app, env).values }));
  hash.update(index);
  // Entries are "XY path\0" (renames add "\0source"): hash the working-tree
  // content of each changed path, so uncommitted edits rebuild too.
  for (const entry of status.toString('utf8').split('\0')) {
    if (entry.length < 4) continue;
    const file = entry.slice(3);
    const absolute = path.join(repoRoot, file);
    hash.update(file);
    hash.update(existsSync(absolute) ? readFileSync(absolute) : 'deleted');
  }
  return hash.digest('hex');
}

function withLock(lockDir, action) {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // A lock older than five minutes belongs to a run that died.
      if (Date.now() - statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs > 300_000 || Date.now() - startedAt > 300_000) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// Output goes to stderr: Playwright's webServer shows only stderr, and a
// failed build must say why there.
function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...options });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
  const failed = result.status !== 0;
  if (failed && output) process.stderr.write(`${output}\n`);
  if (failed) throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message ?? result.signal ?? `exit ${result.status}`})`);
}

/**
 * Builds the app's test bundle unless the stored one matches the current
 * inputs. Returns its directory.
 */
export function ensureTestBuild(app, env = process.env) {
  const { dir, pkg } = appConfig(app);
  const outDir = testBuildDir(app, env);
  const print = fingerprint(app, env);
  const stampPath = path.join(outDir, STAMP);
  if (print && env.HOLOIM_TEST_BUILD_FORCE !== '1' && existsSync(stampPath)) {
    try {
      if (JSON.parse(readFileSync(stampPath, 'utf8')).fingerprint === print) {
        console.log(`[test-build] ${app} (${path.basename(outDir)}) is current: ${path.relative(repoRoot, outDir)}`);
        return outDir;
      }
    } catch {
      // An unreadable stamp means rebuild.
    }
  }
  const startedAt = Date.now();
  console.log(`[test-build] Building ${app} (${path.basename(outDir)}) into ${path.relative(repoRoot, outDir)}`);
  // Workspace packages resolve to their built dist, as in the production
  // build. The viewer and capture servers start together and share packages,
  // so one tsc run at a time writes them.
  withLock(path.join(repoRoot, 'output/test-builds/.packages.lock'), () => {
    run('pnpm', ['--filter', `${pkg}^...`, 'run', 'build'], { cwd: repoRoot, env });
  });
  const tempDir = `${outDir}.tmp-${process.pid}`;
  rmSync(tempDir, { recursive: true, force: true });
  try {
    run('pnpm', ['exec', 'vite', 'build', '--outDir', tempDir, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: path.join(repoRoot, dir),
      // Same-origin API: preview proxies /api and /uploads to the e2e API.
      env: { ...env, HOLOIM_TEST_BUILD: '1', VITE_API_ORIGIN: '' }
    });
    writeFileSync(path.join(tempDir, STAMP), `${JSON.stringify({ fingerprint: print, variant: variantOf(app, env).values, buildMs: Date.now() - startedAt }, null, 2)}\n`);
    rmSync(outDir, { recursive: true, force: true });
    renameSync(tempDir, outDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`[test-build] Built ${app} (${path.basename(outDir)}) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  return outDir;
}

/**
 * Serves the app's test bundle with `vite preview` (HTTPS from the IWSDK
 * plugin's certificate, the /api proxy from the app's Vite config), building
 * it first when needed; HOLOIM_VITE_DEV=1 serves the dev server instead.
 */
export function serveTestBuild(app, viteArgs, env = process.env) {
  const { dir } = appConfig(app);
  const cwd = path.join(repoRoot, dir);
  const args = env.HOLOIM_VITE_DEV === '1'
    ? ['exec', 'vite', ...viteArgs]
    : ['exec', 'vite', 'preview', '--outDir', ensureTestBuild(app, env), ...viteArgs];
  return spawn('pnpm', args, { cwd, env, stdio: 'inherit' });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, app, separator, ...rest] = process.argv.slice(2);
  const viteArgs = separator === '--' ? rest : [separator, ...rest].filter(Boolean);
  try {
    if (command === 'build') {
      ensureTestBuild(app);
    } else if (command === 'serve') {
      const child = serveTestBuild(app, viteArgs);
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
      child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    } else {
      throw new Error('Usage: test-build.mjs <build|serve> <web|capture> [-- <vite args>]');
    }
  } catch (error) {
    console.error(`[test-build] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
