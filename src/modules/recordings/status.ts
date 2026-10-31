import { constants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describeSilences, type SilenceSpan } from "./silence.js";

export interface RecordingStatus {
  version: 1;
  updatedAt: string;
  enabled: boolean;
  pollIntervalMs: number;
  current: {
    file: string; mode: "first" | "retry"; startedAt: string; percent: number; etaSeconds: number | null; paused: boolean;
    silences?: SilenceSpan[];
  } | null;
  queue: string[];
  waiting: string[];
  conflicts: { file: string; reason: string }[];
  failed: { file: string; code: string; at: string }[];
  /** `silences`: long digital-silence stretches (FR-030); absent when none were found or the check failed. */
  recent: { file: string; transcript: string; at: string; silences?: SilenceSpan[] }[];
}

export const RECENT_LIMIT = 20;

/** Owner-private snapshot, replaced atomically so a reader never sees a half-written file. */
export async function writeStatus(path: string, status: RecordingStatus): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(status, null, 2)}\n`, "utf8"); }
    finally { await handle.close(); }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function readStatus(path: string): Promise<RecordingStatus | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RecordingStatus;
    return parsed?.version === 1 && typeof parsed.updatedAt === "string" ? parsed : undefined;
  } catch { return undefined; }
}

/** The worker refreshes the snapshot at least once per poll interval while it runs. */
export function isStale(status: RecordingStatus, now: number): boolean {
  if (!status.enabled) return false;
  const updated = Date.parse(status.updatedAt);
  return !Number.isFinite(updated) || now - updated > 3 * status.pollIntervalMs;
}

/** ETA from running time only; time paused for voice messages does not count. */
export function estimateSeconds(runningMs: number, percent: number): number | null {
  if (percent <= 0 || percent >= 100 || runningMs <= 0) return percent >= 100 ? 0 : null;
  return Math.round(runningMs / 1000 * (100 - percent) / percent);
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours} h ${minutes} min` : minutes ? `${minutes} min` : `${seconds} s`;
}

export function formatStatus(options: { configured: boolean; status: RecordingStatus | undefined; now: number }): string {
  if (!options.configured) return "Recording transcription is off (no recordings folder configured).\n";
  const status = options.status;
  if (status && !status.enabled) return "Recording transcription is off (model or VAD model not ready; run make doctor).\n";
  if (!status || isStale(status, options.now)) return "Recording transcription: service not running.\n";
  const lines: string[] = [];
  const current = status.current;
  if (current) {
    lines.push(`Transcribing: ${current.file}${current.mode === "retry" ? " (retry)" : ""}`,
      `  ${current.percent}% done${current.etaSeconds !== null ? `, about ${duration(current.etaSeconds)} left` : ""}` +
      `${current.paused ? " — paused for a voice message" : ""}`);
    const silent = describeSilences(current.silences ?? []);
    if (silent) lines.push(`  ${silent}`);
  } else {
    lines.push("Idle: nothing is being transcribed.");
  }
  const list = (title: string, items: string[]) => {
    if (items.length) lines.push(`${title} (${items.length}):`, ...items.map((item) => `  ${item}`));
  };
  list("Queued", status.queue);
  list("Waiting to finish recording", status.waiting);
  list("Conflicts", status.conflicts.map((item) => `${item.file} — ${item.reason}`));
  list("Failed (retried after a restart)", status.failed.map((item) => `${item.file} — ${item.code}`));
  list("Recently done", status.recent.slice(0, 5).map((item) => {
    const silent = describeSilences(item.silences ?? []);
    return silent ? `${item.transcript} — ${silent}` : item.transcript;
  }));
  return `${lines.join("\n")}\n`;
}
