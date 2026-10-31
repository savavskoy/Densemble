import type { VadSettings } from "../media/whisper.js";

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
}

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
