import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagnosticSink } from "../ports.js";
import {
  errorCode, FIXED_CODE, MODULE_ID, ModuleError,
  type AbilityCall, type AbilityResult, type AbilitySpec, type CoreOffer, type ModuleContext, type ModuleDefinition,
  type ModuleEntry, type ModuleHealth, type ModuleInstance, type ModuleReason, type ModuleState, type ModuleStateReport,
} from "./contract.js";
import { loadModule, type ModuleLoader } from "./loader.js";

/** Core ability names live in this namespace; modules may not use it. */
const CORE_PREFIX = "densemble_";
const CORE_ABILITIES = new Set(["densemble_state"]);
/** Short enough for `mcp__densemble__<name>` within engine tool-name limits. */
const ABILITY_NAME = /^[a-z][a-z0-9_-]{0,47}$/;

export interface HostAbility {
  moduleId: string;
  spec: AbilitySpec;
  /** Never throws: module errors become `{ ok: false, code: "MODULE_FAILED" }`. */
  invoke(args: unknown, call: AbilityCall): Promise<AbilityResult>;
}

export interface ModuleView {
  entry: ModuleEntry;
  definition?: ModuleDefinition;
  /** `INSTRUCTIONS.md`, read once at resolve. */
  instructions?: string;
  health: ModuleHealth;
}

export interface ModuleHostOptions {
  entries: readonly ModuleEntry[];
  loader?: ModuleLoader;
  core: CoreOffer;
  runtimeDataPath: string;
  diagnostics: DiagnosticSink;
  /** Returns a module's `INSTRUCTIONS.md`, undefined when missing or unreadable. */
  readInstructions?: (id: string) => Promise<string | undefined>;
  stopTimeoutMs?: number;
  now?: () => number;
}

export interface ModuleHost {
  /** Loads and validates every enabled module without starting it; idempotent. */
  resolve(): Promise<void>;
  /** Abilities of enabled modules that passed `resolve()` (engines fix their tool sets early). */
  declaredAbilityNames(): string[];
  /** Starts resolved modules in dependency order; a module failure never rejects. */
  start(): Promise<void>;
  /** Reverse start order, each bounded; `incomplete` lists modules that failed or timed out. Never rejects. */
  stop(): Promise<{ incomplete: string[] }>;
  health(id: string): ModuleHealth | undefined;
  /** One row per configured module, in config order. */
  report(): ModuleStateReport[];
  /** Health transitions; returns an unsubscribe function. */
  onChange(listener: (id: string, health: ModuleHealth) => void): () => void;
  /** Abilities of ready modules. */
  abilities(): HostAbility[];
  get(id: string): ModuleView | undefined;
}

interface Slot {
  entry: ModuleEntry;
  definition?: ModuleDefinition;
  settings?: unknown;
  instructions?: string;
  health: ModuleHealth;
  instance?: ModuleInstance;
  controller?: AbortController;
}

