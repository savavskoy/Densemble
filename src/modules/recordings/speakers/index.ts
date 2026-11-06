import { constants, existsSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MediaError, readBounded, type ProcessControl, type ProcessRunner } from "../../core-api.js";

/**
 * Local speaker separation (spec 006, FR-003): sherpa-onnx (pyannote segmentation 3.0 + a speaker-embedding
 * model) in a child process, so the service's event loop never blocks. Optional at runtime: a caller that gets
 * `SPEAKERS_*` keeps the transcript and labels every phrase `Speaker` (plan D3).
 */
export interface SpeakerSettings {
  /** Absolute path (resolved from config) of the speaker-segmentation ONNX model. */
  segmentationModelPath: string;
  /** Absolute path of the speaker-embedding ONNX model (clustering). */
  embeddingModelPath: string;
  /** Absolute path of the model that compares clusters with the owner's sample; needed only with `ownerSamplePath`. */
  verificationModelPath?: string | undefined;
  /** Label of the owner's phrases when `ownerSamplePath` is configured and matched. */
  ownerName: string;
  /** Absolute path of a short audio sample of the owner's voice (any ffmpeg-readable format). */
  ownerSamplePath?: string | undefined;
  /** Clustering distance threshold; module default when undefined. */
  clusterThreshold?: number | undefined;
  /** Minimum cosine similarity for a cluster to be named as the owner; module default when undefined. */
  ownerThreshold?: number | undefined;
}

/** One continuous stretch of one voice; seconds from the start of the audio. */
export interface SpeakerTurn { start: number; end: number; speaker: number }

export interface DiarizationResult {
  /** Sorted by `start`; `speaker` is a cluster index 0..n-1. */
  turns: SpeakerTurn[];
  /** Cluster index matched to the owner's sample, when configured and matched. */
  ownerSpeaker?: number;
}

export interface DiarizationOptions {
  runner: ProcessRunner;
  signal: AbortSignal;
  /** Private 0700 scratch directory owned by the caller. */
  workDir: string;
  ffmpegPath: string;
  timeoutMs: number;
  onSpawn?: (control: ProcessControl) => void;
  onProgress?: (percent: number) => void;
}

export type SpeakerModelsCode = "SPEAKERS_READY" | "SPEAKERS_MODEL_MISSING" | "SPEAKERS_RUNTIME_MISSING";

/**
 * Defaults of the 2026-10-31 calibration (see the recordings README). Clustering, wespeaker ResNet34: 0.5 split one
 * voice into ~8 clusters, 0.7 kept two voices, 0.9 merged them. Owner match, CAM++ (wespeaker scored strangers up
 * to 0.94, above the owner): the owner 0.66–0.70, strangers at most 0.38.
 */
export const SPEAKER_DEFAULTS = Object.freeze({ clusterThreshold: 0.7, ownerThreshold: 0.5, threads: 4 });

const PROGRESS = /progress\s*=\s*(\d+)%/;
const MAX_RESULT_BYTES = 64_000_000;
/** ONNX files are protobufs well above this; a smaller file is a failed download. */
const MIN_MODEL_BYTES = 100_000;

export class SpeakerError extends Error {
  readonly code = "SPEAKERS_FAILED";
  constructor() { super("SPEAKERS_FAILED"); this.name = "SpeakerError"; }
}

/** The worker next to this file: compiled `.js` in `dist`, the `.ts` source under tests (Node strips types). */
function workerPath(): string {
  const compiled = fileURLToPath(new URL("./worker.js", import.meta.url));
  return existsSync(compiled) ? compiled : fileURLToPath(new URL("./worker.ts", import.meta.url));
}

function runtimeAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("sherpa-onnx-node");
    return true;
  } catch { return false; }
}

async function modelReady(path: string): Promise<boolean> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      return stats.isFile() && stats.size >= MIN_MODEL_BYTES;
    } finally { await handle.close(); }
  } catch { return false; }
}

