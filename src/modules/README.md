# Modules

Optional features that plug into the core without core edits. A module is found by its id:
`modules.<id>` in `config.local.json` makes the host import `src/modules/<id>/index.js`.

## Folder layout

```text
src/modules/
├── contract.ts       ModuleDefinition, ModuleContext, abilities, health and report types
├── core-api.ts       the only core surface a module may import
├── loader.ts         id → dynamic import of ./<id>/index.js (injectable in tests)
├── host.ts           resolve → start in dependency order → health → reverse bounded stop
├── INSTRUCTIONS.md   core instructions for every agent (English)
└── <id>/
    ├── index.ts         export const module: ModuleDefinition<Settings, Api>
    ├── api.ts           optional: public API for core and for modules that require this one
    ├── README.md        owner docs: settings, prerequisites, what it gives agents
    └── INSTRUCTIONS.md  English ability reference; required when the module has abilities
```

## Contract

See `contract.ts`. In short, a definition has `id` (equals the folder), `version`, optional
`requires` (module ids), a zod `settings` schema, optional static `abilities`
(names `<id>_<verb>`, never `densemble_*`), `reasons` (Ukrainian cause and fix per module code),
optional `prepare(settings, core)` for path checks, optional `doctor(settings, core)`, and
`start(ctx)` returning an instance with `stop()` and optional `provides`, `invoke`, `status`.

`ctx` gives the validated `settings`, a private `dataPath` (`runtimeDataPath/modules/<id>/`),
`diagnostics` (module id added), `core`, `require<T>(id)`, `run(task)`, `fail(code)`,
`recovered()` and `signal` (aborted on stop).

Health: `disabled` (never loaded), `unavailable` (unknown id, invalid settings, missing
instructions, bad ability names, dependency problems, `ModuleError(code, { unavailable: true })`
from `start`), `starting`, `ready`, `failed` (`start` threw, `ctx.fail`, a `ctx.run` rejection;
`ctx.recovered()` returns to `ready`). A module whose dependency leaves `ready` becomes
`unavailable` and stays so until the next restart. Codes are fixed strings; diagnostics never
carry paths, content or secrets.

## Rules

- Imports: node built-ins, npm dependencies, the module's own folder, `../core-api.js`, and
  `../<id>/api.js` of a module listed in `requires`. Nothing else.
- Core code outside `src/modules/` may import a module only through its `src/modules/<id>/api.ts`
  (e.g. `recordings-status` reads `recordings/api.ts`), never its internals.
- Background work goes through `ctx.run(task)` so a failure marks only this module `failed`.
  An unhandled rejection outside `ctx.run` is a module bug.
- Stop promptly: `stop()` is bounded (10 s) and `ctx.signal` is aborted first.
- `INSTRUCTIONS.md` describes abilities (Purpose, Inputs, Returns, Limits, Errors), never
  workflows; hard limits live in code.

## Adding a module

1. Create `src/modules/<id>/` with `index.ts`, `README.md` and, if it has abilities,
   `INSTRUCTIONS.md`.
2. Add `"modules": { "<id>": { "agents": [...], "settings": {...} } }` to `config.local.json`
   and run `make restart`. No core file changes.
