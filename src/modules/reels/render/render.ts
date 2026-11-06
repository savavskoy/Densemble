import { constants } from "node:fs";
import { link, mkdir, open, rm, statfs, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { MediaError, type ProcessControl, type ProcessRunner } from "../../core-api.js";
import type { ReelCut } from "./cuts.js";
import { ReelsRenderError } from "./errors.js";
import { FRAME, overlaySvg, overlayTimeline, subtitleCards } from "./layout.js";
import type { ReelWord } from "./words.js";

/** Densemble's outgoing file cap (Telegram's bot upload limit); renders aim below it with room for the container. */
export const MAX_REEL_BYTES = 50_000_000;
const TARGET_BYTES = 45 * 1000 * 1000;
const AUDIO_BITS = 128_000;
const MAX_VIDEO_BITS = 8_000_000;
const PROGRESS = /^out_time_us=(\d+)$/;

export interface RenderRequest {
  source: string;
  /** Already validated and snapped to words. */
  cut: ReelCut;
  /** Words of the whole source (absolute times), tagged with their phrase and speaker. */
  words: readonly ReelWord[];
  /** Final file, created exclusively (never overwritten). */
  target: string;
  /** Private scratch directory owned by the caller; emptied by it. */
  workDir: string;
  ffmpegPath: string;
  runner: ProcessRunner;
  signal: AbortSignal;
  onSpawn?: (control: ProcessControl) => void;
  onProgress?: (percent: number) => void;
}

/** Video bitrate that keeps the reel under `TARGET_BYTES`, at most 8 Mbit/s. */
export function videoBitrate(durationSeconds: number): number {
  const total = TARGET_BYTES * 8 / Math.max(1, durationSeconds);
  return Math.max(500_000, Math.min(MAX_VIDEO_BITS, Math.floor(total - AUDIO_BITS - 64_000)));
}

/** Writes the overlay PNGs (one per distinct state) and the concat-demuxer list; undefined without overlays. */
async function writeOverlays(request: RenderRequest, duration: number): Promise<string | undefined> {
  const { cut } = request;
  const subtitles = cut.subtitles !== false;
  const title = cut.showTitle !== false;
  if (!subtitles && !title) return undefined;
  const cards = subtitles ? subtitleCards(request.words, cut.start, cut.end) : [];
  const states = overlayTimeline(cards, duration, title);
  const images = new Map<string, string>();
  const lines = ["ffconcat version 1.0"];
  for (const state of states) {
    request.signal.throwIfAborted();
    const key = `${state.title ? 1 : 0}:${state.card ?? "-"}:${state.word ?? "-"}`;
    let name = images.get(key);
    if (!name) {
      name = `o${images.size}.png`;
      images.set(key, name);
      try {
        await sharp(Buffer.from(overlaySvg(state, cards, cut.title))).png({ compressionLevel: 1 }).toFile(join(request.workDir, name));
      } catch { throw new ReelsRenderError("REELS_OVERLAY_FAILED"); }
    }
    lines.push(`file '${name}'`, `duration ${(state.end - state.start).toFixed(3)}`);
  }
  // The concat demuxer needs the last file once more for its duration to count.
  lines.push(lines.at(-2)!);
  const list = join(request.workDir, "overlays.ffconcat");
  await writeFile(list, `${lines.join("\n")}\n`, { mode: 0o600 });
  return list;
}

/**
 * Cuts one reel (FR-011): centre crop to 1080×1920, karaoke subtitles and the title burned in from PNG overlays
 * (this FFmpeg has no libass/drawtext), H.264 + AAC under 50 MB. The file appears complete at `target` or not at
 * all; an existing target is never replaced. The source is only read (FR-014).
 */
export async function renderReel(request: RenderRequest): Promise<{ path: string; bytes: number; durationSeconds: number }> {
  const { cut, runner, signal } = request;
  const duration = cut.end - cut.start;
  if (!Number.isFinite(duration) || duration <= 0) throw new ReelsRenderError("REELS_CUT_INVALID");
  if (await freeBytes(request.workDir) < MAX_REEL_BYTES * 2) throw new ReelsRenderError("REELS_DISK_FULL");
  const temp = join(dirname(request.target), `.densemble-${randomUUID()}.partial.mp4`);
  try {
    const overlays = await writeOverlays(request, duration);
    const bitrate = videoBitrate(duration);
    const crop = `scale=${FRAME.width}:${FRAME.height}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${FRAME.width}:${FRAME.height},setsar=1,fps=${FRAME.fps}`;
    const filter = overlays
      ? `[0:v]${crop}[v];[1:v]format=rgba[o];[v][o]overlay=0:0:eof_action=repeat,format=yuv420p[out]`
      : `[0:v]${crop},format=yuv420p[out]`;
    const args = ["-nostdin", "-hide_banner", "-v", "error", "-nostats", "-progress", "pipe:2",
      "-ss", cut.start.toFixed(3), "-t", duration.toFixed(3), "-protocol_whitelist", "file", "-i", request.source,
      ...overlays ? ["-f", "concat", "-protocol_whitelist", "file", "-i", overlays] : [],
      "-filter_complex", filter, "-map", "[out]", "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-maxrate", String(bitrate), "-bufsize", String(bitrate * 2),
      "-profile:v", "high", "-c:a", "aac", "-b:a", String(AUDIO_BITS), "-ar", "48000", "-ac", "2",
      "-t", duration.toFixed(3), "-movflags", "+faststart", "-f", "mp4", "-n", temp];
    try {
      await runner(request.ffmpegPath, args, {
        signal, timeoutMs: Math.max(10 * 60_000, duration * 10_000), discardStdout: true, cwd: request.workDir,
        onStderrLine: (line) => {
          const match = PROGRESS.exec(line.trim());
          if (match) request.onProgress?.(Math.min(99, Math.floor(Number(match[1]) / 1e6 / duration * 100)));
        },
        ...(request.onSpawn ? { onSpawn: request.onSpawn } : {}),
      });
    } catch (error) {
      if (error instanceof MediaError && error.code === "MEDIA_ABORTED") throw new ReelsRenderError("REELS_ABORTED");
      if (error instanceof MediaError && error.code === "MEDIA_TIMEOUT") throw new ReelsRenderError("REELS_TIMEOUT");
      if (error instanceof MediaError && error.code === "MEDIA_AUDIO_TOOLS_MISSING") throw new ReelsRenderError("REELS_TOOLS_MISSING");
      if (await freeBytes(request.workDir) < MAX_REEL_BYTES) throw new ReelsRenderError("REELS_DISK_FULL");
      throw new ReelsRenderError("REELS_RENDER_FAILED");
    }
    const bytes = await syncedSize(temp);
    if (bytes <= 0 || bytes > MAX_REEL_BYTES) throw new ReelsRenderError("REELS_OUTPUT_INVALID");
    try { await link(temp, request.target); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new ReelsRenderError(code === "EEXIST" ? "REELS_TARGET_EXISTS" : code === "ENOSPC" ? "REELS_DISK_FULL" : "REELS_OUTPUT_INVALID");
    }
    request.onProgress?.(100);
    return { path: request.target, bytes, durationSeconds: duration };
  } catch (error) {
    if (error instanceof ReelsRenderError) throw error;
    if ((error as { name?: string }).name === "AbortError" || signal.aborted) throw new ReelsRenderError("REELS_ABORTED");
    throw new ReelsRenderError((error as NodeJS.ErrnoException).code === "ENOSPC" ? "REELS_DISK_FULL" : "REELS_RENDER_FAILED");
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function syncedSize(path: string): Promise<number> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
      return (await handle.stat()).size;
    } finally { await handle.close(); }
  } catch { return -1; }
}

async function freeBytes(path: string): Promise<number> {
  try { const stats = await statfs(path); return stats.bavail * stats.bsize; }
  catch { return Number.POSITIVE_INFINITY; }
}

/** A fresh private scratch directory under `root`, removed by `cleanup`. */
export async function scratchDirectory(root: string): Promise<{ path: string; cleanup(): Promise<void> }> {
  const path = join(root, randomUUID());
  await mkdir(path, { recursive: true, mode: 0o700 });
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
