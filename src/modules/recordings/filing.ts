import { link, lstat, mkdir, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { MediaError, type ProcessRunner } from "../core-api.js";

export interface FinishedCheckOptions {
  runner: ProcessRunner;
  lsofPath?: string;
  ffprobePath: string;
  quietMs: number;
  now: () => number;
  signal: AbortSignal;
}

const TOOL_TIMEOUT_MS = 15_000;
const TOOL_MAX_OUTPUT = 64 * 1024;

function isAbort(error: unknown): boolean {
  return error instanceof MediaError && error.code === "MEDIA_ABORTED";
}

/** True when any process holds the file open, or when that cannot be verified. */
export async function isOpenByAnyProcess(path: string, options: FinishedCheckOptions): Promise<boolean> {
  try {
    // lsof exits 1 both when nothing holds the file and on errors; only a silent exit 1 means "not open".
    const { stdout } = await options.runner("/bin/sh", ["-c", '"$0" -t -- "$1" 2>&1; echo "lsof-status:$?"',
      options.lsofPath ?? "/usr/sbin/lsof", resolve(path)],
      { signal: options.signal, timeoutMs: TOOL_TIMEOUT_MS, maxOutputBytes: TOOL_MAX_OUTPUT });
    return stdout.trim() !== "lsof-status:1";
  } catch (error) {
    if (isAbort(error)) throw error;
    return true;
  }
}

/** Container duration in seconds, or undefined when it cannot be determined. */
export async function probeDuration(path: string, options: FinishedCheckOptions): Promise<number | undefined> {
  try {
    const { stdout } = await options.runner(options.ffprobePath,
      ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "csv=p=0", "-i", resolve(path)],
      { signal: options.signal, timeoutMs: TOOL_TIMEOUT_MS, maxOutputBytes: TOOL_MAX_OUTPUT });
    const text = stdout.trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (isAbort(error)) throw error;
    return undefined;
  }
}

export async function isFinished(path: string, options: FinishedCheckOptions):
Promise<{ finished: boolean; durationSeconds?: number }> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return { finished: false };
  }
  if (!stats.isFile()) return { finished: false };
  if (options.now() - stats.mtimeMs < options.quietMs) return { finished: false };
  if (await isOpenByAnyProcess(path, options)) return { finished: false };
  const durationSeconds = await probeDuration(path, options);
  if (durationSeconds === undefined) return { finished: false };
  return { finished: true, durationSeconds };
}

export type FilingResult = "filed" | "conflict";

/** Moves source into targetDirectory via hard link + unlink; never overwrites an existing file. */
export async function fileRecording(source: string, targetDirectory: string): Promise<FilingResult> {
  await mkdir(targetDirectory, { recursive: true });
  try {
    await link(source, join(targetDirectory, basename(source)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "conflict";
    throw error;
  }
  await unlink(source);
  return "filed";
}

/** Completes a filing interrupted between link and unlink: removes source only when it is the same inode as target. */
export async function repairInterruptedFiling(source: string, target: string): Promise<boolean> {
  if (resolve(source) === resolve(target)) return false;
  try {
    const [a, b] = await Promise.all([lstat(source), lstat(target)]);
    if (!a.isFile() || !b.isFile() || a.dev !== b.dev || a.ino !== b.ino || a.nlink < 2) return false;
  } catch {
    return false;
  }
  await unlink(source);
  return true;
}
