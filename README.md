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

## SDK integration gate — BLOCKED

Both packages and their lockfile resolutions are pinned:
**`@github/copilot-sdk@1.0.16` / `@github/copilot@1.0.91`**. The gate resolves the
local macOS ARM64 native CLI package directly, not the global `copilot` launcher
or the SDK's bundled 1.0.90 runtime. `--no-auto-update` is explicit; the real
`getStatus()` RPC must report 1.0.91. This is a tested startup pairing, **not a
claim that all SDK contracts are compatible**.

### Runbook

Use Node 24 for **every** command, including tests (the native SQLite binding
was built for Node 24). With Node 24 active:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run sdk:gate                           # offline: SKIPPED/BLOCKED, exit 2
npm run sdk:gate -- --real --readiness      # actual start/status/auth/listModels
npm run sdk:gate -- --real                  # also two-runtime forced-stop smoke
```

Without a Node version manager:

```sh
npm exec --yes --package=node@24.21.0 --package=npm@11.9.0 -- \
  sh -c 'node --version && npm run sdk:gate -- --real'
```

Exit **0** is reserved for the entire required contract matrix passing; **1**
means a failed check/cleanup or invalid arguments; **2** means blocked/skipped.
Readiness-only success cannot unlock dependent work. To consume just the JSON
report after building, run `node dist/agents/sdk-gate/main.js --real`.
No report contains tokens, login names, model responses, raw RPC errors, or
tool arguments. An upstream failure is reported as `UPSTREAM_ERROR_REDACTED`,
with the failing stage identified. Do not enable debug logging to share errors.

### Current real evidence and missing coverage

The gate was run locally using Node **24.21.0**:

| Contract | Observation |
|---|---|
| Pinned runtime start/status | PASS: CLI 1.0.91, protocol 3 |
| Isolated authentication | BLOCKED: `getAuthStatus().isAuthenticated === false` |
| Real model discovery | BLOCKED: the actual `listModels()` RPC rejected |
| Forced runtime termination | Smoke PASS: freeze one owned PID with SIGSTOP, observe its unresponsive RPC, terminate it, verify a distinct runtime PID still answers ping |
| Cleanup | PASS: observed owned runtime processes exited; per-run files removed |
| Full process isolation | BLOCKED: no authenticated active chats, native tool descendants, or model-originated subprocesses were tested |

**Zero model requests were sent.** The remaining authenticated probes are
**not implemented or run** at this checkpoint: persona/default-model discovery,
streaming, real user questions, native permissions, explicit skills and MCP,
native subagents and delegated permission propagation, turn-boundary model
switching, immediate steering, image input, abort during streaming/question/tool
execution, resume with restored handlers, and no replay of pending external
actions. The JSON matrix enumerates them individually. The gate deliberately
cannot pass yet, even if auth is subsequently provisioned; finish those real
checks before enabling dependent work.

Offline tests cover report completeness, failure/skip semantics, deadline
handling, error sanitization, installed pins, PID identity and descendant
selection, and cancellation of owned synthetic Node processes. **They are not
mocked proof of SDK permissions, delegated policy, abort/idle, or resume.**
No tool-capable sessions are created by this checkpoint; no real external service
mutations, arbitrary shell permissions, or blanket approvals are used.

### Safe authentication provisioning

The probe intentionally does **not** reuse interactive CLI authentication:
`mode: "empty"`, isolated `HOME`/`COPILOT_HOME`, and `useLoggedInUser: false`
prevent ambient configuration/keychain/`gh` fallback. An unauthenticated probe
does not imply that the user's interactive CLI is logged out.

Provision a fine-grained GitHub PAT with **Copilot Requests** permission for a
Copilot-enabled account, as described in the pinned CLI README. Keep it only in
the existing **external canonical `secrets.local.json`**; do not create a second
credential store here. Have your local secret launcher inject it into
**`COPILOT_GITHUB_TOKEN`** for this process, then rerun:

```sh
npm run sdk:gate -- --real --readiness
```

`COPILOT_GITHUB_TOKEN` is the gate's input; it is explicitly passed as SDK
`gitHubToken`, not a claim about the CLI's environment-variable precedence.
Never paste a token into a command line, report, commit, or shared log. Do not
copy `~/.copilot`, run global login/logout, or change global CLI configuration
to make this check pass.

### Isolation, limits, and boundaries

Each run owns a fresh UUID directory beneath ignored `.cache/sdk-contract/`
(0700), containing its workspace, Copilot home, OS home and runtime scratch.
Only a small environment allowlist reaches the CLI. No private workspace,
personas, user configuration, cross-session searches, or built-in MCP services
are loaded. Logs and remote export are disabled.

RPC deadlines: start 25 s, status/auth 10 s, model list 15 s, graceful stop 8 s,
transport close 2 s. A 180 s watchdog and SIGINT/SIGTERM handlers invoke owned
cleanup. Process signalling uses observed child **PID + start time + executable**
identity, never process-name matching or detached processes. Per-run directories
are removed only after termination checks; the gate never sweeps unrelated
cache directories. The OS snapshot mechanism is a narrow gate harness, **not a
production runtime-tree supervisor**: short-lived/reparented native tool
descendants still need authenticated integration validation.

Until the full gate passes, `state-config`, session control, Telegram, media and
dependent deployment work remain blocked. There is no claim of functional bots,
permission enforcement, reliable SDK cancellation, or session recovery.
