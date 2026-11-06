import { z } from "zod";
import { assertDisjoint, checkedPath, isWithin, type CoreOffer, type PrepareResult, type VadSettings } from "../core-api.js";
import type { SpeakerSettings } from "./speakers/index.js";

/** Decoding flags of one pass: `-sns` and `-mc` (0 = no carried text context, the loop-resistant setting). */
export interface RecordingDecodingSettings { suppressNonSpeech: boolean; maxContext: number }
/** A review-requested retry: a stronger model (FR-029); VAD defaults to the first pass, not stricter. */
export interface RecordingRetrySettings extends RecordingDecodingSettings { modelPath: string; vad: VadSettings }
/** Long digital-silence stretches (FR-030), found with FFmpeg `silencedetect` on the decoded audio. */
export interface RecordingSilenceSettings { thresholdDb: number; minSeconds: number }
export interface RecordingSettings extends RecordingDecodingSettings {
  path: string;
  modelPath: string;
  vadModelPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  whisperPath: string;
  language: string;
  threads: number;
  vocabulary: string[];
  quietMinutes: number;
  pollIntervalMs: number;
  vad: VadSettings;
  retry: RecordingRetrySettings;
  silence: RecordingSilenceSettings;
  notifications: boolean;
  /** Speaker separation (spec 006); undefined when turned off. */
  speakers?: SpeakerSettings | undefined;
}

/** Speaker models (relative to the config file) and the owner's label when neither `speakers` nor `ownerName` sets one. */
export const SPEAKER_SETTING_DEFAULTS = Object.freeze({
  segmentationModelPath: "./models/speaker-segmentation.onnx",
  embeddingModelPath: "./models/speaker-embedding.onnx",
  verificationModelPath: "./models/speaker-verification.onnx",
  ownerName: "Owner",
});

/**
 * First pass = best configuration of the 2026-10-30 benchmark ("E": sensitive VAD with long pads, no carried
 * text context); `-sns` is off because it dropped real speech there. A retry keeps the same VAD and flags
 * and swaps in `retry.modelPath` when configured.
 */
export const RECORDING_DEFAULTS: Readonly<{
  language: string; threads: number; quietMinutes: number; pollIntervalMs: number;
  vad: Readonly<VadSettings>; decoding: Readonly<RecordingDecodingSettings>;
  silence: Readonly<RecordingSilenceSettings>; notifications: boolean;
}> = Object.freeze({
  language: "auto",
  threads: 4,
  quietMinutes: 2,
  pollIntervalMs: 60_000,
  vad: Object.freeze({ threshold: 0.35, minSpeechMs: 250, minSilenceMs: 500, padMs: 200 }),
  decoding: Object.freeze({ suppressNonSpeech: false, maxContext: 0 }),
  silence: Object.freeze({ thresholdDb: -80, minSeconds: 60 }),
  notifications: true,
});

const nonempty = z.string().trim().min(1);
const vadThreshold = z.number().min(0.1).max(0.95);
const vadMs = z.number().int().min(0).max(10_000);
const maxContext = z.number().int().min(-1).max(224);
/** Recognition hints joined into one whisper prompt; bounded like the core `audio.vocabulary`. */
const vocabulary = z.array(z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u)).max(100)
  .refine((terms) => terms.join(", ").length <= 800);

/** `modules.recordings.settings` (or the legacy top-level `recordings`): the same fields and bounds as spec 004. */
export const recordingsSchema = z.object({
  path: nonempty,
  modelPath: nonempty,
  vadModelPath: nonempty,
  language: z.string().regex(/^(auto|[a-z]{2,3})$/).optional(),
  threads: z.number().int().min(1).max(8).optional(),
  vocabulary: vocabulary.optional(),
  quietMinutes: z.number().int().min(1).max(60).optional(),
  pollIntervalMs: z.number().int().min(30_000).max(300_000).optional(),
  vad: z.object({
    threshold: vadThreshold.optional(), minSpeechMs: vadMs.optional(), minSilenceMs: vadMs.optional(), padMs: vadMs.optional(),
  }).strict().optional(),
  suppressNonSpeech: z.boolean().optional(),
  maxContext: maxContext.optional(),
  retry: z.object({
    modelPath: nonempty.optional(), vadThreshold: vadThreshold.optional(), vadMinSpeechMs: vadMs.optional(),
    suppressNonSpeech: z.boolean().optional(), maxContext: maxContext.optional(),
  }).strict().optional(),
  silence: z.object({
    thresholdDb: z.number().int().min(-120).max(-30).optional(), minSeconds: z.number().int().min(10).max(3_600).optional(),
  }).strict().optional(),
  notifications: z.boolean().optional(),
  /** Speaker separation (spec 006): on by default with the models in `SPEAKER_SETTING_DEFAULTS`. */
  speakers: z.object({
    enabled: z.boolean().optional(),
    segmentationModelPath: nonempty.optional(),
    embeddingModelPath: nonempty.optional(),
    verificationModelPath: nonempty.optional(),
    ownerName: z.string().trim().min(1).max(40).regex(/^[^\p{Cc}:\[\]]+$/u).optional(),
    ownerSamplePath: nonempty.optional(),
    clusterThreshold: z.number().min(0.1).max(2).optional(),
    ownerThreshold: z.number().min(0).max(1).optional(),
  }).strict().optional(),
}).strict();
export type RecordingsConfig = z.infer<typeof recordingsSchema>;

