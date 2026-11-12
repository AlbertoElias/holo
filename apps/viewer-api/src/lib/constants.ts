import { MAX_HOLOGRAM_BYTES } from "@holoim/contracts";

/** The upload cap, shared with capture (hologram-budgets). */
export const MAX_GLB_BYTES = MAX_HOLOGRAM_BYTES;
export const MAX_GLB_MEGABYTES = MAX_GLB_BYTES / (1024 * 1024);
export const UPLOADS_DIR = "uploads";
export const API_PREFIX = "/api";
