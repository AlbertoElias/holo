import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

// KTX2 (Basis Universal) encoding for hologram textures (hologram-budgets
// Q4 C), through KTX-Software's `toktx` 4.4.2: the encoder the repo already
// installs for CI (.github/actions/setup) and that the API image installs
// (apps/viewer-api/Dockerfile). Color textures use ETC1S (small, fine for
// albedo and emission); normal maps use UASTC with zstd supercompression,
// which keeps their directions. Both carry a full mip chain.

export const KTX2_MIME = "image/ktx2";

export type TextureRole = "color" | "normal" | "data";

export type ImageSize = { width: number; height: number };

/** Width and height from a PNG or JPEG header, or null when the bytes are neither. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        at += marker === 0xff ? 1 : 2;
        continue;
      }
      const length = view.getUint16(at + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
      at += 2 + length;
    }
  }
  return null;
}

/** The size an image is served at: its longest side at most `maxSide`, aspect kept. */
export function fitWithin(size: ImageSize, maxSide: number): ImageSize {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxSide) return size;
  const scale = maxSide / longest;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

export function toktxPath(): string {
  return process.env.TOKTX_PATH?.trim() || "toktx";
}

function toktxThreads(): number {
  const configured = Number(process.env.TOKTX_THREADS);
  return Number.isInteger(configured) && configured > 0 ? configured : Math.max(1, availableParallelism());
}

/** Encodes `inputPath` (PNG or JPEG) to a KTX2 file at `outputPath`. */
export async function encodeKtx2(
  inputPath: string,
  outputPath: string,
  options: { role: TextureRole; resize?: ImageSize; timeoutMs?: number }
): Promise<void> {
  const args = ["--t2", "--genmipmap", "--threads", String(toktxThreads())];
  if (options.role === "normal") {
    args.push("--encode", "uastc", "--uastc_quality", "2", "--zcmp", "18", "--assign_oetf", "linear");
  } else {
    args.push("--encode", "etc1s", "--assign_oetf", options.role === "color" ? "srgb" : "linear");
  }
  if (options.resize) args.push("--resize", `${options.resize.width}x${options.resize.height}`);
  args.push(outputPath, inputPath);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(toktxPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 10 * 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`toktx could not start (${toktxPath()}): ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`toktx failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`));
    });
  });
}
