# Densemble

A local, single-owner Telegram interface to managed Copilot agent runtimes on
Apple Silicon macOS. One bot per persona, one binding per group/topic, and
separate conversation histories. TypeScript/Node, grammY, SQLite and the Copilot
SDK form a modular monolith; there is no HTTP server or hosted control plane.

**Deployment acceptance is pending:** the authenticated synthetic SDK gate
passed, but real Telegram accounts/tokens and a provisioned whisper.cpp model
are required to complete Telegram/voice acceptance. Offline tests do not prove
live Bot API delivery or Ukrainian transcription accuracy. Nothing installs a
LaunchAgent, creates bots, downloads a speech model, or changes external task
services automatically.

## Development

Use Node.js 24 LTS (the exact version is in `.nvmrc`) and npm 11. Dependency
versions are pinned in `package.json` and `package-lock.json`.

```sh
nvm install
nvm use
npm ci
npm run typecheck
npm test
npm run build
```

`nvm` is optional; any Node version manager can select the version in `.nvmrc`.
The build emits application code to `dist/`; it does not emit tests. `npm test`
runs offline tests, checks dependency imports and the native SQLite binding,
and verifies explicit startup failure. Gate-helper tests include controlled local
Node subprocesses, not model sessions. Tests do not contact Telegram or Copilot.
Source and tests use strict typechecking. `skipLibCheck` excludes dependency
declaration files because the pinned SDK/JSON-RPC and grammY declarations have
upstream compatibility errors; it does not establish SDK runtime compatibility.
If a prebuilt SQLite binary is unavailable, installation requires native build
tools (on macOS, Xcode Command Line Tools and a supported Python installation).

After building, `npm start` starts the foreground service with
`config.local.json`. A missing or invalid configuration fails explicitly.
Use Node 24 for every command, including native SQLite tests.

## Configuration and privacy

Copy [`config.example.json`](config.example.json) to ignored `config.local.json`
and replace its synthetic paths, owner/chat IDs, persona and secret references.
Create the configured data/home directories yourself with private permissions:

```sh
mkdir -p data runtime/copilot
chmod 700 data runtime/copilot
```

Configuration is strict; unknown fields, conflicting bindings, duplicate bot
identities, non-invocable workers as bots, unsafe paths and unresolved secrets
are errors. Detailed schema and lifecycle rules: [contracts](docs/contracts.md).

Keep actual configuration in an ignored `config.local.json`. Reference an
existing external `secrets.local.json` using `secretsPath`; bot entries reference
secret keys, never token values. Do not copy credentials, private agent
instructions, knowledge files, or personal documents into this repository.
The configured agent workspace must remain separate from this service's code.

Local configuration, credentials, dependency caches, runtime data, attachments,
database files, logs, and scratch files are ignored. Use `data/`, `runtime/`,
`logs/`, and `.cache/` for local artifacts. Ignore rules are only an accidental
commit safeguard, not access control; review staged changes before committing.

## Foreground setup

1. Complete the service-only OAuth login below. Densemble uses its own Copilot
   home; it does not import interactive CLI sessions or global MCP configuration.
2. Create a bot for each desired persona through BotFather. Store its token only
   in the existing external canonical `secrets.local.json`; set `tokenRef` to
   that key. Never paste tokens into command-line arguments, commits or logs.
3. Set your numeric Telegram `ownerId` and explicit `bindings`. For a private
   chat, use your numeric user/chat ID and `topicId: null`. Send `/start` to the
   bot yourself. Groups use a negative chat ID; forum bindings require the exact
   topic ID. Other bots/topics/users are ignored before LLM or media processing.
4. For groups, disable BotFather privacy mode or grant the necessary bot rights,
   then verify reception with a real ordinary message without `@`. Membership
   alone does not establish the binding. Existing webhooks cause an explicit
   conflict; the service never deletes them automatically.
5. Declare MCP as `"none"` or explicitly allowlist servers/tools and secret
   references. IDE-only tools are not available from a background service.

```sh
npm run build
node dist/main.js doctor --config config.local.json
npm start -- --config config.local.json
```

