# Configuration and state contracts

The module boundary is ordinary TypeScript: [domain](../src/domain.ts) contains
service-owned values, [ports](../src/ports.ts) contains narrow interfaces.
SDK types belong in `agents`, Telegram types in `telegram`, SQL in `storage`.
None of these modules starts a runtime, polls Telegram, or performs media IO.

## Configuration

`loadConfig(configPath, { codeRoot? })` in `src/config/index.ts` loads an explicit
private JSON file. Copy `config.example.json` to ignored `config.local.json`,
replace **all** synthetic IDs/references, and provision directories before loading.
Relative paths resolve beside that configuration file, not beside the executable.
`codeRoot` defaults to the process working directory; bootstrap should supply it
explicitly if launched from elsewhere.

- `workspacePath` is the external agent workspace, never the service source tree.
  `agentDefinitionsPath`, `agentLaunchersPath`, and every declared skill directory
  must exist inside it. Explicit `workspace/agent/skills` inclusion is required.
- `runtimeDataPath` (SQLite/media) and `runtimeHomePath` (service Copilot OAuth and
  history) must exist, be mutually disjoint, and not overlap the workspace or
  interactive CLI home. `interactiveHomePath` defaults to the user's `.copilot`.
  Symlink paths are rejected. Loading does not initialize OAuth or change files.
- `secretsPath` must explicitly reference an external `secrets.local.json`.
  Credentials are never migrated. `tokenForBot(id)` and `resolveSecret(ref)` are
  in-memory accessors; the returned configuration contains references, not values.
  Do not log their return values or transport exceptions containing credentials.
- Bots have unique IDs, persona bindings, and resolved Telegram token identities.
  Bindings require an explicit `kind` (`private`, `group`, `forum`) and `topicId`
  (`null` outside forums). A group/topic has exactly one consumer; different bots
  may independently bind the same private chat.
- `authorizeScope(config, candidate)` checks the numeric owner, bot sender flag,
  bot, chat, kind, and exact topic before any expensive or external operation.
  Legacy configurations without `users` remain restricted to `ownerId`. A
  configured `users` entry grants only its listed bots, and only a matching
  explicitly bound private chat; group and forum bindings remain owner-only.
- Optional `users` entries contain `telegramUserId`, optional `displayName`, and
  a nonempty unique list of configured `allowedBotIds`. The owner is implicit
  and must not also appear in `users`.
- Optional `workspaces` entries contain a unique stable `id`, display `name`,
  `access` (`private` or `shared`), `ownerUserId`, optional
  `memberUserIds`, an existing local directory `path`, and permitted
  user-invocable `agentIds`. Every member must be the owner or a configured
  user. A private workspace contains only its owner. The workspace owner is
  implicitly a member; it is not automatically added to other workspaces.
  Workspace paths must be canonical, non-symlink, distinct and disjoint from
  service code, instructions, credentials and runtime paths. A directory does
  not need Git metadata and must not overlap another workspace entry.
- Each private user chat gets its own conversation scope. A user with exactly
  one available workspace starts there. With multiple available workspaces,
  Densemble starts the conversation in an empty lobby that cannot be opened as
  a Copilot session; the user must select a workspace first. `/workspace` lists
  authorized IDs/names, while `/workspace <id>` selects one and creates a new
  session without transferring prior conversation context. Unknown or
  unauthorized IDs receive the same generic denial.
- A session's stored workspace path is checked against the user's current
  membership before opening it and before exporting a file. The service
  workspace remains the owner's default, not a fallback for other users.
  Non-owner Copilot sessions omit global MCP servers and service-wide skills
  and receive a user instruction naming the person once per session from the
  configured `displayName` (neutral "a user" if absent). Tool requests that visibly refer to
  another configured workspace or use parent traversal, home-relative paths or
  `.git` are denied. This lexical check cannot reliably stop arbitrary absolute
  paths, shell indirection or every tool escape; it is not a security boundary
  for mutually untrusted users. The Mac's service account/administrator can
  access all local workspaces. Do not treat private workspace membership as
  OS-level confidentiality.
- A workspace path may equal the configured agent workspace exactly (explicit
  co-location of knowledge and agent instructions); any ancestor/descendant
  overlap with it, the code, runtime, config or secrets paths is rejected.
  Members of a co-located shared workspace can read and modify agent
  instructions.
