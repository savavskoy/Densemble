# Densemble

**Preproduction scaffold, not a working service.** Densemble is intended to be
a local Telegram interface to managed Copilot agent runtimes. This repository
currently contains only a strict TypeScript ESM foundation and bootstrap tests.
It does not start Telegram polling, a Copilot runtime, or an HTTP server.

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
runs only unit tests, checks dependency imports and the native SQLite binding,
and verifies explicit startup failure. It does not contact Telegram or Copilot.
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

## Required next gate

The Copilot SDK is pinned to **1.0.16**. Its runtime behavior has **not** been
validated by these bootstrap tests. Before implementing dependent application
modules, executable integration checks must establish the compatible runtime,
background authentication, agent/model discovery, skills/MCP/subagents,
streaming, questions and permissions, image input, steering, model switching,
abort/resume, and isolated process termination.

Until those checks pass, there is no claim of functional bots, permission
enforcement, session isolation, or reliable cancellation. Media parsers, local
audio tools, deployment configuration, and other application modules are
deliberately not included in this bootstrap.
