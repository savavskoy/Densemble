import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Json } from "../domain.js";
import type { DiagnosticSink } from "../ports.js";
import type { AbilityResult, AbilitySpec, ModuleState, ModuleStateReport } from "./contract.js";
import type { ModuleHost } from "./host.js";
import type { SessionAbility } from "./instructions.js";

export const DENSEMBLE_STATE = "densemble_state";

const OWNER_NOTE = "Modules are changed only by the owner in config.local.json (modules.<id>.enabled, " +
  "modules.<id>.settings, modules.<id>.agents) followed by `make restart`; agents cannot enable, disable, " +
  "restart or reconfigure them.";
const NON_OWNER_NOTE = "Module state is visible to the owner only.";

export const densembleStateSpec: AbilitySpec = {
  name: DENSEMBLE_STATE,
  description: "Read Densemble's module state: which modules are enabled, ready, unavailable or failed, why, and what each is " +
    "doing now, with the cause and the fix for each problem. Read-only.",
  input: z.object({ module: z.string().min(1).max(64).optional().describe("Only this module id.") }),
  readOnly: true,
};

export interface DensembleStateOptions {
  /** One line about the coordinator (owner only), when there is one. */
  coordinator?: () => string | undefined;
}

/** Core `densemble_state` ability: the owner sees every module row, anyone else an empty list. */
export function densembleStateAbility(host: ModuleHost, options: DensembleStateOptions = {}): SessionAbility {
  return {
    moduleId: null,
    spec: densembleStateSpec,
    async invoke(args, call): Promise<AbilityResult> {
      if (!call.owner) return { ok: true, modules: [], note: NON_OWNER_NOTE };
      const parsed = densembleStateSpec.input.safeParse(args ?? {});
      if (!parsed.success) return { ok: false, code: "MODULE_INPUT_INVALID", message: "The ability input is invalid." };
      const only = (parsed.data as { module?: string }).module;
      const modules = host.report().filter((row) => only === undefined || row.id === only);
      let coordinator: string | undefined;
      try { coordinator = options.coordinator?.(); } catch { coordinator = undefined; }
      return {
        ok: true,
        // Report rows are plain JSON data (strings, booleans, string arrays).
        modules: modules as unknown as Json,
        ...(coordinator ? { coordinator } : {}),
        note: OWNER_NOTE,
      };
    },
  };
}

/** `runtimeDataPath/modules/state.json`: the snapshot `modules-status` reads without the process lock. */
export interface ModulesStateFile {
  version: 1;
  updatedAt: string;
  modules: ModuleStateReport[];
}

/** The service refreshes the snapshot every minute; older than this means it is not running. */
export const MODULES_STATE_STALE_MS = 3 * 60_000;

export function modulesStatePath(runtimeDataPath: string): string {
  return join(runtimeDataPath, "modules", "state.json");
}

/** Owner-private JSON (0600), replaced atomically so a reader never sees a half-written file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
    finally { await handle.close(); }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function writeModulesState(path: string, modules: readonly ModuleStateReport[], now = Date.now()): Promise<void> {
  const state: ModulesStateFile = { version: 1, updatedAt: new Date(now).toISOString(), modules: [...modules] };
  await writeJsonAtomic(path, state);
}

export async function readModulesState(path: string): Promise<ModulesStateFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ModulesStateFile;
    return parsed?.version === 1 && typeof parsed.updatedAt === "string" && Array.isArray(parsed.modules) ? parsed : undefined;
  } catch { return undefined; }
}

export function isModulesStateStale(state: ModulesStateFile, now: number): boolean {
  const updated = Date.parse(state.updatedAt);
  return !Number.isFinite(updated) || now - updated > MODULES_STATE_STALE_MS;
}

/**
 * The moved-setting hint (contracts/config.md), e.g. "`recordings` moved to `modules.recordings.settings`; add
 * `"agents": ["alfred"]` there …". The agents hint appears only while no agent may use the module.
 */
