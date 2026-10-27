// Set by vite.config.ts: true in the dev server and in the e2e test build
// (HOLOIM_TEST_BUILD=1), false in the production build, which drops every
// branch it guards. Test hooks and dev diagnostics gate on this, never on
// import.meta.env.DEV, so browser checks can run against a built bundle.
declare const __HOLOIM_TEST_HOOKS__: boolean | undefined;

export const testHooks: boolean = typeof __HOLOIM_TEST_HOOKS__ === "boolean" ? __HOLOIM_TEST_HOOKS__ : import.meta.env.DEV;

/**
 * Modules page-side e2e code needs the app's own instances of: three (so
 * vectors and render targets match the scene's) and the hologram fit code.
 * The dev server served them at module URLs; a built bundle has none.
 */
export function installTestModules(): void {
  if (!testHooks) return;
  (window as Window & { __HOLOIM_TEST_MODULES__?: Promise<unknown> }).__HOLOIM_TEST_MODULES__ = Promise.all([
    import("three"),
    import("./features/hologram/drawnPoints")
  ]).then(([three, drawnPoints]) => ({ three, drawnPoints }));
}