- Git integration is intentionally outside this feature: Densemble does not
  initialize Git, configure remotes or credentials, create commits, push, or
  synchronize workspace contents.
- Optional `permissionMode` defaults to `"autopilot"` for all agents; `"manual"`
  explicitly enables per-action confirmation. Autopilot grants ordinary tool requests once without a Telegram
  approval prompt, including exports. Both modes require a matching live native
  session and a confirmed SDK connection, rechecking liveness after the check.
  Managed-policy approval requirements, sandbox escalation, detached processes
  and excluded tools remain denied. Questions are not auto-answered. This
  service-wide owner setting takes effect on restart, never via agent input.
- Optional `bots[].engine` is `"copilot"` (default) or `"claude-code"`; optional
  `bots[].model` overrides the new-session model. A Claude Code bot requires
  `claudeCode: { homePath, defaultModel }`. `homePath` is an existing private
  service-owned `CLAUDE_CONFIG_DIR`, disjoint from the workspace(s), `~/.claude`,
  the Copilot home, data, config and secrets. A persona may be bound once per engine.
  `botEngine(config, botId)` resolves the effective engine.
- `discoverAgents(sources)` parses launcher YAML, checks metadata/canonical files
  and local Markdown links, and returns **all** agents. `userInvocable` governs bot
  bindings only. `infer` is independent and absent unless explicitly declared.
  `defaultModel` comes only from the launcher; the canonical prompt is a path
  reference. Runtime must read that source and register every discovered agent.
  Model availability must be checked by the runtime, without silent substitution.
- MCP must explicitly declare `mode: "none"` or `"allowlist"` with `servers`.
  A server has `name`, `type: "stdio" | "http"`, and a nonempty `tools` allowlist.
  Stdio supplies `command`, `args`, `env`, and optional workspace `cwd`; HTTP
  supplies `url` and `headers`. Environment/header values are `{ secretRef }`;
  arguments may be plain nonsecret strings or `{ secretRef }`. URL credentials
  and query strings are rejected. There is no implicit global or IDE-only MCP.
- Optional `audio` selects local FFmpeg/ffprobe/whisper.cpp executables, an
  explicitly provisioned multilingual whisper.cpp GGML model (any size, quantized
  allowed; `.en` rejected), `language` (`auto` by default, detected from speech
  when a VAD model is set), threads, bounded timeouts, `vocabulary` (≤ 100 hints,
  each 1–60 chars, joined ≤ 800 chars, passed as the Whisper prompt) and an
  optional `vadModelPath` (Silero GGML). Relative paths resolve beside the
  configuration file; bare executable names use PATH. Missing audio tools/model
  do not prevent text service startup, but voice fails explicitly. No automatic
  model download.
