import type { ServiceConfig } from "../config/index.js";
import type { AudioSettings } from "../media/index.js";
import { RECORDING_DEFAULTS, type RecordingSettings } from "../recordings/settings.js";

export function audioSettings(config: ServiceConfig): AudioSettings {
  const settings: AudioSettings = {};
  for (const key of ["ffmpegPath", "ffprobePath", "whisperPath", "modelPath", "language", "vadModelPath"] as const) {
    const value = config.audio?.[key];
    if (value !== undefined) settings[key] = value;
  }
  for (const key of ["threads", "probeTimeoutMs", "decodeTimeoutMs", "asrTimeoutMs"] as const) {
    const value = config.audio?.[key];
    if (value !== undefined) settings[key] = value;
  }
  if (config.audio?.vocabulary) settings.vocabulary = [...config.audio.vocabulary];
  return settings;
}

/**
 * Recording settings, or undefined when recording transcription is not configured; tools are shared with voice.
 * A retry inherits the first pass (VAD, flags, model) and overrides only what `recordings.retry` sets.
 */
export function recordingSettings(config: ServiceConfig): RecordingSettings | undefined {
  const recordings = config.recordings;
  if (!recordings) return undefined;
  const vad = defined(RECORDING_DEFAULTS.vad, recordings.vad);
  const suppressNonSpeech = recordings.suppressNonSpeech ?? RECORDING_DEFAULTS.decoding.suppressNonSpeech;
  const maxContext = recordings.maxContext ?? RECORDING_DEFAULTS.decoding.maxContext;
  const retry = recordings.retry;
  return {
    path: recordings.path,
    modelPath: recordings.modelPath,
    vadModelPath: recordings.vadModelPath,
    ffmpegPath: config.audio?.ffmpegPath ?? "ffmpeg",
    ffprobePath: config.audio?.ffprobePath ?? "ffprobe",
    whisperPath: config.audio?.whisperPath ?? "whisper-cli",
    language: recordings.language ?? RECORDING_DEFAULTS.language,
    threads: recordings.threads ?? RECORDING_DEFAULTS.threads,
    vocabulary: [...recordings.vocabulary ?? config.audio?.vocabulary ?? []],
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
  };
}

function defined<T extends object>(defaults: T, overrides: { [K in keyof T]?: T[K] | undefined } | undefined): T {
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  return merged;
}
