import { constants } from "node:fs";
import { link, mkdir, open, rm, statfs, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MediaError, readBounded, checkVadModel, checkWhisperModel, vocabularyPrompt, whisperArgs, type ProcessControl, type ProcessRunner } from "../core-api.js";
import type { RecordingSettings } from "./settings.js";
import { detectSilences, type SilenceSpan } from "./silence.js";

export const RECORDING_FAILURES = ["DECODE_FAILED", "ASR_FAILED", "TIMEOUT", "DISK_FULL", "TARGET_EXISTS",
  "MODEL_UNAVAILABLE", "OUTPUT_INVALID"] as const;
export type RecordingFailure = typeof RECORDING_FAILURES[number];

export class RecordingError extends Error {
  readonly reason: RecordingFailure;
  constructor(reason: RecordingFailure) {
    super(reason);
    this.name = "RecordingError";
    this.reason = reason;
  }
}

export interface TranscriptionJob {
  recording: string;
  dayDirectory: string;
  key: string;
  durationSeconds: number;
  mode: "first" | "retry";
}
export interface TranscriptionContext {
  settings: RecordingSettings;
  runner: ProcessRunner;
  workRoot: string;
  signal: AbortSignal;
  onProgress?: (percent: number) => void;
  onSpawn?: (control: ProcessControl) => void;
  /** Called once the silence check is done, before recognition starts. */
  onSilences?: (spans: SilenceSpan[]) => void;
}
export interface TranscriptionResult {
  transcript: string;
  /** Long digital-silence stretches; undefined when the check itself failed (never fails the transcription). */
  silences: SilenceSpan[] | undefined;
}

export const NO_SPEECH = "[no speech detected]";
const MAX_TRANSCRIPT_BYTES = 32_000_000;
const WAV_BYTES_PER_SECOND = 32_000;
const PROGRESS = /progress\s*=\s*(\d+)%/;

/** Keeps one copy (the last) of any run of 3+ identical consecutive items; runs of two are kept as spoken. */
function collapseRuns<T>(items: readonly T[], same: (a: T, b: T) => boolean): T[] {
  const kept: T[] = [];
  for (let index = 0; index < items.length;) {
    let end = index;
    while (end + 1 < items.length && same(items[end + 1]!, items[index]!)) end++;
    const run = end - index + 1;
    if (run >= 3) kept.push(items[end]!);
    else for (let copy = index; copy <= end; copy++) kept.push(items[copy]!);
    index = end + 1;
  }
  return kept;
}

/**
 * Within one segment line, a clause (up to `,` `.` `!` `?` `…`) repeated 3+ times in a row is kept once:
 * "що вийде, що вийде, що вийде." → "що вийде." (SC-008: no phrase 3+ times in a row).
 */
function collapseClauses(line: string): string {
  // Matches cover the whole line (text, its punctuation, trailing spaces), so joining them loses nothing.
  const clauses = (line.match(/[^,.!?…]*(?:[,.!?…]+|$)\s*/gu) ?? [line]).filter(Boolean);
  const key = (clause: string) => clause.replace(/[\s,.!?…]+$/u, "").trim().toLocaleLowerCase();
  return collapseRuns(clauses, (a, b) => key(a) !== "" && key(a) === key(b)).join("").trim();
}

/**
 * Drops tag-only lines ("[музика]", "(Music)", "*аплодисменти*") and collapses runs of 3+ identical lines
 * or of 3+ identical consecutive clauses within a line (research R6).
 */
export function filterTranscript(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !/^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)$/u.test(line)).map(collapseClauses);
  const kept = collapseRuns(lines, (a, b) => a === b);
  return `${kept.length ? kept.join("\n") : NO_SPEECH}\n`;
}

