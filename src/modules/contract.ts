import type { z } from "zod";
import type { Json, Scope } from "../domain.js";
import type { SpeechGate } from "../media/speech-gate.js";
import type { DiagnosticSink } from "../ports.js";
import type { QuietHoursConfig } from "../scheduling/quiet-hours.js";

/** Fixed codes only: health, diagnostics and ability errors never carry paths, content or secrets. */
export const FIXED_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
export const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;

export type ModuleState = "disabled" | "unavailable" | "starting" | "ready" | "failed";

export interface ModuleHealth {
  state: ModuleState;
  code: string;
  /** Optional scalar, e.g. the id of the unavailable dependency. */
  detail?: string;
  since: number;
}

/** A configured module after config load (`modules.<id>`); `settings` is validated by the module. */
export interface ModuleEntry {
  id: string;
  enabled: boolean;
  agents: readonly string[];
  settings: unknown;
  /** Set when the settings came from a legacy location (e.g. top-level `recordings`). */
  movedSettings?: { from: string; to: string };
}

/** Core context a module may read; pure path helpers come from `core-api.ts`. */
export interface CoreOffer {
  speechGate: SpeechGate;
  audio: { ffmpegPath: string; ffprobePath: string; whisperPath: string; vocabulary: readonly string[] };
  /** Owner workspace roots (service workspace + owner's configured workspaces). */
  ownerWorkspaces: readonly string[];
  /** Service-owned paths (code, runtime data/home, config, secrets…) a module folder must not overlap. */
  managedRoots: readonly string[];
  /** Resolves a path relative to the config file's directory, as core settings do. */
  resolveFromConfig(path: string): string;
  quietHours: QuietHoursConfig;
}

export interface ModuleReason { cause: string; fix: string; urgent?: boolean }

/** One doctor line; `detail` is an owner-local name for humans and never logged. */
export interface ModuleCheck { component: string; ready: boolean; code: string; count?: number; detail?: string }

export type PrepareResult<S> = { ok: true; settings: S } | { ok: false; code: string };

export interface AbilitySpec {
  /** `<moduleId>_<verb>`; never `densemble_*`. */
  name: string;
  description: string;
  input: z.ZodObject;
  /** Runs without a permission prompt. */
  readOnly?: boolean;
}

export interface AbilityCall {
  scope: Scope;
  agentId: string;
  userId: number;
  owner: boolean;
  workspace: string;
  signal: AbortSignal;
}

export type AbilityResult =
  | { ok: true; message?: string; [key: string]: Json | undefined }
  | { ok: false; code: string; message: string };

export interface ModuleInstance<P = unknown> {
  /** Public API for dependents (typed in the module's `api.ts`). */
  provides?: P;
  invoke?(name: string, args: unknown, call: AbilityCall): Promise<AbilityResult>;
  /** One short line for `/status` and the state report. */
  status?(): string | undefined;
  /** Bounded by the host. */
  stop(): Promise<void>;
}

export interface ModuleContext<S = unknown> {
  settings: S;
  /** `runtimeDataPath/modules/<id>/`, created 0700. */
  dataPath: string;
  /** Adds the module id as metadata. */
  diagnostics: DiagnosticSink;
  core: CoreOffer;
  /** `provides` of a ready module listed in `requires`; otherwise throws `MODULE_DEPENDENCY_UNAVAILABLE`. */
  require<T>(id: string): T;
  /** Background work; a rejection marks the module `failed` with the error's fixed `code` or `MODULE_FAILED`. */
  run(task: () => Promise<unknown>): void;
  fail(code: string): void;
  recovered(): void;
  /** Aborted when the host stops the module. */
  signal: AbortSignal;
}

/** Method syntax keeps any `ModuleDefinition<S, P>` assignable to `ModuleDefinition`. */
export interface ModuleDefinition<S = unknown, P = unknown> {
  /** Equals the folder name. */
  id: string;
  version: string;
  requires?: readonly string[];
  /** Module-owned validation of `modules.<id>.settings` (FR-005). */
  settings: z.ZodType<S>;
  /** Static; names `<id>_<verb>`. */
  abilities?: readonly AbilitySpec[];
  /** `INSTRUCTIONS.md` must exist; implied when `abilities` is not empty. */
  instructions?: boolean;
  /** Ukrainian, user-facing cause and fix per module code. */
  reasons: Readonly<Record<string, ModuleReason>>;
  /** Checks needing core context (paths); may throw an error with a fixed `code`. */
  prepare?(settings: S, core: CoreOffer): PrepareResult<S> | Promise<PrepareResult<S>>;
  /** Only called when the module is enabled and its dependencies are fine. */
  doctor?(settings: S, core: CoreOffer): Promise<ModuleCheck[]>;
  start(context: ModuleContext<S>): Promise<ModuleInstance<P>>;
}

/** Report row per configured module (doctor, `/status`, `densemble_state`, `state.json`). */
export interface ModuleStateReport {
  id: string;
  version?: string;
  enabled: boolean;
  state: ModuleState;
  code: string;
  detail?: string;
  cause?: string;
  fix?: string;
  requires: string[];
  agents: string[];
  status?: string;
  movedSettings?: { from: string; to: string };
}

/**
 * A module error with a fixed code. Thrown from `start()` with `unavailable: true` it means a missing
 * prerequisite (e.g. a model file): the module becomes `unavailable` instead of `failed`.
 */
export class ModuleError extends Error {
  readonly code: string;
  readonly unavailable: boolean;
  constructor(code: string, options: { unavailable?: boolean } = {}) {
    super(code);
    this.code = code;
    this.unavailable = options.unavailable ?? false;
    this.name = "ModuleError";
  }
}

/** The error's own fixed `code` when it has one, else `fallback`. */
export function errorCode(error: unknown, fallback: string): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && FIXED_CODE.test(code) ? code : fallback;
}