export function movedSettingsText(row: Pick<ModuleStateReport, "id" | "agents" | "movedSettings">, agentId = "alfred"): string | undefined {
  const moved = row.movedSettings;
  if (!moved) return undefined;
  const text = `\`${moved.from}\` moved to \`${moved.to}\``;
  if (row.agents.length) return `${text}.`;
  const name = agentId.charAt(0).toUpperCase() + agentId.slice(1);
  return `${text}; add \`"agents": ["${agentId}"]\` to \`modules.${row.id}\` to let ${name} use the module's abilities.`;
}

/** Plain text for `modules-status`; a missing or stale snapshot means the service is not running. */
export function formatModulesStatus(options: { state: ModulesStateFile | undefined; now: number; agentId?: string }): string {
  const { state, now } = options;
  if (!state || isModulesStateStale(state, now)) return "Modules: service not running (no recent module state).\n";
  if (!state.modules.length) return "No modules configured.\n";
  const lines: string[] = [];
  for (const row of state.modules) {
    lines.push(`${row.id}${row.version ? ` ${row.version}` : ""} — ${row.state}${row.enabled ? "" : " (disabled in config)"} [${row.code}]`);
    if (row.status) lines.push(`  Status: ${row.status}`);
    if (row.state !== "ready" && row.cause) lines.push(`  Cause: ${row.cause}`);
    if (row.state !== "ready" && row.fix) lines.push(`  Fix: ${row.fix}`);
    if (row.requires.length) lines.push(`  Requires: ${row.requires.join(", ")}`);
    lines.push(`  Agents: ${row.agents.length ? row.agents.join(", ") : "none"}`);
    const moved = movedSettingsText(row, options.agentId);
    if (moved) lines.push(`  Note: ${moved}`);
  }
  return `${lines.join("\n")}\n`;
}

const stateWords: Record<ModuleState, string> = {
  disabled: "вимкнено", unavailable: "недоступний", starting: "запускається", ready: "працює", failed: "збій",
};

/** «Модулі» section of the owner's Telegram `/status`; empty when no module is configured. */
export function formatModulesSection(rows: readonly ModuleStateReport[]): string {
  if (!rows.length) return "";
  const lines = rows.map((row) => {
    const head = `${row.id} — ${stateWords[row.state]}`;
    if (row.state === "ready") return row.status ? `${head}: ${row.status}` : head;
    const why = [row.cause, row.fix ? `Що зробити: ${row.fix}` : undefined].filter(Boolean).join(" ");
    return why ? `${head}. ${why}` : head;
  });
  return `Модулі:\n${lines.join("\n")}`;
}

export interface ModulesStateWriterOptions {
  host: Pick<ModuleHost, "report" | "onChange">;
  runtimeDataPath: string;
  diagnostics: DiagnosticSink;
  intervalMs?: number;
  now?: () => number;
}

/** Writes `state.json` now, on every host change and every `intervalMs` (60 s); `stop()` waits for a write in flight. */
export function startModulesStateWriter(options: ModulesStateWriterOptions): { stop(): Promise<void>; flush(): Promise<void> } {
  const path = modulesStatePath(options.runtimeDataPath);
  const now = options.now ?? Date.now;
  let stopped = false;
  let writing: Promise<void> | undefined;
  let dirty = false;
  function flush(): Promise<void> {
    if (stopped) return writing ?? Promise.resolve();
    dirty = true;
    return writing ??= (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false;
          try { await writeModulesState(path, options.host.report(), now()); }
          catch { options.diagnostics.record("MODULE_STATE_WRITE_FAILED"); }
        }
      } finally { writing = undefined; }
    })();
  }
  const unsubscribe = options.host.onChange(() => { void flush(); });
  const timer = setInterval(() => { void flush(); }, options.intervalMs ?? 60_000);
  timer.unref();
  void flush();
  return {
    flush,
    async stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      await writing;
    },
  };
}
