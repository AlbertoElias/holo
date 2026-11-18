import {
  createWorkspaceTsEslintConfig,
  globals,
  jsConfig,
  tseslint
} from "@holoim/config-eslint/base";

export default createWorkspaceTsEslintConfig({
  tseslint,
  jsConfig: jsConfig.configs.recommended,
  files: ["src/**/*.{mjs,ts}"],
  globals: {
    ...globals.browser,
    ...globals.node
  }
});
