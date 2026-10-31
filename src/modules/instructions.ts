import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AbilityCall, AbilityResult, AbilitySpec } from "./contract.js";
import type { ModuleHost } from "./host.js";
import { densembleStateAbility, type DensembleStateOptions } from "./state.js";

/** One ability offered to a session; `moduleId` is null for core abilities (`densemble_*`). */
export interface SessionAbility {
  moduleId: string | null;
  spec: AbilitySpec;
  /** Never throws. */
  invoke(args: unknown, call: AbilityCall): Promise<AbilityResult>;
}

/** What one session gets at open: the appended instruction block and its abilities. */
export interface SessionModules {
  instructions: string;
  abilities: SessionAbility[];
}

export interface SessionModulesOptions {
  agentId: string;
  owner: boolean;
  /** Core `src/modules/INSTRUCTIONS.md`; defaults to a reader cached for the process lifetime. */
  readCore?: () => Promise<string>;
  state?: DensembleStateOptions;
}

const FALLBACK_CORE = "Call `densemble_state` to see Densemble's module state. You cannot enable, disable, restart or " +
  "reconfigure modules: tell Oleh the `modules.<id>` key to change in config.local.json and to run `make restart`.";

/** Reads `src/modules/INSTRUCTIONS.md` under the code root (same root from `src/` and `dist/`). */
export function coreInstructionsReader(codeRoot = fileURLToPath(new URL("../../", import.meta.url))): () => Promise<string> {
  return async () => {
    try {
      const text = (await readFile(join(codeRoot, "src", "modules", "INSTRUCTIONS.md"), "utf8")).trim();
      return text || FALLBACK_CORE;
    } catch { return FALLBACK_CORE; }
  };
}

let cachedCore: Promise<string> | undefined;
function defaultCore(): Promise<string> {
  return cachedCore ??= coreInstructionsReader()();
}

/**
 * Builds a session's module block: the core instructions for every agent, then, for each ready module that lists
 * the agent and only for the owner, `# Module <id> v<version>` with its cached `INSTRUCTIONS.md` (read once by the
 * host at resolve). Abilities are `densemble_state` plus those modules' abilities. Never reads or writes the workspace.
 */
export async function buildSessionModules(host: ModuleHost, options: SessionModulesOptions): Promise<SessionModules> {
  const core = (await (options.readCore ?? defaultCore)()).trim() || FALLBACK_CORE;
  const allowed = new Set<string>();
  const blocks = [`# Densemble core\n${core}`];
  if (options.owner) {
    for (const row of host.report()) {
      const view = host.get(row.id);
      if (!view?.definition || view.health.state !== "ready" || !view.entry.agents.includes(options.agentId)) continue;
      allowed.add(row.id);
      const text = view.instructions?.trim();
      if (text) blocks.push(`# Module ${row.id} v${view.definition.version}\n${text}`);
    }
  }
  const abilities: SessionAbility[] = [
    densembleStateAbility(host, options.state),
    ...host.abilities().filter((ability) => allowed.has(ability.moduleId)),
  ];
  return { instructions: blocks.join("\n\n"), abilities };
}