/** User-facing (Ukrainian) cause and fix for host codes; module codes come from the module's `reasons`. */
const HOST_REASONS: Readonly<Record<string, (id: string, detail?: string) => ModuleReason>> = {
  MODULE_DISABLED: (id) => ({ cause: "Модуль вимкнено в config.local.json.",
    fix: `Увімкніть modules.${id}.enabled і виконайте make restart.` }),
  MODULE_UNKNOWN: (id) => ({ cause: `Densemble не знайшов модуля «${id}» у src/modules/${id}.`,
    fix: `Перевірте назву modules.${id} у config.local.json або приберіть цей запис, потім виконайте make restart.` }),
  MODULE_SETTINGS_INVALID: (id) => ({ cause: "Налаштування модуля некоректні.",
    fix: `Виправте modules.${id}.settings за README модуля і виконайте make restart.` }),
  MODULE_DEPENDENCY_UNAVAILABLE: (_id, dependency) => ({
    cause: `Модуль потребує модуля «${dependency ?? "?"}», а той відсутній, вимкнений або не працює.`,
    fix: `Увімкніть і налаштуйте modules.${dependency ?? "?"}, потім виконайте make restart.` }),
  MODULE_DEPENDENCY_CYCLE: () => ({ cause: "Модулі залежать один від одного по колу.",
    fix: "Вимкніть один із цих модулів і виконайте make restart; залежність має виправити розробник модуля." }),
  MODULE_ABILITY_DUPLICATE: () => ({ cause: "Інший модуль або ядро вже має можливість із такою самою назвою.",
    fix: "Вимкніть один із модулів-конфліктів і виконайте make restart; назву має виправити розробник модуля." }),
  MODULE_ABILITY_INVALID: (id) => ({ cause: `Назва можливості модуля не має вигляду ${id}_<дія>.`,
    fix: "Вимкніть модуль і виконайте make restart; назву має виправити розробник модуля." }),
  MODULE_INSTRUCTIONS_MISSING: (id) => ({ cause: "У модуля немає інструкцій для агентів (INSTRUCTIONS.md).",
    fix: `Додайте src/modules/${id}/INSTRUCTIONS.md або вимкніть модуль, потім виконайте make restart.` }),
  MODULE_START_FAILED: () => ({ cause: "Модуль не зміг запуститися.",
    fix: "Перегляньте журнал сервісу (коди MODULE_*), усуньте причину і виконайте make restart." }),
  MODULE_FAILED: () => ({ cause: "Фонова робота модуля аварійно зупинилася; решта Densemble працює.",
    fix: "Перегляньте журнал сервісу, усуньте причину і виконайте make restart." }),
};

/** Reads `src/modules/<id>/INSTRUCTIONS.md` under the code root (the same root from `src/` and `dist/`). */
export function instructionsReader(codeRoot = fileURLToPath(new URL("../../", import.meta.url))): (id: string) => Promise<string | undefined> {
  return async (id) => {
    if (!MODULE_ID.test(id)) return undefined;
    try {
      const text = await readFile(join(codeRoot, "src", "modules", id, "INSTRUCTIONS.md"), "utf8");
      return text.trim() ? text : undefined;
    } catch { return undefined; }
  };
}

/**
 * Module host: resolve (load, validate, order) → start in dependency order → health → reverse bounded stop.
 * A dependent of a module that leaves `ready` becomes `unavailable` and stays so until the next restart,
 * even if its dependency recovers.
 */