/** Decodes, recognises and publishes one recording; the transcript appears complete or not at all. */
export async function transcribeRecording(job: TranscriptionJob, context: TranscriptionContext): Promise<TranscriptionResult> {
  const { settings, runner, signal } = context;
  // A retry is a stronger pass (FR-029): its own model, VAD and flags, all defaulting to the first pass.
  const pass = job.mode === "retry" ? settings.retry : settings;
  if (await checkWhisperModel(pass.modelPath) !== "MEDIA_AUDIO_READY" ||
      await checkVadModel(settings.vadModelPath) !== "MEDIA_AUDIO_READY") throw new RecordingError("MODEL_UNAVAILABLE");
  const work = join(context.workRoot, randomUUID());
  await mkdir(work, { recursive: false, mode: 0o700 });
  try {
    const wav = join(work, "audio.wav");
    // A 4-hour recording decodes to ~460 MB; refuse early rather than fill the disk midway.
    if (await freeBytes(context.workRoot) < job.durationSeconds * WAV_BYTES_PER_SECOND * 1.1 + 64_000_000) {
      throw new RecordingError("DISK_FULL");
    }
    await run(() => runner(settings.ffmpegPath, ["-nostdin", "-v", "error", "-xerror", "-threads", "1", "-protocol_whitelist", "file", "-i", job.recording,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-n", wav], {
      signal, timeoutMs: Math.max(10 * 60_000, job.durationSeconds * 250), discardStdout: true,
      ...(context.onSpawn ? { onSpawn: context.onSpawn } : {}),
    }), "DECODE_FAILED");
    const silences = await findSilences(wav, job, context);
    if (silences) context.onSilences?.(silences);
    const prefix = join(work, "transcript");
    await run(() => runner(settings.whisperPath, whisperArgs({
      model: pass.modelPath, wav, outputPrefix: prefix, language: settings.language, threads: settings.threads,
      prompt: vocabularyPrompt(settings.vocabulary), progress: true,
      vad: { modelPath: settings.vadModelPath, ...pass.vad },
      suppressNonSpeech: pass.suppressNonSpeech, maxContext: pass.maxContext,
    }), {
      signal, timeoutMs: Math.max(30 * 60_000, job.durationSeconds * 1_500), discardStdout: true, cwd: work,
      onStderrLine: (line) => {
        const match = PROGRESS.exec(line);
        if (match) context.onProgress?.(Math.min(100, Number(match[1])));
      },
      ...(context.onSpawn ? { onSpawn: context.onSpawn } : {}),
    }), "ASR_FAILED");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(`${prefix}.txt`, MAX_TRANSCRIPT_BYTES)); }
    catch { throw new RecordingError("OUTPUT_INVALID"); }
    if (text.includes("\0")) throw new RecordingError("OUTPUT_INVALID");
    return { transcript: await publish(job, filterTranscript(text)), silences };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Silence is information, not a failure: a failed check yields undefined; only an abort propagates. */
async function findSilences(wav: string, job: TranscriptionJob, context: TranscriptionContext): Promise<SilenceSpan[] | undefined> {
  try {
    return await detectSilences({ runner: context.runner, ffmpegPath: context.settings.ffmpegPath, wav,
      durationSeconds: job.durationSeconds, settings: context.settings.silence, signal: context.signal, onSpawn: context.onSpawn });
  } catch (error) {
    if (error instanceof MediaError && error.code === "MEDIA_ABORTED") throw error;
    return undefined;
  }
}

async function run(action: () => Promise<unknown>, failure: RecordingFailure): Promise<void> {
  try { await action(); }
  catch (error) {
    if (error instanceof MediaError && error.code === "MEDIA_ABORTED") throw error;
    if (error instanceof MediaError && error.code === "MEDIA_TIMEOUT") throw new RecordingError("TIMEOUT");
    if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new RecordingError("DISK_FULL");
    throw new RecordingError(failure);
  }
}

async function freeBytes(path: string): Promise<number> {
  try { const stats = await statfs(path); return stats.bavail * stats.bsize; }
  catch { return Number.POSITIVE_INFINITY; }
}

/** Hidden temp in the day folder, fsync, then an exclusive link(): never overwrites, never leaves a partial transcript. */
async function publish(job: TranscriptionJob, text: string): Promise<string> {
  const temp = join(job.dayDirectory, `.densemble-${randomUUID()}.partial`);
  const target = join(job.dayDirectory, `${job.key}.txt`);
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(temp, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RecordingError("TARGET_EXISTS");
      throw error;
    }
    return target;
  } catch (error) {
    if (error instanceof RecordingError) throw error;
    throw new RecordingError((error as NodeJS.ErrnoException).code === "ENOSPC" ? "DISK_FULL" : "OUTPUT_INVALID");
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
