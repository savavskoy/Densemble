import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { checkedPath, isWithin, MediaError, ModuleError, type ProcessControl, type ProcessRunner } from "../core-api.js";
import type { ReelsSettings } from "./settings.js";

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
  "www.youtube-nocookie.com"]);
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
const UNAVAILABLE = /private video|video unavailable|has been removed|no longer available|not available|members-only|sign in to confirm|account .*terminated|copyright|this live event/i;
const DOWNLOAD_PROGRESS = /^\[download\]\s+(\d+(?:\.\d+)?)%/;

export type VideoSource =
  | { kind: "youtube"; youtubeId: string; url: string }
  | { kind: "file"; path: string; relativePath: string; size: number; mtimeMs: number };

/** The 11-character id of a YouTube watch/short/live/embed link or youtu.be link; undefined otherwise. */
export function youtubeId(link: string): string | undefined {
  let url: URL;
  try { url = new URL(link.trim()); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  const candidate = url.hostname.toLowerCase() === "youtu.be" ? parts[0]
    : parts[0] === "watch" ? url.searchParams.get("v") ?? undefined
      : ["shorts", "live", "embed"].includes(parts[0] ?? "") ? parts[1] : undefined;
  return candidate && YOUTUBE_ID.test(candidate) ? candidate : undefined;
}

/** A video file inside the workspace (no symlinks, a video extension); `REELS_SOURCE_INVALID` otherwise. */
export async function workspaceVideo(path: string, workspace: string): Promise<Extract<VideoSource, { kind: "file" }>> {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  if (!isWithin(workspace, absolute) || !VIDEO_EXTENSIONS.has(extname(absolute).toLowerCase())) throw new ModuleError("REELS_SOURCE_INVALID");
  try {
    checkedPath(absolute, "file");
    const stats = await lstat(absolute);
    if (!stats.isFile()) throw new Error("not a file");
    return { kind: "file", path: absolute, relativePath: relative(workspace, absolute), size: stats.size, mtimeMs: stats.mtimeMs };
  } catch { throw new ModuleError("REELS_SOURCE_INVALID"); }
}

/** `yt-<id>` for links, `file-<hash of path, size, mtime>` for workspace files (plan D7). */
export function videoId(source: VideoSource): string {
  if (source.kind === "youtube") return `yt-${source.youtubeId}`;
  const hash = createHash("sha256").update(`${source.relativePath}\0${source.size}\0${source.mtimeMs}`).digest("hex");
  return `file-${hash.slice(0, 12)}`;
}

function failure(error: unknown, stderr: readonly string[], fallback: string): ModuleError {
  if (error instanceof MediaError && error.code === "MEDIA_ABORTED") return new ModuleError("REELS_ABORTED");
  if (error instanceof MediaError && error.code === "MEDIA_TIMEOUT") return new ModuleError("REELS_TIMEOUT");
  if (error instanceof MediaError && error.code === "MEDIA_AUDIO_TOOLS_MISSING") return new ModuleError("REELS_YTDLP_MISSING");
  if (stderr.some((line) => UNAVAILABLE.test(line))) return new ModuleError("REELS_VIDEO_UNAVAILABLE");
  return new ModuleError(fallback);
}

const keepTail = (lines: string[], line: string) => { lines.push(line); if (lines.length > 40) lines.shift(); };
const BASE_ARGS = ["--ignore-config", "--no-playlist", "--no-warnings", "--no-color"];

export interface FetchOptions {
  runner: ProcessRunner;
  signal: AbortSignal;
  onSpawn?: (control: ProcessControl) => void;
}

/** Title and duration before downloading, so a too-long or live video is rejected up front. */
export async function youtubeInfo(id: string, settings: ReelsSettings, options: FetchOptions): Promise<{ title: string; durationSeconds?: number; live: boolean }> {
  const stderr: string[] = [];
  let stdout: string;
  try {
    ({ stdout } = await options.runner(settings.ytDlpPath, [...BASE_ARGS, "--skip-download", "--dump-single-json",
      `https://www.youtube.com/watch?v=${id}`], { signal: options.signal, timeoutMs: 120_000, maxOutputBytes: 32_000_000,
      onStderrLine: (line) => keepTail(stderr, line), ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}) }));
  } catch (error) { throw failure(error, stderr, "REELS_FETCH_FAILED"); }
  try {
    const info = JSON.parse(stdout) as { title?: unknown; duration?: unknown; is_live?: unknown; live_status?: unknown };
    const live = info.is_live === true || info.live_status === "is_live" || info.live_status === "is_upcoming";
    const title = typeof info.title === "string" && info.title.trim() ? info.title.trim().slice(0, 300) : id;
    return { title, live, ...(typeof info.duration === "number" && Number.isFinite(info.duration) ? { durationSeconds: info.duration } : {}) };
  } catch { throw new ModuleError("REELS_FETCH_FAILED"); }
}

