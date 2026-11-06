Reels: short vertical videos (9:16) cut from the owner's long videos. Four abilities, usable in any
order. Videos are identified by a `video` id returned by `reels_prepare` and listed by
`reels_status`: `yt-<YouTube id>` for links, `file-<hash>` for workspace files.

Times are accepted as `HH:MM:SS`, `MM:SS`, `SS` (fractions with `.` or `,` allowed, e.g.
`12:31.5`) or a number of seconds. Transcript lines use `[HH:MM:SS] Label: text`; a label is
the owner's name when their voice was recognised, `Speaker N` for other voices (numbered by first
appearance), or `Speaker` when voices could not be separated.

Background notes arrive as your own new turn starting with `[Densemble module reels]`.

## reels_prepare

### Purpose

Gets a video ready for reading and cutting: downloads it from YouTube (or takes a video file
from the owner's workspace) and transcribes it with timecodes and speakers, in the background.

### Inputs

- `source` (required): a YouTube link (`youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…`,
  `/live/…`) or a path to a video file (`.mp4`, `.mov`, `.m4v`, `.mkv`, `.webm`, `.avi`) inside
  the owner's workspace, absolute or relative to it.
- `fresh` (optional, default `false`): `true` downloads and transcribes again even when the
  video was prepared before. Reels already cut stay.

### Returns

`{ ok: true, video, state, message, job?, title?, durationSeconds? }`:

- `state: "started"`: a job was queued; a note follows when it is ready (with the number of
  phrases and the speaker labels) or failed (with the stage and code).
- `state: "ready"`: already prepared; no job, no later note. `title` and `durationSeconds`
  are included.
- `state: "running"`: a job for this video is already queued or running.

### Limits

- Videos up to 3 hours (setting); longer ones are rejected, never truncated. Live or upcoming
  streams are rejected.
- Only YouTube downloads leave the Mac; transcription and speaker separation run locally.
  Nothing is uploaded or published anywhere.
- A workspace file is read in place and never changed, moved or copied.
- One job runs at a time; others wait in order. A 1-hour video usually takes 10–30 minutes.
- Works only for the owner, in the workspace that holds the reels folder.

### Errors

- `REELS_SOURCE_INVALID`: not a YouTube link and not a video file inside the workspace.
- `REELS_OWNER_ONLY`, `REELS_WORKSPACE_DENIED`: wrong user or workspace; final.
- In the failure note: `REELS_YTDLP_MISSING` (the owner must run `brew install yt-dlp`),
  `REELS_VIDEO_UNAVAILABLE` (private, removed or restricted), `REELS_FETCH_FAILED`,
  `REELS_VIDEO_TOO_LONG`, `REELS_VIDEO_LIVE`, `REELS_SOURCE_INVALID` (no video stream),
  `RECORDING_*` (transcription failed, e.g. `RECORDING_MODEL_UNAVAILABLE`,
  `RECORDING_DISK_FULL`), `REELS_INTERRUPTED` (Densemble restarted; call it again).

## reels_transcript

### Purpose

Reads a prepared video's transcript: phrases with start timecodes and speaker labels, whole or
for a time range.

### Inputs

- `video` (required): the video id.
- `from`, `to` (optional): time range; phrases overlapping it are returned. Default: the whole
  video.

### Returns

`{ ok: true, video, title, durationSeconds, speakers, text, truncated?, next? }`: `text` holds
one `[HH:MM:SS] Label: text` line per phrase; `speakers` lists the labels used in the whole
video. At most about 40 000 characters per call: when more remain, `truncated: true` and
`next` is the timecode to pass as `from` in the next call.

### Limits

Read-only. Timecodes are within about a second of speech; speaker labels can be wrong where
people talk over each other. Music or silence has no lines; nothing is translated.

### Errors

- `REELS_VIDEO_UNKNOWN`: no prepared video with this id.
- `REELS_VIDEO_NOT_PREPARED`: preparation is still running or its transcript is missing.
- `REELS_TIME_INVALID`: a time cannot be read, or `to` is not after `from`.

## reels_cut

### Purpose

Cuts exactly the given reels from a prepared video into vertical videos and delivers them to
this chat and to the video's folder in the owner's workspace, together with a list of what was cut.

### Inputs

- `video` (required): the video id.
- `reels` (required, 1–20 entries): each `{ start, end, title, subtitles?, showTitle? }`:
  - `start`, `end`: times in the source video.
  - `title`: 1–120 characters, one line; shown on top during the first 3 seconds and used in
    the file name.
  - `subtitles` (default `true`): burned-in subtitles in the spoken language with the current
    word highlighted.
  - `showTitle` (default `true`): `false` leaves the title out of the picture (it still names
    the file).

### Returns

`{ ok: true, video, job, reels, message }`: the job was queued. Each reel is sent to this chat
as a file when ready, captioned `NN · title` and its range; then a note lists the files. On a
failure the note names the code and how many reels were finished.

### Limits

- The whole list is checked before anything is cut; one bad entry rejects all of it.
- Each reel is 5 s to 3 min, inside the video, and does not overlap another entry.
- Boundaries move slightly onto whole words (never into the middle of a word); nothing is
  added, dropped, merged or reordered.
- 1080×1920, centre crop (an off-centre speaker may be cut off), under 50 MB.
- A workspace video file and every transcript are never changed. A video downloaded from
  YouTube is deleted from the video's folder once its reels are cut (to save disk); the next
  cut of that video downloads it again first (the job shows `stage: "fetching"`). Existing
  reels are never replaced; numbering continues after them.
- One job runs at a time; a 60-second reel usually takes well under a minute.

### Errors

- `REELS_CUTS_REJECTED`: the message lists every problem as `reel N: CODE`:
  `REELS_TIME_INVALID`, `REELS_CUT_INVALID`, `REELS_CUT_OUT_OF_RANGE`, `REELS_CUT_TOO_SHORT`,
  `REELS_CUT_TOO_LONG`, `REELS_CUT_OVERLAP (with reel M)`, `REELS_CUT_TITLE_INVALID`, or
  `list: REELS_CUTS_EMPTY` / `REELS_CUTS_TOO_MANY`.
- `REELS_VIDEO_UNKNOWN`, `REELS_VIDEO_NOT_PREPARED`, `REELS_VIDEO_BUSY` (a job for the video
  is queued or running).
- `REELS_SOURCE_CHANGED`: the workspace file changed since it was prepared.
- In the failure note of a cut that had to download again: the fetch codes of `reels_prepare`.
- In the failure note: `REELS_DISK_FULL`, `REELS_RENDER_FAILED`, `REELS_OVERLAY_FAILED`,
  `REELS_OUTPUT_INVALID`, `REELS_TOOLS_MISSING`, `REELS_TIMEOUT`, `REELS_TARGET_EXISTS`,
  `REELS_INTERRUPTED`.

## reels_status

### Purpose

Shows how far reels jobs are and which videos are prepared.

### Inputs

- `video` (optional): only this video's jobs and record.

### Returns

`{ ok: true, jobs, videos }`:

- `jobs`: up to 20 newest jobs `{ id, kind, videoId, stage, percent, etaSeconds, createdAt,
  updatedAt, finishedAt?, code?, reels? }`. `kind` is `prepare` or `cut`; `stage` is
  `queued`, `fetching`, `transcribing`, `cutting`, `done` or `failed`; `percent` is of the
  current stage; `etaSeconds` may be `null`; `reels` is `{ done, total }` for cuts.
- `videos`: up to 20 prepared videos, newest first: `{ id, title, durationSeconds, preparedAt,
  speakers, reels }`, where `reels` is the number of reels cut so far and `speakers` is
  `separated`, `unavailable` or `off`.

### Limits

Read-only. No paths and no transcript text.

### Errors

- `REELS_OWNER_ONLY`, `REELS_WORKSPACE_DENIED`: wrong user or workspace.
- `MODULE_UNAVAILABLE`: the module is not running; call `densemble_state` with
  `module: "reels"` and tell the owner its cause and fix.

Which moments to cut, and whether to ask the owner first, is decided by the owner's skills and
requests.