Doctor performs bounded, read-only SDK auth/model and Bot API identity/webhook
checks, plus local audio prerequisites. It does not infer, send Telegram
messages, poll updates or invoke MCP tools. Exit 2 means prerequisites or actual
MCP acceptance remain incomplete. Audio is optional for starting text service:
missing ASR prerequisites produce an explicit voice error, never cloud fallback.

Commands in Telegram: `/help`, `/status`, `/model`, `/new`, `/sessions`, `/stop`.
The bot registers its command menu at startup so Telegram suggests commands when
you type `/`. New runs do not post an automatic Stop button; send `/stop` to stop.
Questions/manual permissions and session/model controls use scoped, expiring buttons.
`/new` retains old history; deletion needs confirmation. `/stop` is scoped to
the current bot/chat/topic and does not undo external actions. An unknown
external-action or Telegram-send outcome is reported as uncertain, not retried
as a new agent task. `/status` provides explicit delivery-retry controls with
duplicate warnings. After restart, queued input requires an explicit decision;
interrupted actions and stale permissions are never automatically replayed.

### Autopilot

**Autopilot is the default for every agent**, including existing configurations
that omit `permissionMode`. It approves ordinary tool actions automatically for
the authenticated owner's live managed runs. This includes file reads/writes,
shell/network/MCP actions and explicit file exports: use trusted agents and
workspaces. Set `"permissionMode": "manual"` in `config.local.json` to require
per-action confirmation instead, or `"autopilot"` to select the default explicitly.
Restart the service after changing this setting. Agent clarification questions
still require an answer.

Autopilot does not bypass managed policy, enable undeclared MCP servers, allow
detached processes or revive stopped/stale runs. `/stop` retains its normal
scope and process cleanup; it cannot undo actions already taken.
Quoted URL query-string ampersands are treated as data, not background shell
operators, so ordinary Trello requests are not rejected as detached work.

SIGINT/SIGTERM stop polling/media/runtime work before closing SQLite and releasing
the OS process lock. If pending work cannot be confirmed stopped, shutdown reports
failure and retains database/process ownership rather than allowing a second
instance to race it. A second service/doctor/backup process fails fast. After a
crash, owned runtimes are reconciled before database recovery. The service is
unavailable while the Mac sleeps; reconnect cannot recover messages older than
Telegram's update-retention window.

## Local voice and media

Documents: text PDF, DOCX, UTF-8 TXT/Markdown/CSV. Photos are PNG/JPEG/WebP;
model vision capability is checked without silently switching models. Image-only
PDF, unsupported encodings, oversized or corrupt documents fail explicitly.
Incoming files are limited to 20 MB, exports to 50 MB. Export is an explicit
tool governed by the configured permission mode, not automatic sending of a
model-mentioned path.

Provision FFmpeg and whisper.cpp explicitly, and download a **multilingual
Whisper small GGML** model yourself (not `small.en` or Python `.pt`). Optional
configuration, using your actual local paths:

```json
"audio": {
  "ffmpegPath": "/opt/homebrew/bin/ffmpeg",
  "ffprobePath": "/opt/homebrew/bin/ffprobe",
  "whisperPath": "/opt/homebrew/bin/whisper-cli",
  "modelPath": "/absolute/path/to/ggml-small.bin",
  "language": "auto",
  "threads": 4
}
```

No automatic install/download occurs. Maximum actual duration is 600 seconds;
voice stays local to ASR, then only the labelled transcript goes to Copilot.
Raw voice/WAV are removed on success, failure and cancellation; inputs expire
after seven days unless retained for active work/delivery. See the
[media adapter](src/media/README.md) and [Telegram adapter](src/telegram/README.md).

## macOS background operation

The [Makefile](Makefile) wraps the existing service and macOS commands. Run
`make` for the command list. It does not install or start anything by default.
Stop any existing foreground/`npm start` instance before the first background
launch; the service's process lock prevents two instances sharing its data.

