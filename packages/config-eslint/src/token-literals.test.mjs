import assert from 'node:assert/strict';
import { test } from 'node:test';

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findTokenColours, loadTokenColours, tokenForHexNumber } from './token-literals.mjs';

const colours = loadTokenColours();

test('finds every spelling of a token colour', () => {
  for (const text of ["'#ffc872'", '#FFC872', '#ffc872cc', 'rgb(255, 200, 114)', 'rgba(8,26,30,.72)', 'rgb(8 26 30 / 50%)', 'color: #081a1e;']) {
    assert.equal(findTokenColours(text, colours).length, 1, text);
  }
  assert.equal(tokenForHexNumber('0xffc872', colours), 'color.gold');
  assert.equal(tokenForHexNumber('0xFFC872', colours), 'color.gold');
});

test('ignores colours that are not tokens and look-alikes', () => {
  for (const text of ['#ffc873', '#ffc8721', 'rgb(255, 200, 115)', '#fff', 'url(#ffc872-mask)', 'id-ffc872']) {
    assert.equal(findTokenColours(text, colours).length, 0, text);
  }
  assert.equal(tokenForHexNumber('16762994', colours), undefined);
});

// Runs the real Oxlint binary with the JS plugin, so the test also fails when
// Oxlint stops loading the plugin (JS plugins are alpha in Oxlint 1.x).
const pluginPath = join(dirname(fileURLToPath(import.meta.url)), 'oxlint-plugin.mjs');
const oxlintBin = join(dirname(createRequire(import.meta.url).resolve('oxlint/package.json')), 'bin', 'oxlint');

function lint(code, relativePath) {
  const root = mkdtempSync(join(tmpdir(), 'holoim-token-rule-'));
  try {
    writeFileSync(join(root, '.oxlintrc.json'), JSON.stringify({
      categories: { correctness: 'off' },
      jsPlugins: [pluginPath],
      rules: { 'holoim/no-token-colour-literal': 'error' }
    }));
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), code);
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [oxlintBin, '-f', 'json', relativePath], { cwd: root, encoding: 'utf8' });
    } catch (error) {
      stdout = error.stdout;
    }
    return JSON.parse(stdout).diagnostics;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the lint rule reports strings, templates and hex numbers outside the token package', () => {
  const code = "const a = '#ffc872'; const b = `rgba(8, 26, 30, ${0.72})`; const c = 0xffc872; const d = '#123456';\nexport { a, b, c, d };\n";
  const messages = lint(code, 'apps/capture/src/ui.ts');
  assert.equal(messages.length, 3, JSON.stringify(messages));
  assert.ok(messages.every((message) => message.code === 'holoim(no-token-colour-literal)'), JSON.stringify(messages));
  assert.match(messages[0].message, /color\.gold/);
  assert.equal(lint(code, 'packages/design-tokens/src/three.ts').length, 0);
});
