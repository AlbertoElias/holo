import type { Page } from "@playwright/test";

const sessionStorageKey = "holoim.session";

export type E2eSession = {
  token: string;
  /** For `request.post(..., { headers })` calls that upload or delete. */
  headers: { authorization: string };
};

const sessions = new WeakMap<Page, Promise<E2eSession>>();

/**
 * Signs a test creator in through the API (the test API exposes the magic
 * link), keeps the session in the page's storage like the viewer does, and
 * returns it for direct API calls. Call before `page.goto`. Memoised per
 * page: later calls return the first session.
 */
export function signInForUpload(
  page: Page,
  options: { email?: string; displayName?: string } = {}
): Promise<E2eSession> {
  // One sign-in per page, however many uploads follow.
  let session = sessions.get(page);
  if (!session) {
    session = signIn(page, options);
    sessions.set(page, session);
  }
  return session;
}

async function signIn(
  page: Page,
  { email = "e2e-creator@example.com", displayName = "E2E Creator" }: { email?: string; displayName?: string }
): Promise<E2eSession> {
  const link = await page.request.post("/api/auth/magic-link", { data: { email, displayName } });
  const { devMagicLinkToken } = (await link.json()) as { devMagicLinkToken?: string };
  if (!link.ok() || !devMagicLinkToken) {
    throw new Error(`Test API did not expose a sign-in link (AUTH_DEV_EXPOSE_MAGIC_LINK): ${link.status()}`);
  }
  const verify = await page.request.post("/api/auth/verify", { data: { token: devMagicLinkToken } });
  if (!verify.ok()) {
    throw new Error(`Test sign-in failed: ${verify.status()}`);
  }
  const { token } = (await verify.json()) as { token: string };
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [sessionStorageKey, token]
  );
  return { token, headers: { authorization: `Bearer ${token}` } };
}

/**
 * For specs that mock the whole API: seeds a session token and answers
 * `/api/auth/me` with a creator, so the Upload sheet shows its form rather
 * than sign-in. Call before `page.goto`.
 */
export async function stubSignedInCreator(
  page: Page,
  { email = "e2e-creator@example.com", displayName = "E2E Creator" }: { email?: string; displayName?: string } = {}
): Promise<void> {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [sessionStorageKey, "stubbed-session-token"]
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: { id: "e2e-creator", email, displayName, createdAt: "2026-01-01T00:00:00.000Z" }
    })
  );
}
