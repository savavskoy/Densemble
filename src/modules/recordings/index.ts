import { lstat, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  checkVadModel, checkWhisperModel, ModuleError,
  type AbilityResult, type DiagnosticSink, type Json, type ModuleContext, type ModuleDefinition, type ModuleInstance,
} from "../core-api.js";
import { recordingDoctor } from "./doctor.js";
import { prepareRecordings, recordingSettings, recordingsSchema, type RecordingsConfig } from "./settings.js";
import { writeStatus, type RecordingStatus } from "./status.js";
import { createRecordingWorker, type RecordingWorker } from "./worker.js";

const MODEL_CODES = {
  MEDIA_AUDIO_MODEL_MISSING: "RECORDING_MODEL_MISSING",
  MEDIA_AUDIO_MODEL_ENGLISH_ONLY: "RECORDING_MODEL_ENGLISH_ONLY",
  MEDIA_AUDIO_MODEL_UNSUPPORTED: "RECORDING_MODEL_UNSUPPORTED",
} as const;

const settingsFix = "Виправте modules.recordings.settings.path у config.local.json і виконайте make restart.";

/** Recording transcription (spec 004) as a module: watches one folder inside an owner workspace. */
export const module: ModuleDefinition<RecordingsConfig> = {
  id: "recordings",
  version: "1.0.0",
  settings: recordingsSchema,
  abilities: [{
    name: "recordings_status",
    description: "Recording transcription status: the file being transcribed, the queue, recordings still being written, " +
      "conflicts, failures and recent transcripts (file names only, never transcript text).",
    input: z.object({}).strict(),
    readOnly: true,
  }],
  reasons: {
    RECORDING_MODEL_MISSING: { cause: "Файл моделі розпізнавання або моделі VAD для записів не знайдено чи він не читається.",
      fix: "Перевірте modelPath і vadModelPath у modules.recordings.settings (див. make doctor) і виконайте make restart." },
    RECORDING_MODEL_ENGLISH_ONLY: { cause: "Модель розпізнавання для записів лише англійська.",
      fix: "Вкажіть у modules.recordings.settings.modelPath багатомовну модель (наприклад, ggml-large-v3-turbo.bin) і виконайте make restart." },
    RECORDING_MODEL_UNSUPPORTED: { cause: "Файл моделі для записів не є підтримуваною моделлю whisper.cpp.",
      fix: "Завантажте модель ggml для whisper.cpp, вкажіть її в modules.recordings.settings.modelPath і виконайте make restart." },
    RECORDINGS_PATH_OUTSIDE_WORKSPACE: { cause: "Папка записів лежить поза вашими робочими просторами.",
      fix: "Вкажіть у modules.recordings.settings.path папку всередині робочого простору (наприклад, <workspace>/raw/recordings) і виконайте make restart." },
    RECORDINGS_FOLDER_UNREADABLE: { cause: "Densemble не може прочитати папку записів.",
      fix: "Перевірте, що папка існує і доступна для читання й запису; транскрипція відновиться сама з наступною перевіркою." },
    RECORDINGS_START_FAILED: { cause: "Транскрипція записів не змогла запуститися.",
      fix: "Перегляньте журнал сервісу (коди RECORDING_*), усуньте причину і виконайте make restart." },
    PATH_MISSING_OR_UNREADABLE: { cause: "Папку записів не знайдено або вона не читається.", fix: settingsFix },
    PATH_KIND_INVALID: { cause: "Шлях до папки записів веде не до папки.", fix: settingsFix },
    SYMLINK_PATH_REJECTED: { cause: "Шлях до папки записів містить символьне посилання.", fix: settingsFix },
    UNSAFE_PATH_OVERLAP: { cause: "Папка записів перетинається зі службовими файлами Densemble (код, дані, конфігурація, секрети).",
      fix: settingsFix },
  },
  prepare: (settings, core) => prepareRecordings(settings, core),
  doctor: (settings, core) => recordingDoctor(recordingSettings(settings, core.audio)),
  start: startRecordings,
};

/**
 * Starts the worker when its models are usable. A bad model keeps the module unavailable (with a disabled
 * status for `recordings-status`) without affecting the text and voice service.
 */
