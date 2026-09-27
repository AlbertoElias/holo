import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCommand } from './dev-server.mjs';

// Process-runner failure modes covered here:
// - a successful command resolves;
// - a non-zero exit is observable to the caller;
// - a direct child that exits after spawning a long-lived descendant cannot leak it.

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

test('runCommand resolves after a successful command', async () => {
  await runCommand(process.execPath, ['--input-type=module', '--eval', 'process.exit(0)']);
});

test('runCommand rejects with the non-zero exit code', async () => {
  await assert.rejects(
    runCommand(process.execPath, ['--input-type=module', '--eval', 'process.exit(7)']),
    /exited with code 7/
  );
});

test('runCommand times out and terminates a hung command', async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ['--input-type=module', '--eval', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 50 }
    ),
    /timed out after 50ms/
  );
});

test(
  'runCommand terminates descendants left behind by a successful direct child',
  { skip: process.platform === 'win32' && 'POSIX process-group behavior' },
  async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), 'holoim-process-cleanup-'));
    const pidFile = path.join(fixtureDir, 'descendant.pid');
    const fixture = `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const descendant = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        'setInterval(() => {}, 1000)'
      ], { stdio: 'ignore' });
      descendant.unref();
      writeFileSync(process.argv[1], String(descendant.pid));
    `;

    try {
      await runCommand(process.execPath, ['--input-type=module', '--eval', fixture, pidFile]);
      const descendantPid = Number(await readFile(pidFile, 'utf8'));
      assert.equal(isRunning(descendantPid), false, `descendant ${descendantPid} was left running`);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }
);
