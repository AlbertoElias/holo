// Set by vite.config.ts: true in the dev server and in the e2e test build
// (HOLOIM_TEST_BUILD=1), false in the production build. Development-only
// features the browser checks rely on gate on this, not import.meta.env.DEV.
// (Capture's automation hooks are installed in every build, by design.)
declare const __HOLOIM_TEST_HOOKS__: boolean | undefined;

export const testHooks: boolean = typeof __HOLOIM_TEST_HOOKS__ === 'boolean' ? __HOLOIM_TEST_HOOKS__ : import.meta.env.DEV;
