import {
  createWorkspaceTsEslintConfig,
  globals,
  jsConfig,
  tseslint
} from "@holoim/config-eslint/base";

export default createWorkspaceTsEslintConfig({
  tseslint,
  jsConfig: jsConfig.configs.recommended,
  files: ["src/**/*.ts", "scripts/**/*.ts"],
  globals: {
    ...globals.browser,
    ...globals.node
  }
});
