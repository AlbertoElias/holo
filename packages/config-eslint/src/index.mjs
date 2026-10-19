import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { createWorkspaceTsEslintConfig } from './base.mjs';

const baseConfig = createWorkspaceTsEslintConfig({
  tseslint,
  jsConfig: js.configs.recommended,
  ignores: ['apps/viewer-api/uploads/**'],
  files: ['**/*.{ts,tsx}'],
  globals: {
    ...globals.node,
    ...globals.browser
  }
});

const config = [
  ...baseConfig,
  {
    files: ['apps/viewer-web/**/*.{ts,tsx}', 'apps/knowledge/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  }
];

export default config;