async function startRecordings(ctx: ModuleContext<RecordingsConfig>): Promise<ModuleInstance> {
  const { diagnostics } = ctx;
  const settings = recordingSettings(ctx.settings, ctx.core.audio);
  await adoptLegacyData(ctx.dataPath, diagnostics);
  const model = await checkWhisperModel(settings.modelPath);
  const vad = await checkVadModel(settings.vadModelPath);
  if (model !== "MEDIA_AUDIO_READY" || vad !== "MEDIA_AUDIO_READY") {
    // The host records the model code with the module's new state.
    diagnostics.record("RECORDINGS_DISABLED");
    try {
      await writeStatus(join(ctx.dataPath, "status.json"), { version: 1, updatedAt: new Date().toISOString(), enabled: false,
        pollIntervalMs: settings.pollIntervalMs, current: null, queue: [], waiting: [], conflicts: [], failed: [], recent: [] });
    } catch { diagnostics.record("RECORDINGS_STATUS_FAILED"); }
    throw new ModuleError(model !== "MEDIA_AUDIO_READY" ? MODEL_CODES[model] : "RECORDING_MODEL_MISSING", { unavailable: true });
  }
  // A bad retry model fails only retries (MODEL_UNAVAILABLE, reported per file); first passes go on.
  if (settings.retry.modelPath !== settings.modelPath && await checkWhisperModel(settings.retry.modelPath) !== "MEDIA_AUDIO_READY") {
    diagnostics.record("RECORDING_RETRY_MODEL_UNAVAILABLE");
  }
  const worker = createRecordingWorker({ settings, dataPath: ctx.dataPath, diagnostics, gate: ctx.core.speechGate,
    health: { fail: (code) => { ctx.fail(code); }, recovered: () => { ctx.recovered(); } } });
  try { await worker.start(); }
  catch {
    await worker.stop().catch(() => undefined);
    throw new ModuleError("RECORDINGS_START_FAILED");
  }
  return {
    invoke: async (name) => name === "recordings_status" ? statusResult(worker)
      : { ok: false, code: "RECORDINGS_ABILITY_UNKNOWN", message: "Unknown recordings ability." },
    status: () => statusLine(worker.snapshot()),
    stop: () => worker.stop(),
  };
}

/**
 * Spec 004 kept the worker's data in `runtimeDataPath/recordings`; it is renamed once into the module data
 * directory (`runtimeDataPath/modules/recordings`, same filesystem, atomic) before the orphan check, so
 * `active-process.json` is still honoured. The host has just created the target as an empty directory.
 */
export async function adoptLegacyData(dataPath: string, diagnostics: DiagnosticSink): Promise<void> {
  const legacy = join(dataPath, "..", "..", "recordings");
  try {
    if (!(await lstat(legacy)).isDirectory()) return;
  } catch { return; }
  try {
    await rename(legacy, dataPath);
    diagnostics.record("RECORDINGS_DATA_MOVED");
    return;
  } catch { diagnostics.record("RECORDINGS_DATA_MOVE_FAILED"); }
  // Both directories hold data (e.g. an older build ran again): the old one is kept, but a process it left
  // running is handed over, so the orphan check still ends it instead of letting it run beside a new one.
  const active = join(dataPath, "active-process.json");
  try { await lstat(active); return; } catch { /* None of our own: take over the legacy one. */ }
  await rename(join(legacy, "active-process.json"), active).catch(() => undefined);
}

/** The `status.json` snapshot: names relative to the recordings folder only, never transcript text. */
function statusResult(worker: RecordingWorker): AbilityResult {
  const { updatedAt, current, queue, waiting, conflicts, failed, recent } = worker.snapshot();
  const snapshot = { updatedAt, current, queue, waiting, conflicts, failed, recent } as unknown as Record<string, Json>;
  return { ok: true, ...snapshot };
}

/** Counts only: the line reaches `/status` and `state.json`. */
function statusLine(status: RecordingStatus): string {
  return `транскрибується: ${status.current ? 1 : 0}, у черзі: ${status.queue.length}, очікують: ${status.waiting.length}, ` +
    `конфлікти: ${status.conflicts.length}, помилки: ${status.failed.length}`;
}
