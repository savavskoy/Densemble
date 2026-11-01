import { constants } from "node:fs";
import { link, mkdir, open, rename, rm, statfs, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MediaError, readBounded, checkVadModel, checkWhisperModel, vocabularyPrompt, whisperArgs, whisperDtwPreset,
  type ProcessControl, type ProcessRunner,
} from "../core-api.js";
import type { RecordingSettings } from "./settings.js";
import { detectSilences, type SilenceSpan } from "./silence.js";
import { diarize, type DiarizationResult } from "./speakers/index.js";
import { buildPhrases, collapseRuns, filterSegments, formatTranscript, NO_SPEECH, parseVadLine, vadTimeMapper, whisperSegments,
  type VadSpan } from "./timed.js";

export { NO_SPEECH };

export const RECORDING_FAILURES = ["DECODE_FAILED", "ASR_FAILED", "TIMEOUT", "DISK_FULL", "TARGET_EXISTS",
  "MODEL_UNAVAILABLE", "OUTPUT_INVALID"] as const;
export type RecordingFailure = typeof RECORDING_FAILURES[number];

export class RecordingError extends Error {
  readonly reason: RecordingFailure;
  /** Fixed code for dependents of `transcribeMedia` (`errorCode`). */
  readonly code: string;
  constructor(reason: RecordingFailure) {
    super(reason);
    this.name = "RecordingError";
    this.reason = reason;
    this.code = `RECORDING_${reason}`;
  }
}

export interface TranscriptionJob {
  recording: string;
  /** Where `<key>.txt` and `<key>.words.json` are published. */
  dayDirectory: string;
  key: string;
  durationSeconds: number;
  mode: "first" | "retry";
  /** Replace existing outputs (a fresh video run); recordings never do (spec 004 no-clobber). */
  replace?: boolean;
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
/** `separated`: labels by voice; `unavailable`: speakers configured but separation failed (all `Speaker`); `off`: not configured. */
export type SpeakerOutcome = "separated" | "unavailable" | "off";
export interface TranscriptionResult {
  transcript: string;
  /** `<key>.words.json` next to the transcript; undefined when only it could not be written. */
  words: string | undefined;
  /** Long digital-silence stretches; undefined when the check itself failed (never fails the transcription). */
  silences: SilenceSpan[] | undefined;
  speakers: SpeakerOutcome;
}

const MAX_JSON_BYTES = 512_000_000;
const WAV_BYTES_PER_SECOND = 32_000;
const PROGRESS = /progress\s*=\s*(\d+)%/;
/** Share of the progress bar taken by recognition when speakers are separated after it. */
const RECOGNITION_SHARE = 85;

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
 * Plain-text form of the post-filter (research R6): drops tag-only lines ("[музика]", "(Music)", "*аплодисменти*")
 * and collapses runs of 3+ identical lines or clauses. Timed transcripts use `filterSegments`, the same rules.
 */
export function filterTranscript(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !/^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*)$/u.test(line)).map(collapseClauses);
  const kept = collapseRuns(lines, (a, b) => a === b);
  return `${kept.length ? kept.join("\n") : NO_SPEECH}\n`;
}

/**
 * Decodes, recognises (words with times), separates speakers and publishes one recording or video: the readable
 * transcript and its word-timed version appear complete or not at all. Speaker separation never fails it.
 */
