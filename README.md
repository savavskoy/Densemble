# Densemble

**Preproduction scaffold, not a working service.** Densemble is intended to be
a local Telegram interface to managed Copilot agent runtimes. This repository
contains a strict TypeScript ESM foundation and an **incomplete, blocking SDK
integration gate**. Normal startup does not start Telegram polling, a Copilot
runtime, or an HTTP server. The explicitly opted-in gate launches isolated
Copilot runtimes, but does not start the application.

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

After building, `npm start` deliberately writes a not-configured diagnostic to
stderr and exits with status **1**. There is no configured execution path yet;
creating a configuration file will not turn this scaffold into a service.

## Configuration and privacy

[`config.example.json`](config.example.json) is an **illustrative, nonfunctional**
example of intended configuration inputs, not an implemented or validated schema.
Its paths, identifiers, zero owner ID, and empty bindings are placeholders.
Future configuration loading belongs after the SDK integration gate.

Keep actual configuration in an ignored `config.local.json`. Reference an
existing external `secrets.local.json` using `secretsPath`; bot entries reference
secret keys, never token values. Do not copy credentials, private agent
instructions, knowledge files, or personal documents into this repository.
The configured agent workspace must remain separate from this service's code.

Local configuration, credentials, dependency caches, runtime data, attachments,
database files, logs, and scratch files are ignored. Use `data/`, `runtime/`,
`logs/`, and `.cache/` for local artifacts. Ignore rules are only an accidental
commit safeguard, not access control; review staged changes before committing.

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

The `sdk-contract` prerequisite is verified. Safe next work is `state-config`;
after that shared contract, session control, Telegram core and media can proceed
with the plan's ownership boundaries. Any future failed/blocked gate rerun must
stop dependent SDK changes until its concrete incompatibility is resolved.
