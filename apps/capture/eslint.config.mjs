import {
  createWorkspaceTsEslintConfig,
  tseslint,
  jsConfig,
  globals
} from '@holoim/config-eslint/base';

export default createWorkspaceTsEslintConfig({
  tseslint,
  jsConfig: jsConfig.configs.recommended,
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
