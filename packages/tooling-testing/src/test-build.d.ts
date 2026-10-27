export const TEST_BUILD_APPS: Record<"web" | "capture", { dir: string; pkg: string; variantEnv: string[] }>;
/** Where the app's test bundle for this environment lives. */
export function testBuildDir(app: "web" | "capture", env?: NodeJS.ProcessEnv): string;
/** Builds the app's test bundle unless the stored one matches its current sources; returns its directory. */
export function ensureTestBuild(app: "web" | "capture", env?: NodeJS.ProcessEnv): string;
export function serveTestBuild(app: "web" | "capture", viteArgs: string[], env?: NodeJS.ProcessEnv): import("node:child_process").ChildProcess;