/**
 * Downloads into `directory` as `source.<ext>` (H.264 preferred, at most `maxHeight`, merged to MP4 by FFmpeg).
 * The only network access of the module (FR-019). Returns the downloaded file.
 */
export async function youtubeDownload(id: string, directory: string, settings: ReelsSettings,
  options: FetchOptions & { onProgress?: (percent: number) => void }): Promise<string> {
  const h = settings.maxHeight;
  const stderr: string[] = [];
  let pass = 0;
  let last = 0;
  const report = (line: string) => {
    const match = DOWNLOAD_PROGRESS.exec(line.trim());
    if (!match) return keepTail(stderr, line);
    const percent = Number(match[1]);
    if (percent + 5 < last) pass++;
    last = percent;
    // Video first (most of the bytes), then audio.
    options.onProgress?.(Math.min(99, Math.floor(pass === 0 ? percent * 0.9 : 90 + percent * 0.1)));
  };
  try {
    // yt-dlp prints progress on stdout; the runner streams stderr lines, so stdout is sent there.
    await options.runner("/bin/sh", ["-c", 'exec "$0" "$@" 1>&2', settings.ytDlpPath, ...BASE_ARGS, "--newline", "--progress", "--no-mtime", "--no-part",
      "-f", `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      "--merge-output-format", "mp4", "--ffmpeg-location", settings.ffmpegPath, "-P", directory, "-o", "source.%(ext)s",
      `https://www.youtube.com/watch?v=${id}`], {
      signal: options.signal, timeoutMs: 3 * 60 * 60_000, discardStdout: true, cwd: directory,
      onStderrLine: report, ...(options.onSpawn ? { onSpawn: options.onSpawn } : {}),
    });
  } catch (error) { throw failure(error, stderr, "REELS_FETCH_FAILED"); }
  const names = (await readdir(directory)).filter((name) => /^source\.[a-z0-9]+$/.test(name) && VIDEO_EXTENSIONS.has(extname(name)));
  if (names.length !== 1) throw new ModuleError("REELS_FETCH_FAILED");
  return join(directory, names[0]!);
}

/** Container duration in seconds (ffprobe); `REELS_SOURCE_INVALID` when it has none or no video stream. */
export async function probeVideo(path: string, settings: ReelsSettings, options: FetchOptions): Promise<number> {
  try {
    const { stdout } = await options.runner(settings.ffprobePath, ["-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
      "-show_entries", "stream=codec_type:format=duration", "-of", "json", "-i", path],
    { signal: options.signal, timeoutMs: 30_000, maxOutputBytes: 64_000 });
    const info = JSON.parse(stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
    const duration = Number(info.format?.duration);
    if (!info.streams?.some((stream) => stream.codec_type === "video") || !Number.isFinite(duration) || duration <= 0) throw new Error("no video");
    return duration;
  } catch (error) {
    if (error instanceof MediaError && error.code === "MEDIA_ABORTED") throw new ModuleError("REELS_ABORTED");
    throw new ModuleError("REELS_SOURCE_INVALID");
  }
}
