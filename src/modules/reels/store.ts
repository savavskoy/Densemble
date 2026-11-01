import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { checkedPath, isWithin, ModuleError, readBounded } from "../core-api.js";
import { timecode } from "../recordings/api.js";

/**
 * One folder per video under the reels folder (plan, Storage):
 *   <folder>/<id>/video.json                prepared video
 *   <folder>/<id>/source.<ext>              downloaded video (links only; workspace files stay where they are)
 *   <folder>/<id>/transcript.txt            readable transcript, `[HH:MM:SS] Label: text`
 *   <folder>/<id>/transcript.words.json     word-timed transcript
 *   <folder>/<id>/reels/NN-<slug>.mp4       cut reels
 *   <folder>/<id>/cuts.md                   what was cut, one section per request
 */
export const VIDEO_ID = /^(?:yt-[A-Za-z0-9_-]{11}|file-[0-9a-f]{12})$/;
export const TRANSCRIPT_KEY = "transcript";

export interface VideoRecord {
  version: 1;
  id: string;
  title: string;
  durationSeconds: number;
  /** YouTube link, or the workspace file read in place (FR-014: never changed). */
  source: { kind: "youtube"; youtubeId: string; url: string } | { kind: "file"; relativePath: string; size: number; mtimeMs: number };
  /** The media to cut: `source.<ext>` in the video folder, or the workspace file. */
  media: string;
  preparedAt: string;
  speakers: "separated" | "unavailable" | "off";
}

export const videoDirectory = (folder: string, id: string) => join(folder, id);
export const transcriptPath = (folder: string, id: string) => join(folder, id, `${TRANSCRIPT_KEY}.txt`);
export const wordsPath = (folder: string, id: string) => join(folder, id, `${TRANSCRIPT_KEY}.words.json`);
export const reelsDirectory = (folder: string, id: string) => join(folder, id, "reels");

function validRecord(value: unknown, id: string): value is VideoRecord {
  const record = value as Partial<VideoRecord> | null;
  return typeof record === "object" && record !== null && record.version === 1 && record.id === id &&
    typeof record.title === "string" && typeof record.durationSeconds === "number" && record.durationSeconds > 0 &&
    typeof record.media === "string" && typeof record.preparedAt === "string" && typeof record.source === "object" && record.source !== null;
}

/** The prepared video, or undefined when missing or unreadable. */
export async function readVideo(folder: string, id: string): Promise<VideoRecord | undefined> {
  if (!VIDEO_ID.test(id)) return undefined;
  try {
    const value: unknown = JSON.parse((await readBounded(join(folder, id, "video.json"), 1_000_000)).toString("utf8"));
    return validRecord(value, id) ? value : undefined;
  } catch { return undefined; }
}

/** Atomic replace of `video.json`. */
export async function writeVideo(folder: string, record: VideoRecord): Promise<void> {
  const temp = join(folder, record.id, `.densemble-${randomUUID()}.partial`);
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, join(folder, record.id, "video.json"));
  } finally { await unlink(temp).catch(() => undefined); }
}

/** Prepared videos, newest first. */
export async function listVideos(folder: string): Promise<VideoRecord[]> {
  let names: string[];
  try { names = await readdir(folder); } catch { return []; }
  const records = await Promise.all(names.filter((name) => VIDEO_ID.test(name)).map((name) => readVideo(folder, name)));
  return records.filter((record): record is VideoRecord => record !== undefined)
    .sort((a, b) => b.preparedAt.localeCompare(a.preparedAt));
}

const REEL_FILE = /^(\d{2,})-[a-z0-9-]+\.mp4$/;

/** Reel files of a video and the next free 0-based number (numbers continue across cut requests). */
export async function existingReels(folder: string, id: string): Promise<{ files: string[]; next: number }> {
  let names: string[] = [];
  try { names = await readdir(reelsDirectory(folder, id)); } catch { /* None yet. */ }
  const files = names.filter((name) => REEL_FILE.test(name)).sort();
  const next = files.reduce((max, name) => Math.max(max, Number(REEL_FILE.exec(name)![1])), 0);
  return { files, next };
}

/**
 * Creates `path` when missing and checks it: a real directory with no symlink anywhere on the way, so a link an
 * agent planted in the workspace cannot redirect downloads, transcripts or reels (`REELS_FOLDER_UNSAFE`).
 */
/** Removes the downloaded `source.<ext>` of a video folder (checked first); transcript, reels and cuts.md stay. */
export async function removeDownloadedSource(directory: string): Promise<void> {
  await ensureDirectory(directory);
  for (const name of await readdir(directory)) {
    if (/^source\.[a-z0-9]+$/.test(name)) await unlink(join(directory, name)).catch(() => undefined);
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o755 });
    checkedPath(path, "directory");
  } catch { throw new ModuleError("REELS_FOLDER_UNSAFE"); }
}

/**
 * The media to cut, worked out from the record's id and source (never from its stored path, which lives in the
 * agent-writable workspace): the single `source.<ext>` in the checked video folder, or the workspace file.
 */
export async function sourceMedia(folder: string, video: VideoRecord, workspace: string): Promise<string> {
  if (video.source.kind === "file") {
    const path = resolve(workspace, video.source.relativePath);
    if (!isWithin(workspace, path)) throw new ModuleError("REELS_SOURCE_CHANGED");
    return path;
  }
  const directory = videoDirectory(folder, video.id);
  await ensureDirectory(directory);
  const names = (await readdir(directory)).filter((name) => /^source\.(?:mp4|webm|mkv|mov|m4v)$/.test(name));
  if (names.length !== 1) throw new ModuleError(names.length ? "REELS_VIDEO_NOT_PREPARED" : "REELS_SOURCE_MISSING");
  try { checkedPath(join(directory, names[0]!), "file"); } catch { throw new ModuleError("REELS_FOLDER_UNSAFE"); }
  return join(directory, names[0]!);
}

export interface CutEntry { file: string; start: number; end: number; title: string; subtitles: boolean; showTitle: boolean }

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** Appends one request's reels to `cuts.md` (created with a header for the video). */
export async function appendCuts(folder: string, video: VideoRecord, entries: readonly CutEntry[], at: Date): Promise<void> {
  const path = join(folder, video.id, "cuts.md");
  let header = "";
  try { await readBounded(path, 1); } catch {
    const source = video.source.kind === "youtube" ? video.source.url : video.source.relativePath;
    header = `# Reels — ${cell(video.title)}\n\nSource: ${source}\n`;
  }
  const lines = [`${header}\n## ${at.toISOString().slice(0, 16).replace("T", " ")} UTC — ${entries.length} reel(s)\n`,
    "| # | File | Start | End | Title | Subtitles | Title shown |", "|---|---|---|---|---|---|---|",
    ...entries.map((entry, index) => `| ${index + 1} | reels/${entry.file} | ${timecode(entry.start)} | ${timecode(entry.end)} | ` +
      `${cell(entry.title)} | ${entry.subtitles ? "yes" : "no"} | ${entry.showTitle ? "yes" : "no"} |`)];
  // O_NOFOLLOW: a symlinked cuts.md is refused, never followed.
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try { await handle.writeFile(`${lines.join("\n")}\n`, "utf8"); } finally { await handle.close(); }
}
