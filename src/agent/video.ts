/**
 * Assemble the per-step screenshots the agent captured into an
 * "agent-exploration" video with ffmpeg. This is the "watch the agent test it"
 * video; the deterministic *replay* video still comes from the engine's
 * Playwright video:"on" run.
 *
 * Why screenshots and not a live-capture: the installed E2B SDK exposes a live
 * VNC stream + screenshot(), but no "save recording to file". A slideshow is an
 * honest representation of what the agent saw at each step. If ffmpeg is absent,
 * we skip the video and the screenshots remain as evidence.
 */
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnCollect } from "../proof/spawn";

export interface VideoOptions {
  /** Map of label -> png, as collected by the loop. */
  screenshots: Map<string, Buffer>;
  /** Output .mp4 path. */
  output: string;
  /** Seconds each screenshot is shown. */
  secondsPerFrame?: number;
  /** Frame size (WxH). Defaults to 1280x720. */
  size?: string;
  /** A sink for non-fatal progress notes. */
  log?: (message: string) => void;
}

const DEFAULT_SECONDS_PER_FRAME = 2;
const DEFAULT_SIZE = "1280x720";

export async function buildAgentVideo(options: VideoOptions): Promise<{ ok: boolean; reason?: string }> {
  const log = options.log ?? (() => {});
  if (options.screenshots.size === 0) return { ok: false, reason: "no screenshots captured" };
  if (!await hasBinary("ffmpeg")) {
    log("ffmpeg not found; skipping agent-exploration video (screenshots remain as evidence).");
    return { ok: false, reason: "ffmpeg not found" };
  }

  const framesDir = `${options.output}.frames`;
  await mkdir(framesDir, { recursive: true });
  const entries = [...options.screenshots.entries()].sort(([a], [b]) => a.localeCompare(b));
  let index = 0;
  for (const [, png] of entries) {
    const file = join(framesDir, `frame_${String(index).padStart(4, "0")}.png`);
    await writeFile(file, png);
    index += 1;
  }

  const fps = 1 / (options.secondsPerFrame ?? DEFAULT_SECONDS_PER_FRAME);
  const size = options.size ?? DEFAULT_SIZE;
  // -framerate on the input + scale/pad to a fixed size so frames of varying
  // dimensions concat cleanly. yuv420p + faststart for browser-playable mp4.
  const args = [
    "-y",
    "-framerate", String(fps),
    "-i", join(framesDir, "frame_%04d.png"),
    "-vf", `scale=${size.split("x")[0]}:${size.split("x")[1]}:force_original_aspect_ratio=decrease,pad=${size.split("x")[0]}:${size.split("x")[1]}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    options.output,
  ];

  const result = await spawnCollect("ffmpeg", args);
  await rm(framesDir, { recursive: true, force: true });
  if (result.exitCode !== 0) {
    log(`ffmpeg failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
    return { ok: false, reason: `ffmpeg exit ${result.exitCode}` };
  }
  return { ok: true };
}

/** Verify a binary is on PATH. A missing binary resolves to exit 1 (not a throw). */
export async function hasBinary(name: string): Promise<boolean> {
  const result = await spawnCollect(name, ["-version"]);
  return result.exitCode === 0;
}
