import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Run after capturing both variants with the same ar-bubble.spec.ts revision.
const root = resolve("output/bubble-rendering");
const samples = resolve(root, "comparison");
function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
}
for (const [name, pattern, caption] of [
  ["head", "head-%03d-eye-0.png", "IWER headset yaw and pitch - left eye"],
  ["rotation", "frame-%03d.png", "Same relative view - rotate camera and model together"]
]) {
  ffmpeg([
    "-framerate", "6", "-i", resolve(samples, "before", pattern!),
    "-framerate", "6", "-i", resolve(samples, "after", pattern!),
    "-filter_complex", `[0:v]scale=320:480:flags=neighbor,pad=640:480:160:0:color=0x101820,drawtext=text='BEFORE':x=20:y=20:fontsize=28:fontcolor=white[l];[1:v]scale=320:480:flags=neighbor,pad=640:480:160:0:color=0x101820,drawtext=text='AFTER':x=20:y=20:fontsize=28:fontcolor=white[r];[l][r]hstack,drawtext=text='${caption}':x=20:y=h-35:fontsize=20:fontcolor=white[v]`,
    "-map", "[v]", "-frames:v", "24", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", resolve(root, `comparison-${name}.mp4`)
  ]);
}
const manifest = resolve(root, "comparison-segments.txt");
writeFileSync(manifest, "file 'comparison-head.mp4'\nfile 'comparison-rotation.mp4'\n");
ffmpeg(["-f", "concat", "-safe", "0", "-i", manifest, "-c", "copy", "-movflags", "+faststart", resolve(root, "BEFORE-AFTER.mp4")]);
console.log(resolve(root, "BEFORE-AFTER.mp4"));