export function createModuleHost(options: ModuleHostOptions): ModuleHost {
  const loader = options.loader ?? loadModule;
  const readInstructions = options.readInstructions ?? instructionsReader();
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const sink = options.diagnostics;
  const listeners = new Set<(id: string, health: ModuleHealth) => void>();
  const slots = new Map<string, Slot>();
  for (const entry of options.entries) {
    if (!slots.has(entry.id)) slots.set(entry.id, { entry, health: { state: "starting", code: "MODULE_STARTING", since: now() } });
  }
  const startOrder: Slot[] = [];
  const started: Slot[] = [];
  let resolving: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<{ incomplete: string[] }> | undefined;
  let resolved = false;

  const requires = (slot: Slot): readonly string[] => slot.definition?.requires ?? [];
  const pending = (slot: Slot) => slot.health.state === "starting";

  function set(slot: Slot, state: ModuleState, code: string, detail?: string): void {
    const current = slot.health;
    if (current.state === state && current.code === code && current.detail === detail) return;
    slot.health = { state, code, ...(detail === undefined ? {} : { detail }), since: now() };
    sink.record(code, { module: slot.entry.id, state });
    for (const listener of listeners) {
      try { listener(slot.entry.id, slot.health); } catch { /* An observer must not break module health. */ }
    }
    // A required module leaving ready takes its dependents down with it (they stay down until restart).
    if (resolved && state !== "ready" && state !== "starting") {
      for (const dependent of slots.values()) {
        if (requires(dependent).includes(slot.entry.id) && ["starting", "ready", "failed"].includes(dependent.health.state)) {
          set(dependent, "unavailable", "MODULE_DEPENDENCY_UNAVAILABLE", slot.entry.id);
        }
      }
    }
  }

  function fail(slot: Slot, code: string): void {
    if (stopping || !["starting", "ready", "failed"].includes(slot.health.state)) return;
    set(slot, "failed", FIXED_CODE.test(code) ? code : "MODULE_FAILED");
  }

  async function resolveAll(): Promise<void> {
    const loaded: Slot[] = [];
    for (const slot of slots.values()) {
      if (!slot.entry.enabled) { set(slot, "disabled", "MODULE_DISABLED"); continue; }
      let definition: ModuleDefinition | undefined;
      try { definition = await loader(slot.entry.id); } catch { definition = undefined; }
      if (definition?.id !== slot.entry.id) { set(slot, "unavailable", "MODULE_UNKNOWN"); continue; }
      slot.definition = definition;
      loaded.push(slot);
    }
    checkAbilities(loaded);
    for (const slot of loaded) {
      if (pending(slot)) await checkInstructions(slot);
      if (pending(slot)) await prepareSettings(slot);
    }
    orderByDependencies(loaded);
    resolved = true;
  }

  /** Duplicates first (across modules and core), then the `<id>_` naming rule. */
  function checkAbilities(loaded: Slot[]): void {
    const owners = new Map<string, Set<Slot>>();
    for (const slot of loaded) {
      for (const spec of slot.definition?.abilities ?? []) {
        const holders = owners.get(spec.name) ?? new Set<Slot>();
        holders.add(slot);
        owners.set(spec.name, holders);
      }
    }
    for (const slot of loaded) {
      const names = (slot.definition?.abilities ?? []).map((spec) => spec.name);
      if (new Set(names).size !== names.length ||
          names.some((name) => CORE_ABILITIES.has(name) || (owners.get(name)?.size ?? 0) > 1)) {
        set(slot, "unavailable", "MODULE_ABILITY_DUPLICATE");
      } else if (names.some((name) => !ABILITY_NAME.test(name) || !name.startsWith(`${slot.entry.id}_`) || name.startsWith(CORE_PREFIX))) {
        set(slot, "unavailable", "MODULE_ABILITY_INVALID");
      }
    }
  }

  async function checkInstructions(slot: Slot): Promise<void> {
    const definition = slot.definition;
    if (!definition || (!definition.instructions && !definition.abilities?.length)) return;
    let text: string | undefined;
    try { text = await readInstructions(slot.entry.id); } catch { text = undefined; }
    if (text === undefined) set(slot, "unavailable", "MODULE_INSTRUCTIONS_MISSING");
    else slot.instructions = text;
  }

  /** Module schema, then `prepare()`; no setting values reach diagnostics. */
  async function prepareSettings(slot: Slot): Promise<void> {
    const definition = slot.definition;
    if (!definition) return;
    let settings: unknown;
    try {
      const parsed = definition.settings.safeParse(slot.entry.settings);
      if (!parsed.success) {
        sink.record("MODULE_SETTINGS_ISSUES", { module: slot.entry.id, count: parsed.error.issues.length });
        set(slot, "unavailable", "MODULE_SETTINGS_INVALID");
        return;
      }
      settings = parsed.data;
    } catch { set(slot, "unavailable", "MODULE_SETTINGS_INVALID"); return; }
    if (definition.prepare) {
      try {
        const result: unknown = await definition.prepare(settings, options.core);
        const outcome = typeof result === "object" && result !== null ? result as { ok?: unknown; settings?: unknown; code?: unknown } : {};
        if (outcome.ok !== true) {
          set(slot, "unavailable", errorCode(outcome, "MODULE_SETTINGS_INVALID"));
          return;
        }
        settings = outcome.settings;
      } catch (error) {
        set(slot, "unavailable", errorCode(error, "MODULE_SETTINGS_INVALID"));
        return;
      }
    }
    slot.settings = settings;
  }

  /** Cycles make every member unavailable; the rest is ordered so dependencies start first. */
  function orderByDependencies(loaded: Slot[]): void {
    const color = new Map<Slot, "open" | "done">();
    const stack: Slot[] = [];
    const cyclic = new Set<Slot>();
    const walk = (slot: Slot): void => {
      color.set(slot, "open");
      stack.push(slot);
      for (const id of requires(slot)) {
        const next = slots.get(id);
        if (!next?.definition) continue;
        const seen = color.get(next);
        if (seen === "open") for (const member of stack.slice(stack.indexOf(next))) cyclic.add(member);
        else if (!seen) walk(next);
      }
      stack.pop();
      color.set(slot, "done");
    };
    for (const slot of loaded) if (!color.has(slot)) walk(slot);
    for (const slot of cyclic) if (pending(slot)) set(slot, "unavailable", "MODULE_DEPENDENCY_CYCLE");

    const visited = new Set<Slot>();
    const visit = (slot: Slot): void => {
      if (visited.has(slot)) return;
      visited.add(slot);
      for (const id of requires(slot)) {
        const next = slots.get(id);
        if (next?.definition) visit(next);
      }
      if (!pending(slot)) return;
      const missing = requires(slot).find((id) => {
        const dependency = slots.get(id);
        return !dependency || !pending(dependency);
      });
      if (missing !== undefined) set(slot, "unavailable", "MODULE_DEPENDENCY_UNAVAILABLE", missing);
      else startOrder.push(slot);
    };
    for (const slot of loaded) visit(slot);
  }

  async function startAll(): Promise<void> {
    await resolve();
    for (const slot of startOrder) {
      if (stopping) return;
      if (!pending(slot)) continue;
      const missing = requires(slot).find((id) => slots.get(id)?.health.state !== "ready");
      if (missing !== undefined) { set(slot, "unavailable", "MODULE_DEPENDENCY_UNAVAILABLE", missing); continue; }
      await startOne(slot);
    }
  }

  async function startOne(slot: Slot): Promise<void> {
    const definition = slot.definition;
    if (!definition) return;
    const id = slot.entry.id;
    const controller = new AbortController();
    slot.controller = controller;
    const dataPath = join(options.runtimeDataPath, "modules", id);
    try { await mkdir(dataPath, { recursive: true, mode: 0o700 }); }
    catch { set(slot, "failed", "MODULE_START_FAILED"); return; }
    const context: ModuleContext = {
      settings: slot.settings,
      dataPath,
      diagnostics: { record: (code, metadata) => { sink.record(code, { ...metadata, module: id }); } },
      core: options.core,
      require<T>(dependency: string): T {
        const target = slots.get(dependency);
        if (!requires(slot).includes(dependency) || target?.health.state !== "ready" || !target.instance) {
          throw new ModuleError("MODULE_DEPENDENCY_UNAVAILABLE");
        }
        return target.instance.provides as T;
      },
      run(task) {
        (async () => { await task(); })().catch((error: unknown) => {
          if (!controller.signal.aborted) fail(slot, errorCode(error, "MODULE_FAILED"));
        });
      },
      fail(code) { if (!controller.signal.aborted) fail(slot, code); },
      recovered() {
        if (!controller.signal.aborted && !stopping && slot.health.state === "failed") set(slot, "ready", "MODULE_READY");
      },
      signal: controller.signal,
    };
    let instance: ModuleInstance;
    try {
      instance = await definition.start(context);
      if (typeof instance !== "object" || instance === null || typeof instance.stop !== "function") {
        throw new ModuleError("MODULE_START_FAILED");
      }
    } catch (error) {
      controller.abort();
      if (error instanceof ModuleError && error.unavailable) set(slot, "unavailable", errorCode(error, "MODULE_START_FAILED"));
      else set(slot, "failed", errorCode(error, "MODULE_START_FAILED"));
      return;
    }
    slot.instance = instance;
    started.push(slot);
    if (stopping) return;
    // `ctx.fail()` or a `ctx.run()` rejection during start keeps the module failed.
    if (pending(slot)) set(slot, "ready", "MODULE_READY");
  }

  async function stopOne(slot: Slot): Promise<boolean> {
    slot.controller?.abort();
    const instance = slot.instance;
    if (!instance) return true;
    delete slot.instance;
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => instance.stop()).then(() => "stopped" as const),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), stopTimeoutMs); }),
      ]);
      if (outcome === "stopped") return true;
      sink.record("MODULE_STOP_TIMEOUT", { module: slot.entry.id });
    } catch {
      sink.record("MODULE_STOP_FAILED", { module: slot.entry.id });
    } finally { clearTimeout(timer); }
    return false;
  }

  async function stopAll(): Promise<{ incomplete: string[] }> {
    for (const slot of slots.values()) slot.controller?.abort();
    // A start in flight sees the aborted signal; wait for it (bounded) so its instance is stopped too.
    if (starting) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([starting.catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, stopTimeoutMs); })]);
      clearTimeout(timer);
    }
    const incomplete: string[] = [];
    for (const slot of [...started].reverse()) if (!await stopOne(slot)) incomplete.push(slot.entry.id);
    return { incomplete };
  }

  function reason(slot: Slot): ModuleReason | undefined {
    const { code, detail } = slot.health;
    // `reasons` is not checked by the loader: a module without it must not break reports for every session.
    const known = slot.definition?.reasons?.[code] ?? HOST_REASONS[code]?.(slot.entry.id, detail);
    if (known || (slot.health.state !== "unavailable" && slot.health.state !== "failed")) return known;
    // A code without a declared reason still gets a cause and a fix (SC-005).
    return { cause: `Модуль ${slot.health.state === "failed" ? "аварійно зупинився" : "недоступний"} (код ${code}).`,
      fix: "Перегляньте make doctor і журнал сервісу, усуньте причину і виконайте make restart." };
  }

  function statusLine(slot: Slot): string | undefined {
    if (!slot.instance || (slot.health.state !== "ready" && slot.health.state !== "failed")) return undefined;
    try {
      const line = slot.instance.status?.();
      return typeof line === "string" && line.trim() ? line.trim() : undefined;
    } catch { return undefined; }
  }

  async function invoke(slot: Slot, spec: AbilitySpec, args: unknown, call: AbilityCall): Promise<AbilityResult> {
    const instance = slot.instance;
    if (slot.health.state !== "ready" || !instance?.invoke) {
      return { ok: false, code: "MODULE_UNAVAILABLE", message: "The module is not ready." };
    }
    const parsed = spec.input.safeParse(args);
    if (!parsed.success) return { ok: false, code: "MODULE_INPUT_INVALID", message: "The ability input is invalid." };
    try {
      const result: unknown = await instance.invoke(spec.name, parsed.data, call);
      if (typeof result === "object" && result !== null && typeof (result as { ok?: unknown }).ok === "boolean") {
        return result as AbilityResult;
      }
    } catch { /* Reported below; a module error never escapes the host. */ }
    sink.record("MODULE_ABILITY_FAILED", { module: slot.entry.id });
    return { ok: false, code: "MODULE_FAILED", message: "The module failed to handle the request." };
  }

  function resolve(): Promise<void> {
    return resolving ??= resolveAll();
  }

  return {
    resolve,
    declaredAbilityNames() {
      if (!resolved) return [];
      return [...slots.values()].filter((slot) => slot.health.state !== "disabled" && slot.health.state !== "unavailable")
        .flatMap((slot) => (slot.definition?.abilities ?? []).map((spec) => spec.name));
    },
    start() { return starting ??= startAll(); },
    stop() { return stopping ??= stopAll(); },
    health(id) { return slots.get(id)?.health; },
    report() {
      return [...slots.values()].map((slot): ModuleStateReport => {
        const { entry, definition, health } = slot;
        const why = reason(slot);
        const status = statusLine(slot);
        return {
          id: entry.id,
          ...(definition ? { version: definition.version } : {}),
          enabled: entry.enabled,
          state: health.state,
          code: health.code,
          ...(health.detail === undefined ? {} : { detail: health.detail }),
          ...(why ? { cause: why.cause, fix: why.fix } : {}),
          requires: [...requires(slot)],
          agents: [...entry.agents],
          ...(status === undefined ? {} : { status }),
          ...(entry.movedSettings ? { movedSettings: { ...entry.movedSettings } } : {}),
        };
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    abilities() {
      return [...slots.values()].filter((slot) => slot.health.state === "ready").flatMap((slot) =>
        (slot.definition?.abilities ?? []).map((spec): HostAbility => ({
          moduleId: slot.entry.id, spec, invoke: (args, call) => invoke(slot, spec, args, call),
        })));
    },
    get(id) {
      const slot = slots.get(id);
      if (!slot) return undefined;
      return {
        entry: slot.entry, health: slot.health,
        ...(slot.definition ? { definition: slot.definition } : {}),
        ...(slot.instructions === undefined ? {} : { instructions: slot.instructions }),
      };
    },
  };
}
