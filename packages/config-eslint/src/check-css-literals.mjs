#!/usr/bin/env node
// The CSS half of the token-colour literal check (the ESLint rule
// holoim/no-token-colour-literal covers code). Usage, from an app's lint:
//   node ../../packages/config-eslint/src/check-css-literals.mjs src
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { findTokenColours, loadTokenColours } from './token-literals.mjs';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('Usage: check-css-literals.mjs <dir-or-file>...');
  process.exit(2);
}

function* cssFiles(entry) {
  if (statSync(entry).isFile()) {
    if (entry.endsWith('.css')) yield entry;
    return;
  }
  for (const name of readdirSync(entry)) {
    if (name === 'node_modules' || name === 'dist') continue;
    yield* cssFiles(path.join(entry, name));
  }
}

const colours = loadTokenColours();
let failures = 0;
for (const root of roots) {
  for (const file of cssFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const hit of findTokenColours(text, colours)) {
      const line = text.slice(0, hit.index).split('\n').length;
      console.error(`${file}:${line}: ${hit.text} copies the design token ${hit.token}; use var(${cssVariable(hit.token)}) from @holoim/design-tokens/tokens.css.`);
      failures += 1;
    }
  }
}

function cssVariable(token) {
  return `--holoim-${token.split('.').map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()).join('-')}`;
}

if (failures > 0) process.exit(1);
