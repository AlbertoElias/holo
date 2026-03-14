import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { createWorkspaceTsEslintConfig } from '@holoim/config-eslint/base';

export default createWorkspaceTsEslintConfig({
  tseslint,
  jsConfig: js.configs.recommended,
  ignores: ['output/**', '*.glb'],
  globals: {
    ...globals.browser,
    ...globals.node
  },
  rules: {
    '@typescript-eslint/consistent-type-imports': 'off',
    'no-console': 'off'
  }
});
