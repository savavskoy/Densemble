import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { checkVadModel, checkWhisperModel } from "../media/whisper.js";
import type { SpeechGate } from "../media/speech-gate.js";
import type { DiagnosticSink } from "../ports.js";
import type { RecordingSettings } from "./settings.js";
import { writeStatus } from "./status.js";
import { createRecordingWorker, type RecordingWorker } from "./worker.js";

const MODEL_DIAGNOSTICS = {
  MEDIA_AUDIO_MODEL_MISSING: "RECORDING_MODEL_MISSING",
  MEDIA_AUDIO_MODEL_ENGLISH_ONLY: "RECORDING_MODEL_ENGLISH_ONLY",
  MEDIA_AUDIO_MODEL_UNSUPPORTED: "RECORDING_MODEL_UNSUPPORTED",
} as const;

/**
 * Starts the recordings worker when configured and its models are usable. A bad model or an unreadable
 * folder keeps recording transcription off without affecting the text and voice service.
 */
export async function startRecordingTranscription(options: {
  settings: RecordingSettings | undefined; runtimeDataPath: string; diagnostics: DiagnosticSink; gate: SpeechGate;
}): Promise<RecordingWorker | undefined> {
  const { settings, diagnostics } = options;
  if (!settings) {
    diagnostics.record("RECORDINGS_DISABLED");
    return undefined;
  }
  const model = await checkWhisperModel(settings.modelPath);
  const vad = await checkVadModel(settings.vadModelPath);
  if (model !== "MEDIA_AUDIO_READY" || vad !== "MEDIA_AUDIO_READY") {
    diagnostics.record(model !== "MEDIA_AUDIO_READY" ? MODEL_DIAGNOSTICS[model] : "RECORDING_MODEL_MISSING");
    diagnostics.record("RECORDINGS_DISABLED");
    try {
      const base = join(options.runtimeDataPath, "recordings");
      await mkdir(base, { recursive: true, mode: 0o700 });
      await writeStatus(join(base, "status.json"), { version: 1, updatedAt: new Date().toISOString(), enabled: false,
        pollIntervalMs: settings.pollIntervalMs, current: null, queue: [], waiting: [], conflicts: [], failed: [], recent: [] });
    } catch { diagnostics.record("RECORDINGS_STATUS_FAILED"); }
    return undefined;
  }
  // A bad retry model fails only retries (MODEL_UNAVAILABLE, reported per file); first passes go on.
  if (settings.retry.modelPath !== settings.modelPath && await checkWhisperModel(settings.retry.modelPath) !== "MEDIA_AUDIO_READY") {
    diagnostics.record("RECORDING_RETRY_MODEL_UNAVAILABLE");
  }
  const worker = createRecordingWorker({ settings, runtimeDataPath: options.runtimeDataPath, diagnostics, gate: options.gate });
  try { await worker.start(); }
  catch {
    diagnostics.record("RECORDINGS_START_FAILED");
    await worker.stop().catch(() => undefined);
    return undefined;
  }
  return worker;
}
