import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import noTokenColourLiteral from './rules/no-token-colour-literal.mjs';
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

function lint(code, filename) {
  const linter = new Linter({ configType: 'flat', cwd: '/repo' });
  return linter.verify(code, [{
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { holoim: { rules: { 'no-token-colour-literal': noTokenColourLiteral } } },
    rules: { 'holoim/no-token-colour-literal': 'error' }
  }], { filename });
}

test('the ESLint rule reports strings, templates and hex numbers outside the token package', () => {
  const code = "const a = '#ffc872'; const b = `rgba(8, 26, 30, ${0.72})`; const c = 0xffc872; const d = '#123456';";
  const messages = lint(code, '/repo/apps/capture/src/ui.ts');
  assert.equal(messages.length, 3, JSON.stringify(messages));
  assert.match(messages[0].message, /color\.gold/);
  assert.equal(lint(code, '/repo/packages/design-tokens/src/three.ts').length, 0);
});