```sh
make install              # build and install the LaunchAgent; does not start it
make start                # run in background, independent of this terminal
make status               # launchd state, not application readiness
make logs                 # follow both logs; Ctrl+C stops only the log viewer
make restart              # stop, rebuild/reinstall, then start
make stop                 # unload the background service
```

The installed LaunchAgent starts on login and restarts after a crash.
`make stop` unloads it for the current login session; the installed plist can
load again on the next login. Remove the installed plist after stopping if you
want to permanently remove login autostart.
`make restart` requires a currently loaded service; if it is stopped, use
`make install && make start`. These commands do not manage an independently
started `npm start` process. `/stop` in Telegram stops only the current agent
run, not the service.

For terminal-only operation use `make run` (Ctrl+C stops the service).
`make build`, `make typecheck`, `make test`, and `make doctor` wrap the development
commands; doctor requires the service to be stopped. Select a non-default
configuration with `make install CONFIG=/absolute/path/to/config.local.json`;
repeat the same `CONFIG=...` when reinstalling/restarting or using run/doctor.
Logs use the paths recorded in the installed plist. Install with a stable Node
24 executable, because its absolute path is saved in the LaunchAgent.

Generate a **user** LaunchAgent template after configuring and building:

```sh
node dist/main.js launchd --config config.local.json > "$HOME/Library/LaunchAgents/dev.densemble.agent.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.densemble.agent.plist"
```

Create `~/Library/LaunchAgents` first if absent. Generation alone does not load
the service; `launchctl bootstrap` is an explicit operator action. The template
uses the exact Node executable selected for generation, so generate it with
stable Node 24, not a disposable npm-exec cache. Logs are beneath the configured
data directory. Stop before foreground startup or backup:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.densemble.agent.plist"
```

Logs contain fixed codes and approved scalar metadata, not document content,
tokens, full tool arguments or raw upstream errors.

## Offline backup and restore

Stop the service first. A backup contains an online SQLite snapshot, retained
managed input/output files, generated run files and only `densemble-*` native
session histories. It excludes OAuth configuration/tokens, external workspace,
raw audio and interactive CLI history. Protect backups as private conversation
data; store them outside the code, workspace and configured data/home roots.

```sh
node dist/main.js backup --config config.local.json --target /private/backup-parent/new-snapshot
node dist/main.js restore --config config.local.json --target /private/backup-parent/new-snapshot
```

The parent directory must exist. Backup refuses an existing destination.
Restore requires empty application data and native history destinations, validates
the snapshot database, never overwrites existing state, and preserves service
OAuth configuration. Restore with the same workspace/scope configuration;
provision OAuth independently on a replacement machine. Restart recovery
invalidates old callbacks and marks interrupted work without replaying it.

## SDK integration gate — PASS (synthetic authenticated contracts)

Both packages and their lockfile resolutions are pinned:
**`@github/copilot-sdk@1.0.16` / `@github/copilot@1.0.91`**. The gate resolves the
local macOS ARM64 native CLI package directly, not the global `copilot` launcher
or the SDK's bundled 1.0.90 runtime. `--no-auto-update` is explicit; the real
`getStatus()` RPC must report 1.0.91. The executable gate now verifies the
required authenticated SDK contracts below. This is **not** Telegram, media,
or production-service acceptance.

### Runbook

Use Node 24 for **every** command, including tests (the native SQLite binding
was built for Node 24). With Node 24 active:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run sdk:gate                           # offline: SKIPPED/BLOCKED, exit 2
npm run sdk:gate -- --real --readiness --auth=token
npm run sdk:gate -- --real --readiness --auth=logged-in
npm run sdk:gate -- --real --readiness --auth=cli-login
npm run sdk:gate -- --real --readiness --auth=service-login # manual provisioning below
npm run sdk:gate -- --real --auth=service-login # real synthetic inference + behavior matrix
```

Without a Node version manager:

```sh
npm exec --yes --package=node@24.21.0 --package=npm@11.9.0 -- \
  sh -c 'node --version && npm run sdk:gate -- --real --auth=service-login'
```