export async function transcribeRecording(job: TranscriptionJob, context: TranscriptionContext): Promise<TranscriptionResult> {
  const { settings, runner, signal } = context;
  // A retry is a stronger pass (FR-029): its own model, VAD and flags, all defaulting to the first pass.
  const pass = job.mode === "retry" ? settings.retry : settings;
  if (await checkWhisperModel(pass.modelPath) !== "MEDIA_AUDIO_READY" ||
      await checkVadModel(settings.vadModelPath) !== "MEDIA_AUDIO_READY") throw new RecordingError("MODEL_UNAVAILABLE");
  const work = join(context.workRoot, randomUUID());
  await mkdir(work, { recursive: false, mode: 0o700 });
  const spawn = context.onSpawn ? { onSpawn: context.onSpawn } : {};
  try {
    const wav = join(work, "audio.wav");
    // A 4-hour recording decodes to ~460 MB; refuse early rather than fill the disk midway.
    if (await freeBytes(context.workRoot) < job.durationSeconds * WAV_BYTES_PER_SECOND * 1.1 + 64_000_000) {
      throw new RecordingError("DISK_FULL");
    }
    await run(() => runner(settings.ffmpegPath, ["-nostdin", "-v", "error", "-xerror", "-threads", "1", "-protocol_whitelist", "file", "-i", job.recording,
      "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-n", wav], {
      signal, timeoutMs: Math.max(10 * 60_000, job.durationSeconds * 250), discardStdout: true, ...spawn,
    }), "DECODE_FAILED");
    const silences = await findSilences(wav, job, context);
    if (silences) context.onSilences?.(silences);
    const share = settings.speakers ? RECOGNITION_SHARE : 100;
    const prefix = join(work, "transcript");
    const spans: VadSpan[] = [];
    await run(async () => runner(settings.whisperPath, whisperArgs({
      model: pass.modelPath, wav, outputPrefix: prefix, language: settings.language, threads: settings.threads,
      prompt: vocabularyPrompt(settings.vocabulary), progress: true, json: true, dtw: await whisperDtwPreset(pass.modelPath),
      vad: { modelPath: settings.vadModelPath, ...pass.vad },
      suppressNonSpeech: pass.suppressNonSpeech, maxContext: pass.maxContext,
    }), {
      signal, timeoutMs: Math.max(30 * 60_000, job.durationSeconds * 1_500), discardStdout: true, cwd: work,
      onStderrLine: (line) => {
        const span = parseVadLine(line);
        if (span) { spans.push(span); return; }
        const match = PROGRESS.exec(line);
        if (match) context.onProgress?.(Math.floor(Math.min(100, Number(match[1])) * share / 100));
      },
      ...spawn,
    }), "ASR_FAILED");
    let segments;
    try {
      const text = new TextDecoder("utf-8").decode(await readBounded(`${prefix}.json`, MAX_JSON_BYTES));
      if (text.includes("\0")) throw new RecordingError("OUTPUT_INVALID");
      segments = filterSegments(whisperSegments(JSON.parse(text), vadTimeMapper(spans)).segments);
    } catch { throw new RecordingError("OUTPUT_INVALID"); }
    let diarization: DiarizationResult | undefined;
    let speakers: SpeakerOutcome = "off";
    if (settings.speakers) {
      speakers = "unavailable";
      if (segments.length) {
        try {
          diarization = await diarize(wav, settings.speakers, { runner, signal, workDir: work, ffmpegPath: settings.ffmpegPath,
            timeoutMs: Math.max(30 * 60_000, job.durationSeconds * 1_000), ...spawn,
            onProgress: (percent) => context.onProgress?.(share + Math.floor(percent * (100 - share) / 100)) });
          speakers = "separated";
        } catch (error) {
          if (error instanceof MediaError && error.code === "MEDIA_ABORTED") throw error;
        }
      } else speakers = "separated";
    }
    const timed = buildPhrases(segments, diarization, settings.speakers?.ownerName ?? "");
    const published = await publish(job, formatTranscript(timed), `${JSON.stringify(timed)}\n`);
    return { ...published, silences, speakers };
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

/**
 * Hidden temps in the output folder, fsync, then the transcript: an exclusive link() (never overwrites, spec 004)
 * or, for a fresh video run, a rename(); the word-timed file follows it. Never leaves a partial transcript.
 */
async function publish(job: TranscriptionJob, text: string, words: string): Promise<{ transcript: string; words: string | undefined }> {
  const temps = [`.densemble-${randomUUID()}.partial`, `.densemble-${randomUUID()}.partial`].map((name) => join(job.dayDirectory, name));
  const target = join(job.dayDirectory, `${job.key}.txt`);
  const wordsTarget = join(job.dayDirectory, `${job.key}.words.json`);
  try {
    for (const [index, content] of [text, words].entries()) {
      const handle = await open(temps[index]!, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
    }
    if (job.replace) await rename(temps[0]!, target);
    else {
      try { await link(temps[0]!, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RecordingError("TARGET_EXISTS");
        throw error;
      }
    }
    // The readable transcript is the spec 004 result; a words file that cannot be written does not undo it.
    try { await rename(temps[1]!, wordsTarget); } catch { return { transcript: target, words: undefined }; }
    return { transcript: target, words: wordsTarget };
  } catch (error) {
    if (error instanceof RecordingError) throw error;
    throw new RecordingError((error as NodeJS.ErrnoException).code === "ENOSPC" ? "DISK_FULL" : "OUTPUT_INVALID");
  } finally {
    for (const temp of temps) await unlink(temp).catch(() => undefined);
  }
}
