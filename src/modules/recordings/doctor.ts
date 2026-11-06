import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import { checkVadModel, checkWhisperModel, type ModuleCheck } from "../core-api.js";
import { checkSpeakerModels } from "./speakers/index.js";
import type { RecordingSettings } from "./settings.js";

export interface RecordingDetails {
  recordingsFolder?: string; recordingsModel?: string; recordingsRetryModel?: string; recordingsVadModel?: string;
  recordingsSpeakers?: string;
}

/** Recording transcription readiness (FR-024, FR-025): folder, models, VAD and speaker models. */
export async function recordingChecks(settings: RecordingSettings): Promise<{
  checks: { component: string; ready: boolean; code: string }[]; details: RecordingDetails;
}> {
  let readable = true;
  try { await access(settings.path, constants.R_OK | constants.W_OK | constants.X_OK); } catch { readable = false; }
  const model = await checkWhisperModel(settings.modelPath);
  const retryModel = settings.retry.modelPath === settings.modelPath ? model : await checkWhisperModel(settings.retry.modelPath);
  const vad = await checkVadModel(settings.vadModelPath);
  // Speaker separation is optional at runtime (transcripts fall back to "Speaker"), but doctor reports missing models.
  const speakers = settings.speakers ? await checkSpeakerModels(settings.speakers) : "SPEAKERS_DISABLED";
  return {
    checks: [
      { component: "recordings", ready: true, code: "RECORDINGS_ENABLED" },
      { component: "recordings-folder", ready: readable, code: readable ? "RECORDINGS_FOLDER_READY" : "RECORDINGS_FOLDER_UNREADABLE" },
      { component: "recordings-model", ready: model === "MEDIA_AUDIO_READY", code: model },
      { component: "recordings-retry-model", ready: retryModel === "MEDIA_AUDIO_READY", code: retryModel },
      { component: "recordings-vad", ready: vad === "MEDIA_AUDIO_READY", code: vad },
      { component: "recordings-speakers", ready: speakers === "SPEAKERS_READY" || speakers === "SPEAKERS_DISABLED", code: speakers },
    ],
    details: { recordingsFolder: settings.path, recordingsModel: basename(settings.modelPath),
      recordingsRetryModel: basename(settings.retry.modelPath), recordingsVadModel: basename(settings.vadModelPath),
      ...(settings.speakers ? { recordingsSpeakers: `${basename(settings.speakers.segmentationModelPath)}, ${basename(settings.speakers.embeddingModelPath)}` } : {}) },
  };
}

/** Doctor lines with the owner-local names as `detail` (never logged). */
export async function recordingDoctor(settings: RecordingSettings): Promise<ModuleCheck[]> {
  const { checks, details } = await recordingChecks(settings);
  const detail: Record<string, string | undefined> = {
    "recordings-folder": details.recordingsFolder, "recordings-model": details.recordingsModel,
    "recordings-retry-model": details.recordingsRetryModel, "recordings-vad": details.recordingsVadModel,
    "recordings-speakers": details.recordingsSpeakers,
  };
  return checks.map((check) => {
    const name = detail[check.component];
    return name === undefined ? check : { ...check, detail: name };
  });
}