Exit **0** is reserved for the entire required contract matrix passing; **1**
means a failed check/cleanup or invalid arguments; **2** means blocked/skipped.
Readiness-only success cannot unlock dependent work. To consume just the JSON
report after building, run `node dist/agents/sdk-gate/main.js --real`.
`--auth=token` is the default; selecting an auth mode alone does not enable
real probes. Unknown modes and repeated/conflicting auth flags fail before
launching a runtime. `readiness.isAuthenticated` and `readiness.modelCount`
contain actual RPC results, or `null` when unavailable/unattempted. A rejected
model-list RPC is **not** reported as a zero-model result.
No report contains tokens, login names, model responses, raw RPC errors, or
tool arguments. Upstream console warnings/errors are suppressed and counted.
An upstream failure is reported as `UPSTREAM_ERROR_REDACTED`, with the failing
stage identified. Do not enable debug logging to share errors. The report includes
submitted-message count separately from observed model-call/token counters;
one message can cause multiple inference calls. Interrupted runs are failures,
not evidence of successful cancellation.

### Verified real matrix

The full gate passed on **2026-10-02**, Node **24.21.0**, using the manually
provisioned service login. It submitted **20 synthetic messages**, observed
**30 model calls**, and created/deleted **16 gate sessions**. Explicit inference
models: **`gpt-5.4-mini`**, with **`gpt-5-mini`** for the boundary-switch probe.
Observed usage: **100,567 input / 2,471 output tokens**; SDK diagnostic count: 0.
Readiness-only remains a separate **zero-inference** path.

| Contract | Observation |
|---|---|
| Runtime/auth/models | PASS: CLI 1.0.91, protocol 3; authenticated; 24 models returned |
| Persona/default-model discovery | PASS: metadata-only inspection of 6 launchers, 5 invocable personas, 13 resolvable skill references; worker excluded; all declared models available. Separate synthetic selected persona applied its own instruction |
| Streaming | PASS: root deltas, final answer correlated to submitted message ID, terminal root idle |
| User question | PASS: model invoked native `ask_user`; session-scoped handler answered; opaque synthetic token incorporated |
| Native permission | PASS: real native `bash` request, exact-command approval, actual owned marker and tool-success event |
| Skill | PASS: explicit synthetic `skillDirectories`, `skill.invoked`, token from skill content returned |
| MCP permission | PASS: explicit local stdio fixture, model-triggered MCP request, exact server/wire-tool/arguments policy, exactly one marker |
| Native subagent | PASS: native `task`, synthetic custom worker, started/completed events and root idle after delegation |
| Delegated permission | PASS: worker actually executed native shell write; permission callback correlated by tool-call ID with non-root successful tool event |
| Model switch | PASS: switch at idle boundary, new-model usage observed, prior synthetic history retained |
| Immediate steering | PASS: submitted during an active tool barrier, delivery explicitly reported `steering`, correction incorporated into final root answer |
| Image | PASS: model advertised vision; locally generated PNG blob recognized without the color in the prompt |
| Abort streaming | PASS: abort during actual root deltas; abort event, idle and absence of late output |
| Abort question | PASS: real pending question; abort/idle; late handler response did not restart work |
| Owned tool cancellation | PASS: native shell spawned a Node process and child; both owned PID/start identities actually exited after SDK abort |
| Active runtime isolation | PASS: freeze/kill one active runtime and native tool tree; a second genuinely active chat remained responsive and completed |
| Resume handlers | PASS: new-runtime restart and idle disconnect/resume preserved session history; fresh tool, question and permission handlers worked |
| Resume without replay | PASS: synthetic local side effect committed before lost handler acknowledgment; `continuePendingWork: false` prevented automatic model/tool replay; subsequent explicit turn did not duplicate it |
| Cleanup | PASS: registered gate sessions deleted, owned processes exited, owned run directories removed; service login retained |

The metadata reader defaults to sibling `../openclaw-jazz`; set
`DENSEMBLE_GATE_AGENT_WORKSPACE` to an explicitly chosen workspace if different.
It validates references in place and returns only identifiers/model IDs/counts.
**No real persona, skill body, secret, personal prompt, or document is copied
into Densemble or sent in the inference probes.** All tool writes are synthetic
and local. No real Trello, Calendar, or remote MCP service is used.

