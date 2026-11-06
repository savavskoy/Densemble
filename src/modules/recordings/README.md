# Recordings module

Turns recordings saved into one folder (calls, lectures, meetings) into text files next to
them, locally on this Mac. Everyday use, troubleshooting and every setting explained for the
owner: [user guide → Recording transcription](../../../docs/user-guide/recordings.md). The
folder/file contract and the only mutations Densemble makes:
[contracts → Recording transcription](../../../docs/contracts.md#recording-transcription).

- Id: `recordings`, version `1.1.0`; `requires`: none; `provides`: `RecordingsApi`
  (`api.ts`): `transcribeMedia(...)` — the same transcription for any media file (used by
  `reels`), on the worker's lane — plus `readTimedTranscript`/`formatTranscript`.
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
  `notifications`; new in spec 006: `speakers` (see [Speakers](#speakers)). Table: [user guide → All settings](../../../docs/user-guide/recordings.md#all-settings);
  limits: [contracts → Configuration](../../../docs/contracts.md#configuration). Relative paths
  resolve from the config file's directory. Validation lives in `settings.ts`.

The old top-level `"recordings": { … }` block still works unchanged; it is treated as
`modules.recordings.settings` with `agents: []` and reported as moved (`MODULE_SETTING_MOVED`
in `make doctor` → `config-migration`, and in `make modules-status`). Having both is a config
error (`MODULE_SETTINGS_DUPLICATED`).

## Prerequisites

- FFmpeg/ffprobe and whisper.cpp (paths shared with `audio`), including its
  `whisper-vad-speech-segments` tool next to `whisper-cli` (Homebrew and source builds ship both).
- A multilingual whisper.cpp GGML model (`modelPath`) and the Silero VAD model
  (`vadModelPath`); optionally a stronger `retry.modelPath`. No automatic download.
- The folder must be an existing, non-symlink directory inside `workspacePath` or an
  owner-owned workspace and must not overlap Densemble's code, data, homes, config or secrets.

- For speaker labels: `models/speaker-segmentation.onnx` and `models/speaker-embedding.onnx`
  (see [Speakers](#speakers)); without them transcripts are still written, every phrase
  labelled `Speaker`.

`make doctor` (service stopped) shows `module:recordings` plus `recordings-folder`,
`recordings-model`, `recordings-retry-model`, `recordings-vad` and `recordings-speakers`.

## Recognition

VAD runs first, on its own (`whisper-vad-speech-segments`, `-vmsd 25`); speech is cut into chunks of at
most 25 s (`chunks.ts`), and one `whisper-cli` run decodes every chunk as its own file, loading the model
once. Decoding the whole recording in one input dropped text: whisper.cpp reads it in 30 s windows and, on
repeated takes, jumps to the window end (2026-11-05: a 44-min recording lost whole sentences, ~31% of its
words). Cost: ~3–4 min per hour of audio instead of ~1.

## Transcripts

Each recording gets `<key>.txt` — one `[HH:MM:SS] Label: text` line per phrase — and
`<key>.words.json` with the same phrases and per-word timing (spec 006). Format, labels and
the pipeline: [contracts → Recording transcription](../../../docs/contracts.md#recording-transcription).
Transcripts made before spec 006 stay plain text; ask for a new transcript to upgrade one.

## Speakers

`settings.speakers` (all optional): `enabled` (default `true`), `ownerName` (default: the
top-level `ownerName`, else `"Owner"`), `ownerSamplePath` (a 30–60 s recording of only the
owner's voice; any FFmpeg format), `segmentationModelPath` / `embeddingModelPath` / `verificationModelPath` (default
`./models/speaker-segmentation.onnx` / `./models/speaker-embedding.onnx` /
`./models/speaker-verification.onnx`, the last one needed only with `ownerSamplePath`),
`clusterThreshold` (default `0.7`) and `ownerThreshold` (default `0.5`).

Models: pyannote segmentation 3.0 and wespeaker ResNet34 (VoxCeleb) from the sherpa-onnx
releases — download commands in the [user guide](../../../docs/user-guide/recordings.md#speakers).
Calibration (2026-10-31, a 21-minute two-person call): wespeaker clustered the two voices
at 0.7 (0.5 split one voice into ~8 clusters, 0.9 merged both); CAM++, ERes2Net and TitaNet
fragmented into 7–23 clusters even at 1.1. Naming the owner is a different job: wespeaker
scored strangers on calls up to 0.94, above the owner himself (0.80 on a stage talk), while
CAM++ (3D-Speaker, `verificationModelPath`) gave the owner 0.66–0.70 and strangers at most 0.38
on the same recordings, so the owner match uses CAM++ with `ownerThreshold` 0.5. Separation costs ~2 min per hour of audio on an
M4 and runs in a child process (`speakers/worker.ts`).

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
- Code: `index.ts` (definition, start, `transcribeMedia`), `api.ts`, `settings.ts`,
  `worker.ts`, `lane.ts`, `filing.ts`, `transcribe.ts`, `timed.ts` (words, speakers,
  phrases, format), `speakers/` (diarization API and child worker), `silence.ts`,
  `status.ts`, `notify.ts`, `doctor.ts`, `contract.ts`. `media-work/` in the
  data directory holds `transcribeMedia` work files.
