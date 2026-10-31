## recordings_status

### Purpose

Shows what recording transcription is doing now: the recording being transcribed, the queue,
recordings that are still being written, conflicts, failures and recently finished transcripts.
Use it when Oleh asks about his recordings or transcripts, or when an expected transcript has
not arrived.

### Inputs

None. Call it with an empty object `{}`.

### Returns

`{ ok: true, updatedAt, current, queue, waiting, conflicts, failed, recent }`:

- `current`: `null` when idle, otherwise `{ file, mode, startedAt, percent, etaSeconds, paused,
  silences? }`. `mode` is `first` or `retry`; `paused` is true while a voice message is being
  transcribed; `etaSeconds` may be `null`.
- `queue`: recordings waiting to be transcribed, oldest first.
- `waiting`: recordings that are still being written (not finished yet).
- `conflicts`: `{ file, reason }` items that need Oleh (for example, `TARGET_EXISTS`).
- `failed`: `{ file, code, at }` items; they are tried again after the next restart.
- `recent`: up to 20 finished items `{ file, transcript, at, silences? }`, newest first.
- `silences`: long stretches without an audio signal, `{ startSeconds, durationSeconds, toEnd? }`.

Every `file` and `transcript` is a name relative to the recordings folder, such as
`2026/10/29/meeting.m4a`.

### Limits

Read-only. It returns names only: never transcript text, recording content or full paths.
It does not start, retry, move, rename or delete anything, and no ability does: recordings and
transcripts are never deleted, renamed, emptied or overwritten.

### Errors

- `MODULE_UNAVAILABLE`: recording transcription is not running; call `densemble_state` with
  `module: "recordings"` and tell Oleh its cause and fix.
- `MODULE_FAILED`: the module could not answer; the rest of Densemble keeps working.

How abilities are combined is decided by the owner's skills and requests.