Offline tests cover event-origin/idle correlation, permission input decisions,
exact allowlists and revocation, model/metadata parsing, fixture encoding,
report completeness, deadlines, path boundaries, PID identity, session-ownership
transfer, and service-home preservation. **Mocks are never contract evidence.**
Each real contract gets one attempt per execution; missing events are blocked,
not skipped into success. No automatic corrective-prompt loop is used.

### Pinned API details and production boundaries

- Native permission handlers must return **`approve-once` / `reject`**, not
  output-event variants such as `approved` / `denied-interactively-by-user`.
  Those latter variants are accepted by the public union but failed at the
  pinned runtime's native permission boundary. No SDK patch or blanket approval
  is needed. Approvals are limited to exact synthetic commands, files, or
  server/tool/argument tuples; shell quoting variants still name one fixed action.
- Session **`configDirectory` must match the runtime `baseDirectory`** for
  native persistence/deletion/restart lookup. An earlier per-run override
  misplaced session history and made `deleteSession` report not-found.
  `enableConfigDiscovery: false`, memory/store disabling and explicit tool
  filters keep this from importing interactive-home context.
- MCP permission `toolName` is the canonical wire name, such as
  `gate-gate_mark`, not just the server-advertised `gate_mark`.
- Register handlers/tools again on every resume. Use
  **`continuePendingWork: false`** and fail-closed external-action reconciliation.
  A committed action with a lost acknowledgment has **unknown outcome**, not a
  successful abort. This gate uses a local ledger, not a real network service;
  production still needs a durable operation ledger/idempotency strategy.
- Forced termination is reported as forced, never as cooperative success.
  Production needs a runtime supervisor, persisted stop generations, and stale
  callback rejection; the gate's OS snapshots are not that complete supervisor.
- This matrix establishes the SDK seam only. Telegram authorization/delivery,
  media/ASR, production permissions, durable state, sleep/recovery and deployment
  acceptance are separate dependent work.

### Explicit authentication modes

- **`--auth=token` (default):** uses only externally injected
  `COPILOT_GITHUB_TOKEN`, passed as SDK `gitHubToken`. `useLoggedInUser: false`
  prevents account fallback even when the token is missing or invalid.
  `HOME` and XDG paths stay inside the run directory. Other token variables
  (`GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_SDK_AUTH_TOKEN`) are not inherited.
- **`--auth=logged-in`:** opts into the SDK's documented
  `useLoggedInUser: true` stored-login/`gh` discovery, without supplying a token.
  Ambient token variables are still excluded, so they cannot silently override
  the selected source. Actual `HOME` is retained; `GH_CONFIG_DIR` comes from that
  explicit variable, otherwise `$XDG_CONFIG_HOME/gh` or `$HOME/.config/gh`.
  HOME and gh config paths must be absolute. XDG config/cache remain isolated.
  The fixed PATH additionally allows `/opt/homebrew/bin` and `/usr/local/bin`
  for installed `gh`; it does not inherit arbitrary PATH entries. gh prompts
  are disabled. No login/logout or token extraction command is run.
- **`--auth=cli-login`:** uses the same explicit logged-in discovery settings,
  but selects the SDK's supported `mode: "copilot-cli"` so keychain access is not
  disabled by empty mode. The Copilot home/workspace are still separate, remote
  sessions and built-in MCPs are disabled. This alternative is not approval to load ambient tools in the
  eventual application.
- **`--auth=service-login`:** uses the same sanitized logged-in environment and
  `useLoggedInUser: true`, with `mode: "copilot-cli"` and the fixed persistent
  `resolve("runtime/copilot")` as SDK `baseDirectory` / runtime `COPILOT_HOME`.
  It ignores ambient `COPILOT_HOME` and token variables. This service-only home
  must be manually provisioned; the gate never creates it or falls back to the
  interactive CLI home. Workspace, OS scratch and XDG directories remain
  per-run. The service home can also contain SDK-generated service state;
  it must never contain copied interactive CLI config, personas or history.
  Only explicit full `--real` runs create synthetic gate sessions.

