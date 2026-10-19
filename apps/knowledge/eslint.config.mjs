import config from "@holoim/config-eslint";

export default [
  ...config,
  { ignores: ["dist/**", "test-results/**", "playwright-report/**"] },
];
