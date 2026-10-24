import noTokenColourLiteral from './rules/no-token-colour-literal.mjs';

// Re-export ESLint ecosystem deps so consumers don't need direct dependencies.
// Usage: import { tseslint, jsConfig, globals } from '@holoim/config-eslint/base';
export { default as tseslint } from 'typescript-eslint';
export { default as jsConfig } from '@eslint/js';
export { default as globals } from 'globals';

// Workspace rules: a design-token colour copied by hand drifts from
// docs/product/design/tokens.json, so code reads it from @holoim/design-tokens.
export const holoimPlugin = {
  meta: { name: '@holoim/eslint-plugin' },
  rules: { 'no-token-colour-literal': noTokenColourLiteral }
};

export const workspaceDefaultIgnores = [
  "**/dist/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/.turbo/**",
  "**/*.d.ts"
];

export const workspaceDefaultRules = {
  "@typescript-eslint/consistent-type-imports": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_"
    }
  ],
  "@typescript-eslint/require-await": "off"
};

export function createWorkspaceTsEslintConfig({
  tseslint,
  jsConfig,
  ignores = [],
  files = ["**/*.{ts,tsx,js,mjs,cjs,mts,cts}"],
  globals = {},
  rules = {}
} = {}) {
  if (!tseslint || !jsConfig) {
    throw new Error("createWorkspaceTsEslintConfig requires both tseslint and jsConfig.");
  }

  return tseslint.config(
    { ignores: [...workspaceDefaultIgnores, ...ignores] },
    jsConfig,
    ...tseslint.configs.recommended,
    {
      files,
      languageOptions: {
        globals
      },
      plugins: {
        holoim: holoimPlugin
      },
      rules: {
        ...workspaceDefaultRules,
        "holoim/no-token-colour-literal": "error",
        ...rules
      }
    }
  );
}
