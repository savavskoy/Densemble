import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import { checkVadModel, checkWhisperModel, type ModuleCheck } from "../core-api.js";
import { legacyJobInstalled } from "./legacy.js";
import type { RecordingSettings } from "./settings.js";

export interface RecordingDetails {
  recordingsFolder?: string; recordingsModel?: string; recordingsRetryModel?: string; recordingsVadModel?: string;
}

/** Recording transcription readiness (FR-024, FR-025): folder, models, VAD and the legacy job. */
export async function recordingChecks(settings: RecordingSettings, legacyPlist?: string): Promise<{
  checks: { component: string; ready: boolean; code: string }[]; details: RecordingDetails;
}> {
  let readable = true;
  try { await access(settings.path, constants.R_OK | constants.W_OK | constants.X_OK); } catch { readable = false; }
  const model = await checkWhisperModel(settings.modelPath);
  const retryModel = settings.retry.modelPath === settings.modelPath ? model : await checkWhisperModel(settings.retry.modelPath);
  const vad = await checkVadModel(settings.vadModelPath);
  const legacy = await legacyJobInstalled(legacyPlist);
  return {
    checks: [
      { component: "recordings", ready: true, code: "RECORDINGS_ENABLED" },
      { component: "recordings-folder", ready: readable, code: readable ? "RECORDINGS_FOLDER_READY" : "RECORDINGS_FOLDER_UNREADABLE" },
      { component: "recordings-model", ready: model === "MEDIA_AUDIO_READY", code: model },
      { component: "recordings-retry-model", ready: retryModel === "MEDIA_AUDIO_READY", code: retryModel },
      { component: "recordings-vad", ready: vad === "MEDIA_AUDIO_READY", code: vad },
      { component: "recordings-legacy-job", ready: !legacy,
        code: legacy ? "RECORDINGS_LEGACY_JOB_INSTALLED" : "RECORDINGS_LEGACY_JOB_ABSENT" },
    ],
    details: { recordingsFolder: settings.path, recordingsModel: basename(settings.modelPath),
      recordingsRetryModel: basename(settings.retry.modelPath), recordingsVadModel: basename(settings.vadModelPath) },
  };
}

/** Doctor lines with the owner-local names as `detail` (never logged). */
export async function recordingDoctor(settings: RecordingSettings, legacyPlist?: string): Promise<ModuleCheck[]> {
  const { checks, details } = await recordingChecks(settings, legacyPlist);
  const detail: Record<string, string | undefined> = {
    "recordings-folder": details.recordingsFolder, "recordings-model": details.recordingsModel,
    "recordings-retry-model": details.recordingsRetryModel, "recordings-vad": details.recordingsVadModel,
  };
  return checks.map((check) => {
    const name = detail[check.component];
    return name === undefined ? check : { ...check, detail: name };
  });
}
