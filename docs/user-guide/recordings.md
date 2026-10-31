# Recording transcription

Densemble can turn your recordings (calls, lectures, meetings) into text on its own.
You put a recording into one folder, and a little later a text file with everything
that was said appears next to it. Everything happens on your Mac: the audio is not
sent anywhere.

- [What it does](#what-it-does)
- [Before you start](#before-you-start)
- [Set up (once)](#set-up-once)
- [Everyday use](#everyday-use)
- [Checking progress](#checking-progress)
- [Reading a transcript](#reading-a-transcript)
- [Better spelling of names and terms](#better-spelling-of-names-and-terms)
- [Asking for a new transcript](#asking-for-a-new-transcript)
- [Your files are safe](#your-files-are-safe)
- [When something goes wrong](#when-something-goes-wrong)
- [All settings](#all-settings)
- [Asking an agent](#asking-an-agent)
- [Turning it off](#turning-it-off)
- [Moving from the standalone transcriber](#moving-from-the-standalone-transcriber)

## What it does

1. You save a recording into your **recordings folder**.
2. Densemble waits until the recording is really finished.
3. It moves the recording into a folder for its day, for example `2026/10/29/`.
4. It writes the text into a file next to the recording.
5. macOS shows a notification: "Transcription ready".

Silence, music and noise are skipped, the language is detected from the speech
itself, and Telegram voice messages always go first (see [below](#voice-messages-come-first)).

## Before you start

- A Mac with Apple Silicon and Densemble already running (see the main
  [README](../../README.md)).
- FFmpeg and whisper.cpp installed, for example with Homebrew:
  `brew install ffmpeg whisper-cpp`. If voice messages already work in Telegram,
  you have them.
- About 2 GB of free disk space for the speech models (5 GB with the optional
  retry model), plus about 120 MB per hour
  of recording while it is being transcribed.
- A recordings folder **inside your Densemble workspace** (the folder set as
  `workspacePath` in `config.local.json`), for example
  `<workspace>/raw/recordings`. Densemble refuses a folder elsewhere.

## Set up (once)

Run all commands from the Densemble folder.

**1. Download the two models** (about 1.6 GB; they stay in `models/` and are not
part of git):

```sh
curl -fL -o models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
curl -fL -o models/ggml-silero-v5.1.2.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

The first is the speech model; the second detects where speech is, so silence and
music are skipped.

Optional, for [new transcripts](#asking-for-a-new-transcript): the full
`ggml-large-v3` model (about 3 GB more). It is slower but more accurate, and is
used only for a repeated attempt:

```sh
curl -fL -o models/ggml-large-v3.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
```

Then add `"retry": { "modelPath": "./models/ggml-large-v3.bin" }` to the
recordings `settings` (step 2).

**2. Turn on the recordings module** in `config.local.json`, with the full path to
your recordings folder:

```json
"modules": {
  "recordings": {
    "agents": ["alfred"],
    "settings": {
      "path": "/Users/you/workspace/raw/recordings",
      "modelPath": "./models/ggml-large-v3-turbo.bin",
      "vadModelPath": "./models/ggml-silero-v5.1.2.bin"
    }
  }
}
```

The three `settings` lines are all you need. Everything else has sensible defaults
(see [All settings](#all-settings)). `agents` is optional: it lists the agents that
may tell you about your recordings ([Asking an agent](#asking-an-agent)).

Already have an older top-level `"recordings": { … }` block? It keeps working as
is; `make doctor` and `make modules-status` only remind you that it has moved to
`modules.recordings.settings`. Move it when convenient (do not keep both: that is a
configuration error).

**3. Check and start:**

```sh
make stop
make doctor      # "module:recordings" and every "recordings-…" line should say ready
make start
make transcribe-status
make modules-status   # recordings — ready
```

If `make transcribe-status` says "Idle: nothing is being transcribed.", you are
done. If `make doctor` shows a problem, see
[When something goes wrong](#when-something-goes-wrong).

## Everyday use

### Getting a recording into the folder

Either way works:

- **Record straight into the folder.** In OBS: Settings → Output → Recording
  Path → your recordings folder. OBS names files like `2026-10-29 15-13-24.mkv`,
  and Densemble uses that date for the day folder.
- **Copy or move a file in**: from a phone, a dictaphone, Zoom, anywhere. Supported
  formats: m4a, mp3, wav, mp4, mkv, mov, flv, webm, ogg, opus, aac. For a file not
  named by OBS, the day is the date the file was last changed.

Put recordings in the top of the folder, not in your own subfolders: Densemble
does not look inside folders it did not create.

### What happens next

You don't need to do anything. Densemble checks the folder every minute. A
recording is taken only when:

- no app has it open any more (OBS has stopped recording, the copy has finished);
- it has not changed for 2 minutes;
- it can actually be read as audio or video.

Then it is moved into its day folder and transcribed. Recordings are handled one
at a time, oldest first. A new recording that arrives during a long queue is
noticed and joins the queue.

### Where to find the text

```text
recordings/
└── 2026/
    └── 10/
        └── 29/
            ├── 2026-10-29 15-13-24.mkv
            └── transcript_2026-10-29_2026-10-29_15-13-24.txt
```

The transcript is named `transcript_<day>_<recording name>.txt`; spaces in the
recording name become `_`.

### How long it takes

On a recent Mac a two-hour lecture took about 3–4 minutes. Older or busier Macs
take longer. You can watch progress with
[`make transcribe-status`](#checking-progress).

### Voice messages come first

If someone sends a voice message to a Densemble bot while a recording is being
transcribed, the recording is paused, the voice message is answered at normal
speed, and the recording continues where it stopped. `/stop` in Telegram stops a
chat reply, not recording transcription.

### Restarts and sleep

Restarting Densemble or the Mac is safe. Unfinished work is thrown away and the
recording is transcribed again from the start; a half-written transcript never
appears.

## Checking progress

```sh
make transcribe-status
```

Example:

```text
Transcribing: 2026/10/29/2026-10-29 15-13-24.mkv
  42% done, about 2 min left
Queued (1):
  2026/10/29/call.m4a
Waiting to finish recording (1):
  2026-10-29 18-00-00.mkv
Recently done (1):
  2026/10/28/transcript_2026-10-28_lecture.txt
```

If a recording has a long stretch with no sound signal at all (at least a minute,
for example OBS lost its microphone), the status says so under the recording and
next to it in "Recently done", and so does the "Transcription ready" notification:

```text
Recently done (1):
  2026/10/29/transcript_2026-10-29_2026-10-29_09-03-05.txt — no audio signal from 13:23 to the end (68 min)
```

Nothing is wrong with the transcript then: that part of the recording is simply
empty. Check your recording setup.

| Line | Meaning |
|---|---|
| Transcribing | The recording being processed now, % done and time left. "Paused for a voice message" is normal. |
| Queued | Recordings waiting for their turn. |
| Waiting to finish recording | Still being recorded or copied, or changed less than 2 minutes ago. |
| Conflicts | Recordings Densemble will not touch until you sort them out (see [below](#when-something-goes-wrong)). |
| Failed | Recordings that could not be transcribed. They are tried again after the next restart. |
| Recently done | The latest transcripts. |

For scripts: `node dist/main.js recordings-status --json --config config.local.json`.

## Reading a transcript

- Plain UTF-8 text, one phrase per line, without timestamps.
- Silence, music and noise are left out; so are lines like `[Music]` or
  `(applause)`.
- If the same line, sentence or phrase repeats three or more times in a row (a typical
  recognition glitch), only one copy is kept. Each part of the recording is
  recognised on its own, so one misheard phrase does not spread into the next
  minutes.
- `[no speech detected]` means the recording had no speech, for example an empty
  test recording.

Automatic transcripts are good but not perfect: proper names and rare terms can
come out wrong. Check anything important against the recording.

## Better spelling of names and terms

Give Densemble a list of words it should spell correctly: names, organisations,
terms. Add `vocabulary` to the recordings `settings`:

```json
"settings": {
  "path": "…",
  "modelPath": "./models/ggml-large-v3-turbo.bin",
  "vadModelPath": "./models/ggml-silero-v5.1.2.bin",
  "vocabulary": ["НБУВ", "бібліотекознавство", "Densemble"]
}
```

Up to 100 entries, each up to 60 characters. Without it, the `vocabulary` from the
`audio` block (used for voice messages) is used. Run `make restart` after the
change. It only affects new transcripts.

## Asking for a new transcript

If a transcript came out badly, you can ask for a second attempt with a stronger
speech model: `retry.modelPath`, for example the full `ggml-large-v3`
([Set up](#set-up-once), step 1). It is slower (about 2–3 minutes per hour of
recording instead of 1) and gets more words right. Speech detection stays the same
as in the first attempt, because stricter filtering drops quiet speech. Without
`retry.modelPath` the second attempt uses the same model and settings again.

1. **Keep the old transcript** by renaming it with `.attempt-1` before `.txt`:

   ```text
   transcript_2026-10-29_call.txt  →  transcript_2026-10-29_call.attempt-1.txt
   ```

2. **Add a line** to `review-log.tsv` in the top of your recordings folder (create
   it if it doesn't exist). The columns are separated by tabs: time, the word
   `retranscribe`, and the transcript's path inside the recordings folder:

   ```sh
   printf '%s\tretranscribe\t%s\n' "$(date '+%Y-%m-%d %H:%M')" \
     "2026/10/29/transcript_2026-10-29_call.txt" >> "/Users/you/workspace/raw/recordings/review-log.tsv"
   ```

Within a minute or so the new attempt starts; `make transcribe-status` marks it
"(retry)". The result is a new `transcript_2026-10-29_call.txt`; the old one stays
as `.attempt-1.txt`, so you can compare. If you only rename the old file without
step 2, nothing happens: Densemble treats the recording as done.

## Your files are safe

Densemble never deletes, overwrites or renames your recordings or transcripts.
The only things it does in the recordings folder are:

- move a finished recording from the top of the folder into its day folder;
- create a transcript that does not exist yet;
- use a short-lived hidden temporary file `.densemble-….partial`, removed
  automatically.

It never writes to `review-log.tsv`. If something is in the way (a file with the
same name already in the day folder, for example), it stops and reports a
conflict instead of guessing.

## When something goes wrong

### What `make transcribe-status` says

| Message | What to do |
|---|---|
| Recording transcription is off (no recordings folder configured) | Add `modules.recordings` ([Set up](#set-up-once)), or set its `enabled` to `true`, and `make restart`. |
| Recording transcription is off (model or VAD model not ready; run make doctor) | A model file is missing or wrong. Run `make stop`, `make doctor`, fix what it shows, `make start`. |
| Recording transcription: service not running | Densemble is not running or is stuck. `make status`, then `make start` or `make restart`. |
| A file stays in "Waiting to finish recording" | Some app still has it open (OBS still recording, a copy still running), or it keeps changing. Close the app or wait. |

### Conflicts

| Reason | Meaning and fix |
|---|---|
| `TARGET_EXISTS` | The day folder already has a file with this name. Rename one of them; Densemble picks it up on the next check. |
| `SAME_KEY` | Two recordings in the same day folder have the same name with different extensions (`call.m4a` and `call.mp4`). Only the older one is transcribed; rename the other one. |
| `TARGET_UNSAFE` | The day folder path is not a normal folder (for example a link). Replace it with a normal folder. |

### Failures

A failed recording gets a "Transcription failed" notification and is listed under
"Failed". It is tried again after `make restart`.

| Reason | Meaning and fix |
|---|---|
| `DECODE_FAILED` | The file is damaged or has no sound track. Check that it plays. |
| `ASR_FAILED` | Speech recognition crashed. Check `make doctor`; try `make restart`. |
| `TIMEOUT` | It took far too long. Usually the Mac is overloaded; restart later. |
| `DISK_FULL` | Not enough free disk space. Free some space and `make restart`. |
| `MODEL_UNAVAILABLE` | A model file was moved or damaged. Download it again ([Set up](#set-up-once), step 1). |
| `TARGET_EXISTS` | A transcript with this name appeared while it was working. Nothing was overwritten; check which file you want. |
| `OUTPUT_INVALID` | The recognizer produced unreadable output. Ask for a [new transcript](#asking-for-a-new-transcript). |

### What `make doctor` says

Run it with the service stopped (`make stop` first).

| Line | If not ready |
|---|---|
| `recordings-folder` | The folder doesn't exist, can't be read, or isn't inside your workspace. Fix `modules.recordings.settings.path`. |
| `recordings-model` | `…MODEL_MISSING`: download the model. `…ENGLISH_ONLY`: you used a `.en` model; use the multilingual one. `…UNSUPPORTED`: not a whisper.cpp model file. |
| `recordings-retry-model` | The same for `retry.modelPath` (or the main model when it is not set). New first attempts still work; only repeated attempts fail with `MODEL_UNAVAILABLE`. |
| `recordings-vad` | The Silero file is missing or wrong; download it again. |
| `recordings-legacy-job` | An older standalone transcriber is still installed on this Mac. Densemble and it take turns safely, but remove the old one; see [Moving from the standalone transcriber](#moving-from-the-standalone-transcriber). |

## All settings

All of these go in `modules.recordings.settings` of `config.local.json` (or in the
older top-level `recordings` block, if you still have it). Only the first three are
required. Run `make restart` after any change.

| Setting | Default | What it does |
|---|---|---|
| `path` | (required) | Your recordings folder, inside the workspace. |
| `modelPath` | (required) | Speech model file. |
| `vadModelPath` | (required) | Speech-detection model file. |
| `language` | `"auto"` | Language of the recordings, for example `"uk"` or `"en"`. `"auto"` detects it per recording. |
| `vocabulary` | from `audio` | Words to spell correctly ([details](#better-spelling-of-names-and-terms)). |
| `threads` | `4` | CPU cores to use. More is faster but leaves less for other work. |
| `quietMinutes` | `2` | How long a file must stay unchanged before it is taken (1–60). |
| `pollIntervalMs` | `60000` | How often the folder is checked, in milliseconds (30 000–300 000). |
| `notifications` | `true` | macOS notifications when a transcript is ready or failed. |
| `retry.modelPath` | the main model | Speech model for [repeated attempts](#asking-for-a-new-transcript), for example `./models/ggml-large-v3.bin`. |
| `vad` | tuned | Speech detection: `threshold` 0.35, `minSpeechMs` 250, `minSilenceMs` 500, `padMs` 200 (measured on real lectures and calls, 2026-10-30). Leave as is unless you know why. |
| `suppressNonSpeech`, `maxContext` | `false`, `0` | Recognition flags (`-sns`, `-mc`). `maxContext` 0 recognises each part on its own and prevents repeated-phrase loops. |
| `retry.vadThreshold`, `retry.vadMinSpeechMs`, `retry.suppressNonSpeech`, `retry.maxContext` | as the first attempt | Different settings for repeated attempts only. |
| `silence` | `thresholdDb` −80, `minSeconds` 60 | What counts as a stretch [without audio signal](#checking-progress): quieter than −80 dB for at least 60 s. |

`config.example.json` shows every setting with its default.

## Asking an agent

Agents listed in `modules.recordings.agents` (for example `["alfred"]`) can check
transcription for you: ask «що з транскрипцією записів?» in your own chat and the
agent answers from the same status as `make transcribe-status`. Agents only read
the status: they cannot start, retry, move or delete anything, and they answer
only you (the owner), never other users. Change the list and run `make restart`.

If something is wrong with the module (for example a missing model), `make
modules-status` and the «Модулі» section of `/status` show the cause and what to
do, and the coordinator agent (`coordinatorAgentId`) tells you once in its chat.

## Turning it off

Set `"enabled": false` in `modules.recordings` (the settings stay for later) or
remove `modules.recordings` from `config.local.json`, then run `make restart`.
Your recordings and transcripts stay where they are.

## Moving from the standalone transcriber

Only for Macs that used the older standalone transcriber
(`com.openclaw-jazz.transcribe-recordings` launchd job). Do it once, in this
order; at no point are files transcribed twice:

1. Set up recordings in Densemble as [above](#set-up-once) and `make restart`.
   While the old job is installed, `make doctor` reports `recordings-legacy-job`
   not ready, and the two take turns through the old job's lock.
2. Check `make transcribe-status`, then remove the old job:

   ```sh
   launchctl bootout gui/$(id -u)/com.openclaw-jazz.transcribe-recordings
   mv ~/Library/LaunchAgents/com.openclaw-jazz.transcribe-recordings.plist \
      ~/Library/LaunchAgents/com.openclaw-jazz.transcribe-recordings.plist.retired
   ```

3. `make restart`. The warning is gone. Existing transcripts, `review-log.tsv`
   and review tools keep working: the file layout is the same.