/**
 * Path rules of spec 004: model paths resolve from the config file's directory (checked at start, so a bad
 * model disables only recordings); the folder must exist, contain no symlink, lie inside an owner workspace
 * and not overlap service-owned paths. A broken rule makes the module unavailable with its code.
 */
export function prepareRecordings(raw: RecordingsConfig, core: CoreOffer): PrepareResult<RecordingsConfig> {
  const settings: RecordingsConfig = { ...raw, modelPath: core.resolveFromConfig(raw.modelPath),
    vadModelPath: core.resolveFromConfig(raw.vadModelPath) };
  if (raw.speakers?.enabled !== false) {
    const speakers = raw.speakers ?? {};
    settings.speakers = { ...speakers,
      segmentationModelPath: core.resolveFromConfig(speakers.segmentationModelPath ?? SPEAKER_SETTING_DEFAULTS.segmentationModelPath),
      embeddingModelPath: core.resolveFromConfig(speakers.embeddingModelPath ?? SPEAKER_SETTING_DEFAULTS.embeddingModelPath),
      verificationModelPath: core.resolveFromConfig(speakers.verificationModelPath ?? SPEAKER_SETTING_DEFAULTS.verificationModelPath),
      ...(speakers.ownerSamplePath ? { ownerSamplePath: core.resolveFromConfig(speakers.ownerSamplePath) } : {}) };
  }
  if (raw.retry) {
    settings.retry = { ...raw.retry };
    if (raw.retry.modelPath) settings.retry.modelPath = core.resolveFromConfig(raw.retry.modelPath);
  }
  const folder = checkedPath(core.resolveFromConfig(raw.path), "directory");
  if (!core.ownerWorkspaces.some((root) => isWithin(root, folder))) return { ok: false, code: "RECORDINGS_PATH_OUTSIDE_WORKSPACE" };
  for (const managed of core.managedRoots) assertDisjoint(managed, folder);
  settings.path = folder;
  return { ok: true, settings };
}

/**
 * Full recording settings from prepared module settings; tools (and vocabulary, unless set here) are shared
 * with voice. A retry inherits the first pass (VAD, flags, model) and overrides only what `retry` sets.
 */
export function recordingSettings(recordings: RecordingsConfig, audio: CoreOffer["audio"], ownerName?: string): RecordingSettings {
  const vad = defined(RECORDING_DEFAULTS.vad, recordings.vad);
  const suppressNonSpeech = recordings.suppressNonSpeech ?? RECORDING_DEFAULTS.decoding.suppressNonSpeech;
  const maxContext = recordings.maxContext ?? RECORDING_DEFAULTS.decoding.maxContext;
  const retry = recordings.retry;
  return {
    path: recordings.path,
    modelPath: recordings.modelPath,
    vadModelPath: recordings.vadModelPath,
    ffmpegPath: audio.ffmpegPath,
    ffprobePath: audio.ffprobePath,
    whisperPath: audio.whisperPath,
    language: recordings.language ?? RECORDING_DEFAULTS.language,
    threads: recordings.threads ?? RECORDING_DEFAULTS.threads,
    vocabulary: [...recordings.vocabulary ?? audio.vocabulary],
    quietMinutes: recordings.quietMinutes ?? RECORDING_DEFAULTS.quietMinutes,
    pollIntervalMs: recordings.pollIntervalMs ?? RECORDING_DEFAULTS.pollIntervalMs,
    vad,
    suppressNonSpeech,
    maxContext,
    retry: {
      modelPath: retry?.modelPath ?? recordings.modelPath,
      vad: defined(vad, { threshold: retry?.vadThreshold, minSpeechMs: retry?.vadMinSpeechMs }),
      suppressNonSpeech: retry?.suppressNonSpeech ?? suppressNonSpeech,
      maxContext: retry?.maxContext ?? maxContext,
    },
    silence: defined(RECORDING_DEFAULTS.silence, recordings.silence),
    notifications: recordings.notifications ?? RECORDING_DEFAULTS.notifications,
    speakers: speakerSettings(recordings.speakers, ownerName),
  };
}

/** Prepared `speakers` (paths already resolved) → diarization settings; undefined when turned off. */
function speakerSettings(speakers: RecordingsConfig["speakers"], ownerName: string | undefined): SpeakerSettings | undefined {
  if (speakers?.enabled === false) return undefined;
  return {
    segmentationModelPath: speakers?.segmentationModelPath ?? SPEAKER_SETTING_DEFAULTS.segmentationModelPath,
    embeddingModelPath: speakers?.embeddingModelPath ?? SPEAKER_SETTING_DEFAULTS.embeddingModelPath,
    verificationModelPath: speakers?.verificationModelPath ?? SPEAKER_SETTING_DEFAULTS.verificationModelPath,
    ownerName: speakers?.ownerName ?? ownerName ?? SPEAKER_SETTING_DEFAULTS.ownerName,
    ownerSamplePath: speakers?.ownerSamplePath,
    clusterThreshold: speakers?.clusterThreshold,
    ownerThreshold: speakers?.ownerThreshold,
  };
}

function defined<T extends object>(defaults: T, overrides: { [K in keyof T]?: T[K] | undefined } | undefined): T {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  return merged;
}
