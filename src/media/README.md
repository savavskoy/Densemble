# Media adapter

`index.ts` exports `createMediaPipeline`, `MediaError`, `mediaMessages`,
`MEDIA_LIMITS`, `checkAudioReadiness`, and `runManagedProcess`, with their option
types. The factory is synchronous; filesystem initialization is lazy and async.

```ts
const media = createMediaPipeline({
  config, // LoadedConfig, or { runtimeDataPath, workspacePath }
  store,
  diagnostics,
  download: downloadFile,
  audio: { ffmpegPath, ffprobePath, whisperPath, modelPath },
});
```

## Bootstrap and application hooks

1. Acquire the service lock, open SQLite, call `store.recover()` once, and await
   `media.cleanup()` **before** accepting ingress. Run cleanup periodically and
   after explicitly deleting a session. It does not inspect user workspace or
   interactive CLI state.
2. Authenticate the owner/chat/topic and admit/deduplicate input **before**
   `prepare(input, identity, signal)`. The run must already be live. Ordinary
   inputs must be reserved to it; steering may instead pass an existing,
   durably **queued** input with `runId: null` in the **same scope/session**.
   The adapter rechecks live identity and the persisted input before effects and
   after asynchronous continuations. Queued inputs must stay queued, unassigned,
   and match the prepared snapshot (including album messages/readiness metadata).
   It never reserves, assigns, consumes or rewrites inbox input. The application
   must revalidate and atomically `attachToRun` immediately before steering.
   If the root finishes during preparation, media rejects and leaves the input
   queued for a later turn. Abort its signal on stop.
3. `PreparedInput.text` preserves every album message caption and includes extracted
   documents or an explicitly labelled automatic transcript. Display `notices`
   to the user, including the transcript and correction invitation. Check the
   current model's image capability before supplying `images` to the SDK; never
   silently change the model. Raw audio is never an SDK attachment.
4. Successfully prepared inputs and exports have per-artifact run processing
   pins. Call `releaseRun(identity)` after the runtime actually finishes/stops
   consuming files, including failure/disconnect paths. Do not release while
   still passing image paths to a live runtime. Failed preparation releases its
   own pins; validated nonaudio input files retain their normal seven-day expiry.
   In-progress, unregistered downloads/parsers have local ownership guards that
   prevent concurrent cleanup. Recovery removes abandoned SQLite processing pins.
5. `transcribe(attachment, scope, signal)` is deliberately stateless: question
   voice replies need not invent a run/session identity. The application must
   verify the pending request before starting it **and revalidate its exact
   identity/expiry after ASR**, then atomically claim the answer once.
6. Register an explicit export tool with concrete permission parameters.
   **After approval**, call `exportFile(identity, absolutePath, signal)`.
   A model mentioning a path is not export authorization. Enqueue its returned
   attachment ID in the durable outbox, including `attachmentIds: [id]`, before
   releasing the run pin. Nonterminal/uncertain outbox links protect files until
   delivery is resolved or explicitly discarded.
7. For confirmed session deletion: finish stop, release processing pins, use
   `store.sessions.delete(scope, sessionId)`, then pass **only its returned**
   `artifacts` to `removeArtifacts(artifacts)`. Live attachment rows cannot be
   deleted with this method. File deletion is idempotent; startup cleanup handles
   a crash after row deletion and before file removal.

`resolveAttachment(scope, id, signal?)` returns
`Promise<{ path, fileName, mimeType, sizeBytes }>` only for registered, owned,
unexpired **output** artifacts; inputs and audio cannot be resolved for sending.
An expired output file pinned by durable outbox remains
deliverable. It rechecks session/run relationships, scope, marker, all ancestors,
file size and expiry. Transport should resolve immediately before delivery, open
without following symlinks, and check actual stream bytes. Do not cache resolved
paths. Use `MediaError.userMessage` for a fixed safe explanation; never send/log
raw parser, transport, subprocess or document errors.

## Download contract

```ts
type MediaDownload = (
  botId: string,
  fileId: string,
  destination: string,
  signal: AbortSignal,
  maxBytes: number,
) => Promise<unknown>;
```