/** Never throws. */
export async function checkSpeakerModels(settings: SpeakerSettings): Promise<SpeakerModelsCode> {
  if (!await modelReady(settings.segmentationModelPath) || !await modelReady(settings.embeddingModelPath) ||
      (settings.ownerSamplePath && !await modelReady(settings.verificationModelPath ?? settings.embeddingModelPath))) {
    return "SPEAKERS_MODEL_MISSING";
  }
  return runtimeAvailable() ? "SPEAKERS_READY" : "SPEAKERS_RUNTIME_MISSING";
}

function validResult(value: unknown): value is DiarizationResult {
  if (typeof value !== "object" || value === null) return false;
  const { turns, ownerSpeaker } = value as { turns?: unknown; ownerSpeaker?: unknown };
  return Array.isArray(turns) && turns.every((turn: unknown) => {
    const { start, end, speaker } = (turn ?? {}) as Record<string, unknown>;
    return typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end) &&
      end > start && Number.isInteger(speaker) && (speaker as number) >= 0;
  }) && (ownerSpeaker === undefined || (Number.isInteger(ownerSpeaker) && (ownerSpeaker as number) >= 0));
}

/**
 * Separates speakers in a 16 kHz mono PCM WAV. Runs out of process so the service's event loop never
 * blocks. Throws `SpeakerError` (`SPEAKERS_FAILED`) on failure; an abort propagates as `MEDIA_ABORTED`.
 */
export async function diarize(wav: string, settings: SpeakerSettings, options: DiarizationOptions): Promise<DiarizationResult> {
  const { runner, signal, workDir } = options;
  const spawn = options.onSpawn ? { onSpawn: options.onSpawn } : {};
  try {
    if (await checkSpeakerModels(settings) !== "SPEAKERS_READY") throw new SpeakerError();
    let ownerWav: string | undefined;
    if (settings.ownerSamplePath) {
      ownerWav = join(workDir, "owner.wav");
      // The first two minutes are plenty for a voice print.
      await runner(options.ffmpegPath, ["-nostdin", "-v", "error", "-xerror", "-threads", "1", "-protocol_whitelist", "file",
        "-i", settings.ownerSamplePath, "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", "120", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le", "-f", "wav", "-n", ownerWav], { signal, timeoutMs: 120_000, discardStdout: true, ...spawn });
    }
    const output = join(workDir, "speakers.json");
    const request = join(workDir, "speakers-request.json");
    await writeFile(request, JSON.stringify({
      wav, segmentation: settings.segmentationModelPath, embedding: settings.embeddingModelPath,
      verification: settings.verificationModelPath ?? settings.embeddingModelPath,
      threads: SPEAKER_DEFAULTS.threads, clusterThreshold: settings.clusterThreshold ?? SPEAKER_DEFAULTS.clusterThreshold,
      ownerThreshold: settings.ownerThreshold ?? SPEAKER_DEFAULTS.ownerThreshold, output,
      ...(ownerWav ? { ownerWav } : {}),
    }), { mode: 0o600, flag: "wx" });
    await runner(process.execPath, ["--no-warnings", workerPath(), request], {
      signal, timeoutMs: options.timeoutMs, discardStdout: true, cwd: workDir,
      onStderrLine: (line) => {
        const match = PROGRESS.exec(line);
        if (match) options.onProgress?.(Math.min(100, Number(match[1])));
      },
      ...spawn,
    });
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(output, MAX_RESULT_BYTES)));
    if (!validResult(result)) throw new SpeakerError();
    const speakers = new Set(result.turns.map((turn) => turn.speaker));
    return {
      turns: [...result.turns].sort((a, b) => a.start - b.start || a.end - b.end),
      ...(result.ownerSpeaker !== undefined && speakers.has(result.ownerSpeaker) ? { ownerSpeaker: result.ownerSpeaker } : {}),
    };
  } catch (error) {
    if (error instanceof MediaError && error.code === "MEDIA_ABORTED") throw error;
    throw new SpeakerError();
  }
}