- Optional `coordinatorAgentId` and `modules`: see [Modules](#modules).
- Recording transcription is the `recordings` module: its settings live in
  `modules.recordings.settings` (absent → off). The legacy top-level `recordings`
  block is the same object and still accepted (see [Modules](#modules)). Required:
  `path` (existing non-symlink directory inside `workspacePath` or an
  owner-owned workspace, disjoint from code, runtime, interactive/Claude homes,
  configuration and secrets; else `RECORDINGS_PATH_OUTSIDE_WORKSPACE` /
  `UNSAFE_PATH_OVERLAP`), `modelPath`, `vadModelPath`. Optional: `language`,
  `threads` (1–8), `vocabulary` (overrides `audio.vocabulary`), `quietMinutes`
  (1–60, default 2), `pollIntervalMs` (30 000–300 000, default 60 000), `vad`
  (`threshold` 0.1–0.95, `minSpeechMs`/`minSilenceMs`/`padMs` 0–10 000; default
  0.35/250/500/200), `suppressNonSpeech` (default false), `maxContext` (−1…224,
  default 0), `retry` (`modelPath`, `vadThreshold`, `vadMinSpeechMs`,
  `suppressNonSpeech`, `maxContext`; each defaults to the first-pass value),
  `silence` (`thresholdDb` −120…−30, default −80; `minSeconds` 10–3 600, default 60)
  and `notifications` (default true). An unusable `retry.modelPath` is reported
  (`RECORDING_RETRY_MODEL_UNAVAILABLE`, doctor `recordings-retry-model`) and fails
  retries only (`MODEL_UNAVAILABLE`). Tool paths are shared with `audio`. An
  unusable model or path keeps the recordings module `unavailable` with that code
  (`RECORDING_MODEL_*`, `RECORDINGS_PATH_OUTSIDE_WORKSPACE`, …); the service still
  starts. Settings apply after a restart, to new transcriptions only.

`ConfigError.code` is a fixed diagnostic, never a serialized Zod/YAML error with
configuration values. Examples are deliberately not executable private settings.

## SQLite API

`openStore({ path })` in `src/storage/index.ts` opens an owned database, migrates
with `user_version`, enables WAL/foreign keys/FULL synchronization, and returns
`StateStore`. Parent directories must already exist. Files are private (0600);
database and sidecar symlinks are rejected. Tests use synthetic `.cache` fixtures.

Each mutating multi-row operation is a short immediate SQLite transaction.
No transaction encloses SDK, Telegram, filesystem deletion, or media processing.
The seven sub-ports are defined fully in `src/ports.ts`:

| Port | Methods |
|---|---|
| `sessions` | `conversation`, `create`, `current`, `get`, `list`, `activate`, `setProviderSessionId`, `requestModel`, `applyModel`, `clearPendingModel`, `delete` |
| `inbox` | `admit`, `recordControl`, `recordIgnored`, `acknowledge`, `offset`, `get`, `queued`, `reserve`, `attachToRun`, `cancelQueued` |
| `runs` | `active`, `get`, `isLive`, `markRunning`, `markWaiting`, `cancel`, `finish`, `complete` |
| `requests` | `create`, `get`, `pending`, `setPrompt`, `saveDraft`, `claim`, `resolve`, `cancel`, `invalidateRun`, `expire` |
| `outbox` | `enqueue`, `get`, `list`, `claim`, `settle`, `retry`, `discard`, `pinnedAttachmentIds` |
| `attachments` | `add`, `get`, `list`, `pin`, `unpin`, `expired`, `removeExpired` |
| `proactivity` | `create`, `get`, `listForScope`, `listDue`, `countActive`, `setStatus`, `reschedule`, `isAgentPaused`, `setAgentPaused`, `recordOccurrence`, `settleOccurrence`, `syntheticId` |

The store also exposes `recover`, `cleanup`, `backup`, and `close`.
All clocks are Unix milliseconds; methods with optional `now` default to
`Date.now()`. `retryAfter` is an **absolute** millisecond timestamp, not Telegram's
relative seconds. `StateError.code` signals guard/configuration errors.

### Admission and lifecycle

1. Normalize/authenticate ingress first. `Scope` is exactly
   `(ownerId, botId, chatId, topicId)`; absent topics are `null`, not `undefined`/0.
   Commands/callbacks take the priority control path, not agent input admission.
2. `sessions.create(scope, { agentId, workspace, model })` creates and selects a
   fresh session. Create/activate require no active run in that scope.
3. `inbox.admit(message, { sessionId, reserveRun?, albumDelayMs? })` atomically
   persists update/message dedup and logical input, optionally reserving its run.
   An active run leaves new input queued. Albums extend a quiet window (750 ms
   default), retain captions and group into one input. `reserve` enforces FIFO
   and readiness. Late parts return `disposition: "late-album"` without a turn.
4. Admission returns `{ accepted, disposition, input, run }`; duplicates may
   have `input: null` after explicit deletion. Update and message keys are
   independent; compact dedup/album tombstones survive deletion/cleanup.
5. A polling consumer must process each bot's updates in received order, durably
   record even ignored updates (`recordIgnored`), and only then call
   `acknowledge(botId, updateId)`. It refuses unknown updates and never regresses
   an offset. It cannot infer unseen gaps in Telegram's sparse update IDs.
6. `RunIdentity` contains scope, session, run, generation. Check `isLive` before
   effects and asynchronous continuations. `attachToRun(identity, inputId)` claims
   queued steering once for that generation; use it only when runtime steering
   is supported. Otherwise leave it queued and explain that to the user.
7. `cancel` immediately invalidates requests and queued steering but leaves the
   run `cancelling`. The application must actually stop media/runtime, then call
   `finish(..., "cancelled")`. Creating/switching sessions before that is refused.
8. On success use `runs.complete(identity, deliveries)` to atomically persist
   final outbox items and mark success. It rejects stale/cancelling generations.
   Terminal inputs' message bodies are removed, not retained as a second SDK
   transcript. Interrupted input bodies remain until explicit cleanup.
9. `requestModel` stores desired selection only. After runtime confirms a change
   at a no-active-run boundary, `applyModel(..., expectedModel)` uses compare-and-
   swap. A failed switch clears only the matching pending value. Provider session
   IDs are unique and immutable once assigned.

### Requests and delivery

`requests.create(identity, payload, { expiresAt })` generates a short opaque ID.
Production Telegram sessions never create question requests: `ask_user` is absent
from the tool allowlist and explicitly excluded, with neither `onUserInputRequest`
nor `onElicitationRequest` registered and no `askUserVariant`. The pinned SDK
1.0.16 maps absent handlers to `requestUserInput: false` and
`requestElicitation: false`; exclusions take precedence over the allowlist.
Both create and resume append a system instruction to ask one plain-text question,
end the turn, and wait for an ordinary reply. No desktop CLI settings are changed.

Permissions still carry a concrete action/parameters and use the existing
approve-once/reject buttons in manual mode. Redact secret parameters before
presentation. Legacy question payloads, `saveDraft`, rendering, and validation
remain for persisted-record compatibility and to avoid changing the shared
permission/storage lifecycle in this patch; the runtime schema converters were
removed. Compatibility tests do not enable forms in production.
`claim` checks scope/session/run/generation, live status, expiry and the complete
answer in one transaction; only the first valid response wins. Call runtime once,
then `resolve`. Do not store executable SDK callbacks in SQLite.

`outbox.enqueue` deduplicates by scope + delivery key; reusing a key with different
identity/content is rejected. Persist before `claim`; claimed items become
`sending`, increment a monotonic attempt number, and must be settled with that
attempt. Network ambiguity is `uncertain`, never `sent` or an automatic retry.
Known retryable failures use `retryAfter`; `claim` enforces bounded attempts
(default five) and optional bot filtering. Explicit user retry of uncertainty
requires `retry(..., { allowUncertain: true })` after warning about duplicates.
Manual retry opens a fresh bounded budget without resetting attempt identity.
Rate-limit waiting and HTML/chunk formatting belong in the delivery adapter.

### Recovery, retention and deletion

Call `recover()` **once at startup after acquiring the service process lock**:
active runs become `interrupted`, all live requests become invalidated, and
`sending` deliveries become `uncertain`. Abandoned processing pins are removed;
durable outbox attachment links remain. Queued inputs are returned intact.
Never auto-replay interrupted runs or reconstruct SDK callbacks from stored rows.
The application decides when retained queued work may resume.

Attachments store only managed **relative** paths, never arbitrary workspace
paths. Input expiry defaults to seven days and cannot exceed that interval;
audio defaults to immediate expiry and must be pinned while actively processed.
Output expiry is caller-controlled. Processing pins and nonterminal outbox links
block expiration. Uncertain deliveries retain pins until resolved/discarded.
`removeExpired` rechecks pins transactionally and returns the owned artifact for
the media adapter's bounded, realpath-checked deletion.

`sessions.delete` requires the exact scope and no live run, sending delivery or
processing pin. It deletes only service rows and returns
`{ sessionId, providerSessionId, artifacts }`, **never a workspace deletion path**.
The caller must have explicit confirmation, delete only that provider session
via the service runtime, and remove only returned managed artifacts. The media
adapter must clean orphan owned files if interrupted between row/file deletion.
`cleanup({ before })` removes old terminal request/outbox payloads and processed
inbox bodies; it does not delete native history, attachments or user files.
`backup(destination)` uses SQLite's online backup API, exclusively creates a private
0600 destination before copying, removes its owned incomplete destination on failure, refuses an existing target,
and does not copy a live database/WAL with raw filesystem operations.

## Modules

Optional features in `src/modules/<id>/` behind one contract (`src/modules/contract.ts`);
module authors: [`src/modules/README.md`](../src/modules/README.md).

### Configuration

```json
"coordinatorAgentId": "alfred",
"modules": { "<id>": { "enabled": true, "agents": ["alfred"], "settings": { } } }
```

- `modules` is an optional record keyed by module id (`^[a-z][a-z0-9-]{0,31}$`, else
  `MODULE_ID_INVALID`); absent or `{}` → core only. Each entry is strict: `enabled`
  (default `true`; `false` → nothing loaded, checked or run), `agents` (persona ids allowed to
  use the module's abilities, default `[]`; an unknown id → `MODULE_AGENT_UNKNOWN`) and
  `settings` (opaque to the core, validated by the module at start; relative paths resolve
  from the config file's directory).
- `coordinatorAgentId` (optional) must be a persona with an owner private binding, else
  `COORDINATOR_BINDING_MISSING`.
- Legacy top-level `recordings` = `modules.recordings` with `enabled: true`, `agents: []` and
  those settings; reported as `MODULE_SETTING_MOVED` (startup diagnostic, doctor
  `config-migration`, `modules-status`). Both at once → `MODULE_SETTINGS_DUPLICATED`.
- Config-load codes above stop the service as any `ConfigError`. Everything checked at module
  start (unknown id, invalid settings, `prepare` path codes, missing prerequisites) affects
  only that module. Changes take effect on `make restart`; nothing switches a module at runtime.

### Health

| State | Codes |
|---|---|
| `disabled` | `MODULE_DISABLED` |
| `unavailable` | `MODULE_UNKNOWN`, `MODULE_SETTINGS_INVALID`, `MODULE_DEPENDENCY_UNAVAILABLE` (`detail` = dependency id), `MODULE_DEPENDENCY_CYCLE`, `MODULE_ABILITY_DUPLICATE`, `MODULE_ABILITY_INVALID`, `MODULE_INSTRUCTIONS_MISSING`, module codes (e.g. `RECORDING_MODEL_MISSING`, `RECORDINGS_PATH_OUTSIDE_WORKSPACE`) |
| `starting` | `MODULE_STARTING` |
| `ready` | `MODULE_READY` |
| `failed` | `MODULE_START_FAILED`, `MODULE_FAILED`, module codes from `ctx.fail` or a `ctx.run` rejection (e.g. `RECORDINGS_FOLDER_UNREADABLE`) |

- Modules start in dependency order (`requires`) after media cleanup and before the
  application; they stop first on shutdown, in reverse order, each bounded to 10 s
  (`MODULE_STOP_TIMEOUT` / `MODULE_STOP_FAILED`; shutdown then reports
  `MODULE_STOP_INCOMPLETE`).
- A module that leaves `ready` makes its dependents `unavailable`
  (`MODULE_DEPENDENCY_UNAVAILABLE`) until the next restart. `ctx.recovered()` returns a
  `failed` module to `ready`.
- Every code has a Ukrainian `cause` and `fix` (host texts for `MODULE_*`, the module's
  `reasons` for its own). Codes are fixed strings; diagnostics carry the module id and state,
  never paths, content or secrets. Host diagnostics: the health codes above plus
  `MODULE_SETTINGS_ISSUES` (`count`), `MODULE_ABILITY_FAILED`, `MODULE_ABILITY_REFUSED`,
  `MODULE_STATE_WRITE_FAILED`.

### Files

```text
runtimeDataPath/modules/<id>/        module-private data (0700), created by the host
runtimeDataPath/modules/state.json   { version: 1, updatedAt, modules: ModuleStateReport[] }
runtimeDataPath/modules/notices.json { version: 1, modules: { <id>: { notified: <code> | "ok", pending?: { code, at } } } }
```

- `state.json` (0600, atomic) is written at start, on every health change and every 60 s;
  `modules-status [--json]` (`make modules-status`) reads it without the process lock and
  treats it as "service not running" when older than 3 minutes. A row: `id`, `version?`,
  `enabled`, `state`, `code`, `detail?`, `cause?`, `fix?`, `requires`, `agents`, `status?`
  (one line from the module), `movedSettings?`.
- The owner's Telegram `/status` adds a «Модулі» section from the same rows. `doctor` adds
  `module:<id>` (`MODULE_DISABLED` ready for a disabled module, `MODULE_ENABLED` or the
  unavailable code otherwise), the module's own checks only when it is enabled and resolves,
  `config-migration` for moved settings and `MODULE_COORDINATOR_CONFIGURED|NOT_CONFIGURED`.

### Abilities and instructions

- Module abilities are static, named `<id>_<verb>` (never `densemble_*`), with a zod input.
  A session gets them only when the module is `ready`, the persona is in
  `modules.<id>.agents` and the session is the owner's; each call is checked again (live
  turn, ready, agent, owner: `MODULE_NOT_PERMITTED` / `MODULE_UNAVAILABLE`), the input is
  validated (`MODULE_INPUT_INVALID`) and a module error becomes `MODULE_FAILED`. Hard limits
  live in module code (`<ID>_NOT_ALLOWED`), not in instructions.
- Core ability `densemble_state` (every agent, every engine, read-only, input `{ module? }`):
  the owner gets `{ ok, modules: ModuleStateReport[], coordinator?, note }`, where `note`
  says modules change only in `config.local.json` + `make restart`; anyone else gets
  `{ ok: true, modules: [], note }`.
- Session instructions: the core `src/modules/INSTRUCTIONS.md` for every agent, plus each
  allowed module's `src/modules/<id>/INSTRUCTIONS.md` (one `## <ability>` section with
  Purpose, Inputs, Returns, Limits, Errors). Densemble never reads or writes the workspace
  for this.

### Coordinator notices

- With `coordinatorAgentId`, Densemble sends a fixed (non-LLM) text to that persona's owner
  private chat when a module goes `unavailable`/`failed` with a code different from the last
  one notified, and once when it is `ready` again. The ledger `notices.json` survives
  restarts, so a persisting failure is not re-sent.
- During `quietHours` a notice waits (`pending`) and goes once per module after the window,
  unless the reason is `urgent`. Re-evaluated every 60 s. No coordinator → no notices.

## Recording transcription

The `recordings` module (settings `modules.recordings.settings`, data
`runtimeDataPath/modules/recordings/`; owner docs
[`src/modules/recordings/README.md`](../src/modules/recordings/README.md)) owns one watched
folder; its file contract is shared with the owner's review tooling and does not change:

```text
<path>/review-log.tsv                                   read-only for Densemble
<path>/<recording>.<ext>                                root: filed when finished
<path>/YYYY/MM/DD/<name>.<ext>
<path>/YYYY/MM/DD/transcript_YYYY-MM-DD_<name, spaces as _>.txt
<path>/YYYY/MM/DD/<label>_transcript_….txt              written by review only
<path>/YYYY/MM/DD/transcript_….attempt-1.txt            written by review only
<path>/YYYY/MM/DD/.densemble-<uuid>.partial             Densemble temp only
```

- Media: m4a mp3 wav mp4 mkv mov flv webm ogg opus aac (case-insensitive); hidden,
  non-media files and other subfolders are ignored.
- A root file is filed when no process holds it open (`lsof`), it is unmodified
  for `quietMinutes` and ffprobe reads a positive duration; its day comes from an
  OBS name `YYYY-MM-DD HH-MM-SS.ext`, else the local mtime date. Filing is
  `link()` + `unlink()`: an existing target is a reported conflict, never
  overwritten; a same-inode root remnant of an interrupted move is removed; a
  symlinked or non-directory `YYYY/MM/DD` component is a `TARGET_UNSAFE` conflict.
  The folder is rescanned after every recording; an unreadable day folder is
  skipped (`RECORDINGS_FOLDER_UNREADABLE`), never fatal. FFmpeg/ffprobe read only
  local files (`-protocol_whitelist file`). The running tool's process group id
  is kept in `runtimeDataPath/modules/recordings/active-process.json`, so a restart after
  a crash ends an orphaned FFmpeg/whisper group before starting again.
- A recording is **done** when `<key>.txt`, `<label>_<key>.txt` or
  `<key>.attempt-N.txt` exists, even if the recording was deleted; a **retry** is
  pending when `review-log.tsv` has `retranscribe` for `<day>/<key>.txt` and no
  transcript exists — it runs with the `retry` settings: `retry.modelPath` (a
  stronger model), otherwise the first-pass model, VAD and flags.
  Two media files with the same key in one day: the oldest is transcribed, the
  others are reported as `SAME_KEY` conflicts.
- Densemble's only mutations: filing, creating a `<key>.txt` that did not exist
  (temp → `fsync` → exclusive `link()`), and creating/removing its own
  `.densemble-*.partial`. Nothing is renamed, emptied or deleted otherwise.
- Recognition: whisper.cpp with Silero VAD, vocabulary prompt, language detected
  from speech, `-mc 0` (no carried text context) on the first pass; transcripts
  are post-filtered (tag-only lines dropped, runs of ≥ 3 identical lines or of
  ≥ 3 identical consecutive clauses — split at `, . ! ? …` — within a line kept
  once; empty →
  `[no speech detected]`).
- Digital silence: after decoding, FFmpeg `silencedetect`
  (`noise=<thresholdDb>dB:d=<minSeconds>`) runs over the WAV; spans
  `{ startSeconds, durationSeconds, toEnd? }` go to `status.json` (`current.silences`,
  `recent[].silences`), `recordings-status` and the ready notification
  ("no audio signal from 13:23 to the end (68 min)"), plus `RECORDING_SILENCE_FOUND`
  (`count`, `seconds`). A failed check never fails the transcription
  (`RECORDING_SILENCE_CHECK_FAILED`, no `silences` field). Recordings are
  processed one at a time, oldest first; a failure is remembered (path, size,
  mtime) until restart. Work files live under `runtimeDataPath/modules/recordings/work`
  and are removed on completion and at start.
- Voice first: one `SpeechGate` per service; a voice message stops (`SIGSTOP`)
  the recording's process group and continues it (`SIGCONT`) afterwards; paused
  time does not count toward the recording's timeout. `/stop` never reaches it.
- Status: `runtimeDataPath/modules/recordings/status.json` (0600, atomic) is read by
  `recordings-status [--json]` without the process lock (falling back to the spec 004
  `runtimeDataPath/recordings/status.json`, which the module renames into its data
  directory once at the first start); stale after 3 × poll
  interval → "service not running". macOS notifications "Transcription ready" /
  "Transcription failed" go once per outcome per file per run.
- Legacy launchd job: while `~/Library/LaunchAgents/com.openclaw-jazz.transcribe-recordings.plist`
  exists, Densemble warns (`RECORDINGS_LEGACY_JOB_INSTALLED`) and holds the old
  script's lock dir `/tmp/transcribe-new-recordings.lock` around each recording;
  a foreign lock means skip (`RECORDINGS_LEGACY_LOCK_BUSY`). The lock's mtime is
  refreshed every 10 minutes (the old script treats 6 h as stale) and only the
  same directory Densemble created is removed.
- Diagnostics (codes only): `RECORDINGS_STARTED|DISABLED|START_FAILED|PASS_FAILED|STATUS_FAILED|FOLDER_UNREADABLE|LEGACY_LOCK_BUSY`,
  `RECORDING_FILED|WAITING|CONFLICT|STARTED|PAUSED|RESUMED|DONE|FAILED|INTERRUPTED|NOTIFY_FAILED|ORPHAN_ENDED`,
  `RECORDING_MODEL_MISSING|ENGLISH_ONLY|UNSUPPORTED`; failure `reason` is one of
  `DECODE_FAILED ASR_FAILED TIMEOUT DISK_FULL TARGET_EXISTS MODEL_UNAVAILABLE OUTPUT_INVALID`.

## Remaining adapter responsibilities

`AgentRuntime` (`open`, `execute`, `setModel`, `models`, `disconnect`,
`deleteSession`, `shutdown`) uses `RuntimeCommand`/`RuntimeEvent`, never SDK types.
`Session.engine` (`copilot` | `claude-code`, SQLite migration 3, default
`copilot`) is fixed at creation. The service composes an engine router that
dispatches every call by that engine; each engine refuses foreign sessions with
`SESSION_ENGINE_MISMATCH`. `deleteSession(..., engine)` receives the engine from
the deletion journal (legacy entries are Copilot). Optional
`supportsSteering(session) === false` (Claude Code) makes the application leave
new input queued for the next turn instead of steering. Claude Code provider
session IDs are the Densemble session UUID; Copilot's remain `densemble-<uuid>`.
`MediaPreparation` (`prepare`, `transcribe`, `exportFile`, `cleanup`) handles IO,
format/resource validation, subprocess cancellation and filesystem confinement.
Its production `releaseRun`/`removeArtifacts` hooks release pins only after
confirmed termination and remove only session-deletion artifacts.
`DeliveryTransport` (`deliver`, `preview`, `acknowledgeCallback`) and
`IngressHandler.handle` join Telegram to the application without Telegram types.
Telegram owns the only durable outbox consumer and maps prompts to the final
keyboard-bearing chunk. Application only enqueues; terminal transitions call
`invalidatePreview` to clear cached and remote interim content.
`DiagnosticSink.record` accepts fixed codes and non-object metadata, not prompts.

Bootstrap/process locking, runtime ownership and permission callbacks, ordered
polling/controls, actual bounded stop, model availability, parsing/ASR and safe
file delivery remain application/adapter work; this state layer does not fake
any of those guarantees.
