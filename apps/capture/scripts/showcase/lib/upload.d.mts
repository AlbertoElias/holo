export interface Credential { token: string; source: string }
export interface QuickLookLoad { deformed: number; rigid: number; frames: number }
export interface LoadChannel { node: number; path: string; times: ArrayLike<number>; interpolation: string }
export interface HologramDto { id: string; url: string; sizeBytes: number; hologramName: string; usdzStatus: string; usdzUrl?: string | null }
export const QUICK_LOOK_BUDGET: { deformed: number; rigid: number };
export function isLoopback(apiUrl: URL): boolean;
export function findCredential(apiUrl: URL, envNames?: string[]): Credential | null;
export function setupHint(apiUrl: URL): string;
export function insecureTarget(apiUrl: URL, credential: Credential | null): string | null;
export function checkAccount(apiUrl: URL, credential: Credential): Promise<{ account: { displayName: string }; error?: undefined } | { error: string; account?: undefined }>;
export function waitForPreview(api: string | URL, id: string): Promise<HologramDto>;
export function uploadHologram(args: { api: string | URL; authHeaders: Record<string, string>; name: string; submittedBy: string; bytes: Uint8Array; filename: string; quickLook: boolean }): Promise<{ dto: HologramDto; error?: undefined } | { error: string; dto?: undefined }>;
export function quickLookLoad(json: unknown, channels: readonly LoadChannel[]): QuickLookLoad;
