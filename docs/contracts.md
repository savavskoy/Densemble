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
- Optional `audio` selects local FFmpeg/ffprobe/whisper.cpp executables, the
  explicitly provisioned multilingual small GGML model, language/threads and
  bounded timeouts. Relative paths resolve beside the configuration file;
  bare executable names use PATH. Missing audio tools/model do not prevent text
  service startup, but voice fails explicitly. No automatic model download.

`ConfigError.code` is a fixed diagnostic, never a serialized Zod/YAML error with
configuration values. Examples are deliberately not executable private settings.

## SQLite API

`openStore({ path })` in `src/storage/index.ts` opens an owned database, migrates
with `user_version`, enables WAL/foreign keys/FULL synchronization, and returns
`StateStore`. Parent directories must already exist. Files are private (0600);
database and sidecar symlinks are rejected. Tests use synthetic `.cache` fixtures.

Each mutating multi-row operation is a short immediate SQLite transaction.
No transaction encloses SDK, Telegram, filesystem deletion, or media processing.
The six sub-ports are defined fully in `src/ports.ts`:

| Port | Methods |
|---|---|
| `sessions` | `conversation`, `create`, `current`, `get`, `list`, `activate`, `setProviderSessionId`, `requestModel`, `applyModel`, `clearPendingModel`, `delete` |
| `inbox` | `admit`, `recordControl`, `recordIgnored`, `acknowledge`, `offset`, `get`, `queued`, `reserve`, `attachToRun`, `cancelQueued` |
| `runs` | `active`, `get`, `isLive`, `markRunning`, `markWaiting`, `cancel`, `finish`, `complete` |
| `requests` | `create`, `get`, `pending`, `setPrompt`, `saveDraft`, `claim`, `resolve`, `cancel`, `invalidateRun`, `expire` |
| `outbox` | `enqueue`, `get`, `list`, `claim`, `settle`, `retry`, `discard`, `pinnedAttachmentIds` |
| `attachments` | `add`, `get`, `list`, `pin`, `unpin`, `expired`, `removeExpired` |

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
Question fields have IDs, choices, multiplicity, and freeform policy; permissions
carry a concrete action/parameters. Redact secret parameters before presentation.
`saveDraft` stores valid partial fields without resolving the callback.
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

## Remaining adapter responsibilities

`AgentRuntime` (`open`, `execute`, `setModel`, `models`, `disconnect`,
`deleteSession`, `shutdown`) uses `RuntimeCommand`/`RuntimeEvent`, never SDK types.
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