**Pinned-SDK limitation:** `@github/copilot-sdk@1.0.16`'s
`buildRuntimeEnv()` unconditionally sets `COPILOT_DISABLE_KEYTAR=1` in
`mode: "empty"`, including when `useLoggedInUser` is true. Merely retaining HOME
does **not** re-enable keychain access. See the
[pinned SDK source](https://github.com/github/copilot-sdk/blob/f8ae645902b74b62cd47aac1fd9b29adaec3aff2/nodejs/src/client.ts)
and [documented CLI auth discovery](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).
The local metadata-only check found a `copilot-cli` keychain entry, but no
installed `gh` or gh auth directory, and no injected token. The additional
CLI-login probe was also unauthenticated: enabling keychain discovery alone
did not supply a usable login to the separate Copilot home. Empty mode is a
harness choice, not a requirement of Densemble; its keytar setting alone does
not explain the failure in CLI-login mode. These probes establish missing
authentication for the tested configurations, not that interactive Copilot is
logged out or that every possible authentication route is unsupported.
Those transient-home results do not describe the authenticated service-login
result above.
No SDK patch, direct credential extraction, credential copying, or global
config migration was attempted.

### Manual OAuth login for the service-only home

From the repository root, explicitly provision a private, non-symlinked
`runtime/copilot` and complete the browser login yourself:

```sh
mkdir -p runtime/copilot
chmod 700 runtime/copilot
env -u COPILOT_GITHUB_TOKEN -u GH_TOKEN -u GITHUB_TOKEN \
  COPILOT_HOME="$PWD/runtime/copilot" COPILOT_AUTO_UPDATE=false \
  ./node_modules/@github/copilot-darwin-arm64/copilot login --web-flow
```

Do not point this directory (or any ancestor) at a symlink. Do not copy an
existing login, print/extract stored tokens, share OAuth codes, or use global
login/logout for this gate. The command is a **manual prerequisite**, never run
automatically by the gate. It uses the pinned native CLI and only its
service-specific Copilot home; the user's interactive `~/.copilot` stays untouched.

After completing login, with Node 24 active:

```sh
npm run sdk:gate -- --real --readiness --auth=service-login
```

The gate checks the service directory and every ancestor before allocating
run files, then again immediately before SDK startup. Missing paths report
`SERVICE_LOGIN_HOME_MISSING`, non-directories report
`SERVICE_LOGIN_HOME_NOT_DIRECTORY`, symlinks report
`SERVICE_LOGIN_HOME_SYMLINKED`, and unreadable paths report
`SERVICE_LOGIN_HOME_UNREADABLE`. No runtime is spawned on these failures.
Directory/config-file presence is **not** authentication evidence: only the real
`getAuthStatus()` RPC establishes readiness. No token values are read or copied
by the harness. The CLI/SDK uses its own supported auth discovery.

Normal cleanup, startup failure and emergency cleanup never remove or replace
the service home or login. Full behavior cleanup deletes **only the exact
gate session IDs registered by that execution**, normally through `deleteSession`;
after a forced runtime exit it can remove those exact session directories.
It never lists/deletes other sessions or sweeps the service home.
Treat the home as private service state, including any
SDK-generated files/logs, not a disposable run directory. Readiness performs
**zero model requests**; even authenticated readiness leaves the entire gate
**BLOCKED** because readiness is not behavior evidence.

### Other explicit credential sources

A new PAT is **not mandated**. If an existing supported credential is available
through an external secret launcher, inject it as `COPILOT_GITHUB_TOKEN`:

```sh
npm run sdk:gate -- --real --readiness --auth=token
```

Alternatively, already installed/authenticated `gh` can be tested with
`--auth=logged-in`; that route was unavailable locally and has **not** been
validated as authenticated. Do not install/login automatically to make the
gate pass. Keep manually supplied token credentials in the existing external
canonical `secrets.local.json`, never a new token store here. The explicit manual
OAuth flow above lets the CLI manage its own service login state; leave existing
interactive CLI/gh stores untouched. Never paste a token into a command line, report, commit, or shared
log. Do not copy `~/.copilot`, run global login/logout, or change global CLI
configuration.

### Isolation, limits, and boundaries

Each run owns a fresh UUID directory beneath ignored `.cache/sdk-contract/`
(0700), containing its workspace, OS home and runtime scratch. Transient auth
modes also keep their Copilot home there; only explicit service-login mode uses
the persistent, separately provisioned `runtime/copilot`, outside run-directory cleanup.
Only a small environment allowlist reaches the CLI. All auth modes keep
a service-controlled `baseDirectory` (SDK sets `COPILOT_HOME`), an empty
workspace, disabled custom instructions/built-in MCPs/remote sessions/export,
and no cross-session searches. Full behavior sessions explicitly enable only
the fixture tools for that probe; readiness creates no sessions. Logged-in modes' sole
discovery exception is existing authentication through HOME/gh config, **not**
interactive Copilot config, personas, or history. Token and logged-in modes use
`mode: "empty"`; CLI-login and service-login use `mode: "copilot-cli"`.
Log level remains `none`, but CLI mode enables the SDK's process file-logging
facility in its Copilot home: disposable for CLI-login, potentially persistent
service-only state for service-login. This
is configuration separation, not an OS sandbox or a guarantee about future
tool-capable sessions.

RPC deadlines: start 25 s, status/auth 10 s, model list 15 s, session create 20 s,
turn idle 60 s, graceful stop 8 s, transport close 2 s. A 180 s readiness /
20 min full-gate watchdog and SIGINT/SIGTERM handlers invoke owned
cleanup. Process signalling uses observed child **PID + start time + executable**
identity, never process-name matching or detached processes. Per-run directories
are removed only after termination checks; the gate never sweeps unrelated
cache directories. The OS snapshot mechanism is a narrow gate harness, **not a
production runtime-tree supervisor**. Native tool identities are explicitly
registered before abort; the gate verifies both their actual exit and an
unaffected active neighboring runtime.

The `sdk-contract` prerequisite is verified; application state and adapters
build on those checked contracts. Any future failed/blocked gate rerun must
stop dependent SDK changes until its concrete incompatibility is resolved.

## Acceptance status

Verified locally on Node 24: configuration/SQLite recovery, synthetic cross-module
Telegram ingress → document worker → application → runtime events → outbox,
duplicate suppression, priority stop, backup/restore, process ownership and
shutdown failure retention. The external boundaries in offline tests are fakes.

The **production Copilot adapter**, application and real SQLite were also run
against the provisioned service OAuth: a synthetic reply completed, a second
turn was cancelled, then the same native session resumed with
`continuePendingWork: false`. The completed reply remained in real SDK history,
with no automatic replay; exactly two sends, tool requests denied and fixture
sessions removed. The zero-inference lifecycle probe is separate. Reproduce
these opt-in checks only with an explicit service home:

```sh
DENSEMBLE_RUNTIME_SMOKE=1 DENSEMBLE_RUNTIME_HOME="$PWD/runtime/copilot" \
  npm test -- tests/unit/runtime-sdk-smoke.test.ts
DENSEMBLE_APPLICATION_SMOKE=1 DENSEMBLE_RUNTIME_HOME="$PWD/runtime/copilot" \
  npm test -- tests/unit/runtime-application-smoke.test.ts
```

The full test suite skips opt-in real SDK tests by default. The separate
authenticated SDK gate is documented above; running it consumes Copilot usage.

**Not yet verified:** real Telegram DM/group/forum routing, privacy-mode
configuration, actual file uploads/downloads and Bot API outages; Ukrainian voice
recognition using a real whisper.cpp model; manual sleep/wake and LaunchAgent
operation. Complete those checks with provisioned bot tokens, numeric owner/chat
bindings, a local multilingual model and an approved voice sample before
considering deployment accepted. No real Trello/Calendar mutations are part of
acceptance.
