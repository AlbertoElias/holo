import type { SessionResponse, UserDTO } from "@holoim/contracts";
import { postGrantResponseSchema, sessionResponseSchema, userDtoSchema } from "@holoim/contracts";

const apiOrigin = import.meta.env.VITE_API_ORIGIN ?? "";
const apiBase = `${apiOrigin}/api`;

export const sessionStorageKey = "holoim.session";

export function getSessionToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(sessionStorageKey);
}

export function setSessionToken(token: string): void {
  window.localStorage.setItem(sessionStorageKey, token);
}

export function clearSessionToken(): void {
  window.localStorage.removeItem(sessionStorageKey);
}

export function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export async function requestMagicLink(input: {
  email: string;
  displayName?: string;
  /** Where the emailed link goes after signing in: "record" opens capture. */
  next?: "record";
}): Promise<{ devMagicLinkToken?: string }> {
  const response = await fetch(`${apiBase}/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Could not send the sign-in link."));
  }
  const body = (await response.json()) as { devMagicLinkToken?: string };
  return body.devMagicLinkToken ? { devMagicLinkToken: body.devMagicLinkToken } : {};
}

export async function verifyMagicLink(token: string): Promise<SessionResponse> {
  const response = await fetch(`${apiBase}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token })
  });
  if (!response.ok) {
    throw new Error(await readError(response, "This sign-in link is invalid or expired."));
  }
  const session = sessionResponseSchema.parse(await response.json());
  setSessionToken(session.token);
  return session;
}

export async function fetchCurrentUser(): Promise<UserDTO | null> {
  if (!getSessionToken()) {
    return null;
  }
  const response = await fetch(`${apiBase}/auth/me`, { headers: authHeaders() });
  if (response.status === 401) {
    clearSessionToken();
    return null;
  }
  if (!response.ok) {
    return null;
  }
  return userDtoSchema.parse(await response.json());
}

export async function signOut(): Promise<void> {
  try {
    await fetch(`${apiBase}/auth/logout`, { method: "POST", headers: authHeaders() });
  } catch {
    // Local sign-out still applies when the API is unreachable.
  }
  clearSessionToken();
}

/**
 * Mints a single-use post grant (docs/features/phone-capture.md): capture
 * posts one take with it as this creator. The session token never leaves
 * this origin; only the grant travels, in a URL fragment.
 */
export async function mintPostGrant(): Promise<string> {
  const response = await fetch(`${apiBase}/auth/post-grant`, { method: "POST", headers: authHeaders() });
  if (!response.ok) {
    throw new Error(await readError(response, "Could not open the recorder."));
  }
  return postGrantResponseSchema.parse(await response.json()).grant;
}
