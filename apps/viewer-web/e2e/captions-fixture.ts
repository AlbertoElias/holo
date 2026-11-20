// A GLB with a `HOLOIM_captions` root extension added to its JSON chunk
// (docs/features/sound-voice-captions.md, slice 3), as `direct` writes it:
// listed in `extensionsUsed`, never required; the binary chunk is untouched.

export type FixtureCue = { from: number; to: number; text: string; kind: string; speaker?: string };

export function withCaptions(glb: Buffer, cues: readonly FixtureCue[], language = "en-US"): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as { extensions?: Record<string, unknown>; extensionsUsed?: string[] };
  json.extensions = { ...json.extensions, HOLOIM_captions: { version: 1, tracks: [{ language, cues }] } };
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "HOLOIM_captions"])];
  let text = JSON.stringify(json);
  text += " ".repeat((4 - (Buffer.byteLength(text) % 4)) % 4);
  const jsonBytes = Buffer.from(text, "utf8");
  const rest = glb.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBytes.length + rest.length, 8);
  header.writeUInt32LE(jsonBytes.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, jsonBytes, rest]);
}
