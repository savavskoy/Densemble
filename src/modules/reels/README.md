# Reels module

Cuts short vertical reels (9:16, subtitles with the spoken word highlighted, a title) from
the owner's long videos — YouTube links or video files in their workspace — on request of an allowed
agent in Telegram. A toolbox, not a workflow: choosing moments, asking for approval and learning
the owner's taste belong to the owner's own skills in the workspace (spec 006).

- Id: `reels`, version `1.0.0`; `requires`: `recordings` (transcription with timecodes and
  speakers, `RecordingsApi.transcribeMedia`); `provides`: none.
- Optional: absent from `config.local.json` → nothing is loaded, checked or run.

## Settings

In `config.local.json`, then `make restart`:

```json
"modules": {
  "recordings": { "agents": ["alfred"], "settings": { "…": "…" } },
  "reels": {
    "agents": ["mr-beast"],
    "settings": {}
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `folder` | `<workspacePath>/raw/reels` | Prepared videos and their reels; must be inside an owner workspace, not overlapping Densemble's own paths. Created at start. |
| `ytDlpPath` | `/opt/homebrew/bin/yt-dlp` | yt-dlp for YouTube downloads. |
| `maxVideoMinutes` | `180` (max `180`) | Longer videos are rejected up front. |
| `maxHeight` | `1080` | Highest downloaded resolution (`720`, `1080`, `1440`, `2160`). |

FFmpeg/ffprobe paths are shared with `audio`. Transcription settings (models, language,
vocabulary, speakers and the owner's voice sample) are the recordings module's:
[recordings README → Speakers](../recordings/README.md#speakers).

## Prerequisites

- The recordings module enabled and `ready` (its models, plus the speaker models for labels).
- `brew install yt-dlp` for links (workspace files work without it). No automatic installs.
- FFmpeg with `libx264` and `aac` (Homebrew's has both). Subtitles are drawn as images, so
  libass/drawtext are not needed.

`make doctor` (service stopped) shows `module:reels`, `reels-folder` and `reels-yt-dlp`.

## Health

| State / code | Meaning |
|---|---|
| `ready` / `MODULE_READY` | Abilities work. |
| `unavailable` / `MODULE_DEPENDENCY_UNAVAILABLE` | The recordings module is not ready. |
| `unavailable` / `REELS_FOLDER_OUTSIDE_WORKSPACE`, `UNSAFE_PATH_OVERLAP`, `PATH_*`, `SYMLINK_PATH_REJECTED` | `settings.folder` is not acceptable. |
| `unavailable` / `REELS_FOLDER_UNAVAILABLE` | The folder cannot be created or read. |

A failed job (download, transcription, rendering) is reported to the agent and in
`reels_status`; it never fails the module.

## What it gives agents

`reels_prepare`, `reels_transcript`, `reels_cut`, `reels_status`; reference for agents:
[`INSTRUCTIONS.md`](INSTRUCTIONS.md). Background jobs report back to the chat where the ability
was called: finished reels arrive there as files, and the agent is woken with a note
(`[Densemble module reels] …`) when a video is ready, cut or failed.

Hard limits, enforced in code (spec 006, FR-021): only the owner, only in the workspace that holds
the folder; nothing is published; only the YouTube download leaves the Mac; cutting never
changes a workspace video or a transcript; existing reels are never replaced. A YouTube
download is deleted once its reels are cut and fetched again before the next cut (to save
disk).

## Files

```text
<folder>/<video id>/                 yt-<YouTube id> or file-<hash>
├── video.json                       title, duration, source, speakers
├── source.mp4                       downloaded video, deleted after each cut (workspace files are read in place)
├── transcript.txt                   [HH:MM:SS] Label: text
├── transcript.words.json            the same phrases with per-word timing
├── cuts.md                          what was cut, one section per request
└── reels/NN-<title-slug>.mp4        finished reels
```

- Data: `runtimeDataPath/modules/reels/` — `jobs.json` (20 newest jobs; a job running at a
  restart is reported `REELS_INTERRUPTED`), `work/` (overlay images, emptied at start).
- Code: `index.ts` (definition, abilities, jobs), `settings.ts`, `fetch.ts` (yt-dlp, ffprobe,
  workspace files), `store.ts` (video folders, `cuts.md`), `jobs.ts`, `render/` (validation,
  word snapping, subtitle layout, overlays with sharp, FFmpeg).