`destination` is **absent**, inside an already-created private random directory.
The downloader is its sole creator: open with
`O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600; refuse any existing file or
symlink. Enforce `maxBytes` against actual streamed bytes and honour abort.
Remove only the downloader's own inode on failure; do not rename or replace
files. The adapter checks absence and ancestors before download, then rechecks
regular-file status, link count, every ancestor, actual byte count and any
declared size. Telegram filenames are sanitized display metadata only.

Limits are decimal **20,000,000 incoming / 50,000,000 outgoing bytes**. UTF-8 text
rejects invalid sequences, NUL, empty content and more than 200,000 characters.
The aggregate prepared text has the same cap; oversized content is never
silently truncated. PNG/JPEG/WebP require matching signatures, full bounded image
decoding, at most 40 million pixels and dimensions no larger than 16,384.
PDF is text-only, at most 1,000 pages; encrypted, corrupt and image-only PDFs fail
explicitly. DOCX has a ZIP preflight before content extraction: at most 2,000
entries, 64 MB uncompressed total, 16 MB per entry, 100:1 compression ratio,
consistent headers/CRC/lengths, no duplicate/traversal/symlink entries, encrypted
entries, macros, embedded active objects, DTDs or entity declarations.

All document/image extraction runs in a serial worker queue, with a 30-second
timeout, 192 MB old-generation / 32 MB young-generation V8 limits and independent
image/archive allocation limits. These V8 heap limits alone do **not** constrain
ArrayBuffers or decoded PDF streams. PDF decoding therefore uses the separate
hard WebAssembly memory ceiling below. Abort terminates and awaits the actual worker.
`extraction: { timeoutMs?, maxCharacters? }` can lower, never raise, production
limits. `now` optionally supplies a deterministic lifecycle clock.

### Hard PDF decoded-memory limit

PDFium, the mature PDF engine used by Chrome, performs PDF decoding/text extraction
inside one WebAssembly linear memory, capped at **128 MiB** by the WebAssembly
engine itself. Input bytes and returned text are separately bounded; images are
not rendered and PDF JavaScript/actions are not executed.

The pinned `@embedpdf/pdfium@2.15.1` binary defines a 2 GiB maximum internally,
so its loader cannot accept an externally capped memory. `pdf.ts` verifies the
**entire vendor binary SHA-256**, its size and exact single-memory section before
lowering only that section's maximum in memory, using a same-width unsigned
LEB128 encoding. No PDF syntax is parsed or patched by this adapter. Original
installed files are never modified. Module validation and the WebAssembly engine
enforce the new maximum, including direct native growth attempts that bypass
JavaScript hooks. A hook records allocation failure so a parser cannot turn an
out-of-memory condition into apparently successful empty text.

`MEDIA_PDF_UNSAFE` reports a decoded-memory violation or inability to establish
this exact limit. A dependency upgrade must re-audit the pinned binary identity
and pass the native-growth and compressed-Flate-bomb regressions; mismatched
assets fail closed, never fall back to an unbounded parser. There is no Python
runtime dependency or claimed Darwin `RLIMIT_AS`/`RLIMIT_DATA` guarantee.

## Owned paths and export policy

Within the separately configured runtime data directory:

```text
media/
  incoming/<random-uuid>/payload
  outgoing/<random-uuid>/payload
  audio/<random-uuid>/payload
                       decoded.wav
                       transcript.txt
```

Each owned random directory also has `.densemble-media.json`, a bounded ownership
marker containing only IDs/scope/type, never transcript, original filename or
document content. SQLite paths are relative to `runtimeDataPath/media`.
Cleanup only touches validated marked directories and known files, never
recursively follows links, and leaves unknown directories/files alone.
Preparation reserves a directory as active **before** making it visible.
Cleanup rechecks activity after reading its marker and immediately before every
unlink/rmdir; it cannot delete a download that became active during an await.

Exports may originate from the configured workspace (which must match the owning
session), or `runtimeDataPath/generated/<sessionId>/<runId>`.
`generatedRunDirectory(identity)` safely creates/returns this current run directory.
Generation source files are **not** removed by media cleanup; application runtime
lifecycle owns them. An export copies the source into a random output directory
without deleting or modifying the source. Symlinks, hard links, directories,
traversal, other runs' generated files, and secret/configuration-bearing filenames
are rejected. Explicit permission plus path policy is not an OS sandbox and does
not claim to make arbitrary shell/MCP or concurrently modified user files safe.

## Local ASR prerequisites and lifecycle

Nothing installs FFmpeg/whisper.cpp or downloads an ASR model automatically.
Provision those explicitly and supply an absolute `audio.modelPath` pointing at
the **GGML multilingual small** whisper.cpp model (quantized variants supported).
The model header is checked for the small multilingual architecture, rejecting
`small.en` and other model families. This header check is not a model checksum or
proof of real recognition quality.

`AudioSettings` supports:

- `ffprobePath`, `ffmpegPath`, `whisperPath` (default command names are `ffprobe`,
  `ffmpeg`, `whisper-cli`);
- `modelPath` (required for ASR; no default download location);
- `language` (`auto` by default), `threads` (default 4, bounded to 1–8);
- lower `probeTimeoutMs`, `decodeTimeoutMs`, `asrTimeoutMs`;
- `processRunner` for deterministic tests, not a cloud-provider fallback.

Actual source duration is obtained using ffprobe, not Telegram metadata.
FFmpeg decodes mono 16 kHz PCM with a 601-second/20 MB bound, and a second ffprobe
checks decoded duration; anything over **600 seconds** is rejected before Whisper.
Only file/pipe input protocols are enabled. Voice work, including downloads, is
serialized at concurrency one; waiting and running requests are cancellable.
Subprocesses use literal spawn arguments, bounded stdout/stderr, explicit
timeouts, and an owned private process group terminated by exact PID/group
ownership. They are not unreferenced or left running. Raw/WAV/transcript files
are removed after success, failure or cancellation; only transcript text reaches
the application/session. Startup removes marked orphan audio.

`checkAudioReadiness(settings)` performs **non-executing prerequisite checks** and
returns `{ready, code}` (`MEDIA_AUDIO_READY`, `MEDIA_AUDIO_TOOLS_MISSING`, or
`MEDIA_AUDIO_MODEL_MISSING`). Doctor should expose this separately from a real
voice acceptance test. Tests cover real worker/process cancellation, synthetic
audio with installed ffmpeg/ffprobe when available, and a stand-in ASR runner.
They do **not** demonstrate Ukrainian ASR accuracy; that requires an explicitly
provisioned real model and a user-approved real sample.

Pinned parser dependencies: `@embedpdf/pdfium@2.15.1`, `mammoth@1.13.0`,
`yauzl@3.4.0`, `sharp@0.35.5`, and development types
`@types/emscripten@1.41.6`, `@types/yauzl@3.4.0`.
