# Recordings module

Turns recordings saved into one folder (calls, lectures, meetings) into text files next to
them, locally on this Mac. Everyday use, troubleshooting and every setting explained for the
owner: [user guide → Recording transcription](../../../docs/user-guide/recordings.md). The
folder/file contract and the only mutations Densemble makes:
[contracts → Recording transcription](../../../docs/contracts.md#recording-transcription).

- Id: `recordings`, version `1.0.0`; `requires`: none; `provides`: none yet.
- Optional: absent from `config.local.json` → nothing is loaded, checked or run.

## Settings

In `config.local.json`, then `make restart`:

```json
"coordinatorAgentId": "alfred",
"modules": {
  "recordings": {
    "enabled": true,
    "agents": ["alfred"],
    "settings": {
      "path": "/Users/you/workspace/raw/recordings",
      "modelPath": "./models/ggml-large-v3-turbo.bin",
      "vadModelPath": "./models/ggml-silero-v5.1.2.bin"
    }
  }
}
```

- `enabled` (default `true`): `false` switches the module off without removing its settings.
- `agents` (default `[]`): personas allowed to use `recordings_status` (see below).
- `settings`: exactly the spec 004 recordings fields with the same defaults — required `path`,
  `modelPath`, `vadModelPath`; optional `language`, `threads`, `vocabulary`, `quietMinutes`,
  `pollIntervalMs`, `vad`, `suppressNonSpeech`, `maxContext`, `retry`, `silence`,
  `notifications`. Table: [user guide → All settings](../../../docs/user-guide/recordings.md#all-settings);
  limits: [contracts → Configuration](../../../docs/contracts.md#configuration). Relative paths
  resolve from the config file's directory. Validation lives in `settings.ts`.

The old top-level `"recordings": { … }` block still works unchanged; it is treated as
`modules.recordings.settings` with `agents: []` and reported as moved (`MODULE_SETTING_MOVED`
in `make doctor` → `config-migration`, and in `make modules-status`). Having both is a config
error (`MODULE_SETTINGS_DUPLICATED`).

## Prerequisites

- FFmpeg/ffprobe and whisper.cpp (paths shared with `audio`).
- A multilingual whisper.cpp GGML model (`modelPath`) and the Silero VAD model
  (`vadModelPath`); optionally a stronger `retry.modelPath`. No automatic download.
- The folder must be an existing, non-symlink directory inside `workspacePath` or an
  owner-owned workspace and must not overlap Densemble's code, data, homes, config or secrets.

`make doctor` (service stopped) shows `module:recordings` plus `recordings-folder`,
`recordings-model`, `recordings-retry-model`, `recordings-vad` and `recordings-legacy-job`.

## Health

| State / code | Meaning |
|---|---|
| `ready` / `MODULE_READY` | Watching the folder. |
| `disabled` / `MODULE_DISABLED` | `enabled: false`; models and folder are not checked. |
| `unavailable` / `RECORDING_MODEL_MISSING`, `…_ENGLISH_ONLY`, `…_UNSUPPORTED` | A model file is missing or wrong; text and voice keep working. |
| `unavailable` / `RECORDINGS_PATH_OUTSIDE_WORKSPACE`, `UNSAFE_PATH_OVERLAP`, `PATH_*`, `SYMLINK_PATH_REJECTED` | `settings.path` is not acceptable. |
| `failed` / `RECORDINGS_FOLDER_UNREADABLE` | A scan pass could not read the folder; the next good pass returns to `ready`. |
| `failed` / `RECORDINGS_START_FAILED` | The worker could not start. |

Each code has a Ukrainian cause and fix (`reasons` in `index.ts`), shown by
`make modules-status`, the «Модулі» section of `/status` and `densemble_state`, and sent once
to the coordinator's chat. A failed recording is a per-file failure (status + macOS
notification), not a module failure.

## What it gives agents

One read-only ability, `recordings_status`: the file being transcribed, queue, recordings
still being written, conflicts, failures and recent transcripts — file names only, never
transcript text or full paths. Reference for agents: [`INSTRUCTIONS.md`](INSTRUCTIONS.md).

To allow an agent, list its persona id in `modules.recordings.agents` and run
`make restart`. Only the owner's sessions can call it. No ability starts, retries, moves,
renames or deletes anything.

## Files

- Data: `runtimeDataPath/modules/recordings/` — `status.json` (read by
  `make transcribe-status` / `recordings-status [--json]`), `active-process.json`, `work/`.
  The spec 004 folder `runtimeDataPath/recordings/` is renamed here once at the first start.
- Code: `index.ts` (definition, start), `settings.ts`, `worker.ts`, `filing.ts`,
  `transcribe.ts`, `silence.ts`, `status.ts`, `notify.ts`, `legacy.ts`, `doctor.ts`,
  `contract.ts`.
