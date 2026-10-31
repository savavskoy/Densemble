import { z } from "zod";
import type { CoreOffer, ModuleDefinition, ModuleEntry } from "../../../src/modules/contract.js";
import type { ModuleLoader } from "../../../src/modules/loader.js";
import { SpeechGate } from "../../../src/media/speech-gate.js";

/** A minimal valid module: any settings, no abilities, a no-op instance. */
export function fakeModule<S = unknown, P = unknown>(id: string, overrides: Partial<ModuleDefinition<S, P>> = {}): ModuleDefinition<S, P> {
  return {
    id,
    version: "1.0.0",
    settings: z.unknown() as z.ZodType<S>,
    reasons: {},
    start: async () => ({ stop: async () => undefined }),
    ...overrides,
  };
}

/** Injectable loader over fixed definitions; `loaded` records every id asked for. */
export function fakeLoader(definitions: readonly ModuleDefinition[]): ModuleLoader & { loaded: string[] } {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const loaded: string[] = [];
  const loader = async (id: string) => {
    loaded.push(id);
    return byId.get(id);
  };
  return Object.assign(loader, { loaded });
}

export function entry(id: string, overrides: Partial<ModuleEntry> = {}): ModuleEntry {
  return { id, enabled: true, agents: [], settings: undefined, ...overrides };
}

export function fakeCore(overrides: Partial<CoreOffer> = {}): CoreOffer {
  return {
    speechGate: new SpeechGate(),
    audio: { ffmpegPath: "ffmpeg", ffprobePath: "ffprobe", whisperPath: "whisper-cli", vocabulary: [] },
    ownerWorkspaces: [],
    managedRoots: [],
    resolveFromConfig: (path) => path,
    quietHours: { start: "22:00", end: "08:00", timezone: "UTC" },
    ...overrides,
  };
}

/**
 * A module with a read-only `<id>_status` and a mutating `<id>_publish` ability. Its hard limit lives in code:
 * `target: "public"` is always refused with `<ID>_NOT_ALLOWED`, whatever the instructions or a skill ask for.
 */
export function abilityModule(id = "fixture", overrides: Partial<ModuleDefinition> = {}): ModuleDefinition & { calls: unknown[] } {
  const calls: unknown[] = [];
  const code = `${id.toUpperCase().replace(/-/g, "_")}_NOT_ALLOWED`;
  const definition = fakeModule(id, {
    abilities: [
      { name: `${id}_status`, description: "Fixture status.", input: z.object({}), readOnly: true },
      { name: `${id}_publish`, description: "Fixture publish.", input: z.object({ target: z.string() }) },
    ],
    start: async () => ({
      stop: async () => undefined,
      invoke: async (name, args, call) => {
        calls.push({ name, args, agentId: call.agentId, owner: call.owner });
        if (name === `${id}_publish`) {
          const target = (args as { target: string }).target;
          if (target === "public") return { ok: false, code, message: "Publishing publicly is not allowed." };
          return { ok: true, message: `Published to ${target}.` };
        }
        return { ok: true, status: "idle" };
      },
    }),
    ...overrides,
  });
  return Object.assign(definition, { calls });
}
